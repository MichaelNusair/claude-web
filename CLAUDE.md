# CLAUDE.md

See [AGENTS.md](AGENTS.md) — it is the orientation for anyone, human or agent,
working on this repository.

The short version, if you read nothing else:

- **Finish the job: `npm test`, then commit, then `git push origin main`, then
  `./deploy-remote.sh`.** Every time, without being asked. A change that is green on
  this box and nowhere else is not done — it is something the user has to chase you
  for. There is no staging; this box is production. The suite is re-run on the deploy
  box and the deploy refuses to ship if anything fails, so never work around it. This
  applies to anything you find left uncommitted, unpushed, or undeployed, whether you
  built it or not: nothing in this repository is left built-but-not-live. Details in
  [AGENTS.md](AGENTS.md#finishing-is-committed-pushed-and-deployed).
- **Deploys run on the deploy box, never here** — an agreement with the user, and
  `deploy.sh` enforces it by refusing a full deploy on the instance the stack
  manages, which is this one. `./deploy-remote.sh` runs the real deploy there from
  `origin/main`, so push first: unlike `deploy.sh`, it ships what is on the branch
  rather than your working tree, and it refuses to run if anything here is
  uncommitted. `./deploy.sh --app-only` is still right, and still finishes, for a
  change that is only app payload (`chat-service`, `pwa`, the extensions,
  `infra/userdata`). Either way both paths ship more than your diff and more than one
  agent works here at once, so run `git status` first and say what you are shipping.
- **You have passwordless `sudo` on this box — install whatever you need.**
  `sudo dnf install -y …`; for a headless browser, `sudo npx playwright install-deps`
  and then `npx playwright install chromium`. Do not route around a missing package
  or ask the user to install it. Anything a *deployment* depends on belongs in the
  package list in `infra/userdata/bootstrap.sh` instead, because an instance
  replacement gives you a fresh root volume and only `/workspace` survives it.
  [AGENTS.md](AGENTS.md#the-box-you-are-on) has the rest.
- This app runs shell commands on behalf of whoever is logged in. An
  authentication gap here is remote code execution. It has happened once already;
  [docs/SECURITY.md](docs/SECURITY.md) explains how.
- Authentication is enforced in `chat-service/auth.js`, inside the application
  process — never in nginx, never in the load balancer alone.
- Run `npm run test:auth` before finishing any change to auth, routing, or the
  stack. `deploy.sh` runs it too and refuses to deploy if it fails.
- Never commit `claude-web.config.json` or `infra/cdk.context.json`; both carry
  account-specific details.
