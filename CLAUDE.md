# CLAUDE.md

See [AGENTS.md](AGENTS.md) — it is the orientation for anyone, human or agent,
working on this repository.

The short version, if you read nothing else:

- **Finish the job: `npm test`, then commit, then `git push origin main`, then
  `./deploy.sh`.** Every time, without being asked. A change that is green on this
  box and nowhere else is not done — it is something the user has to chase you for.
  There is no staging; this box is production. `deploy.sh` re-runs the suite and
  refuses to ship if anything fails, so never work around it. It also ships the
  whole working tree rather than your diff, and more than one agent works here at
  once — so run `git status` first and say what you are shipping. This applies to
  anything you find left uncommitted, unpushed, or undeployed, whether you built it
  or not: nothing in this repository is left built-but-not-live. Details in
  [AGENTS.md](AGENTS.md#finishing-is-committed-pushed-and-deployed).
- This app runs shell commands on behalf of whoever is logged in. An
  authentication gap here is remote code execution. It has happened once already;
  [docs/SECURITY.md](docs/SECURITY.md) explains how.
- Authentication is enforced in `chat-service/auth.js`, inside the application
  process — never in nginx, never in the load balancer alone.
- Run `npm run test:auth` before finishing any change to auth, routing, or the
  stack. `deploy.sh` runs it too and refuses to deploy if it fails.
- Never commit `claude-web.config.json` or `infra/cdk.context.json`; both carry
  account-specific details.
