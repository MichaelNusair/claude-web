#!/bin/bash
set -euxo pipefail
exec > >(tee /var/log/bootstrap.log) 2>&1

# cloud-init runs without HOME set; the code-server installer reads it under
# `set -u` and aborts. Export it before anything else runs.
export HOME="${HOME:-/root}"

APP_PORT="__APP_PORT__"
REGION="__REGION__"
PASSWORD_SECRET_ARN="__PASSWORD_SECRET_ARN__"
SESSION_SECRET_ARN="__SESSION_SECRET_ARN__"
WHISPER_SECRET_ARN="__WHISPER_SECRET_ARN__"
GITHUB_SECRET_ARN="__GITHUB_SECRET_ARN__"
DATA_VOLUME_ID="__DATA_VOLUME_ID__"
DOMAIN_NAME="__DOMAIN_NAME__"
VPC_CIDR="__VPC_CIDR__"
AUTH_MODE="__AUTH_MODE__"
OIDC_CLIENT_ID="__OIDC_CLIENT_ID__"
GIT_USER_NAME="__GIT_USER_NAME__"
GIT_USER_EMAIL="__GIT_USER_EMAIL__"
DEFAULT_MODEL="__DEFAULT_MODEL__"
# `bypassPermissions` lets Claude run commands without asking, which is the
# point of the product but also means anyone who gets past the login page has a
# shell. Configurable so a deployment can choose `acceptEdits` or `plan`.
PERMISSION_MODE="__PERMISSION_MODE__"
EFFORT_LEVEL="__EFFORT_LEVEL__"

USER_NAME="coder"
DATA_MNT="/workspace"

# ---------------------------------------------------------------------------
# Packages
# ---------------------------------------------------------------------------
# Split into required vs nice-to-have: a single unavailable optional package
# must not abort provisioning (this script runs under `set -e`).
# tmux is load-bearing, not a convenience: it is what makes a Claude session
# outlive the browser. code-server tears the extension host down within seconds
# of the last WebSocket closing (measured: 5s, mid-turn, work lost), and the
# extension's CLI dies with it. A session started under tmux is parented to
# systemd instead, so it survives closing the editor, a code-server restart, and
# a redeploy — and several devices can attach to the same live session at once.
dnf install -y git tar gzip unzip jq nginx gcc gcc-c++ make cmake python3 python3-pip \
  openssl shadow-utils nvme-cli xfsprogs tmux
# ripgrep is not in the AL2023 repos; Claude Code ships its own, so this is
# only a convenience for interactive shell use.
dnf install -y ripgrep || echo "ripgrep unavailable in repos; skipping"

# Node 22 (Claude Code CLI requires >= 18; 22 is current LTS)
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
dnf install -y nodejs

# ---------------------------------------------------------------------------
# User
# ---------------------------------------------------------------------------
id -u "$USER_NAME" &>/dev/null || useradd -m -s /bin/bash "$USER_NAME"

# ---------------------------------------------------------------------------
# Persistent data volume
# ---------------------------------------------------------------------------
TOKEN="$(curl -fsS -X PUT http://169.254.169.254/latest/api/token \
  -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')"
SELF_ID="$(curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/instance-id)"

# Attach the workspace volume to ourselves. Done here rather than with a
# CfnVolumeAttachment because CloudFormation creates the new attachment before
# removing the old one during an instance replacement, which always fails.
ATTACHED_TO="$(aws ec2 describe-volumes --volume-ids "$DATA_VOLUME_ID" --region "$REGION" \
  --query 'Volumes[0].Attachments[0].InstanceId' --output text 2>/dev/null || echo None)"

if [ "$ATTACHED_TO" != "$SELF_ID" ]; then
  if [ "$ATTACHED_TO" != "None" ] && [ -n "$ATTACHED_TO" ]; then
    # A replaced-but-not-yet-reaped predecessor still holds it.
    aws ec2 detach-volume --volume-id "$DATA_VOLUME_ID" --region "$REGION" || true
    aws ec2 wait volume-available --volume-ids "$DATA_VOLUME_ID" --region "$REGION" || true
  fi
  for _ in $(seq 1 30); do
    if aws ec2 attach-volume --volume-id "$DATA_VOLUME_ID" --instance-id "$SELF_ID" \
         --device /dev/sdf --region "$REGION"; then
      break
    fi
    sleep 10
  done
  aws ec2 wait volume-in-use --volume-ids "$DATA_VOLUME_ID" --region "$REGION" || true
