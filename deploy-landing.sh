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
step "Checking the page against the stack"
# ---------------------------------------------------------------------------
# Analytics needs the page, the CloudFront behaviours and the CSP to agree, and
# disagreement is invisible: the page still looks perfect and records nothing.
node landing/landing-test.js || { echo "landing tests failed — not deploying." >&2; exit 1; }

# ---------------------------------------------------------------------------
step "Staging the site"
# ---------------------------------------------------------------------------
# The upload comes from a staging copy rather than from landing/ directly,
# because one file is per-deployment: analytics.js is committed holding
# placeholders and is stamped here with this deployment's PostHog token. The
# working tree is never modified, so nothing account-specific can be committed by
# accident.
STAGE="$ROOT/dist/landing-site"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R landing/. "$STAGE/"
rm -f "$STAGE/landing-test.js"
node infra/landing-analytics.js "$STAGE/analytics.js" ||
  { echo "Could not write the analytics settings into the page." >&2; exit 1; }

# ---------------------------------------------------------------------------
step "Checking what is about to be uploaded"
# ---------------------------------------------------------------------------
# Cheap guards against the mistakes that actually happen: a referenced asset that
# was never created, a copy button whose visible text disagrees with what it
# copies (the clipboard fallback selects the visible node, so a mismatch hands the
# visitor a command that does not work), and a page that forgot to load the
# tracker — a page nobody can see the visits to looks exactly like a page nobody
# visited.
SITE="$STAGE" PH_KEY="$CFG_LANDING_PH_KEY" node - <<'CHECK'
import { readFileSync, existsSync, readdirSync } from 'fs';

const site = process.env.SITE;
const key = process.env.PH_KEY;
let failed = 0;
const fail = (msg) => { console.error(`  FAIL ${msg}`); failed = 1; };

const pages = readdirSync(site).filter((name) => name.endsWith('.html'));
if (!pages.includes('index.html')) fail('no index.html to serve');

for (const page of pages) {
  const html = readFileSync(`${site}/${page}`, 'utf8');

  for (const match of html.matchAll(/(?:href|src)="(\/[^"]*)"/g)) {
    const asset = match[1].split('?')[0];
    if (!existsSync(`${site}${asset}`)) fail(`${page} references ${asset}, which is not in the site`);
  }

  for (const match of html.matchAll(/data-copy="([^"]*)"[\s\S]*?<code>([\s\S]*?)<\/code>/g)) {
    const [, copied, shown] = match;
    if (copied.trim() !== shown.trim()) {
      fail(`${page}: copy button shows "${shown.trim()}" but copies "${copied.trim()}"`);
    }
  }

  if (!html.includes('src="/analytics.js"')) fail(`${page} does not load /analytics.js, so visits to it are invisible`);
  if (!/<title>.+<\/title>/.test(html)) fail(`${page} has no <title>`);
}

if (!/name="description"/.test(readFileSync(`${site}/index.html`, 'utf8'))) {
  fail('index.html has no meta description');
}

// The substitution is the step with no symptom of its own: an unstamped script
// loads, returns immediately, and reports nothing for as long as nobody checks.
const script = readFileSync(`${site}/analytics.js`, 'utf8');
if (key) {
  if (!script.includes(key)) fail('analytics.js does not carry the configured PostHog key');
  if (/__POSTHOG_[A-Z_]+__/.test(script)) fail('analytics.js still holds an unsubstituted placeholder');
} else if (!script.includes('__POSTHOG_PROJECT_TOKEN__')) {
  fail('no PostHog key is configured, yet analytics.js has been stamped with something');
}

process.exit(failed);
CHECK
echo "  site OK"

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
aws s3 sync "$STAGE/" "s3://$BUCKET/" \
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
  printf '\033[1;32m✓ Live at https://%s\033[0m\n' "$DOMAIN"

  # The analytics proxy is the one part of the page with no visible symptom: if
  # these behaviours are missing or misrouted the page loads perfectly and
  # records nothing. So fetch the tracker the way a visitor's browser will, from
  # the path CloudFront was configured with (print-config exports the same
  # constant the stack and the page were built from).
  if [ -n "$CFG_LANDING_PH_KEY" ]; then
    PH_URL="https://$DOMAIN$CFG_LANDING_PH_PATH/static/array.js"
    ph_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$PH_URL" || true)"
    if [ "$ph_code" = "200" ]; then
      printf '\033[1;32m✓ Analytics reaching PostHog through %s\033[0m\n\n' "$CFG_LANDING_PH_PATH"
    else
      printf '\033[1;33m! The page is live but %s returned %s, so it is\n' "$PH_URL" "$ph_code"
      printf '  loading no tracker and recording nothing. A new behaviour takes a\n'
      printf '  few minutes to reach every edge; if it persists, check the\n'
      printf '  additionalBehaviors in infra/lib/landing-stack.js.\033[0m\n\n'
    fi
  else
    printf '\n'
  fi
else
  printf '\033[1;33m! Returned %s. A new distribution takes ~15 minutes to\n' "$code"
  printf '  deploy, and a first-time certificate waits on DNS validation.\033[0m\n\n'
fi
