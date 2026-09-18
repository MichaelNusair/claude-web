# Security

Read this before you expose a deployment to the internet.

## What this software actually is

A web page that runs shell commands on a server you own, as a user that can
read and write every repository on it.

That is the product, not a side effect. Claude Code is given a working directory
and permission to act, and the whole point is that you can send it a message
from your phone and it edits code, runs tests and pushes commits without asking
permission for each step. Every security property below follows from that one
fact: **anyone who can reach the chat and pass its login has a shell on the
box.** There is no meaningful sandbox between "authenticated user of this app"
and "arbitrary code execution".

Deploy it accordingly. It is a personal workspace, not a multi-tenant service.

## The threat model

What the design defends against:

- The internet at large finding the URL and using it.
- A stolen session cookie being replayed after the password is rotated.
- Online password guessing.
- A forged session cookie.
- Credentials appearing in logs, git history, or the browser.

What it explicitly does **not** defend against:

- A person who legitimately logs in. They have a shell. There are no per-user
  permissions, no audit trail of who did what, and no way to give someone
  read-only access. Do not share the password with anyone you would not give
  SSH access to.
- Prompt injection reaching the shell. If Claude reads a hostile file, issue, or
  web page while running in `bypassPermissions`, the instructions it finds there
  execute with the same privileges you have. This is the sharpest edge in the
  product and it has no clean mitigation — see *Reducing the blast radius*.
- A malicious dependency in a repo on the workspace.

## How authentication works

Enforced in the application process, in
[`chat-service/auth.js`](../chat-service/auth.js), not in the reverse proxy.

This placement is deliberate and comes from a real failure. An earlier version
of this project delegated the decision to nginx, and the nginx config carried a
comment claiming an `auth_request` gate that had never been written. The result:
`/api/*` and `/ws` were reachable from the internet with no credentials at all,
on a box running `--permission-mode bypassPermissions`, while the README stated
that the only unauthenticated path was `/healthz`. Every layer agreed it was
secure except the one actually serving traffic.

So: the process that spawns `claude` is the process that checks the credential.
A proxy misconfiguration can now break the app, but it cannot open it.

Two modes, set by `authMode` in `claude-web.config.json`.

### `password` (default)

- A 32-character password is generated into Secrets Manager at deploy time and
  never written to the repository.
- `POST /api/login` verifies it with a constant-time digest comparison and
  returns an HMAC-signed session cookie: `HttpOnly`, `Secure`, `SameSite=Lax`,
  30-day expiry.
- The cookie's signing key is derived from the session secret **and** a hash of
  the current password, so rotating the password immediately invalidates every
  outstanding session. Without that, a leaked password stays useful for as long
  as the attacker's cookie lives.
- Failed attempts are throttled per client IP with exponential backoff (up to 15
  minutes), and nginx separately rate-limits `/api/login` to 12 requests/minute.
- The server **refuses to start** if the password or session secret is missing or
  under 16 characters. A misconfigured deployment is a dead one, never an open
  one.

### `oidc`

Authentication moves to the load balancer, so no unauthenticated request reaches
the instance at all. The app still verifies the `x-amzn-oidc-data` JWT's ES256
signature against the ALB's published key, because "the load balancer checked
it" is only true if the header actually came from the load balancer — and *only
the ALB can reach the instance* is a security group rule, one console click from
being false.

Requires an OAuth app with your provider. See [DEPLOY.md](DEPLOY.md).

## What is gated

Everything except an explicit allowlist. `isOpenPath()` in `auth.js` lists the
only paths served without a session:

| Path | Why it is open |
| --- | --- |
| `/healthz` | ALB health check. Returns a constant; touches nothing. |
| `/login`, `/login.html` | The login page itself. Self-contained, inline CSS. |
| `/api/login` | Verifies the password. Rate-limited. |
| `/api/auth-mode` | Says whether to show a password form. Reveals no secret. |

The allowlist direction matters: a new route added to `server.js` is gated
unless someone deliberately opens it. The reverse — a denylist — is how the
original bug happened.

The editor at `/editor/` is gated separately by code-server's own password,
which is the same value. Two independent doors, each enforced by the process
behind it, so neither depends on the proxy being right.

### Verified, not asserted

[`chat-service/auth-test.js`](../chat-service/auth-test.js) boots the real server
and asserts that every API route, every static asset and the WebSocket upgrade
refuse an unauthenticated caller; that forged, tampered and expired cookies are
rejected; and that the server dies rather than starting without credentials.