fi

# On Nitro instances the requested /dev/sdf shows up as an NVMe device whose
# serial is the volume ID (minus the dash), so match on that rather than guess
# a device name.
SERIAL="$(echo "$DATA_VOLUME_ID" | tr -d '-')"
DEV=""
for _ in $(seq 1 60); do
  for candidate in /dev/nvme*n1; do
    [ -b "$candidate" ] || continue
    if nvme id-ctrl -H "$candidate" 2>/dev/null | grep -qi "$SERIAL" ||
       udevadm info --query=property --name="$candidate" 2>/dev/null | grep -qi "$SERIAL"; then
      DEV="$candidate"; break
    fi
  done
  # Non-Nitro / older virtualization keeps the literal name.
  [ -z "$DEV" ] && [ -b /dev/sdf ] && DEV=/dev/sdf
  [ -n "$DEV" ] && break
  sleep 5
done

if [ -z "$DEV" ]; then
  echo "FATAL: workspace volume $DATA_VOLUME_ID never appeared" >&2
  lsblk >&2
  exit 1
fi

# Refuse to touch the disk that carries the running root filesystem.
ROOT_SRC="$(findmnt -no SOURCE / || true)"
ROOT_DISK="$(lsblk -no PKNAME "$ROOT_SRC" 2>/dev/null || true)"
if [ -n "$ROOT_DISK" ] && [ "$DEV" = "/dev/$ROOT_DISK" ]; then
  echo "FATAL: resolved $DEV is the root disk; refusing to format" >&2
  exit 1
fi

# Format only if the volume is blank — this is what preserves data across
# instance replacement.
if ! blkid "$DEV"; then
  mkfs.xfs "$DEV"
fi

mkdir -p "$DATA_MNT"
UUID="$(blkid -s UUID -o value "$DEV")"
grep -q "$UUID" /etc/fstab || echo "UUID=$UUID $DATA_MNT xfs defaults,nofail 0 2" >> /etc/fstab
mount -a

# Projects and Claude Code session history both live on the persistent volume.
mkdir -p "$DATA_MNT/projects" "$DATA_MNT/claude" "$DATA_MNT/code-server-data" \
         "$DATA_MNT/code-server-ext"
chown -R "$USER_NAME:$USER_NAME" "$DATA_MNT"

# Symlink ~/.claude to the volume so `--resume` finds sessions after a rebuild.
sudo -u "$USER_NAME" bash -euxo pipefail <<VOLLINK
cd /home/$USER_NAME
[ -L .claude ] || { rm -rf .claude; ln -s "$DATA_MNT/claude" .claude; }
VOLLINK

# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------
# Disable tracing around the secret so it doesn't land in /var/log/bootstrap.log.
set +x
CS_PASSWORD="$(aws secretsmanager get-secret-value \
  --secret-id "$PASSWORD_SECRET_ARN" --region "$REGION" \
  --query SecretString --output text)"
SESSION_SECRET="$(aws secretsmanager get-secret-value \
  --secret-id "$SESSION_SECRET_ARN" --region "$REGION" \
  --query SecretString --output text)"

# The chat service reads its credentials from this file. It gates a process that
# runs shell commands, so an empty value here must stop the service rather than
# open it — server.js refuses to start without both, and this check makes the
# reason obvious in the bootstrap log instead of only in journalctl.
if [ -z "$CS_PASSWORD" ] || [ -z "$SESSION_SECRET" ]; then
  set -x
  echo "FATAL: login password or session secret is empty; refusing to configure the chat service." >&2
  exit 1
fi

install -d -m 0755 /etc
cat > /etc/claude-auth.env <<AUTHENV
AUTH_PASSWORD=$CS_PASSWORD
SESSION_SECRET=$SESSION_SECRET
CW_AUTH_MODE=$AUTH_MODE
CW_OIDC_EXPECTED_CLIENT_ID=$OIDC_CLIENT_ID
CW_REGION=$REGION
AUTHENV
# Readable only by the service account: anything else running on the box would
# otherwise be able to mint its own session cookie.
chmod 600 /etc/claude-auth.env
chown "$USER_NAME:$USER_NAME" /etc/claude-auth.env
set -x

