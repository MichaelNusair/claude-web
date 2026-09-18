#!/bin/bash
set -euo pipefail

# Run the real deploy on the deploy box, from origin/main, and watch it finish.
#
# WHY THIS EXISTS
#
# A full deploy cannot be driven from the workspace instance. CloudFormation applies
# a UserData change by *stopping* that instance, so everything deploy.sh does after
# `cdk deploy` — waiting for SSM, pushing the payload, checking the app still
# requires a login, printing the summary — dies with the box. The stack goes green
# and the running app was never updated. deploy.sh now refuses outright when it sees
# it is running there, and this script is the other half of that refusal: the way to
# actually ship.
#
# So the deploy runs somewhere the stack cannot stop. Two consequences, both of them
# the point rather than side effects:
#
#   1. It survives this end going away. The deploy is started detached on the deploy
#      box and this script only reads its log, so closing the editor, losing the
#      network, or the workspace instance restarting mid-deploy does not stop it.
#      Run this again and it re-attaches to the same run instead of starting a
#      second one.
#   2. It deploys origin/main, not your working tree. deploy.sh ships the tree it is
#      run from, and the tree on the deploy box is whatever `git reset --hard
#      origin/main` makes it. That is why this refuses to run with uncommitted or
#      unpushed work: silently shipping a *different* tree than the one you are
#      looking at is worse than making you push.
#
# Configure the box in claude-web.config.json under `deployFrom` (instanceId,
# repoPath, user). Anything with an SSM agent and a role that can deploy the stack
# will do — a laptop, CI, or a small instance kept for the purpose. docs/DEPLOY.md
# has the setup.
#
# Any arguments are passed through to deploy.sh on the box.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

REMOTE_ARGS=("$@")

LOG_FILE=/var/log/claude-web-deploy.log
STATUS_FILE=/var/log/claude-web-deploy.status
PID_FILE=/var/log/claude-web-deploy.pid

eval "$(node infra/print-config.js)"

AWS_ARGS=(--region "$CFG_REGION")
[ -n "$CFG_PROFILE" ] && AWS_ARGS+=(--profile "$CFG_PROFILE")

if [ -z "$CFG_DEPLOY_INSTANCE" ]; then
  cat >&2 <<'NOBOX'
No deploy box configured.

A full deploy must not run on the instance the stack manages, so it needs a second
machine. Add one to claude-web.config.json:

  "deployFrom": {
    "instanceId": "i-0123456789abcdef0",
    "repoPath": "/home/ec2-user/claude-web",
    "user": "ec2-user"
  }

It needs the SSM agent running, a clone of this repository with its own
claude-web.config.json, and a role that can deploy the stack. See docs/DEPLOY.md.

If the change is app-only — anything under chat-service, pwa, the extensions or
infra/userdata — you do not need this at all:

  ./deploy.sh --app-only
NOBOX
  exit 1
fi

printf '\n\033[1mDeploying\033[0m %s\n' "https://$CFG_DOMAIN"
printf '  from %s  at %s  as %s\n' "$CFG_DEPLOY_INSTANCE" "$CFG_DEPLOY_PATH" "$CFG_DEPLOY_USER"

# ---------------------------------------------------------------------------
# The deploy box may not be the instance being deployed
# ---------------------------------------------------------------------------
# Otherwise this is an elaborate way to reach the exact failure the refusal in
# deploy.sh exists to prevent — and it would be reached over SSM, where the log
# stops mid-sentence with no exit code, which is harder to read than the local
# version of the same mistake.
STACK_INSTANCE="$(aws cloudformation describe-stacks --stack-name "$CFG_STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue | [0]" \
  --output text "${AWS_ARGS[@]}" 2>/dev/null || true)"
if [ "$CFG_DEPLOY_INSTANCE" = "$STACK_INSTANCE" ]; then
  {
    echo
    echo "deployFrom.instanceId is $CFG_DEPLOY_INSTANCE, which is the instance this"
    echo "stack manages. A deploy there stops the box it is deploying, so it cannot"
    echo "finish. Point deployFrom at a different machine."
  } >&2
  exit 1
fi

# ---------------------------------------------------------------------------
step "Checking there is nothing here that the deploy box would miss"
# ---------------------------------------------------------------------------
# The box deploys origin/main. Anything uncommitted or unpushed here would simply
# not be in what ships, and the deploy would report success over a tree that is not
# the one you are looking at.
DIRTY="$(git status --porcelain)"
if [ -n "$DIRTY" ]; then
  {
    echo
    echo "Uncommitted changes. The deploy box ships origin/main, so these would not"
    echo "be deployed and nothing would say so:"
    echo
    git status --short
    echo
    echo "Commit and push them — including work that is not yours, named in the commit"
    echo "message, per AGENTS.md — then run this again. For an app-only change you can"
    echo "also ship the tree as it stands from here with ./deploy.sh --app-only."
  } >&2
  exit 1
fi

