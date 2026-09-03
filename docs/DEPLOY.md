# Deploying

One EC2 instance, one load balancer, one persistent volume, in your own AWS
account. About 20 minutes end to end, most of it waiting for first boot.

> Read [SECURITY.md](SECURITY.md) first. This deploys a web page that runs shell
> commands on a machine you own. That is the point of it, and it is worth
> understanding before it is reachable from the internet.

## Prerequisites

| What | Why | Check |
| --- | --- | --- |
| An AWS account | Everything runs here | `aws sts get-caller-identity` |
| A Route53 hosted zone you control | DNS record + certificate validation | `aws route53 list-hosted-zones` |
| Bedrock model access enabled | Claude runs on Bedrock, not an API key | see below |
| Node 20+ | CDK and the chat service | `node --version` |
| Docker *not* required | | |

**A hosted zone is genuinely required.** The app is served over HTTPS, an ALB
needs a real certificate for that, and a certificate needs a domain you can prove
you own. A subdomain of something you already have is fine —
`claude.yourdomain.com`.

**Enable Bedrock model access** in the region you are deploying to, or the first
message will fail with `AccessDeniedException`:

1. Open the Bedrock console → *Model access*.
2. Request access to the Anthropic models you want. Claude models are usually
   granted immediately.
3. Confirm from the CLI:

   ```bash
   aws bedrock list-foundation-models --region us-east-1 \
     --query "modelSummaries[?contains(modelId,'claude')].modelId" --output text
   ```

## Deploy

```bash
git clone https://github.com/MichaelNusair/claude-web.git
cd claude-web

cp claude-web.config.example.json claude-web.config.json
$EDITOR claude-web.config.json     # set domainName and hostedZoneName

./deploy.sh
```

That is the whole flow. `deploy.sh` validates the config, runs the
authentication tests, packages the VS Code extensions, deploys the CDK stack,
waits for first boot, ships the application payload over SSM, then verifies that
the live URL requires a login. It prints the URL and password at the end.

It is safe to re-run. Application changes ship without replacing the instance, so
a redeploy takes a couple of minutes and keeps your projects and history.

### First boot takes a while

Ten to fifteen minutes. It installs code-server, Node, the Claude Code CLI and
extension, and compiles `whisper.cpp` from source (there is no arm64 package).
`deploy.sh` waits for all of it. To watch:

```bash
aws ssm start-session --target <InstanceId>
sudo tail -f /var/log/bootstrap.log
```

## Configuration

Only `domainName` and `hostedZoneName` are required. Everything else has a
working default — see
[`claude-web.config.example.json`](../claude-web.config.example.json) for the
annotated version and [`infra/config.js`](../infra/config.js) for the authoritative
defaults and validation.

| Key | Default | Notes |
| --- | --- | --- |
| `domainName` | — | **Required.** `claude.example.com` |
| `hostedZoneName` | — | **Required.** `example.com` — must contain `domainName` |
| `hostedZoneId` | looked up | Set it to skip a Route53 lookup at synth time |
| `certificateArn` | created | Empty creates a DNS-validated certificate |
| `region` | `us-east-1` | Must have Bedrock access enabled |
| `awsProfile` | default chain | Named CLI profile, if you use one |
| `authMode` | `password` | or `oidc` |
| `allowedCidrs` | `["0.0.0.0/0"]` | **Narrow this if you can.** See SECURITY.md |
| `instanceType` | `t4g.large` | 2 vCPU / 8 GiB, Graviton |
| `workspaceVolumeSize` | `100` | GiB, retained on stack deletion |
| `instanceAdminAccess` | `false` | Read SECURITY.md before enabling |
| `defaultModel` | `us.anthropic.claude-opus-5` | Overridable per chat |
| `permissionMode` | `bypassPermissions` | The main risk/UX tradeoff |
| `gitUserName` / `gitUserEmail` | placeholder | Author on Claude's commits |

Any key can also be set through the environment — useful in CI, where a config
file is awkward:

```bash
CLAUDE_WEB_DOMAIN=claude.example.com \
CLAUDE_WEB_HOSTED_ZONE=example.com \
./deploy.sh
```

Print what the deployment will actually use:

```bash
npm run config
```

## After the first deploy

### Add your GitHub token

Without it Claude can read repositories you clone by hand but cannot push, open
PRs, or clone anything private. The ARN is in the stack outputs.

