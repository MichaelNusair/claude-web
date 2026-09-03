# Notes for AI agents

You are probably here because someone asked you to help them deploy, operate, or
modify claude-web. This file is the orientation you need. `CLAUDE.md` points here;
so does the README.

Read [docs/SECURITY.md](docs/SECURITY.md) before changing anything under
`chat-service/` or `infra/`. It explains why the code is shaped the way it is.

## What this project is, in one paragraph

A self-hosted web front end for Claude Code, running on one EC2 instance in the
user's own AWS account. The primary surface is a phone-friendly chat PWA; a full
VS Code (code-server) instance is available at `/editor/`. The chat is a thin UI
over the real `claude` CLI: one long-lived process per conversation, driven over
`--input-format stream-json`, which is what makes it behave like a messaging app
rather than a series of one-shot commands. Claude runs with
`--permission-mode bypassPermissions` by default, so it executes shell commands
without prompting.

## The one thing you must not get wrong

**This application executes shell commands on behalf of whoever is logged in. An
authentication gap is a remote code execution vulnerability, not a bug.**

That is not hypothetical here. This project previously shipped with `/api/*` and
`/ws` reachable from the internet with no credentials, because the nginx config
carried a comment describing an `auth_request` gate that had never been written,
and every document in the repo repeated the claim. The lesson encoded in the
current design:

- Authentication is enforced **in the application process**
  ([`chat-service/auth.js`](chat-service/auth.js)), never delegated to nginx, the
  ALB, or any other layer that a comment can lie about.
- New routes are **gated by default**. `isOpenPath()` is an allowlist. Do not
  turn it into a denylist.
- The server **refuses to start** without a strong password and session secret.
  Do not add a fallback, a default, or a development bypass that could reach
  production.
- [`chat-service/auth-test.js`](chat-service/auth-test.js) is the contract. It
  boots the real server and speaks real HTTP and WebSocket to it. `deploy.sh`
  runs it and refuses to deploy on failure.

If you are asked to "just disable auth for testing", use
`CW_INSECURE_COOKIES=1` on `localhost` — which only drops the `Secure` cookie
flag so cookies work over plain HTTP — and say plainly that removing the gate
itself is not something you will do on an internet-facing deployment.

### Before you finish any change to auth, routing, or the stack

```bash
npm run test:auth      # must be 36/36 or better; never fewer checks than before
npm run test:client
cd infra && npx cdk synth --quiet
```

If you add a route to `server.js`, add it to the `guarded` list in
`auth-test.js`. A route with no test is a route nobody is checking.

## Repository map

```
chat-service/            The chat backend + PWA client. The security boundary.
  auth.js                Password + OIDC verification, cookies, throttling.
  auth-test.js           End-to-end auth tests. Run these.
  server.js              HTTP routes, static files, WebSocket upgrade gate.
  session-manager.js     One `claude` process per conversation; transcripts.
  transcribe.js          Voice: local whisper.cpp, optional Azure override.
  smoke-test.js          Boots app.js in jsdom — catches load-time breakage.
  public/                index.html, app.js, style.css, login.html.

infra/                   AWS CDK (JavaScript, not TypeScript).
  config.js              Config loading + validation. Single source of truth.
  print-config.js        Emits shell assignments for deploy.sh / migrate.sh.
  lib/stack.js           The whole stack. No account-specific values.
  userdata/bootstrap.sh  Instance provisioning. Idempotent; re-run on deploy.

pwa/                     Assets copied into chat-service/public/ by deploy.sh.
                         THIS IS THE SOURCE OF TRUTH for manifest + sw.js.
voice-extension/         VS Code dictation extension (for the editor surface).
mobile-extension/        Strips VS Code chrome for phone use.
deploy.sh                The whole deploy. Read it before changing the pipeline.
migrate.sh               Brings local repos + Claude session history up.
```

## Common requests, and how to handle them

### "Help me deploy this"

```bash
cp claude-web.config.example.json claude-web.config.json
# set domainName and hostedZoneName
./deploy.sh
```

Before running it, confirm all four, because each has a distinct and confusing
failure mode:

1. **AWS credentials work** — `aws sts get-caller-identity`.
2. **They own a Route53 hosted zone** containing the domain, and it is the zone
   actually serving that domain publicly. Otherwise certificate validation hangs
   forever with no useful error.
3. **Bedrock model access is enabled** in the target region — otherwise the first
   message fails with `AccessDeniedException` long after the deploy "succeeded".
4. **They understand what `bypassPermissions` means.** Point them at
   docs/SECURITY.md. Do not skip this because it is awkward.

Then walk them through `allowedCidrs`. If they only use this from a couple of
known networks, narrowing it is the single highest-value hardening step and costs
nothing. Most people do not know the option exists.

### "It deployed but X is broken"

The Troubleshooting section of [docs/DEPLOY.md](docs/DEPLOY.md) covers the known
failure modes. Diagnose from the box rather than guessing:

```bash
aws ssm start-session --target <InstanceId>     # no SSH port exists
sudo journalctl -u claude-chat -n 100           # chat service
sudo tail -50 /var/log/bootstrap.log            # first boot
sudo tail -50 /var/log/reprovision.log          # redeploy provisioning
sudo nginx -t                                   # proxy config
systemctl is-active claude-chat code-server nginx
```

If `claude-chat` is dead, check the top of the journal first: the service aborts
deliberately when `AUTH_PASSWORD` or `SESSION_SECRET` is missing, and the error
message says so. That is correct behaviour, not a crash — find out why
`/etc/claude-auth.env` is empty.

### "Add a feature to the chat"

`server.js` routes → `session-manager.js` for anything touching the `claude`
process → `public/app.js` for UI. Client requests go through the `api()` wrapper
so a 401 redirects to login; use it rather than bare `fetch`.

### "Change the routing"

Read the comment block above the nginx config in `bootstrap.sh` first. The layout
is not arbitrary:

- The chat's assets are namespaced under `/chat/` and the catch-all `/` belongs to
  code-server, because code-server emits absolute asset URLs and has no supported
  nginx sub-path configuration.
- `index.html` references `/chat/app.js`, and `server.js` rewrites those exact
  strings for cache-busting. Change one, change both.
- `/editor/` strips its prefix and uses `proxy_redirect` so code-server's
  root-relative redirects do not bounce the user back to the chat.

### "Make it cheaper"

Stopping the instance when idle is the main lever; the ALB bills regardless. A
smaller `instanceType` works but `whisper.cpp` transcription gets slower. Do not
suggest removing the ALB — it terminates TLS, and the security model depends on
the instance being unreachable except through it.

## Gotchas that look like bugs

Things that have burned people, in this codebase specifically:

- **`pwa/manifest.webmanifest` and `chat-service/public/manifest.webmanifest` are
  two copies.** `deploy.sh` copies `pwa/` over `public/`, so `pwa/` wins. Edit
  that one. Same for `sw.js`.
- **The manifest link needs `crossorigin="use-credentials"`.** Manifests are
  fetched with credentials omitted by default, which means 401 and no install
  prompt now that static files are gated.
- **`userDataCausesReplacement: false` is deliberate.** The bootstrap script's S3
  asset hash is in userdata, so leaving it on replaced the instance on every
  script edit. `deploy.sh` re-runs `/opt/bootstrap.sh` on the live instance
  instead. This is why `bootstrap.sh` must stay idempotent.
- **The service worker deliberately unregisters itself.** It caches nothing. A
  stale cached shell breaks a live WebSocket client rather than helping, and a
  wedged worker has no user-side escape. Do not add caching.
- **Every `__PLACEHOLDER__` in `bootstrap.sh` needs a matching `sed -e` in
  `stack.js`.** A mismatch ships a literal `__FOO__` to the box. Check with:

  ```bash
  diff <(grep -oE '__[A-Z_]+__' infra/userdata/bootstrap.sh | sort -u) \
       <(grep -oE '__[A-Z_]+__' infra/lib/stack.js | sort -u)
  ```

- **Quoted heredocs in `bootstrap.sh` do not expand variables.** `<<'EOF'` is
  intentional in places that write scripts; those use `__PLACEHOLDER__` + `sed`.
  Adding a `$VAR` inside one silently writes a literal `$VAR`.
- **`session-manager.js` mangles the *resolved* path** for transcript lookup, so
  symlinks matter. This is why `migrate.sh` rewrites paths.
- **The CLI's flags are process arguments**, so model, permission mode and effort
  are fixed for the life of a conversation. Settings changes apply to new chats
  only. This is not a bug to fix.

## Things not to do

- Do not commit `claude-web.config.json` — it holds the user's domain, account
  profile and git identity. It is gitignored; keep it that way.
- Do not commit `infra/cdk.context.json` — CDK caches lookups there and the cache
  embeds the AWS account id.
- Do not put an account id, hosted zone id, certificate ARN or personal email
  into tracked files. That is exactly what was removed to make this publishable.
- Do not enable `instanceAdminAccess` on a user's behalf without explaining that
  it makes one leaked password into AWS account takeover.
- Do not weaken `auth.js` to make a test pass. Fix the test or the caller.
- Do not add a caching service worker.

## Verifying your work

There is no staging environment, so local verification is what you have:

```bash
npm test                                   # auth + client
cd infra && npx cdk synth --quiet          # stack compiles
bash -n deploy.sh migrate.sh infra/userdata/bootstrap.sh
node --check chat-service/server.js
```

`nginx -t` cannot run locally unless nginx is installed; `deploy.sh` runs it on
the instance and fails the deploy if the config is invalid.

Be honest about what you did and did not verify. "Synthesizes and passes the auth
tests, not deployed" is a useful, accurate statement. "Works" is not, unless you
watched it work.
