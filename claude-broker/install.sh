#!/usr/bin/env bash
#
# Installs the broker on the instance. Run as root by deploy.sh, from the payload
# at /opt/claude-web/claude-broker. Idempotent: it runs on every deploy.
#
# This lives here rather than in infra/userdata/bootstrap.sh because a
# bootstrap.sh edit cannot reach a running instance. cloud-init runs scripts-user
# once per instance ever — the semaphore in
# /var/lib/cloud/instances/<id>/sem/config_scripts_user — so /opt/bootstrap.sh
# stays at whatever first boot wrote, and a deploy re-runs that stale copy. Only
# a genuine instance replacement updates it, and a stack update usually stop/starts
# instead. Anything that must actually land goes in the payload.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
USER_NAME="coder"
SETTINGS="/workspace/code-server-data/User/settings.json"
WRAPPER="$HERE/wrapper.js"

install -m 0644 "$HERE/claude-broker.service" /etc/systemd/system/claude-broker.service
systemctl daemon-reload

# `enable --now`, never `restart`. Restarting this unit kills every live
# conversation, which is the failure it exists to prevent, and a deploy runs this
# script. So a change to broker.js takes effect at the next deliberate restart:
#
#   systemctl restart claude-broker    # ends every running conversation
#
# If the unit is already running, this is a no-op.
systemctl enable --now claude-broker

# Point the Claude Code extension at the wrapper instead of the real binary. Set
# rather than merged-as-a-default, because it is infrastructure rather than a
# preference: the panel is only shared between devices while this is in place.
#
# Rollback is `systemctl stop claude-broker` — no settings change, no deploy. The
# wrapper execs the real binary whenever the broker is unreachable, so the panel
# falls straight back to its old one-process-per-page behaviour.
python3 - "$SETTINGS" "$WRAPPER" <<'MERGE'
import json, os, sys

target, wrapper = sys.argv[1], sys.argv[2]
current = {}
if os.path.exists(target):
    try:
        current = json.load(open(target))
    except (ValueError, OSError):
        # Corrupt settings: better to write a working file than to fail a deploy.
        current = {}
if current.get('claudeCode.claudeProcessWrapper') == wrapper:
    print('claudeProcessWrapper already set')
    sys.exit(0)
current['claudeCode.claudeProcessWrapper'] = wrapper
os.makedirs(os.path.dirname(target), exist_ok=True)
with open(target, 'w') as fh:
    json.dump(current, fh, indent=2)
print(f'claudeProcessWrapper -> {wrapper}')
MERGE

chown "$USER_NAME:$USER_NAME" "$SETTINGS"

# A wrapper the extension cannot execute would leave the panel unable to start
# Claude at all, which is the one outcome worth failing a deploy over.
chmod 0755 "$WRAPPER"
test -x "$WRAPPER" || { echo "wrapper is not executable: $WRAPPER" >&2; exit 1; }

systemctl is-active --quiet claude-broker || {
  echo "claude-broker did not start:" >&2
  systemctl status claude-broker --no-pager --lines=20 >&2 || true
  exit 1
}
echo "claude-broker: $(systemctl is-active claude-broker)"