```bash
aws secretsmanager put-secret-value \
  --secret-id <GithubSecretArn> \
  --secret-string '{"token":"github_pat_..."}' \
  --region us-east-1
```

A fine-grained token scoped to the repositories you actually want is a much
better idea than a classic `repo`-scoped one — it is a credential living on an
internet-facing box.

No redeploy needed; a credential helper reads it per git invocation.

### Add a project

From the app: **New chat → Add a project**, which creates the directory, an empty
git repository, and optionally a GitHub remote.

By hand:

```bash
aws ssm start-session --target <InstanceId>
sudo -u coder git -C /workspace/projects clone https://github.com/you/repo.git
```

### Bring over local projects and history

```bash
GITHUB_TOKEN="$(gh auth token)" ./migrate.sh
```

Clones every git repository under `~/Documents/code` onto the workspace volume,
then copies your local Claude Code session history up so past conversations are
resumable from your phone. Override the source with `LOCAL_CODE=...`.

The non-obvious part it handles for you: Claude Code keys transcripts by a
mangled **absolute** path and records that path inside each transcript, so
migrating means rewriting both — `-Users-you-Documents-code-X` →
`-workspace-projects-X`, and every embedded `/Users/you/Documents/code/X` →
`/workspace/projects/X`. Skip either and the history is copied but never found.

## Optional: OIDC instead of a password

Moves authentication to the load balancer, so no unauthenticated request reaches
the instance, and you get real identities and MFA instead of one shared secret.

1. Create an OAuth app with your provider. Set the redirect URI to
   `https://<domainName>/oauth2/idpresponse`.
2. Put the client secret in Secrets Manager:

   ```bash
   aws secretsmanager create-secret --name claude-web-oidc \
     --secret-string '<client-secret>' --region us-east-1
   ```

3. Configure it, using the full ARN including the random suffix:

   ```json
   {
     "authMode": "oidc",
     "oidc": {
       "issuer": "https://accounts.google.com",
       "authorizationEndpoint": "https://accounts.google.com/o/oauth2/v2/auth",
       "tokenEndpoint": "https://oauth2.googleapis.com/token",
       "userInfoEndpoint": "https://openidconnect.googleapis.com/v1/userinfo",
       "clientId": "....apps.googleusercontent.com",
       "clientSecretArn": "arn:aws:secretsmanager:us-east-1:123456789012:secret:claude-web-oidc-AbCdEf"
     }
   }
   ```

4. `./deploy.sh`

Note that the ALB authenticates *anyone* your provider will authenticate. With
Google that is every Google account in existence unless you restrict it — use a
Cognito user pool, or a Google Workspace-restricted client, if that matters.

## Optional: the landing page

The repository includes a static marketing site in [`landing/`](../landing/) — the
page at <https://claude.strikelabs.tech>. You almost certainly don't need this if
you are self-hosting for yourself, but it's here and deployable.

It is a deliberately separate stack: its own hostname, a private S3 bucket behind
CloudFront, and no shared resources with the workspace. The public thing has no
route to the private thing, and deploying either cannot disturb the other.

```json
{
  "landing": {
    "domainName": "claude.example.com",
    "certificateArn": ""
  }
}
```

```bash
./deploy-landing.sh
```

Three things worth knowing:

- **It must be a different hostname from `domainName`.** One DNS record cannot
  point at both CloudFront and a load balancer, and the config refuses the
  overlap rather than letting CloudFormation discover it.
- **The certificate must be in us-east-1**, the only region CloudFront reads them
  from, whatever region the rest of your deployment uses. Leave `certificateArn`
  empty and one is created there; a wildcard already in us-east-1 can be reused.
- **A new CloudFront distribution takes ~15 minutes** to reach every edge, and a
  first-time certificate waits on DNS validation before that. The script polls,
  then tells you if it is still settling rather than failing.

### If you are moving a hostname between the two

Say the workspace currently owns `claude.example.com` and you want the landing
page there instead. **Move the workspace off it first.** Both stacks manage a
Route53 record, and if you create the landing record while the workspace stack
still owns that name, they will fight over it.

```bash
# 1. Give the workspace a new hostname in claude-web.config.json, then:
./deploy.sh              # deletes the old record, creates the new one

# 2. Only now point the landing site at the freed hostname:
./deploy-landing.sh
```

