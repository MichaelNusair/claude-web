#!/bin/bash
# Migrate local projects and their Claude Code session history to the server.
#
# Two halves:
#   1. Repos       — cloned server-side from each project's git remote.
#   2. Transcripts — copied up, with paths rewritten from the local layout
#                    (/Users/you/Documents/code/X) to the server's
#                    (/workspace/projects/X). Both the session directory name
#                    and the cwd recorded inside each transcript must change,
#                    or Claude Code won't associate the history with the repo.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Read the same validated configuration the deploy uses, so this can never point
# at a different account or region than the stack it is migrating into.
eval "$(node "$ROOT/infra/print-config.js")"
PROFILE="$CFG_PROFILE"
REGION="$CFG_REGION"
STACK_NAME="$CFG_STACK"
DOMAIN="$CFG_DOMAIN"

AWS_ARGS=(--region "$REGION")
[ -n "$PROFILE" ] && AWS_ARGS+=(--profile "$PROFILE")

# Where your repos live locally. Override with LOCAL_CODE=... if it differs.
LOCAL_CODE="${LOCAL_CODE:-$HOME/Documents/code}"
LOCAL_SESSIONS="$HOME/.claude/projects"
REMOTE_PROJECTS="/workspace/projects"
REMOTE_SESSIONS="/workspace/claude/projects"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
note() { printf '    %s\n' "$1"; }

INSTANCE_ID="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text \
  "${AWS_ARGS[@]}")"
[ -n "$INSTANCE_ID" ] && [ "$INSTANCE_ID" != "None" ] || { echo "stack not deployed" >&2; exit 1; }
step "Instance $INSTANCE_ID"

# Run a script on the instance and wait for it, surfacing output on failure.
run_remote() {
  local comment="$1" script="$2" timeout="${3:-1800}"
  local cmd_id
  cmd_id="$(aws ssm send-command \
    --instance-ids "$INSTANCE_ID" \
    --document-name AWS-RunShellScript \
    --comment "$comment" \
    --cli-input-json "$(python3 -c "
import json,sys
print(json.dumps({'Parameters':{'commands':sys.stdin.read().split('\n')}}))" <<<"$script")" \
    --timeout-seconds "$timeout" \
    --query 'Command.CommandId' --output text \
    "${AWS_ARGS[@]}")"

  while true; do
    local st
    st="$(aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$INSTANCE_ID" \
      --query Status --output text "${AWS_ARGS[@]}" 2>/dev/null || echo Pending)"
    case "$st" in
      Success)
        aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$INSTANCE_ID" \
          --query StandardOutputContent --output text \
          "${AWS_ARGS[@]}"
        return 0 ;;
      Failed|Cancelled|TimedOut)
        echo "remote step '$comment' $st:" >&2
        aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$INSTANCE_ID" \
          --query 'StandardOutputContent' --output text \
          "${AWS_ARGS[@]}" >&2
        aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$INSTANCE_ID" \
          --query 'StandardErrorContent' --output text \
          "${AWS_ARGS[@]}" >&2
        return 1 ;;
    esac
    sleep 10
  done
}