git fetch --quiet origin main
AHEAD="$(git rev-list --count origin/main..HEAD)"
BEHIND="$(git rev-list --count HEAD..origin/main)"
if [ "$AHEAD" -ne 0 ]; then
  {
    echo
    echo "$AHEAD commit(s) here are not on origin/main:"
    git --no-pager log --oneline origin/main..HEAD
    echo
    echo "Push first — the deploy box can only deploy what it can fetch:"
    echo "  git push origin main"
  } >&2
  exit 1
fi
if [ "$BEHIND" -ne 0 ]; then
  # Not a refusal: shipping what is on main, including someone else's pushed work,
  # is the rule in AGENTS.md. But it must be said out loud, because the suite that
  # runs is the one on the box and it is testing code this machine has not seen.
  printf '\n\033[1;33m! origin/main has %s commit(s) this checkout does not:\033[0m\n' "$BEHIND"
  git --no-pager log --oneline HEAD..origin/main | sed 's/^/    /'
  printf '  They will be deployed too. The suite runs on the box, so they are tested there.\n'
fi
DEPLOYING="$(git rev-parse --short origin/main)"
printf '  shipping origin/main at %s — %s\n' "$DEPLOYING" "$(git log -1 --format=%s origin/main)"

# ---------------------------------------------------------------------------
# Talking to the box
# ---------------------------------------------------------------------------
# Run Command rather than a session, because it needs no plugin installed locally
# and because a command that has been *sent* does not depend on this end staying
# alive to keep running.
#
# Output comes back in $SSM_OUT rather than on stdout, and callers must not wrap
# this in $(...): a command substitution runs in a subshell, so the $SSM_STATUS
# it sets there is thrown away and the caller reads an empty status. That mistake
# cost this script its first real deploy — it started one correctly and then
# announced it could not start it.
SSM_STATUS=""
SSM_OUT=""
ssm_run() {
  local script="$1" cmd_id status=Pending tries=0
  cmd_id="$(aws ssm send-command \
    --instance-ids "$CFG_DEPLOY_INSTANCE" \
    --document-name AWS-RunShellScript \
    --comment "claude-web deploy-remote" \
    --timeout-seconds 120 \
    --cli-input-json "$(python3 -c 'import json,sys; print(json.dumps({"Parameters": {"commands": [sys.stdin.read()]}}))' <<<"$script")" \
    --query Command.CommandId --output text "${AWS_ARGS[@]}")"
  while [ "$tries" -lt 90 ]; do
    status="$(aws ssm get-command-invocation --command-id "$cmd_id" \
      --instance-id "$CFG_DEPLOY_INSTANCE" --query Status --output text \
      "${AWS_ARGS[@]}" 2>/dev/null || echo Pending)"
    case "$status" in
      Success|Failed|Cancelled|TimedOut) break ;;
    esac
    tries=$((tries + 1))
    sleep 2
  done
  SSM_STATUS="$status"
  SSM_OUT="$(aws ssm get-command-invocation --command-id "$cmd_id" \
    --instance-id "$CFG_DEPLOY_INSTANCE" --query StandardOutputContent --output text \
    "${AWS_ARGS[@]}" 2>/dev/null || true)"
  if [ "$status" != "Success" ]; then
    aws ssm get-command-invocation --command-id "$cmd_id" \
      --instance-id "$CFG_DEPLOY_INSTANCE" --query StandardErrorContent --output text \
      "${AWS_ARGS[@]}" 2>/dev/null >&2 || true
  fi
}

step "Waiting for the deploy box to answer SSM"
PING="$(aws ssm describe-instance-information \
  --filters "Key=InstanceIds,Values=$CFG_DEPLOY_INSTANCE" \
  --query 'InstanceInformationList[0].PingStatus' --output text \
  "${AWS_ARGS[@]}" 2>/dev/null || echo None)"
if [ "$PING" != "Online" ]; then
  {
    echo "$CFG_DEPLOY_INSTANCE is $PING to SSM, so nothing can be run on it."
    echo "Start it and wait for the agent, or point deployFrom at another machine:"
    echo "  aws ec2 start-instances --instance-ids $CFG_DEPLOY_INSTANCE ${AWS_ARGS[*]}"
  } >&2
  exit 1
fi
echo "  Online"

# ---------------------------------------------------------------------------
step "Starting the deploy on $CFG_DEPLOY_INSTANCE"
# ---------------------------------------------------------------------------
# Everything below runs as root via SSM, and everything that touches the checkout
# is handed to the user that owns it — a root-owned object in that tree would break
# every later deploy with git's "dubious ownership" refusal, which is a confusing
# way to find out.
#
# The launch is detached with setsid and its own redirections so it outlives this
# SSM command: SSM waits for the command, not for the process group.
LAUNCH="$(python3 - "$CFG_DEPLOY_PATH" "$CFG_DEPLOY_USER" "$LOG_FILE" "$STATUS_FILE" "$PID_FILE" \
  "${REMOTE_ARGS[@]+"${REMOTE_ARGS[@]}"}" <<'PY'