Your projects, session history and volume are unaffected by a hostname change —
nothing is keyed by domain. Two things do change: **an installed PWA points at
the old URL** and must be removed from your home screen and re-added at the new
one, and any bookmark needs updating.

## Optional: voice dictation

Works out of the box with no API key: `whisper.cpp` with `base.en` runs on the
instance and audio never leaves it. Roughly 4 seconds for 11 seconds of speech on
2 vCPUs.

`base.en` is English-only. For other languages, swap `WHISPER_MODEL` to a
multilingual build (`ggml-base.bin`) in `/etc/claude-voice.env`.

To use Azure OpenAI Whisper instead — it falls back to local if Azure errors:

```bash
aws secretsmanager put-secret-value \
  --secret-id <WhisperSecretArn> \
  --secret-string '{"endpoint":"https://YOUR.openai.azure.com","apiKey":"KEY","deployment":"YOUR_DEPLOYMENT"}' \
  --region us-east-1
```

`deployment` is the **deployment name** you chose in Azure, not the model id — a
resource with no deployment returns `DeploymentNotFound` no matter how valid the
key is. `GET /api/voice-status?refresh=1` reports the active backend and re-reads
the secret without a restart.

## Operating it

```bash
# Shell in (no SSH port is open)
aws ssm start-session --target <InstanceId>

# Logs
sudo journalctl -u claude-chat -f
sudo journalctl -u code-server -f
sudo tail -f /var/log/bootstrap.log      # first boot
sudo tail -f /var/log/reprovision.log    # re-provisioning during a redeploy

# Who has been logging in
sudo journalctl -u claude-chat | grep -E 'login|failed login'

# Restart
sudo systemctl restart claude-chat
```

### Stop it when idle

```bash
aws ec2 stop-instances --instance-ids <InstanceId>
aws ec2 start-instances --instance-ids <InstanceId>
```

The workspace volume is retained, so projects and history survive. A stopped
instance costs only storage — and has no attack surface.

## Cost

Roughly **$75/month** left running continuously:

| | |
| --- | --- |
| `t4g.large` | ~$49 |
| ALB | ~$16 |
| 100 GiB gp3 workspace | ~$8 |
| 40 GiB gp3 root | ~$3 |

Plus Bedrock token usage, which is billed per request and is usually the part you
actually notice. Stopping the instance when idle removes the compute portion; the
ALB bills whether or not the instance is running.

## Tearing it down

```bash
cd infra && npx cdk destroy
```

The workspace volume, the session secret, and the GitHub and Whisper secrets are
**retained on purpose**, so a teardown does not destroy your work. Delete them by
hand once you are sure:

```bash
aws ec2 delete-volume --volume-id <id>
aws secretsmanager delete-secret --secret-id <arn> --force-delete-without-recovery
```

## Troubleshooting

**`domainName is required`** — no `claude-web.config.json`. Copy the example.

**`domainName "x" is not inside hostedZoneName "y"`** — the hostname must be
within the zone. `claude.example.com` needs zone `example.com`.

**Certificate validation hangs** — ACM is waiting for a DNS record in your zone.
It only works if the zone is the one actually serving your domain on the public
internet; check that your registrar's nameservers point at this Route53 zone.

**`AccessDeniedException` on the first message** — Bedrock model access is not
enabled in this region. See Prerequisites.

**`/healthz` returns 503** — targets are unhealthy, usually because first boot is
still running. `sudo tail -f /var/log/bootstrap.log`.

**Editor at `/editor/` misbehaves** — code-server has no officially supported
nginx sub-path configuration, so this path is the least battle-tested part of the
routing. It is served by stripping the `/editor/` prefix while code-server's own
absolute asset URLs are served from the catch-all. If it breaks, the chat is
unaffected; open an issue with what you see.

**Chat loads but stays on "Loading…"** — `app.js` failed to parse or fetch. Open
the browser console, and check `sudo journalctl -u claude-chat` for the client
error the app reports back.

**Stuck on "reconnecting…"** — the session expired but the socket close looks
identical to a dropped network. The client probes `/api/auth-check` and redirects
to `/login`; if it does not, hard-reload.

**Deploy aborts with "THIS ENDPOINT IS OPEN"** — the deployed app served the chat
API without a login. Do not ignore this. Stop the instance, then open an issue —
that is the exact bug this project was built to never ship again.