`deploy.sh` runs it *before* deploying and refuses to proceed if it fails, then
curls the live URL afterwards and aborts if the deployed app answers
`/api/projects` without a login. The claim in this document is checked by
machine on every deploy, because the last time it was only checked by a comment
it was wrong for months.

Run it yourself:

```bash
npm run test:auth
```

## Infrastructure

- **No SSH ingress.** Shell access is via SSM Session Manager: no open port, and
  IAM-controlled and audited.
- **TLS terminates at the ALB**, with a DNS-validated ACM certificate created by
  the stack. Port 80 permanently redirects to 443.
- **The instance is not publicly reachable.** Its security group accepts traffic
  only from the load balancer's security group, on one port.
- **Least-privilege instance role by default.** `instanceAdminAccess` is `false`,
  granting only Bedrock model invocation, read on its own four secrets, and
  attach/describe on its own volume. See below before turning it on.
- **Secrets live in Secrets Manager**, read at request time by the service
  account. `/etc/claude-auth.env` is mode `600` and owned by `coder`.
- **The GitHub token is never written to disk.** A git credential helper fetches
  it from Secrets Manager per invocation, so rotating it needs no redeploy and
  nothing on the box can read it out of a file.
- **Bootstrap logging disables shell tracing around secrets** so they do not land
  in `/var/log/bootstrap.log`.

## Reducing the blast radius

In rough order of value for effort:

1. **Restrict `allowedCidrs`.** The single highest-value change available. If you
   only ever use this from home, an office, or a VPN, setting
   `["203.0.113.4/32"]` removes the login page from public reach entirely.
   Nothing can guess a password it cannot connect to.
2. **Leave `instanceAdminAccess: false`.** With it on, anything that executes in
   the workspace reaches your whole AWS account through instance metadata — and
   Claude executes things. That turns one leaked password, or one successful
   prompt injection, into account takeover. Turn it on only if you specifically
   want the workspace to deploy AWS infrastructure, and then use a dedicated
   account with nothing else in it.
3. **Use a dedicated AWS account.** Cheap, and it bounds everything above.
4. **Consider `permissionMode: "acceptEdits"`.** Claude still edits files freely
   but asks before running commands. It costs you the hands-off experience and
   buys a checkpoint in front of the dangerous half.
5. **Use `authMode: "oidc"`** if you want real identities and MFA rather than one
   shared password.
6. **Stop the instance when you are not using it.** The workspace volume is
   retained, so nothing is lost, and a stopped instance has no attack surface.
7. **Give the GitHub token the narrowest scope that works.** It can push to
   whatever you grant it. A fine-grained token limited to specific repositories
   beats a classic `repo`-scoped one.

## Rotating credentials

Rotate the login password (this signs every device out, because the cookie
signing key is derived from it):

```bash
aws secretsmanager put-secret-value --secret-id <PasswordSecretArn> \
  --secret-string "$(openssl rand -base64 24)" --region us-east-1
./deploy.sh --app-only   # re-reads the secret onto the instance
```

`--app-only` because nothing about the stack changes here — and because it is the
form that works from inside the workspace, which is where you are most likely to be
when you decide to rotate a password. See [DEPLOY.md](DEPLOY.md) on why a full
deploy is not run from there.

Sign every device out without changing the password — rotate the cookie key:

```bash
aws secretsmanager put-secret-value --secret-id <SessionSecretArn> \
  --secret-string "$(openssl rand -base64 48)" --region us-east-1
./deploy.sh --app-only
```

Both ARNs are in the stack outputs (`dist/outputs.json` after a deploy).

## If you think you have been compromised

The instance holds a GitHub token and, depending on configuration, credentials
reaching your AWS account. Treat it as a credential incident, not just a host
incident.

```bash
# 1. Cut off access immediately.
aws ec2 stop-instances --instance-ids <InstanceId> --region us-east-1

# 2. Revoke the GitHub token at https://github.com/settings/tokens

# 3. Rotate the login password and session secret (above).

# 4. Read the access log before you rebuild it.
aws ssm start-session --target <InstanceId>
sudo journalctl -u claude-chat | grep -E 'login|failed login'
```

Successful and failed logins are logged with their source IP, and never with the
attempted password.

The workspace volume survives instance termination, so you can replace the
instance without losing work — but if you believe code on the volume was
modified, diff it against your remotes before trusting it.

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue:
open a [GitHub security advisory](https://github.com/MichaelNusair/claude-web/security/advisories/new).

Include what you can reach, what you can do with it, and how you got there.
Findings that let an unauthenticated caller reach the chat API, or that let one
authenticated session forge another, are the most valuable — those are the
boundaries this design actually claims to hold.