# ---------------------------------------------------------------------------
# code-server
# ---------------------------------------------------------------------------
# Skip when already present: the installer's `rpm -U` exits non-zero if the same
# version is installed, which aborts an otherwise-idempotent re-provision.
if ! command -v code-server >/dev/null 2>&1; then
  curl -fsSL https://code-server.dev/install.sh | sh -s -- --version 4.131.0
else
  echo "code-server already installed: $(code-server --version | head -1)"
fi

# VS Code 1.131 bundles Copilot and shows its "Build with Agent" pane on
# startup, which competes with the Claude panel for the same space and wins the
# layout race. Remove both the pane's trigger and the extension so there is
# exactly one AI surface on screen.
VSCODE_DIR=/usr/lib/code-server/lib/vscode
if [ -f "$VSCODE_DIR/product.json" ]; then
  cp -n "$VSCODE_DIR/product.json" "$VSCODE_DIR/product.json.orig" || true
  python3 - "$VSCODE_DIR/product.json" <<'STRIPCHAT'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
removed = [k for k in ('defaultChatAgent', 'chatWelcomeView', 'gitHubEntitlement')
           if data.pop(k, None) is not None]
json.dump(data, open(path, 'w'), indent=2)
print(f"product.json: removed {removed or 'nothing'}")
STRIPCHAT
fi
if [ -d "$VSCODE_DIR/extensions/copilot" ]; then
  mv "$VSCODE_DIR/extensions/copilot" "$VSCODE_DIR/extensions/.copilot-disabled"
fi

install -d -o "$USER_NAME" -g "$USER_NAME" "/home/$USER_NAME/.config/code-server"
set +x   # the heredoc below interpolates the password
cat > "/home/$USER_NAME/.config/code-server/config.yaml" <<CSCONF
bind-addr: 127.0.0.1:9999
auth: password
password: $CS_PASSWORD
cert: false
disable-telemetry: true
disable-update-check: true
user-data-dir: $DATA_MNT/code-server-data
extensions-dir: $DATA_MNT/code-server-ext
CSCONF
chmod 600 "/home/$USER_NAME/.config/code-server/config.yaml"
chown "$USER_NAME:$USER_NAME" "/home/$USER_NAME/.config/code-server/config.yaml"
set -x

# ---------------------------------------------------------------------------
# GitHub auth
# ---------------------------------------------------------------------------
# A git credential helper that reads the PAT from Secrets Manager on demand.
# Preferred over ~/.git-credentials or a token baked into the remote URL: the
# secret is never written to disk, rotating it needs no redeploy, and anything
# running in the workspace can't read it out of a file.
cat > /usr/local/bin/git-credential-secretsmanager <<'HELPER'
#!/bin/bash
# git calls this with an operation argument; only `get` needs to do anything.
[ "$1" = "get" ] || exit 0
TOKEN="$(aws secretsmanager get-secret-value \
  --secret-id "$GITHUB_SECRET_ARN" --region "$AWS_REGION" \
  --query SecretString --output text 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)"
[ -n "$TOKEN" ] || exit 0
echo "username=x-access-token"
echo "password=$TOKEN"
HELPER
chmod 755 /usr/local/bin/git-credential-secretsmanager

# The helper runs as a subprocess of git, so it needs these in its environment.
cat > /etc/profile.d/00-github-env.sh <<GHENV
export GITHUB_SECRET_ARN="$GITHUB_SECRET_ARN"
export AWS_REGION="$REGION"
GHENV

sudo -u "$USER_NAME" git config --global credential.helper secretsmanager
sudo -u "$USER_NAME" git config --global credential.https://github.com.username x-access-token
# Long-lived clones and Claude's own git calls both benefit from these.
sudo -u "$USER_NAME" git config --global user.name "$GIT_USER_NAME"
sudo -u "$USER_NAME" git config --global user.email "$GIT_USER_EMAIL"
sudo -u "$USER_NAME" git config --global init.defaultBranch main
sudo -u "$USER_NAME" git config --global push.autoSetupRemote true

