# CLAUDE.md

See [AGENTS.md](AGENTS.md) — it is the orientation for anyone, human or agent,
working on this repository.

The short version, if you read nothing else:

- This app runs shell commands on behalf of whoever is logged in. An
  authentication gap here is remote code execution. It has happened once already;
  [docs/SECURITY.md](docs/SECURITY.md) explains how.
- Authentication is enforced in `chat-service/auth.js`, inside the application
  process — never in nginx, never in the load balancer alone.
- Run `npm run test:auth` before finishing any change to auth, routing, or the
  stack. `deploy.sh` runs it too and refuses to deploy if it fails.
- Never commit `claude-web.config.json` or `infra/cdk.context.json`; both carry
  account-specific details.
