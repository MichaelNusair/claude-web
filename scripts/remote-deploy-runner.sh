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
#   $1  the repository checkout to deploy from
#   $2… passed through to ./deploy.sh
#
# Deliberately no `set -e`: the exit code of the deploy is the product of this
# script, so a failing deploy must reach the two lines that record it.

LOG_DIR=/var/log
PID_FILE="$LOG_DIR/claude-web-deploy.pid"
STATUS_FILE="$LOG_DIR/claude-web-deploy.status"

echo $$ > "$PID_FILE"

repo="$1"
shift

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