# gh CLI, so Claude can open PRs and read issues as it does locally.
if ! command -v gh >/dev/null 2>&1; then
  GH_VER=2.65.0
  curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VER}/gh_${GH_VER}_linux_arm64.tar.gz" \
    -o /tmp/gh.tar.gz &&
    tar -xzf /tmp/gh.tar.gz -C /tmp &&
    install -m 0755 "/tmp/gh_${GH_VER}_linux_arm64/bin/gh" /usr/local/bin/gh &&
    rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VER}_linux_arm64" ||
    echo "gh install failed; git still works via the credential helper"
fi

# gh reads GH_TOKEN from the environment; resolve it from the secret at login.
cat > /etc/profile.d/01-gh-token.sh <<'GHTOKEN'
_gh_token() {
  aws secretsmanager get-secret-value \
    --secret-id "$GITHUB_SECRET_ARN" --region "$AWS_REGION" \
    --query SecretString --output text 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null
}
if [ -n "${GITHUB_SECRET_ARN:-}" ] && [ -z "${GH_TOKEN:-}" ]; then
  GH_TOKEN="$(_gh_token)"
  [ -n "$GH_TOKEN" ] && export GH_TOKEN GITHUB_TOKEN="$GH_TOKEN"
fi
GHTOKEN

# ---------------------------------------------------------------------------
# Bedrock env for Claude Code (CLI + extension inherit this)
# ---------------------------------------------------------------------------
# Quoted heredoc: the placeholders are substituted by the sed below, not by this
# shell, so that a literal `$` never reaches the generated profile script.
cat > /etc/profile.d/claude-bedrock.sh <<'BEDROCKENV'
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION=__REGION__
export ANTHROPIC_MODEL=__DEFAULT_MODEL__
BEDROCKENV
sed -i -e "s|__REGION__|$REGION|" -e "s|__DEFAULT_MODEL__|$DEFAULT_MODEL|" \
  /etc/profile.d/claude-bedrock.sh

# ---------------------------------------------------------------------------
# Claude Code CLI + the official VS Code extension
# ---------------------------------------------------------------------------
npm install -g @anthropic-ai/claude-code

# The official extension is published on Open VSX, which is the marketplace
# code-server uses. Install the arm64 build to match this Graviton instance.
EXT_VSIX="/tmp/claude-code.vsix"
EXT_URL="$(curl -fsSL https://open-vsx.org/api/anthropic/claude-code/linux-arm64/latest |
  jq -r '.files.download')"
curl -fsSL "$EXT_URL" -o "$EXT_VSIX"
sudo -u "$USER_NAME" HOME="/home/$USER_NAME" \
  /usr/bin/code-server \
    --user-data-dir "$DATA_MNT/code-server-data" \
    --extensions-dir "$DATA_MNT/code-server-ext" \
    --install-extension "$EXT_VSIX"

# Voice dictation companion extension (built and shipped by deploy.sh).
if [ -f /opt/claude-web/claude-voice.vsix ]; then
  sudo -u "$USER_NAME" HOME="/home/$USER_NAME" \
    /usr/bin/code-server \
      --user-data-dir "$DATA_MNT/code-server-data" \
      --extensions-dir "$DATA_MNT/code-server-ext" \
      --install-extension /opt/claude-web/claude-voice.vsix
fi

# ---------------------------------------------------------------------------
# Local speech-to-text (whisper.cpp)
# ---------------------------------------------------------------------------
# Runs on-box: no API quota to request, no key, no per-request cost, and audio
# never leaves the instance. Measured here (2 vCPU arm64, base.en): ~4s for 11s
# of audio. Built from source because there is no arm64 package.
if [ ! -x /opt/whisper/whisper-cli ]; then
  (
    set -euxo pipefail
    rm -rf /opt/whisper-src && mkdir -p /opt/whisper-src
    git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git /opt/whisper-src
    cd /opt/whisper-src
    cmake -B build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF
    cmake --build build -j"$(nproc)" --target whisper-cli

    install -d /opt/whisper/models
    install -m 0755 build/bin/whisper-cli /opt/whisper/whisper-cli
    # The CLI links against the shared ggml libraries it just built.
    find build -name 'libggml*.so*' -o -name 'libwhisper*.so*' \
      | xargs -I{} cp -P {} /opt/whisper/
    sh ./models/download-ggml-model.sh base.en
    mv models/ggml-base.en.bin /opt/whisper/models/
    cd / && rm -rf /opt/whisper-src
  ) || echo "whisper build failed; voice will need Azure credentials"
