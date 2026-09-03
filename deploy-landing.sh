#!/bin/bash
#
# Deploy the marketing site: CDK for the infrastructure, `aws s3 sync` for the
# content, then a CloudFront invalidation.
#
# Separate from deploy.sh on purpose. This touches nothing the workspace depends
# on, and the workspace deploy touches nothing here — so shipping a copy tweak
# can never disturb a running instance, and vice versa.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

eval "$(node infra/print-config.js)"

if [ -z "$CFG_LANDING_DOMAIN" ]; then
  cat >&2 <<'NOLANDING'
No landing site configured.

Add a "landing" section to claude-web.config.json:

  "landing": {
    "domainName": "claude.example.com"
  }

It must be a different hostname from the workspace — one DNS record cannot point
at both CloudFront and the load balancer.
NOLANDING
  exit 1
fi

DOMAIN="$CFG_LANDING_DOMAIN"
STACK="$CFG_LANDING_STACK"
PROFILE="$CFG_PROFILE"

# CloudFront and its certificate are always in us-east-1, whatever region the
# workspace uses, so every call here is pinned there.
AWS_ARGS=(--region us-east-1)
[ -n "$PROFILE" ] && AWS_ARGS+=(--profile "$PROFILE")
CDK_ARGS=()
[ -n "$PROFILE" ] && CDK_ARGS+=(--profile "$PROFILE")

printf '\n\033[1mDeploying landing site\033[0m %s\n' "https://$DOMAIN"

# ---------------------------------------------------------------------------
step "Checking the page is well-formed"
# ---------------------------------------------------------------------------
# Cheap guards against the two mistakes that actually happen: a referenced asset
# that was never created, and a copy button whose visible text disagrees with
# what it copies (the clipboard fallback selects the visible node, so a mismatch
# hands the visitor a command that does not work).
node - <<'CHECK'
import { readFileSync, existsSync } from 'fs';

const html = readFileSync('landing/index.html', 'utf8');
let failed = 0;
const fail = (msg) => { console.error(`  FAIL ${msg}`); failed = 1; };

for (const match of html.matchAll(/(?:href|src)="(\/[^"]*)"/g)) {
  const asset = match[1].split('?')[0];
  if (!existsSync(`landing${asset}`)) fail(`references ${asset}, which does not exist in landing/`);
}

for (const match of html.matchAll(/data-copy="([^"]*)"[\s\S]*?<code>([\s\S]*?)<\/code>/g)) {
  const [, copied, shown] = match;
  if (copied.trim() !== shown.trim()) {
    fail(`copy button shows "${shown.trim()}" but copies "${copied.trim()}"`);
  }
}

if (!/<title>.+<\/title>/.test(html)) fail('no <title>');
if (!/name="description"/.test(html)) fail('no meta description');

process.exit(failed);
CHECK
echo "  page OK"

# ---------------------------------------------------------------------------
step "Deploying infrastructure"
# ---------------------------------------------------------------------------
(
  cd infra
  [ -d node_modules ] || npm install
  npx cdk deploy "$STACK" \
    "${CDK_ARGS[@]+"${CDK_ARGS[@]}"}" \
    --require-approval never \
    --outputs-file "$ROOT/dist/landing-outputs.json"
) || { echo "CDK deploy failed." >&2; exit 1; }

[ -s "$ROOT/dist/landing-outputs.json" ] || { echo "No stack outputs written." >&2; exit 1; }

read_output() {
  python3 -c "
import json
print(json.load(open('$ROOT/dist/landing-outputs.json'))['$STACK'].get('$1',''))"
}

BUCKET="$(read_output SiteBucketName)"
DIST_ID="$(read_output DistributionId)"
[ -n "$BUCKET" ] && [ -n "$DIST_ID" ] || { echo "Missing bucket or distribution in outputs." >&2; exit 1; }

# ---------------------------------------------------------------------------
step "Uploading content"
# ---------------------------------------------------------------------------
# HTML is revalidated on every request so a copy fix goes live at once; the
# fingerprint-free CSS/JS get a short TTL for the same reason. This site is tiny
# and traffic-light, so correctness beats cache efficiency here.
aws s3 sync landing/ "s3://$BUCKET/" \
  --delete \
  --exclude '.DS_Store' \
  --cache-control 'public, max-age=300, must-revalidate' \
  "${AWS_ARGS[@]}" --only-show-errors

# Content types S3 guesses wrong or not at all.
aws s3 cp "s3://$BUCKET/favicon.svg" "s3://$BUCKET/favicon.svg" \
  --content-type 'image/svg+xml' \
  --cache-control 'public, max-age=86400' \
  --metadata-directive REPLACE "${AWS_ARGS[@]}" --only-show-errors

# ---------------------------------------------------------------------------
step "Invalidating the CloudFront cache"
# ---------------------------------------------------------------------------
INVALIDATION="$(aws cloudfront create-invalidation \
  --distribution-id "$DIST_ID" --paths '/*' \
  --query 'Invalidation.Id' --output text "${AWS_ARGS[@]}")"
echo "  invalidation $INVALIDATION"

# ---------------------------------------------------------------------------
step "Verifying https://$DOMAIN"
# ---------------------------------------------------------------------------
code=none
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$DOMAIN/" || true)"
  [ "$code" = "200" ] && break
  sleep 10
done

printf '\n'
if [ "$code" = "200" ]; then
  printf '\033[1;32m✓ Live at https://%s\033[0m\n\n' "$DOMAIN"
else
  printf '\033[1;33m! Returned %s. A new distribution takes ~15 minutes to\n' "$code"
  printf '  deploy, and a first-time certificate waits on DNS validation.\033[0m\n\n'
fi
