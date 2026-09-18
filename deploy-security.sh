#!/bin/bash
#
# Deploy the audit stack: a CloudTrail trail, and optionally a GuardDuty detector.
#
# Its own script for the same reason it is its own CDK stack — what it creates is
# account-wide, not part of the app. Nothing here touches the workspace instance,
# the load balancer or DNS, which is also why this one is safe to run from the
# workspace itself: unlike a full `deploy.sh`, there is no UserData change, so
# CloudFormation never stops the box the deploy is running on.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

eval "$(node infra/print-config.js)"

if [ "$CFG_SECURITY_ENABLED" != "true" ]; then
  cat >&2 <<'NOSEC'
Audit stack not enabled.

Add a "security" section to claude-web.config.json:

  "security": {
    "enabled": true,
    "cloudTrail": true,
    "guardDuty": false
  }

cloudTrail records every API call made in the account — including the ones made
with the workspace's instance role, which is the only way to find out after the
fact what a compromised workspace did.

guardDuty defaults to false because AWS permits exactly ONE detector per account
per region. If the account already has one, enabling this here fails the deploy
on that resource rather than adopting it. Check first:

  aws guardduty list-detectors

An empty list means you can turn it on.
NOSEC
  exit 1
fi

STACK="$CFG_SECURITY_STACK"
PROFILE="$CFG_PROFILE"
REGION="$CFG_REGION"

AWS_ARGS=(--region "$REGION")
[ -n "$PROFILE" ] && AWS_ARGS+=(--profile "$PROFILE")
CDK_ARGS=()
[ -n "$PROFILE" ] && CDK_ARGS+=(--profile "$PROFILE")

printf '\n\033[1mDeploying audit stack\033[0m %s in %s\n' "$STACK" "$REGION"
printf '  CloudTrail: %s   GuardDuty: %s\n' "$CFG_SECURITY_CLOUDTRAIL" "$CFG_SECURITY_GUARDDUTY"

# ---------------------------------------------------------------------------
step "Checking for resources that already exist"
# ---------------------------------------------------------------------------
# Both of these would otherwise surface as a mid-deploy CloudFormation error
# naming a logical id, which tells the operator nothing about what to do.
if [ "$CFG_SECURITY_GUARDDUTY" = "true" ]; then
  EXISTING="$(aws guardduty list-detectors \
    --query 'DetectorIds[0]' --output text "${AWS_ARGS[@]}" 2>/dev/null || echo None)"
  if [ "$EXISTING" != "None" ] && [ -n "$EXISTING" ]; then
    cat >&2 <<EOF

This account already has a GuardDuty detector in $REGION: $EXISTING

AWS allows only one, and CDK cannot adopt an existing one, so this deploy would
fail. Detection is already on — set "guardDuty": false in the security section of
claude-web.config.json and re-run. Nothing is lost by doing so.
EOF
    exit 1
  fi
  echo "  no existing detector"
fi

if [ "$CFG_SECURITY_CLOUDTRAIL" = "true" ]; then
  # Not fatal. A second trail is legal and works; it just bills twice for the
  # same events, and an account inside an AWS Organization usually has one
  # already, imposed from the management account.
  TRAILS="$(aws cloudtrail describe-trails \
    --query 'trailList[?IsMultiRegionTrail==`true`].Name' \
    --output text "${AWS_ARGS[@]}" 2>/dev/null || true)"
  if [ -n "$TRAILS" ]; then
    printf '\033[1;33m  ! Multi-region trail(s) already present: %s\033[0m\n' "$TRAILS"
    printf '    A second trail duplicates the events and the bill. If one of those\n'
    printf '    already covers this account, set "cloudTrail": false instead.\n'
  else
    echo "  no multi-region trail yet"
  fi
fi

# ---------------------------------------------------------------------------
step "Deploying"
# ---------------------------------------------------------------------------
(
  cd infra
  [ -d node_modules ] || npm install
  npx cdk deploy "$STACK" \
    "${CDK_ARGS[@]+"${CDK_ARGS[@]}"}" \
    --require-approval never \
    --outputs-file "$ROOT/dist/security-outputs.json"
) || { echo "CDK deploy failed." >&2; exit 1; }

# ---------------------------------------------------------------------------
step "Verifying"
# ---------------------------------------------------------------------------
# A trail can exist and be switched off, which looks identical in
# CloudFormation and records nothing at all. Ask the service, not the template.
if [ "$CFG_SECURITY_CLOUDTRAIL" = "true" ]; then
  NAME="$(aws cloudtrail describe-trails \
    --query "trailList[?starts_with(Name, \`$STACK\`)].Name | [0]" \
    --output text "${AWS_ARGS[@]}")"
  if [ -n "$NAME" ] && [ "$NAME" != "None" ]; then
    LOGGING="$(aws cloudtrail get-trail-status --name "$NAME" \
      --query 'IsLogging' --output text "${AWS_ARGS[@]}")"
    printf '  trail %s logging=%s\n' "$NAME" "$LOGGING"
    [ "$LOGGING" = "True" ] || { echo "Trail exists but is not logging." >&2; exit 1; }
  else
    echo "Could not find the deployed trail." >&2
    exit 1
  fi
fi

if [ "$CFG_SECURITY_GUARDDUTY" = "true" ]; then
  DETECTOR="$(aws guardduty list-detectors \
    --query 'DetectorIds[0]' --output text "${AWS_ARGS[@]}")"
  STATUS="$(aws guardduty get-detector --detector-id "$DETECTOR" \
    --query 'Status' --output text "${AWS_ARGS[@]}")"
  printf '  detector %s status=%s\n' "$DETECTOR" "$STATUS"
  [ "$STATUS" = "ENABLED" ] || { echo "Detector is not enabled." >&2; exit 1; }
fi

printf '\n\033[1;32m✓ Audit stack deployed\033[0m\n'
printf '  Findings and history:\n'
printf '    aws cloudtrail lookup-events --max-results 10 --region %s\n' "$REGION"
if [ "$CFG_SECURITY_GUARDDUTY" = "true" ]; then
  printf '    https://console.aws.amazon.com/guardduty/home?region=%s#/findings\n' "$REGION"
fi
printf '\n  Worth knowing: the trail bucket is RETAINed on stack deletion, on\n'
printf '  purpose. `cdk destroy` leaves the logs behind rather than deleting the\n'
printf '  evidence of whatever prompted the teardown.\n\n'