fi

# whisper-cli finds its co-located shared libraries without LD_LIBRARY_PATH.
if [ -x /opt/whisper/whisper-cli ]; then
  echo '/opt/whisper' > /etc/ld.so.conf.d/whisper.conf
  ldconfig
fi

# Voice configuration, read at service start. Local whisper is used by default;
# Azure is used instead if the secret holds credentials.
cat > /etc/claude-voice.env <<VOICEENV
WHISPER_SECRET_ARN=$WHISPER_SECRET_ARN
AWS_REGION=$REGION
WHISPER_BIN=/opt/whisper/whisper-cli
WHISPER_MODEL=/opt/whisper/models/ggml-base.en.bin
VOICEENV

# ---------------------------------------------------------------------------
# Editor defaults + trust the projects dir (no "do you trust?" prompt on phone)
# ---------------------------------------------------------------------------
install -d -o "$USER_NAME" -g "$USER_NAME" "$DATA_MNT/code-server-data/User"
# Written here as well as by the mobile-shell extension, so the very first load
# is already configured — the extension only activates after the workbench is up.
# Merged into any existing file rather than overwritten, so preferences changed
# in the editor survive a reboot or an instance replacement.
cat > /tmp/mobile-defaults.json <<'SETTINGS'
{
  "security.workspace.trust.enabled": false,
  "workbench.startupEditor": "none",
  "workbench.colorTheme": "Default Dark Modern",
  "workbench.activityBar.location": "hidden",
  "workbench.statusBar.visible": false,
  "workbench.editor.showTabs": "none",
  "workbench.editor.editorActionsLocation": "hidden",
  "workbench.layoutControl.enabled": false,
  "workbench.tips.enabled": false,
  "breadcrumbs.enabled": false,
  "window.menuBarVisibility": "hidden",
  "terminal.integrated.fontSize": 13,
  "editor.fontSize": 15,
  "editor.lineHeight": 1.6,
  "editor.minimap.enabled": false,
  "editor.lineNumbers": "off",
  "editor.glyphMargin": false,
  "editor.folding": false,
  "chat.disableAIFeatures": true,
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "claudeCode.allowDangerouslySkipPermissions": true,
  "claudeCode.initialPermissionMode": "bypassPermissions",
  "claudeCode.hideOnboarding": true,
  "claudeCode.disableLoginPrompt": true,
  "claudeCode.autosave": true
}
SETTINGS

SETTINGS_FILE="$DATA_MNT/code-server-data/User/settings.json"
python3 - "$SETTINGS_FILE" /tmp/mobile-defaults.json <<'MERGE'
import json, sys, os
target, defaults_path = sys.argv[1], sys.argv[2]
defaults = json.load(open(defaults_path))
current = {}
if os.path.exists(target):
    try:
        current = json.load(open(target))
    except (ValueError, OSError):
        current = {}  # corrupt file: fall back to defaults rather than fail
# Existing values win, so anything changed in the editor is preserved.
merged = {**defaults, **current}
with open(target, 'w') as fh:
    json.dump(merged, fh, indent=2)
print(f"settings merged: {len(defaults)} defaults, {len(current)} existing")
MERGE
rm -f /tmp/mobile-defaults.json
chown -R "$USER_NAME:$USER_NAME" "$DATA_MNT/code-server-data/User"

# The CLI reads its own settings file (separate from VS Code settings). Set the
# same default there so terminal sessions and the chat service don't prompt
# either. Merged, so existing permission rules are kept.
python3 - "$DATA_MNT/claude/settings.json" "$PERMISSION_MODE" "$EFFORT_LEVEL" <<'CLAUDESETTINGS'
import json, os, sys
target, permission_mode, effort = sys.argv[1], sys.argv[2], sys.argv[3]
current = {}
if os.path.exists(target):
    try:
        current = json.load(open(target))
    except (ValueError, OSError):
        current = {}
