#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
# Everything account-specific comes from claude-web.config.json (see
# claude-web.config.example.json). infra/config.js is the single source of truth
# for defaults and validation, so this reads through it rather than parsing the
# JSON again and drifting from it.
if [ ! -f "$ROOT/claude-web.config.json" ] && [ -z "${CLAUDE_WEB_DOMAIN:-}" ]; then
  cat >&2 <<'NOCONFIG'
No configuration found.

  cp claude-web.config.example.json claude-web.config.json
  $EDITOR claude-web.config.json      # set domainName and hostedZoneName

You need an AWS account, a Route53 hosted zone you control, and Bedrock model
access enabled in your region. See docs/DEPLOY.md.
NOCONFIG
  exit 1
fi

eval "$(node infra/print-config.js)"

DOMAIN="$CFG_DOMAIN"
REGION="$CFG_REGION"
PROFILE="$CFG_PROFILE"
STACK_NAME="$CFG_STACK"

# An empty --profile is not a valid flag, so the profile is only passed when the
# deployment actually configured one; otherwise the default credential chain is
# used, which is what most people and all CI systems want.
AWS_ARGS=(--region "$REGION")
[ -n "$PROFILE" ] && AWS_ARGS+=(--profile "$PROFILE")

printf '\n\033[1mDeploying\033[0m %s\n' "https://$DOMAIN"
printf '  region %s   auth %s   permissions %s   admin-role %s\n' \
  "$REGION" "$CFG_AUTH_MODE" "$CFG_PERMISSION_MODE" "$CFG_ADMIN"

# ---------------------------------------------------------------------------
step "Checking authentication"
# ---------------------------------------------------------------------------
# Runs first and blocks the deploy, because this is the check that matters: the
# chat service can execute shell commands, and it once shipped reachable without
# credentials. Boots the real server and confirms every route and the WebSocket
# upgrade refuse an unauthenticated caller.
(
  cd chat-service
  [ -d node_modules/ws ] || npm install --silent
  node auth-test.js
) || { echo "AUTH TESTS FAILED — refusing to deploy." >&2; exit 1; }

# ---------------------------------------------------------------------------
step "Checking the client boots"
# ---------------------------------------------------------------------------
# `node --check` only parses. This actually runs app.js in a DOM, because a
# runtime error at load leaves the page stuck on "Loading…" with no other
# symptom — and that has shipped before.
(
  cd chat-service
  [ -d node_modules/jsdom ] || npm install --silent
  node smoke-test.js
) || { echo "client smoke test failed — not deploying." >&2; exit 1; }

# ---------------------------------------------------------------------------
step "Packaging the voice dictation extension"
# ---------------------------------------------------------------------------
mkdir -p dist
for ext in voice-extension mobile-extension; do
  out="claude-voice.vsix"
  [ "$ext" = "mobile-extension" ] && out="claude-mobile.vsix"
  (
    cd "$ext"
    npx --yes @vscode/vsce@latest package \
      --skip-license \
      --allow-missing-repository \
      --out "$ROOT/dist/$out"
  )
done

# ---------------------------------------------------------------------------
step "Deploying infrastructure"
# ---------------------------------------------------------------------------
CDK_ARGS=()
[ -n "$PROFILE" ] && CDK_ARGS+=(--profile "$PROFILE")
(
  cd infra
  [ -d node_modules ] || npm install
  npx cdk deploy "$STACK_NAME" \
    "${CDK_ARGS[@]+"${CDK_ARGS[@]}"}" \
    --require-approval never \
    --outputs-file "$ROOT/dist/outputs.json"
) || { echo "CDK deploy failed — stopping before the payload step." >&2; exit 1; }

# A failed CDK run can leave a stale outputs file from a previous deploy, which
# would silently point the rest of this script at the wrong instance.
[ -s "$ROOT/dist/outputs.json" ] || { echo "No stack outputs written." >&2; exit 1; }