# ---------------------------------------------------------------------------
step "Discovering local projects"
# ---------------------------------------------------------------------------
declare -a NAMES=() REMOTES=() BRANCHES=()
for dir in "$LOCAL_CODE"/*/; do
  name="$(basename "$dir")"
  [ -d "$dir/.git" ] || { note "skip $name (not a git repo)"; continue; }
  remote="$(git -C "$dir" remote get-url origin 2>/dev/null || true)"
  [ -n "$remote" ] || { note "skip $name (no origin remote)"; continue; }
  # Normalise SSH remotes to HTTPS — the server authenticates with a token.
  remote="$(sed -E 's#^git@([^:]+):#https://\1/#' <<<"$remote")"
  # Ask the remote what its default branch is; fall back to the local one.
  branch="$(git -C "$dir" ls-remote --symref origin HEAD 2>/dev/null \
            | sed -n 's#^ref: refs/heads/\([^\t ]*\).*#\1#p' | head -1)"
  if [ -z "$branch" ]; then
    branch="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  fi
  if [ -z "$branch" ] || [ "$branch" = "HEAD" ]; then
    note "skip $name (remote has no branches — empty repo?)"
    continue
  fi
  NAMES+=("$name"); REMOTES+=("$remote"); BRANCHES+=("$branch")
  note "$name  ($branch)"
done
[ "${#NAMES[@]}" -gt 0 ] || { echo "no git projects found in $LOCAL_CODE" >&2; exit 1; }

# ---------------------------------------------------------------------------
step "Cloning ${#NAMES[@]} repositories on the server"
# ---------------------------------------------------------------------------
if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "GITHUB_TOKEN is not set — private repositories will fail to clone." >&2
  echo "Export a token with repo read access and re-run." >&2
  exit 1
fi

clone_script="set -uo pipefail
mkdir -p $REMOTE_PROJECTS
cd $REMOTE_PROJECTS
export GIT_TERMINAL_PROMPT=0
FAILED=''"
for i in "${!NAMES[@]}"; do
  n="${NAMES[$i]}"; r="${REMOTES[$i]}"; b="${BRANCHES[$i]}"
  # Inject the token only into the URL used for cloning; strip it afterwards so
  # it is never persisted in .git/config on disk.
  auth_url="$(sed -E "s#^https://#https://x-access-token:\${GH_TOKEN}@#" <<<"$r")"
  clone_script+="
if [ -d '$n/.git' ]; then
  echo 'exists: $n'
else
  echo 'cloning: $n'
  # sudo strips the environment, so pass the token explicitly via env(1).
  if sudo -u coder env GH_TOKEN=\"\$GH_TOKEN\" GIT_TERMINAL_PROMPT=0 \\
       git clone --branch '$b' \"$auth_url\" '$n' 2>&1 | tail -2; then
    sudo -u coder git -C '$n' remote set-url origin '$r'
  else
    FAILED=\"\$FAILED $n\"
  fi
fi"
done
clone_script+="
chown -R coder:coder $REMOTE_PROJECTS
echo '--- cloned ---'
ls -1 $REMOTE_PROJECTS
[ -z \"\$FAILED\" ] || echo \"FAILED:\$FAILED\""

# GH_TOKEN is passed via the environment of the remote shell, not the log.
run_remote "clone repos" "GH_TOKEN='$GITHUB_TOKEN'
$clone_script" 3600

# ---------------------------------------------------------------------------
step "Rewriting and packaging session history"
# ---------------------------------------------------------------------------
STAGE="$ROOT/dist/sessions"
rm -rf "$STAGE" && mkdir -p "$STAGE"

python3 - "$LOCAL_SESSIONS" "$STAGE" "$LOCAL_CODE" "$REMOTE_PROJECTS" <<'PY'
import os, sys, json, shutil

local_sessions, stage, local_code, remote_projects = sys.argv[1:5]
local_code = local_code.rstrip('/')

def mangle(path):
    return path.replace('/', '-').replace('.', '-')

migrated = 0
projects = 0
for entry in sorted(os.listdir(local_sessions)):
    src_dir = os.path.join(local_sessions, entry)
    if not os.path.isdir(src_dir):
        continue
    # Only migrate histories that belong to a project under the code folder.
    prefix = mangle(local_code) + '-'
    if not entry.startswith(prefix):
        continue
    name = entry[len(prefix):]
    if not name:
        continue

    old_cwd = f'{local_code}/{name}'
    new_cwd = f'{remote_projects}/{name}'
    dest_dir = os.path.join(stage, mangle(new_cwd))

    # Skip macOS AppleDouble stubs; they are metadata, not transcripts.
    transcripts = [
        f for f in os.listdir(src_dir)
        if f.endswith('.jsonl') and not f.startswith('._')
    ]
    if not transcripts:
        continue
    os.makedirs(dest_dir, exist_ok=True)
    projects += 1

    for fname in transcripts:
        src = os.path.join(src_dir, fname)
        dst = os.path.join(dest_dir, fname)
        # Rewrite the recorded cwd (and any absolute path referencing the old
        # project root) so tool calls and file references resolve server-side.
        with open(src, 'r', encoding='utf-8', errors='replace') as fh_in, \
             open(dst, 'w', encoding='utf-8') as fh_out:
            for line in fh_in:
                fh_out.write(line.replace(old_cwd, new_cwd))
        migrated += 1

    # Carry over sidecar files (todo lists, shell snapshots) if present.
    for extra in os.listdir(src_dir):
        if extra.endswith('.jsonl'):
            continue
        s = os.path.join(src_dir, extra)
        d = os.path.join(dest_dir, extra)
        try:
            if os.path.isdir(s):
                shutil.copytree(s, d, dirs_exist_ok=True)
            else:
                shutil.copy2(s, d)
        except OSError:
            pass

print(f'staged {migrated} transcripts across {projects} projects')
PY

# COPYFILE_DISABLE stops macOS tar writing ._* AppleDouble stubs, which would
# otherwise show up on the server as phantom duplicate sessions.
COPYFILE_DISABLE=1 tar --exclude='._*' --exclude='.DS_Store' \
  -czf "$ROOT/dist/sessions.tar.gz" -C "$STAGE" .
SIZE=$(du -h "$ROOT/dist/sessions.tar.gz" | cut -f1)
note "archive: $SIZE"

# ---------------------------------------------------------------------------
step "Uploading session history via S3"
# ---------------------------------------------------------------------------
# Session archives far exceed SSM's inline parameter limit, so stage through
# the stack's own private transfer bucket (the instance role can read it).
BUCKET="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='TransferBucketName'].OutputValue" --output text \
  "${AWS_ARGS[@]}")"
[ -n "$BUCKET" ] && [ "$BUCKET" != "None" ] || {
  echo "TransferBucket output missing — deploy the stack first (./deploy.sh)." >&2
  exit 1
}
KEY="migration/sessions.tar.gz"

aws s3 cp "$ROOT/dist/sessions.tar.gz" "s3://$BUCKET/$KEY" \
  "${AWS_ARGS[@]}" --only-show-errors
note "s3://$BUCKET/$KEY"

run_remote "install sessions" "set -euo pipefail
mkdir -p $REMOTE_SESSIONS
cd /tmp
aws s3 cp 's3://$BUCKET/$KEY' sessions.tar.gz --region $REGION
# Merge into the existing history rather than replacing it.
tar -xzf sessions.tar.gz -C $REMOTE_SESSIONS
rm -f sessions.tar.gz
chown -R coder:coder /workspace/claude
echo '--- session dirs on server ---'
ls -1 $REMOTE_SESSIONS | head -40
echo '--- transcript count ---'
find $REMOTE_SESSIONS -name '*.jsonl' | wc -l" 1800

aws s3 rm "s3://$BUCKET/$KEY" "${AWS_ARGS[@]}" --only-show-errors || true

# ---------------------------------------------------------------------------
step "Restarting the chat service"
# ---------------------------------------------------------------------------
run_remote "restart" "systemctl restart claude-chat
sleep 3
systemctl is-active claude-chat" 300

printf '\n\033[1;32m✓ Migration complete — https://%s\033[0m\n\n' "$DOMAIN"