perms = current.get('permissions') or {}
perms['defaultMode'] = permission_mode
current['permissions'] = perms
current.setdefault('effortLevel', effort)
os.makedirs(os.path.dirname(target), exist_ok=True)
with open(target, 'w') as fh:
    json.dump(current, fh, indent=2)
print(f'claude settings: defaultMode={permission_mode}')
CLAUDESETTINGS
chown -R "$USER_NAME:$USER_NAME" "$DATA_MNT/claude"

# ---------------------------------------------------------------------------
# nginx: chat at /, VS Code at /editor/
# ---------------------------------------------------------------------------
# Routing, and why it is shaped this way:
#
#   = /          the chat shell, so the bare domain opens the phone UI
#   /chat/       the chat's own static assets, prefix stripped by proxy_pass
#   /login /api/ /ws   the chat service's endpoints
#   /editor/     code-server's entry point, prefix stripped
#   /            catch-all to code-server, which serves its own absolute asset
#                URLs (/static/..., /stable-.../...) from here
#
# The chat's assets are namespaced under /chat/ rather than code-server being
# moved to a sub-path, because code-server has no supported nginx sub-path
# configuration — it emits absolute asset URLs and expects to own the root.
# Keeping the catch-all pointed at it means it still does, while the chat's
# assets live somewhere the catch-all can never swallow. An earlier version
# served the chat's index at /chat while its <script src="/app.js"> resolved to
# the catch-all, so the chat shell loaded and its code did not.
#
# SECURITY: none of these locations authenticates anything. The chat service
# authenticates every request itself (chat-service/auth.js) and code-server
# checks its own password. That is deliberate — the previous config claimed an
# `auth_request` gate here that was never written, and the chat API sat open to
# the internet as a result. Authentication belongs in the process whose data is
# at stake, not in a proxy comment.
mkdir -p /opt/claude-web

# Recover the real client address. The ALB appends the caller's IP to
# X-Forwarded-For, so without this every request appears to come from the load
# balancer and the login throttle in auth.js would lump all callers together.
cat > /etc/nginx/conf.d/00-realip.conf <<REALIP
set_real_ip_from $VPC_CIDR;
real_ip_header X-Forwarded-For;
real_ip_recursive on;

# Slow down password guessing at the edge, before it reaches Node. auth.js also
# locks out per IP; this is the cheap first layer, and it is scoped to the login
# route so a burst of chat traffic is never throttled.
limit_req_zone \$binary_remote_addr zone=login:10m rate=12r/m;
limit_req_status 429;
REALIP

