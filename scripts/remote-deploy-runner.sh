#!/bin/bash
# The deploy, running on the deploy box with nothing attached to it.
#
# deploy-remote.sh starts this over SSM, detached, and then only reads its log. It
# is a file in the repository rather than a heredoc inside an SSM command for two
# reasons: a heredoc nested inside the JSON that SSM takes is the shape that breaks
# quoting (see the payload block in deploy.sh), and this way what runs on the box is
# something you can read in a diff.
#
# Nothing here is allowed to be clever. Its whole job is to record the exit code of
# ./deploy.sh somewhere a poller can find it, because the poller cannot see the
# process — that is the point of detaching it.
#
#   $1  where to write the exit code, when there is one
#   $2  where to write this process's pid
#   $3  the repository checkout to deploy from
#   $4… passed through to ./deploy.sh
#
# The two paths are arguments rather than constants because one deploy box can
# serve several deployments, and two runs sharing one status file would report each
# other's exit code. deploy-remote.sh derives them from the stack name and creates
# them before starting this, so the names on both ends always agree.
#
# Deliberately no `set -e`: the exit code of the deploy is the product of this
# script, so a failing deploy must reach the two lines that record it.

STATUS_FILE="$1"
PID_FILE="$2"
repo="$3"
shift 3

if [ -z "$STATUS_FILE" ] || [ -z "$PID_FILE" ] || [ -z "$repo" ]; then
  echo "remote-deploy-runner: usage: $0 <status-file> <pid-file> <repo> [deploy args…]" >&2
  exit 2
fi

echo $$ > "$PID_FILE"

if ! cd "$repo"; then
  echo "remote-deploy-runner: cannot enter $repo" >&2
  echo 127 > "$STATUS_FILE"
  exit 127
fi

printf 'Deploying %s at %s\n' "$(git rev-parse --short HEAD 2>/dev/null)" "$(date -Is)"
printf 'Arguments: %s\n\n' "${*:-none}"

./deploy.sh "$@"
code=$?

# The status file is what tells the poller to stop waiting, so it is written last
# and it is written whatever happened.
echo "$code" > "$STATUS_FILE"
printf '\nDeploy finished with exit code %s at %s\n' "$code" "$(date -Is)"
exit "$code"