read_output() {
  python3 -c "
import json,sys
print(json.load(open('$ROOT/dist/outputs.json'))['$STACK_NAME'].get('$1',''))"
}

INSTANCE_ID="$(read_output InstanceId)"
[ -n "$INSTANCE_ID" ] || { echo "No InstanceId in stack outputs." >&2; exit 1; }
step "Instance: $INSTANCE_ID"

# ---------------------------------------------------------------------------
step "Waiting for SSM agent"
# ---------------------------------------------------------------------------
state=None
for _ in $(seq 1 60); do
  state="$(aws ssm describe-instance-information \
    --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
    --query 'InstanceInformationList[0].PingStatus' --output text \
    "${AWS_ARGS[@]}" 2>/dev/null || echo None)"
  [ "$state" = "Online" ] && break
  sleep 10
done
[ "$state" = "Online" ] || { echo "SSM never came online." >&2; exit 1; }

# ---------------------------------------------------------------------------
step "Waiting for first-boot provisioning to finish"
# ---------------------------------------------------------------------------
# SSM answers well before cloud-init is done. Installing the payload before
# Node exists fails with "npm: command not found", so gate on cloud-init.
WAIT_ID="$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "wait for cloud-init" \
  --parameters 'commands=["cloud-init status --wait || true","command -v npm >/dev/null || { echo MISSING_NPM; tail -40 /var/log/bootstrap.log; exit 1; }","command -v code-server >/dev/null || { echo MISSING_CODE_SERVER; tail -40 /var/log/bootstrap.log; exit 1; }"]' \
  --timeout-seconds 1800 \
  --query 'Command.CommandId' --output text \
  "${AWS_ARGS[@]}")"

while true; do
  st="$(aws ssm get-command-invocation --command-id "$WAIT_ID" --instance-id "$INSTANCE_ID" \
    --query Status --output text "${AWS_ARGS[@]}" 2>/dev/null || echo Pending)"
  case "$st" in
    Success) break ;;
    Failed|Cancelled|TimedOut)
      echo "Provisioning did not complete ($st):" >&2
      aws ssm get-command-invocation --command-id "$WAIT_ID" --instance-id "$INSTANCE_ID" \
        --query 'StandardOutputContent' --output text \
        "${AWS_ARGS[@]}" >&2
      exit 1 ;;
  esac
  sleep 15
done