cat > /etc/nginx/conf.d/claude-web.conf <<NGINXCONF
server {
    listen $APP_PORT default_server;
    server_name _;
    client_max_body_size 100M;

    # ALB health check — must not require a password.
    location = /healthz {
        access_log off;
        return 200 'ok';
        add_header Content-Type text/plain;
    }

    # Mobile CSS injected into the editor shell below.
    location = /mobile-overlay.js { root /opt/claude-web/pwa; add_header Cache-Control "no-cache"; }

    # --- Chat (primary interface) -------------------------------------------
    # The bare domain is the chat shell.
    location = / {
        proxy_pass http://127.0.0.1:9997/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
    }

    # Chat assets. The trailing slash on proxy_pass strips /chat/, so the chat
    # service sees /app.js while the browser asks for /chat/app.js.
    location /chat/ {
        proxy_pass http://127.0.0.1:9997/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
    }

    location /login {
        proxy_pass http://127.0.0.1:9997;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    # Rate-limited separately: this is the one unauthenticated endpoint that
    # checks a secret, so it is the only one worth guessing against.
    location = /api/login {
        limit_req zone=login burst=5 nodelay;
        proxy_pass http://127.0.0.1:9997;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:9997;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 3600s;
        proxy_request_buffering off;
        proxy_buffering off;
    }
    location /ws {
        proxy_pass http://127.0.0.1:9997;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_buffering off;
    }

    # --- VS Code with the real Claude extension -----------------------------
    # Entry point only. code-server thinks it lives at the root, so its own
    # Location headers point there; proxy_redirect keeps the browser inside
    # /editor/ instead of bouncing it back to the chat at /.
    location /editor/ {
        proxy_pass http://127.0.0.1:9999/;
        proxy_redirect / /editor/;
        proxy_set_header Accept-Encoding "";
        sub_filter '</head>' '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,maximum-scale=1,user-scalable=no"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><script src="/mobile-overlay.js" defer></script></head>';
        sub_filter_once on;
        sub_filter_types text/html;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }

    # Catch-all: code-server's absolute asset and WebSocket URLs.
    location / {
        proxy_pass http://127.0.0.1:9999/;
        # Inject mobile layout CSS and viewport meta into the workbench shell.
        # Only viewport/PWA meta plus the overlay script. Deliberately NO
        # stylesheet: CSS that touches `.part.*` desynchronises the workbench's
        # JS-computed absolute layout and renders as a blank gray screen.
        sub_filter '</head>' '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,maximum-scale=1,user-scalable=no"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><script src="/mobile-overlay.js" defer></script></head>';
        sub_filter_once on;
        sub_filter_types text/html;
        # sub_filter cannot rewrite compressed bytes.
        proxy_set_header Accept-Encoding "";
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host \$host;

        # code-server is WebSocket-driven; these are load-bearing.
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
NGINXCONF

# Drop the default server block so ours owns the port.
sed -i '/^\s*listen\s*80;/,$ s/^/#/' /etc/nginx/nginx.conf 2>/dev/null || true
cat > /etc/nginx/nginx.conf <<'MAINCONF'
user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log notice;
pid /run/nginx.pid;
events { worker_connections 1024; }
http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    sendfile on;
    keepalive_timeout 65;
    map $http_upgrade $connection_upgrade { default upgrade; '' close; }
    include /etc/nginx/conf.d/*.conf;
}
MAINCONF

# ---------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------
cat > /etc/systemd/system/code-server.service <<SVC
[Unit]
Description=code-server with Claude Code
After=network.target $DATA_MNT.mount
Requires=$DATA_MNT.mount

[Service]
Type=simple
User=$USER_NAME
Environment=HOME=/home/$USER_NAME
EnvironmentFile=/etc/claude-voice.env
Environment=CLAUDE_CODE_USE_BEDROCK=1
Environment=AWS_REGION=$REGION
Environment=ANTHROPIC_MODEL=$DEFAULT_MODEL
Environment=GITHUB_SECRET_ARN=$GITHUB_SECRET_ARN
WorkingDirectory=$DATA_MNT/projects
ExecStart=/usr/bin/code-server
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVC

cat > /etc/systemd/system/claude-chat.service <<SVC
[Unit]
Description=Claude chat (mobile UI + transcription)
After=network.target $DATA_MNT.mount
Requires=$DATA_MNT.mount

[Service]
Type=simple
User=$USER_NAME
EnvironmentFile=/etc/claude-voice.env
# Login password + cookie signing key. server.js aborts if either is missing, so
# a failure to read this file stops the service rather than opening it.
EnvironmentFile=/etc/claude-auth.env
Environment=HOME=/home/$USER_NAME
Environment=CODER_HOME=/home/$USER_NAME
Environment=PORT=9997
Environment=PROJECTS_ROOT=$DATA_MNT/projects
Environment=CLAUDE_HOME=$DATA_MNT/claude
Environment=CLAUDE_CODE_USE_BEDROCK=1
Environment=AWS_REGION=$REGION
Environment=ANTHROPIC_MODEL=$DEFAULT_MODEL
Environment=GITHUB_SECRET_ARN=$GITHUB_SECRET_ARN
WorkingDirectory=/opt/claude-web/chat-service
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVC

systemctl daemon-reload
systemctl enable --now code-server
if [ -f /opt/claude-web/chat-service/server.js ]; then
  (cd /opt/claude-web/chat-service && npm install --omit=dev)
  chown -R "$USER_NAME:$USER_NAME" /opt/claude-web/chat-service
  systemctl enable --now claude-chat
fi
systemctl enable --now nginx
nginx -t && systemctl reload nginx

echo "bootstrap complete for https://$DOMAIN_NAME"