import shlex, sys
path, user, log, status, pid = sys.argv[1:6]
args = ' '.join(shlex.quote(a) for a in sys.argv[6:])
q = shlex.quote
print(f'''set -e
if [ -s {q(pid)} ] && kill -0 "$(cat {q(pid)})" 2>/dev/null; then
  echo "ALREADY_RUNNING $(cat {q(pid)})"
  exit 0
fi
rm -f {q(log)} {q(status)} {q(pid)}
runuser -u {q(user)} -- git -C {q(path)} fetch --prune --quiet origin
runuser -u {q(user)} -- git -C {q(path)} reset --hard --quiet origin/main
runuser -u {q(user)} -- git -C {q(path)} log -1 --format="HEAD %h %s"
install -o {q(user)} -g {q(user)} -m 0644 /dev/null {q(log)}
install -o {q(user)} -g {q(user)} -m 0644 /dev/null {q(status)}
install -o {q(user)} -g {q(user)} -m 0644 /dev/null {q(pid)}
setsid runuser -u {q(user)} -- bash {q(path + "/scripts/remote-deploy-runner.sh")} {q(path)} {args} \\
  </dev/null >>{q(log)} 2>&1 &
disown || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -s {q(pid)} ] && break
  sleep 1
done
[ -s {q(pid)} ] || {{ echo "the deploy did not start; last of the log:"; tail -20 {q(log)}; exit 1; }}
echo "STARTED $(cat {q(pid)})"''')
PY
)"
ssm_run "$LAUNCH"
LAUNCH_OUT="$SSM_OUT"
printf '%s\n' "$LAUNCH_OUT" | sed 's/^/  /'
if [ "$SSM_STATUS" != "Success" ]; then
  echo "Could not start the deploy on $CFG_DEPLOY_INSTANCE ($SSM_STATUS)." >&2
  exit 1
fi
ATTACHED=0
case "$LAUNCH_OUT" in
  *ALREADY_RUNNING*) ATTACHED=1 ;;
esac

# ---------------------------------------------------------------------------
step "Following the deploy"
# ---------------------------------------------------------------------------
# Line offsets rather than byte offsets: SSM normalises trailing whitespace in
# captured output, so counting bytes drifts and eventually reprints or skips a
# chunk of the log. Lines survive that.
#
# Nothing here can hurry the deploy along, so it polls slowly enough to be cheap
# and prints only what is new.
SEEN=0
[ "$ATTACHED" -eq 1 ] && printf '  a deploy was already running; re-attaching to it\n'
CODE=""
WAITED=0
LIMIT=3600
while [ "$WAITED" -lt "$LIMIT" ]; do
  ssm_run "printf 'CWSTATUS:%s\n' \"\$(tr -dc 0-9 < $STATUS_FILE 2>/dev/null)\"
printf 'CWLINES:%s\n' \"\$(wc -l < $LOG_FILE 2>/dev/null || echo 0)\"
tail -n +$((SEEN + 1)) $LOG_FILE 2>/dev/null || true"
  OUT="$SSM_OUT"
  CODE="$(printf '%s\n' "$OUT" | sed -n 's/^CWSTATUS:\([0-9]\+\)$/\1/p' | head -1)"
  TOTAL="$(printf '%s\n' "$OUT" | sed -n 's/^CWLINES:\([0-9]\+\)$/\1/p' | head -1)"
  BODY="$(printf '%s\n' "$OUT" | sed '1,2d')"
  # First look at a deploy that was already running: show the tail, not a dump of
  # the whole thing from the start, which SSM would truncate anyway.
  if [ "$ATTACHED" -eq 1 ] && [ "$SEEN" -eq 0 ] && [ "${TOTAL:-0}" -gt 40 ]; then
    BODY="$(printf '%s\n' "$BODY" | tail -40)"
    printf '  … showing the last 40 lines of %s\n' "$TOTAL"
  fi
  [ -n "$BODY" ] && printf '%s\n' "$BODY"
  [ -n "${TOTAL:-}" ] && SEEN="$TOTAL"
  [ -n "$CODE" ] && break
  sleep 15
  WAITED=$((WAITED + 15))
done

if [ -z "$CODE" ]; then
  {
    echo
    echo "Still running after $((LIMIT / 60)) minutes. It is not waiting on this script —"
    echo "run ./deploy-remote.sh again to re-attach, or read the log on the box:"
    echo "  aws ssm start-session --target $CFG_DEPLOY_INSTANCE ${AWS_ARGS[*]}"
    echo "  tail -f $LOG_FILE"
  } >&2
  exit 1
fi

printf '\n'
if [ "$CODE" -eq 0 ]; then
  printf '\033[1;32m✓ Deployed %s to https://%s from %s\033[0m\n' \
    "$DEPLOYING" "$CFG_DOMAIN" "$CFG_DEPLOY_INSTANCE"
else
  printf '\033[1;31m✗ The deploy failed on %s (exit %s). Nothing here was changed.\033[0m\n' \
    "$CFG_DEPLOY_INSTANCE" "$CODE" >&2
  printf '  The full log is %s on the box.\n' "$LOG_FILE" >&2
fi
exit "$CODE"