# ---------------------------------------------------------------------------
step "Uploading application payload"
# ---------------------------------------------------------------------------
# Shipped separately from userdata so editing the voice extension or PWA assets
# doesn't force an EC2 replacement.
rm -rf dist/stage && mkdir -p dist/stage
cp -R chat-service dist/stage/chat-service
rm -rf dist/stage/chat-service/node_modules
# The overlay script is injected into the editor shell by nginx, so it ships as
# a top-level asset rather than inside the chat service.
mkdir -p dist/stage/pwa && cp pwa/mobile-overlay.js dist/stage/pwa/
mkdir -p dist/stage/vsix
cp dist/claude-voice.vsix dist/claude-mobile.vsix dist/stage/vsix/
# The chat UI serves its own PWA assets, so bundle them into its public dir.
cp pwa/manifest.webmanifest pwa/sw.js dist/stage/chat-service/public/
mkdir -p dist/stage/chat-service/public/pwa-icons
cp pwa-icons/*.png dist/stage/chat-service/public/pwa-icons/
# COPYFILE_DISABLE stops macOS tar from emitting AppleDouble `._*` companions for
# every file carrying an extended attribute (macOS adds com.apple.provenance to
# downloaded and newly written files). Those stubs land on the instance, show up
# as phantom files in the editor, and left a non-empty directory behind that
# broke the vsix cleanup below.
COPYFILE_DISABLE=1 tar -czf dist/payload.tar.gz -C dist/stage chat-service pwa vsix

# Staged through S3 rather than inlined into the SSM command.
#
# SSM caps a parameter value at ~100 KB, and base64 inflates by a third, so the
# inline route hit a hard wall the moment the chat service grew — which it did,
# the first time authentication was added. The transfer bucket already exists for
# migrate.sh and the instance role can already read it, so this has no
# infrastructure cost and no size cliff to trip over again.
TRANSFER_BUCKET="$(read_output TransferBucketName)"
[ -n "$TRANSFER_BUCKET" ] || { echo "No TransferBucketName in stack outputs." >&2; exit 1; }

PAYLOAD_KEY="payload/$(date +%Y%m%d-%H%M%S)-$$.tar.gz"
step "Staging payload via s3://$TRANSFER_BUCKET/$PAYLOAD_KEY"
aws s3 cp dist/payload.tar.gz "s3://$TRANSFER_BUCKET/$PAYLOAD_KEY" \
  "${AWS_ARGS[@]}" --only-show-errors

CMD_ID="$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "claude-web payload" \
  --cli-input-json "$(python3 - "$TRANSFER_BUCKET" "$PAYLOAD_KEY" "$REGION" <<'PY'
import json, sys
bucket, key, region = sys.argv[1], sys.argv[2], sys.argv[3]
cmds = [
  "set -euxo pipefail",
  "mkdir -p /opt/claude-web && cd /opt/claude-web",
  f"aws s3 cp s3://{bucket}/{key} /tmp/payload.tar.gz --region {region}",
  "tar -xzf /tmp/payload.tar.gz -C /opt/claude-web",
  "rm -f /tmp/payload.tar.gz",
  # Delete AppleDouble stubs FIRST. They are prevented at the tar end now, but
  # this must still run before anything else walks the tree: when it ran after
  # the vsix move below, a leftover `._claude-voice.vsix` made the directory
  # non-empty and `rmdir` failed the whole deploy.
  "find /opt/claude-web -name '._*' -delete || true",
  # `rm -rf` rather than `rmdir`: this directory is ours and disposable, and
  # failing the deploy over an unexpected file in it buys nothing.
  "mv -f /opt/claude-web/vsix/*.vsix /opt/claude-web/ && rm -rf /opt/claude-web/vsix",
  # Fail loudly: a silent npm failure leaves the service dead with a confusing
  # 'CHDIR' error, which has happened more than once.
  "cd /opt/claude-web/chat-service && npm install --omit=dev",
  "test -d /opt/claude-web/chat-service/node_modules || { echo 'npm install produced no node_modules'; exit 1; }",
  "chown -R coder:coder /opt/claude-web",
  "sudo -u coder HOME=/home/coder /usr/bin/code-server"
  " --user-data-dir /workspace/code-server-data"
  " --extensions-dir /workspace/code-server-ext"
  " --install-extension /opt/claude-web/claude-voice.vsix --force",
  "sudo -u coder HOME=/home/coder /usr/bin/code-server"
  " --user-data-dir /workspace/code-server-data"
  " --extensions-dir /workspace/code-server-ext"
  " --install-extension /opt/claude-web/claude-mobile.vsix --force",
  "systemctl enable --now claude-chat",
  "systemctl restart claude-chat",
  "systemctl restart code-server",
  # Re-run provisioning on the live instance. The instance is no longer
  # replaced on every script edit (see userDataCausesReplacement in stack.js),
  # so this is what applies bootstrap changes — nginx routing, editor settings,
  # the built-in-chat removal. It is written to be idempotent.
  "if [ -x /opt/bootstrap.sh ]; then bash /opt/bootstrap.sh > /var/log/reprovision.log 2>&1 || "
  "{ echo 'reprovision failed:'; tail -20 /var/log/reprovision.log; exit 1; }; fi",
  "nginx -t && systemctl reload nginx",
  "sleep 3",
  # `is-active` exits non-zero if any unit is down, which fails the SSM command
  # — so a half-broken deploy can no longer report success.
  "systemctl is-active claude-chat code-server nginx",
  "curl -fsS -o /dev/null http://127.0.0.1:9997/healthz || { echo 'chat service not answering'; exit 1; }",
  "curl -fsS -o /dev/null http://127.0.0.1:9999/healthz || curl -fsS -o /dev/null http://127.0.0.1:9999/ || { echo 'code-server not answering'; exit 1; }",
]
print(json.dumps({"Parameters": {"commands": cmds}}))
PY
)" \
  --timeout-seconds 900 \
  --query 'Command.CommandId' --output text \
  "${AWS_ARGS[@]}")"

step "Installing payload (SSM command $CMD_ID)"
while true; do
  status="$(aws ssm get-command-invocation \
    --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
    --query Status --output text \
    "${AWS_ARGS[@]}" 2>/dev/null || echo Pending)"
  case "$status" in
    Success) break ;;
    Failed|Cancelled|TimedOut)
      echo "Payload install $status:" >&2
      aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
        --query StandardErrorContent --output text \
        "${AWS_ARGS[@]}" >&2
      exit 1 ;;
  esac
  sleep 10
done

# ---------------------------------------------------------------------------
step "Verifying https://$DOMAIN"
# ---------------------------------------------------------------------------
code=none
for _ in $(seq 1 36); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$DOMAIN/healthz" || true)"
  [ "$code" = "200" ] && break
  sleep 10
done

# ---------------------------------------------------------------------------
step "Confirming the deployed app requires a login"
# ---------------------------------------------------------------------------
# The local auth tests prove the code is correct; this proves the thing actually
# serving traffic is. A proxy or listener misconfiguration that exposed the chat
# API would pass every unit test and still be an open shell, which is precisely
# the failure this project already shipped once.
verify_closed() {
  local path="$1" label="$2" status
  status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$DOMAIN$path" || echo 000)"
  case "$status" in
    401|403|302|303) printf '  \033[1;32m✓\033[0m %-28s → %s (closed)\n' "$label" "$status" ;;
    000) printf '  \033[1;33m?\033[0m %-28s → unreachable; check again once DNS settles\n' "$label" ;;
    *)
      printf '  \033[1;31m✗ %s returned %s — THIS ENDPOINT IS OPEN\033[0m\n' "$label" "$status"
      return 1 ;;
  esac
}

AUTH_OK=0
verify_closed /api/projects  "GET /api/projects"  || AUTH_OK=1
verify_closed /api/models    "GET /api/models"    || AUTH_OK=1
verify_closed /              "GET /"              || AUTH_OK=1

if [ "$AUTH_OK" -ne 0 ]; then
  printf '\n\033[1;31mDEPLOY VERIFICATION FAILED: the chat API answered without a login.\033[0m\n' >&2
  printf 'Claude runs shell commands on this instance, so treat this as an open\n' >&2
  printf 'remote-execution endpoint. Restrict allowedCidrs or stop the instance now:\n' >&2
  printf '  aws ec2 stop-instances --instance-ids %s %s\n\n' "$INSTANCE_ID" "${AWS_ARGS[*]}" >&2
  exit 1
fi

PW_ARN="$(read_output PasswordCommand | sed -n 's/.*--secret-id \([^ ]*\).*/\1/p')"
PW="$(aws secretsmanager get-secret-value --secret-id "$PW_ARN" \
  --query SecretString --output text \
  "${AWS_ARGS[@]}" 2>/dev/null || echo '<see stack outputs>')"

printf '\n'
if [ "$code" = "200" ]; then
  printf '\033[1;32m✓ Live at https://%s\033[0m\n' "$DOMAIN"
else
  printf '\033[1;33m! /healthz returned %s — DNS or target registration may still be settling.\033[0m\n' "$code"
fi

SHELL_CMD="aws ssm start-session --target $INSTANCE_ID ${AWS_ARGS[*]}"

cat <<SUMMARY

  URL       https://$DOMAIN
  Password  $PW
  Editor    https://$DOMAIN/editor/
  Shell     $SHELL_CMD

  Sign in with the password above. It gates the chat; the editor asks for the
  same one separately.
SUMMARY
