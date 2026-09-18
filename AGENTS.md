# Notes for AI agents

You are probably here because someone asked you to help them deploy, operate, or
modify claude-web. This file is the orientation you need. `CLAUDE.md` points here;
so does the README.

Read [docs/SECURITY.md](docs/SECURITY.md) before changing anything under
`chat-service/` or `infra/`. It explains why the code is shaped the way it is.

**Then read ["Finishing" is committed, pushed, and deployed](#finishing-is-committed-pushed-and-deployed).
It is not optional, and it is the instruction agents here have most often skipped.**

## What this project is, in one paragraph

A self-hosted web front end for Claude Code, running on one EC2 instance in the
user's own AWS account. The primary surface is a phone-friendly chat PWA; a full
VS Code (code-server) instance is available at `/editor/`. The chat is a thin UI
over the real `claude` CLI: one long-lived process per conversation, driven over
`--input-format stream-json`, which is what makes it behave like a messaging app
rather than a series of one-shot commands. Claude runs with
`--permission-mode bypassPermissions` by default, so it executes shell commands
without prompting.

## "Finishing" is committed, pushed, and deployed

**A change that is green on this box and nowhere else is not finished. It is a
change the user has to chase you for.**

Work in this repository is done when all three of these are true, in this order:

```bash
npm test                       # all of it, not just the part you touched
git add -A && git commit       # see the message rules below
git push origin main           # the open-source repo: github.com/MichaelNusair/claude-web
./deploy.sh                    # the user's own deployment. It re-runs the tests
                               # and refuses to ship if any of them fail.
```

Do all three without being asked. Do not stop after the tests and describe what
*could* be shipped; do not leave the commit for the user; do not say "ready to
deploy" as if that were the finish line. If you were asked to build something, you
were asked to put it live — this box *is* production, there is no staging, and an
uncommitted change is one editor crash away from being gone.

**It does not matter who left it.** This is a sweep of the repository, not of your
diff. If you find uncommitted changes, commits that never got pushed, or a tree
that is ahead of what is actually running, finish them too — the user's
instruction is that nothing in here is left built-but-not-live, regardless of
which agent or which session built it. So start by looking:

```bash
git status --short              # anything uncommitted, from any session
git fetch origin && git status -sb   # "ahead N" means commits nobody else has
```

Read what you find before you ship it, and say whose it is (see below). The only
thing that stops you is work you can see is *broken*, not work that is merely
someone else's.

Five things that are still true while you do it:

- **Say what you are shipping.** `deploy.sh` ships the whole working tree, not your
  diff. More than one agent works in this repository at a time, so run `git status`
  first and, if there is work in there that is not yours, say so in the commit
  message and in what you tell the user. Ship it — but named, never quietly. And
  never commit `claude-web.config.json` or `infra/cdk.context.json` (both
  gitignored; keep it that way).
- **Someone else's file may be mid-edit.** The suite is the arbiter: if `npm test`
  is green with their work in the tree, ship it and say you did. If it is red
  *because* of their work, do not fix it by reverting them and do not weaken the
  test — commit your own files by name, push, deploy that, and say plainly what
  you left behind and why.
- **Green first, always.** `deploy.sh` runs the suite itself and refuses on
  failure, and that refusal is a feature. Never pass a flag, skip a test, or weaken
  an assertion to get past it.
- **A deploy is visible to the user.** It restarts `claude-chat` and `code-server`,
  so editor pages reconnect and any tmux server *not* owned by
  `claude-tmux.service` dies with the old cgroup. It never restarts
  `claude-broker`, which is why conversations in the panel survive it — keep that
  true (see the broker's cgroup note below).
- **Report what actually happened.** The commit hash, that the push landed, and
  the deploy's own verdict. If the deploy failed, say that plainly and leave it
  failed rather than describing the change as done.

If you genuinely must not deploy — the user said not to, or the tree holds work
that is known broken — then say so explicitly, in one sentence, as part of
reporting the work. Silence reads as "deployed", and that is the failure this
section exists to prevent.

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
npm run test:auth      # must be 49/49 or better; never fewer checks than before
npm run test:client
npm run test:panes     # several projects at once; what closing a tab must not do
npm run test:overlay   # 106/106; the editor overlay: chords, drafts, clipboard, speech
npm run test:polish    # 19/19; the dictation cleanup's bounds, and its failure paths
npm run test:projects  # 53/53; real git repos, real pushes
npm run test:admin     # the operations surface, and every refusal it makes
npm run test:status    # 42/42; which conversation a device is told about, and from where
npm run test:broker    # 51/51; one process per conversation, and what counts as a turn
cd infra && npx cdk synth --quiet
```

`npm test` runs all of them in that order.

If you add a route to `server.js`, add it to the `guarded` list in
`auth-test.js`. A route with no test is a route nobody is checking.

## Repository map

```
chat-service/            The chat backend + PWA client. The security boundary.
  auth.js                Password + OIDC verification, cookies, throttling.
  auth-test.js           End-to-end auth tests. Run these.
  server.js              HTTP routes, static files, WebSocket upgrade gate.
  session-manager.js     One `claude` process per conversation; transcripts;
                         the project lifecycle (create, clone, remove).
  admin.js               The operations surface: what is running on all four
                         surfaces, what is wrong with it, and stopping one thing
                         at a time. Reads the broker's processes from outside
                         with ps, and refuses far more than it does.
  claude-status.js       "Is Claude working, and what did it last say" for the
                         EDITOR's panel, in ~40ms, so a device need not wait out
                         the panel's own history load to find out. Two sources,
                         deliberately unequal: the broker for whether a turn is in
                         flight, the tail of the transcript for the message.
                         Depends on nothing in this service but the transcript
                         path helper — the chat service is meant to be retired,
                         and this should move rather than be rewritten.
  status-test.js         That the two sources stay separated: a broker answer
                         wins, a missing one falls back, and neither may claim a
                         conversation is idle when that is not known.
  push.js                Web Push, hand-rolled on node crypto: VAPID (ES256) and
                         RFC 8291 aes128gcm, plus the device list. No dependency
                         on purpose — see its header. Keys live under CLAUDE_HOME
                         so a deploy cannot invalidate a phone's subscription.
  push-test.js           The encryption against RFC 8291's published vector, byte
                         for byte and step by step, and a fake push service over
                         real HTTP for the sending, pruning and refusals.
  turn-watcher.js        What actually decides your phone should buzz: polls the
                         transcripts every 5s for a turn that just ended in a
                         session this app is NOT running, and sends one
                         notification per conversation.
  turn-watcher-test.js   Mostly about silence — a restart, a rewritten
                         transcript, a mid-turn write and this app's own
                         conversations must all announce nothing.
  manifest.js            One web app manifest per project, so a project can have
                         its own home-screen icon and therefore its own window on
                         Android. Differs only in `id`, `start_url`, name.
  manifest-test.js       That a project's manifest stays installable and stays in
                         step with pwa/manifest.webmanifest, which it duplicates.
  transcribe.js          Voice: local whisper.cpp, optional Azure override.
  polish.js              Makes a finished dictation readable: punctuation,
                         capitals, misheard names. Bedrock Haiku, one bounded
                         pass, returns the raw transcript on any failure.
  smoke-test.js          Boots app.js in jsdom — catches load-time breakage.
                         Also the notification switch, against stubbed
                         Notification/PushManager/serviceWorker: every way that
                         switch can lie is invisible from a desktop browser.
  polish-test.js         The cleanup's guard rails: what `looksLikeCleanup`
                         must reject, and that every failure path hands the
                         raw transcript back.
  overlay-test.js        Boots pwa/mobile-overlay.js in jsdom. Nothing else
                         loads that file, and it drives the editor by
                         keybinding, so this is what checks both. Also the
                         speech reducer and the rules iOS imposes on it, against
                         a fake speechSynthesis — jsdom has none, which is also
                         how the no-speech path gets covered.
  project-test.js        Project removal against real git repos. Deletes trees,
                         so the refusals are what this tests hardest.
  admin-test.js          Both halves of /chat/admin against a fake box having
                         every failure this project has had, at once. What it
                         refuses to signal is the code under test.
  pane-test.js           Several projects open at once — a tab is a project, not
                         a conversation: a background project rendering off
                         screen, the live cap, switching chats inside one tab,
                         and that neither that nor closing a tab stops anything.
  public/                index.html, app.js, style.css, login.html, and
                         admin.html + admin.js for the operations surface.

claude-broker/           Keeps the editor panel's `claude` alive and shared
                         between devices. No dependencies beyond node.
  broker.js              The daemon: one process per (cwd, session id), byte
                         transparent, replays the stream to a joining page.
  wrapper                What the extension launches instead of `claude`. Every
                         failure path execs the real binary — keep it that way.
                         No file extension, on purpose: see its header, and do
                         not rename it to wrapper.js.
  broker-test.js         Boots the real broker over a real socket against a fake
                         CLI. Proves sharing, and proves the fallback.
  install.sh             Installs the unit and the editor setting. In the payload
                         because a bootstrap.sh edit cannot reach a live box.

infra/                   AWS CDK (JavaScript, not TypeScript).
  config.js              Config loading + validation. Single source of truth.
  print-config.js        Emits shell assignments for deploy.sh / migrate.sh.
  lib/stack.js           The whole stack. No account-specific values.
  userdata/bootstrap.sh  Instance provisioning. Idempotent; re-run on deploy.

  lib/landing-stack.js   Optional marketing site: S3 + CloudFront. Separate stack.

landing/                 The public marketing page. Static, no build step.
pwa/                     Assets copied into chat-service/public/ by deploy.sh.
                         THIS IS THE SOURCE OF TRUTH for manifest + sw.js.
voice-extension/         VS Code dictation extension (for the editor surface).
mobile-extension/        Strips VS Code chrome for phone use, and owns the
                         rescue from a layout a file view has taken over.
deploy.sh                The whole deploy. Read it before changing the pipeline.
deploy-landing.sh        The landing site only. Independent of deploy.sh.
migrate.sh               Brings local repos + Claude session history up.
```

### Two stacks, deliberately

`ClaudeWebStack` is the workspace — a machine that runs shell commands.
`ClaudeWebLandingStack` is a public static page. They share no resources, and the
landing side has no route to the instance. Keep it that way: do not "simplify" by
serving the marketing page off the workspace's nginx, which would put public
traffic on the box that holds the GitHub token.

Both manage a Route53 record, so **they must never be configured with the same
hostname** — `config.js` rejects that rather than letting CloudFormation find out.
When moving a hostname from one to the other, deploy the stack that is *giving it
up* first.

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

**In the client there is no "the chat" any more.** A window onto a project is a
*pane* — its socket, its thread element, the bubble being streamed into, the tool
cards still waiting for their results — and several are open at once as tabs.
Every render function takes the pane it draws into, because a background project
keeps rendering while you are looking at a different one; that is the whole reason
tabs exist. `activePane()` is the one on screen and the only thing the composer,
the header and the mic belong to. If you reach for "the thread" or "the socket" as
a module-level thing, that is the bug the pane model exists to make impossible.

**A tab is a project, not a conversation** — `paneKey(cwd) === cwd`, so a
directory has exactly one tab, and `pane.sessionId` is which of that project's
chats the window currently shows. This is deliberate and was the second design:
tabs per conversation gave a box with 17 projects and 32 chats a chip strip nobody
could read. Switching conversation inside a tab (`showConversation`) drops the old
socket and joins another; it never stops what it left, and the toast says so.
Drafts stay keyed per conversation (`convKey(cwd, sessionId)`), not per tab, so
text always resurfaces in the chat it was typed in — as do list rows, `/api/live`
and everything the server keys by session. The price, accepted: two chats in one
project cannot be on screen at the same time.

Three panes hold a socket (`MAX_LIVE`); past that the least recently used *idle*
one is cooled to a tab — socket closed, thread dropped, nothing stopped. Cooling
is never applied to a pane that is working: the cap is exceeded and the user told
instead, because a tab going quiet while the box is still spending on it is the
one outcome worse than four sockets. Closing a tab is not stopping either, and
neither is switching conversations; ending a conversation is `/chat/admin`'s job,
on purpose. `pane-test.js` holds all of that down and `deploy.sh` runs it.

### "Delete a project I'm done with"

`POST /api/projects/remove` — commit, push every branch and tag, verify with the
remote that it landed, then `rm -rf` the directory. Reachable from the chat: New
chat → the ⋯ next to a project.

The order matters and the verification is not decoration. A `git push` that exits
0 is not proof the remote has anything: the remote-tracking ref it updated is a
local file, and this operation deletes the only other copy of the work. So the
commit on disk is compared against `git ls-remote`, over the network, and anything
short of a match refuses to delete.

It returns **409, not 500**, when something exists only on that machine — no
remote, a stash, a push that partly failed, a chat still working in the directory.
That is a refusal the user can answer, and the client turns it into a specific
question with `force` as the answer. If you add a new way for work to be
local-only, add a check for it *and* a case to `project-test.js`. `force` must
never become the default, and must never be inferred.

Chat transcripts under `CLAUDE_HOME` are deliberately left behind. They are small,
they are the record of what was done, and keeping them means re-cloning the repo
later lands next to its own history.

### "Clone one of my GitHub repos"

`POST /api/projects/clone`, or the repository list from `GET /api/github/repos`.

`parseGithubRepo()` accepts `owner/repo` and github.com URLs and **rejects every
other host**. That is a security boundary, not tidiness: the workspace's git
credential helper (`git-credential-secretsmanager`) answers with the PAT for
whatever host git asks it about, so cloning a caller-supplied URL from elsewhere
would hand that host the token. Do not relax it to "any git URL". If someone wants
that, the fix is to scope the credential helper to github.com first.

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

## The surfaces, and which one persists

Know this before answering any question about long-running work:

| Surface | Who owns `claude` | Survives closing the app | Shared live across devices |
| --- | --- | --- | --- |
| Chat (`/`) | `claude-chat` systemd service | yes | yes — `getBySession` hands both sockets the same process |
| Extension panel — **the editor's default** | `claude-broker.service`, reached through the wrapper | yes | yes — one process per conversation, every page attached |
| Extension panel, broker stopped | extension host, tied to the browser | **no — dies in ~5s** | **no — it forks** |
| `cc` / tmux | the tmux server, owned by `claude-tmux.service` | yes | yes — multiple tmux clients, one session |

The middle two rows are the same panel. Which one you get depends on whether
`claude-broker.service` is running and `claudeCode.claudeProcessWrapper` points at
it, so when someone reports the panel forking, that is the first thing to check:

```bash
systemctl status claude-broker
grep claudeProcessWrapper /workspace/code-server-data/User/settings.json
```

That 5 seconds is measured, not guessed: a probe on a live box recorded
`exthost` and `claude` both `DEAD` five seconds after `ws_conns` hit 0, mid-turn.
`ReconnectionGraceTime` does appear in the code-server bundle, which misleadingly
suggests a 3-hour grace period — it does not apply here. Do not tell someone the
extension will keep working in the background; it will not.

**The panel does not just fail to share — it forks, silently, and that is worse.**
code-server creates one extension host *per browser page*, so a second device (or
a plain reload) gets a second extension host, which starts its own `claude` and
resumes the same session id from the transcript on disk. The first process is
never told anything and keeps running. Two live processes then append to one
`.jsonl`, and the two devices diverge from the moment of the fork. Observed on a
live box, 2026-09-17: extension hosts 314616 (phone) and 319472 (laptop) under one
code-server, three `claude` processes, one project directory — and an agent whose
own `CLAUDE_PID` changed from 315100 to 319986 mid-conversation while the phone's
315100 was still running. What the user sees is "I opened my laptop and Claude was
idle, and now they're telling different stories".

**The fix is outside the extension host, because nothing can fix it inside one.**
No supported API shares an extension host between two page loads, so the panel
cannot solve this itself and neither can this repo by patching it. What it can do
is take the process out of the extension host altogether:
[`claude-broker/`](claude-broker/) is a daemon owning one `claude` per
conversation, and the extension's own
`claudeCode.claudeProcessWrapper` setting — "Executable path used to launch the
Claude process" — points the panel at
[`claude-broker/wrapper`](claude-broker/wrapper) instead of the binary. The
wrapper hands its stdio to the broker and every page attaches to the same process.
The panel is not modified, not patched, and does not know: it sees an ordinary
stream-json conversation on stdio.

The contract is that the wrapper is exec'd with the real claude path as its first
argument, then the extension's own args — confirmed in the shipped bundle, not
assumed:

```js
if (J) return { pathToClaudeCodeExecutable: J, executableArgs: X ? [X] : [], env: Q, viaProcessWrapper: !0 };
```

so `process.argv[2]` is the binary and `slice(3)` is everything the extension
wanted. Setting a wrapper also makes the extension resolve permission mode itself
(`resolvePermissionModeInCli: !W0("claudeProcessWrapper")`), which is why the
wrapper must pass the args through untouched.

**"Exec'd" is conditional, and the condition is the wrapper's file extension.**
Reading only the pairing above is how the panel came to be broken on 2026-09-17.
The other half of the bundle turns that pair into a command line, and it branches
on the configured path's extension:

```js
function qW0($){return![".js",".mjs",".tsx",".ts",".jsx"].some((Q)=>$.endsWith(Q))}
let b=qW0(G),          // G = the configured wrapper path
    p=b?G:Y,           // Y is the JS runtime, "node"
    C=b?[...z,...d]    // exec'd:     wrapper <real claude> <args>
      :[...z,G,...d];  // under node: node <real claude> wrapper <args>
```

`executableArgs` comes first in both branches, so a wrapper named `wrapper.js`
hands node the real `claude` as its entry script: node parses an ELF binary as
JavaScript and the panel reports `SyntaxError: Invalid or unexpected token` with
Claude never having started. Hence the extensionless filename, its `"type":
"module"` from the sibling `package.json`, its shebang, and its executable bit —
all four are load-bearing, `install.sh` refuses a JS-looking path, and
`broker-test.js` exec's the file exactly as the extension does rather than
spawning `node wrapper`. A test that builds its own argv proves nothing about the
panel; that is why the break got through a green suite.

**The wrapper fails safe, and every change to it must keep doing so.** It sits in
front of the only interface the user has, so no broker, a stale socket, a refused
join, or a malformed handshake all fall through to exec'ing the real binary — the
panel forks again, which is merely the old behaviour, rather than failing to start.
That is what makes `systemctl stop claude-broker` a complete rollback with no
settings change and no deploy. `claude-broker/broker-test.js` asserts both halves
and `deploy.sh` will not deploy without it.

`cc` / tmux stays as the surface that depends on nothing — no broker, no wrapper,
no extension setting — and is the real CLI rather than a UI over it. Verified on
the box: two simultaneous clients, one session, one `claude`, and the session still
alive after both detached.

**A tmux session is only as durable as the cgroup its server is in.** Sessions are
forked by the tmux server, so they inherit *its* cgroup, and a server first
started by `cc` from an editor terminal is inside `code-server.service` — which is
`KillMode=control-group`, systemd's default. So `systemctl restart code-server`,
which every deploy does, kills the sessions: being detached from the terminal is
not enough. Observed 2026-09-17, a task running in tmux dying mid-deploy, which is
the exact failure tmux was introduced to prevent. Hence `claude-tmux.service` owns
the server, with `exit-empty off` so it stays alive with no sessions — otherwise
the next `cc` quietly starts a replacement in the wrong cgroup and durability is
lost with nothing to see. `cc` warns when it finds a server outside that unit.
Never `systemctl restart claude-tmux` from a deploy path; `enable --now` only.

**The same cgroup lesson applies to the broker**, and for the same reason: the
conversations are its children, so they live in `claude-broker.service`'s cgroup.
Never `systemctl restart claude-broker` from a deploy path — `enable --now` only,
exactly as with `claude-tmux`. A restart ends every live conversation, which is the
failure the service exists to prevent, so a change to `broker.js` lands at the next
deliberate restart, chosen at a moment when losing the running work is acceptable.

### Seeing all four at once: `/chat/admin`

Every note in the section above was found with an SSM shell, `ps` and
`journalctl` — ten forgotten probes at ~205 MB each, three `claude` processes
against one project, a tmux server in the wrong cgroup. None of it was visible
from any of the app's own surfaces. [`chat-service/admin.js`](chat-service/admin.js)
is that shell, on a phone: what is running on each surface, what is wrong with it,
and stopping one thing at a time. Four decisions in it are load-bearing.

**It is a screen inside the chat service, not an app of its own.** A second app
would be a second authentication implementation, and this repository's founding bug
was auth living in the wrong place. It is behind the same gate as `/ws` and adds no
authority the caller did not already have — that gate hands out a shell with
`bypassPermissions`. Every one of its routes is in the `guarded` list in
`auth-test.js`; unauthenticated, `/api/admin/overview` would be a remote inventory
of the box and `/api/admin/kill` a remote kill.

**It is served at `/chat/admin`** because nginx already routes `/chat/` to the
service with the prefix stripped. A new nginx location would mean editing
`bootstrap.sh`, which `--app-only` cannot apply and a full deploy may answer by
replacing the instance.

**The broker is inspected from the outside, with `ps` and `/proc`.** Adding a
list/kill op to `broker.js` is the obvious move and the wrong one: its
conversations are its children, so the change would only take effect at a restart,
and a restart ends every live conversation. Their argv already carries
`--resume <session id>`, so today's broker needs no change at all. The same argv is
what tells a real conversation from the panel's never-written-to probe.

**Every stop is a refusal first.** `AdminBlocked` → 409 with a reason, which the
client turns into a specific question, exactly as a project removal does. `force`
is the answer to that question: never a default, never inferred. And a pid from the
client is only ever signalled after being re-found in a freshly-read process table
under the parent we expected — the one thing this file must never become is a way
to turn a caller-supplied string into a signal for an arbitrary process.
`admin-test.js` tests the refusals hardest, and `deploy.sh` will not deploy without
it.

## Being told a turn ended

The thing that made this box worth building is starting a turn and walking away.
Which leaves one question — *is it done yet* — and three answers, deliberately
separate, because they fail in different places and one of them can wake a phone up
at night.

**A conversation this app is running announces itself on screen.** `announce()` in
`app.js`: a toast, and a buzz through the Vibration API. It knows the turn ended
because it is holding the socket, so nothing has to be polled or guessed.

**A conversation this app is *not* running is watched from the transcripts.**
`chat-service/turn-watcher.js`, started by `server.js`, polls every five seconds
and sends a Web Push notification when a session in the editor panel or under tmux
finishes a turn. It reads the same `lastExchange()` as `claude-status.js` rather
than asking the broker, because the broker has no such event to subscribe to and
adding one means restarting it — which ends every live conversation, the cgroup rule
again. Its whole design is about not buzzing for nothing, and each rule is there
because the failure it prevents would make the feature something you turn off:

- **Nothing is announced for what was already finished when the watcher started.**
  The first scan seeds silently, so a deploy does not replay the day.
- **This app's own conversations are excluded**, by session id from
  `manager.liveSummary()`, *including after they exit* — otherwise a chat you were
  just reading buzzes as you close the app. That is also why `announce()` keeps its
  toast and its buzz: the two surfaces do not overlap, so neither is redundant.
- **One notification per conversation**, with a per-conversation `Topic` and `tag`
  and `renotify: true`, so a second answer replaces the first rather than stacking
  behind it.
- **Nothing older than ten minutes**, and a content digest so a rewritten
  transcript is not a new answer.

**Notifications are switched on from either surface, and there is only one of
them.** The chat app's Settings sheet has a checkbox; the editor overlay's status
sheet has a button (`toggleNotify` in `pwa/mobile-overlay.js`). Same origin, same
worker under `/chat/`, same subscription, same row in the device list — turning it on
in one place turns it on in both, which is why the wording says "this device" and
never "this app". The editor needed its own switch because the sessions being watched
are the editor's: someone who only ever opens `/editor/` could not reach the one
feature written for them. The plumbing is deliberately duplicated rather than
imported — the overlay is a plain script nginx injects into code-server's HTML, and a
switch that depends on a second request and on code-server's CSP is a switch that
fails where it is needed. Both copies obey the same two rules: ask
`Notification.requestPermission()` before anything is awaited (mobile Chrome refuses a
prompt that is no longer the consequence of the tap), and tell the server *before*
the browser drops a subscription (the endpoint is what identifies the device, and it
is gone afterwards). `overlay-test.js` and `smoke-test.js` each assert that order
from a log of acts, and both checks were confirmed to fail when the order is swapped.
One thing the overlay must not do: `await navigator.serviceWorker.ready`. That
resolves for the worker controlling *this* page, and `/chat/sw.js` will never control
`/editor/` — it hangs forever. `register()` returns the registration; use it.

Push itself is `chat-service/push.js`, hand-rolled: VAPID plus RFC 8291, ~400 lines
of node crypto and no new dependency on a box whose whole job is running shell
commands. The keypair and the device list live under `CLAUDE_HOME` (not in
`/opt/claude-web`, which a deploy replaces), so shipping does not silently
unsubscribe every phone. All four `/api/push/*` routes are gated and listed in
`auth-test.js`: a subscription endpoint is a capability to write on the operator's
lock screen, and the list of them is an inventory of their devices.

**A conversation you are looking at in the editor is polled while you look.** The
overlay's status sheet re-asks `/api/claude-status` every five seconds while it is
the sheet on screen, and reads a newly changed message aloud. Bounded by that sheet
on purpose — a phone that starts talking on its own in a meeting is worse than one
that stays quiet — and unbounded speech is fenced by the same rule: only while the
sheet is open, only when the *text* changed, never on a change of conversation.
This is independent of push and must stay that way; the sheet works with
notifications refused, and notifications work with the sheet never opened.

## A window per project, on a phone

On a laptop each project can have its own window. On Android it cannot: Chrome
gives an installed web app exactly one window, and there is no API that opens a
second — this was checked before anything was built, and the answer does not depend
on our code.

What *is* per-app is identity. A manifest whose `id` differs describes a distinct
application even when served from the same URL, and a distinct application on
Android is a distinct home-screen icon with its own task in the recents switcher.
So `chat-service/manifest.js` hands out one manifest per project — same origin,
same code, same login, same push subscription, differing in `id`, `start_url` and
the name under the icon — and `start_url` is `/editor/?folder=<path>`, so tapping a
project's icon lands exactly where tapping it in the project switcher does. One
install per project, once, and the second window the user asked for.

**The `<link rel="manifest">` has to be injected into the editor's document**, which
is why `pwa/mobile-overlay.js` does it (`linkProjectManifest`) rather than the chat
app: a browser installs the manifest linked from the page you install *from*, and
that page is code-server's, which ships no manifest at all. The overlay replaces any
existing link rather than appending — the first one found wins, so appending would
silently install the wrong app — and keeps `crossorigin="use-credentials"` for the
same reason the chat's own link does. The install itself is a button in the project
sheet, using `beforeinstallprompt` where Chrome offers it and telling the user which
menu item to use where it does not (every iOS browser).

**Chrome can still refuse the install, and the reason only exists on the phone.**
Android matches an installed web app to a page by *scope*, and the chat app's manifest
claims `/` — the whole origin, including every `/editor/` URL — so with the chat icon
on the home screen Chrome answers "this app is already installed" for a project
manifest whatever its `id` says. That is the leading hypothesis for a report from a
real phone, not a finding, so what is shipped is a diagnostic rather than a fix:
**Check this install** in the project sheet (`explainInstall`) prints the build of the
overlay, the manifest this page links and what the server says is in it, whether this
is a browser tab at all, whether `beforeinstallprompt` fired, and — via
`navigator.getInstalledRelatedApps()` — which installed app Chrome thinks this page
belongs to. That last answer is only possible because `manifest.js` declares the chat
app in `related_applications`; the API answers about nothing else.
`prefer_related_applications: false` is stated explicitly there, because `true` is the
one member that would suppress the install offer this is trying to explain.

If the hypothesis holds, the fix is to narrow the chat app's scope to `/chat/`, which
is not free: its `start_url` moves, `/login` and the `/editor/` shortcut fall out of
scope, and a lapsed session then opens the app in a browser bar. Confirm on a device
before paying that — removing the chat icon and installing a project is a thirty-second
experiment that settles it.

**A workbench left open across a deploy runs the script it loaded**, which is
indistinguishable from a feature that does not work. `/mobile-overlay.js` is served
`Cache-Control: no-cache`, so a reload is enough — and `OVERLAY_BUILD`, printed by the
install check, is how to tell the two apart without arguing about it. Bump it when this
file changes in a way anyone would go looking for.

`GET /manifest.webmanifest?project=<name>` is gated like everything else, and is in
`auth-test.js` for a reason that is easy to miss: it answers 200 for a project that
exists and 404 for one that does not, so ungated it would enumerate the project
tree by guessing names.

## Gotchas that look like bugs

Things that have burned people, in this codebase specifically:

- **`pwa/manifest.webmanifest` and `chat-service/public/manifest.webmanifest` are
  two copies.** `deploy.sh` copies `pwa/` over `public/`, so `pwa/` wins. Edit
  that one. Same for `sw.js`.
- **The manifest link needs `crossorigin="use-credentials"`.** Manifests are
  fetched with credentials omitted by default, which means 401 and no install
  prompt now that static files are gated.
- **`userDataCausesReplacement: false` is deliberate, and does not mean userdata
  edits are free.** The bootstrap script's S3 asset hash is in userdata, so
  leaving the flag on replaced the instance on every script edit; `deploy.sh`
  re-runs `/opt/bootstrap.sh` on the live instance instead, which is why
  `bootstrap.sh` must stay idempotent. But CloudFormation's own update behaviour
  for `UserData` on a running instance is *replacement*, so a changed bootstrap
  asset hash still replaces the box — observed 2026-09-15, when a deploy carrying
  one moved the whole thing to a new instance. `cdk diff` says "may be replaced"
  when this is about to happen, and it is worth reading, because two things follow:
  `/opt/claude-web` lives on the root volume and dies with the instance, and the
  payload that recreates it is pushed by `deploy.sh` *after* the stack completes.
  So drive that deploy from a machine other than the one being replaced. From the
  instance itself it only worked because CloudFormation deletes the old instance
  last, which is luck rather than design.
- **`./deploy.sh --app-only` is how you deploy from the box itself.** It runs
  every test, packages both extensions, pushes the payload to the instance that
  is already running, and skips `cdk deploy` — so it cannot race its own
  replacement. Use it for the chat service, the extensions, the overlay and `cc`.
  It reads the running stack's outputs into `dist/outputs.json` so the stages
  after it are the same code path as a full deploy. What it cannot do is apply an
  edit to `infra/userdata/bootstrap.sh`: it re-runs the `/opt/bootstrap.sh`
  already on disk, and the new one only arrives through UserData. Check with
  `cdk diff` — if the instance would be replaced, that part needs a full deploy
  from somewhere else.
- **A deploy ends every chat conversation, and only the chat's.** `deploy.sh` runs
  `systemctl restart claude-chat`, and a conversation is a child of that unit, so
  its cgroup takes all of them with it — the cgroup rule above, seen from the other
  side. The broker's and tmux's conversations survive exactly because no deploy path
  restarts those units. Nothing is corrupted (the transcripts are on disk and every
  session is still offered in the chat list) but a turn in flight is lost, and the
  client's tabs come back attached to fresh processes. So say so rather than being
  clever about it when someone asks to deploy mid-task, and put long work on the
  editor panel or `cc`. `/chat/admin` prints this under the chat's own conversations
  for the same reason.
- **`/api/projects` reads every transcript, so nothing may poll it.** It stats and
  opens each `.jsonl` to build the titles — fine once per screen, ruinous every few
  seconds. Anything that needs to know what is *running* asks `/api/live`, which is
  a walk of the in-memory conversation map, and the client updates the list's badges
  in place from that rather than redrawing the list. If you add ambient state to the
  UI, add it to `/api/live`; do not reach for the list route because it already has
  a field you want.
- **The CDK CLI reads a narrower slice of `~/.aws/config` than the AWS CLI.** A
  profile whose credentials come from `credential_source = Ec2InstanceMetadata`
  fails the CDK step with "Unable to resolve AWS account to use" while every `aws`
  call in the same script, with the same `--profile`, works. `deploy.sh` resolves
  the profile with `aws configure export-credentials` and hands CDK environment
  credentials instead of the flag. It also checks `sts get-caller-identity` up
  front, because the other way this shows up is a configured profile that no
  longer exists — an instance replacement takes `~/.aws` with the root volume
  while `awsProfile` in the config keeps naming it.
- **The service worker exists for notifications and has no `fetch` handler.** That
  absence is the point: a worker that mishandles a request wedges the app in a way
  the app cannot fix, because the page never loads and so the code that would
  replace the worker never runs either. That happened once, which is why the
  previous version of `pwa/sw.js` existed only to unregister itself. It caches
  nothing — a stale shell breaks a live WebSocket client rather than helping — and
  a browser will not deliver a push to anything but a worker, which is the only
  reason one is registered again. It is also registered only when the switch in
  settings is turned on, never merely by opening the app, and `/chat/reset.html`
  remains the escape hatch. Do not add caching, and do not add `fetch`.
- **The overlay drives the editor through keyboard chords, and both ends have to
  agree.** `pwa/mobile-overlay.js` cannot call a VS Code command — there is no
  supported global for the workbench's command service, and rewriting the bundle
  to get one black-screened the editor twice. So the buttons synthesise
  `ctrl+alt+shift+F9`/`F10`/`F11`, and `mobile-extension/package.json` binds those to
  its commands. Nothing throws if they drift apart; the buttons just stop working,
  on the surface where the user has no other way out. `overlay-test.js` reads the
  chords out of the manifest and compares them against what the buttons dispatch —
  keep it that way rather than hard-coding the keys in the test as well.
- **The terminal button opens an *editor* terminal, not a panel one.** This surface
  sets `workbench.panel.defaultLocation: 'right'`, so the obvious
  `workbench.action.terminal.toggleTerminal` puts a shell in a narrow column beside
  Claude, with the soft keyboard over what is left of it. An editor terminal gets
  the whole window the same way Claude does, and with tabs hidden the two take
  turns — which is also why one button toggles both directions (press it while the
  terminal is in front and you get Claude back) rather than needing a second
  control. It shows an existing terminal rather than creating one, because
  code-server keeps shells alive across a page reload while the extension host is
  destroyed: creating per press would leave a pile of orphaned shells. A shell in a
  tab still dies with the tab, so long work belongs in `cc`/tmux, not here.
  On the `tmux` surface Claude is itself an editor terminal, so this button asks
  *which* terminal is in front rather than whether one is —
  `isClaudeTerminalTab` — because treating Claude as "the terminal" made the button
  bounce off it and never open a shell. That test stays regardless of the default
  surface; it costs nothing on `panel` and is load-bearing on `tmux`.
- **The workbench reloads itself, and a reload of `/editor/` destroys work.** Its
  lifecycle service calls `location.reload()` when the browser restores the page
  from the back/forward cache — on a phone that is every app switch — and a reload
  restarts the extension host. The extension host is where the panel used to keep
  the conversation, which is what made a reload fork it; the broker (and, on the
  other surface, the tmux server) is what takes the process out of the blast radius,
  since both outlive the page. A reload is now survivable rather than free:
  the panel rebuilds its view from the stream the broker replays.
  Everything else below still applies — a reload still discards
  typed text and still rearranges the layout. So
  treat *every* extra page load on that surface as damage: it is measurable (the
  remote agent log shows a fresh `ManagementConnection` and "Extension Host Process
  exited with code: 0" per load, and `code-server-data/logs/*/exthost*/` gains a
  directory) and it is what "it refreshed a few times and deleted what I typed"
  means. Two rules follow. Never navigate to arrive where you already are — the
  project switcher checks the current `?folder=` first. And nothing may hold typed
  text as its only copy: the chat composer and the overlay's dictation textarea both
  write to localStorage as you type, because the reload is not this app's decision.
  When a report like that comes in again, the Layout sheet shows this tab's recent
  loads with `navigation.type` for each — `navigate` means something assigned to
  `location`, `reload` means the page or the OS did it, `bfcache-restore` means the
  browser suspended the tab and the workbench reloaded in response. That line is the
  only diagnostic; the server side of all three causes is identical.
- **The startup layout pass must only act when the layout is wrong.** The mobile
  extension re-checks at 0.8/2/4s because VS Code restores its saved layout shortly
  after startup — but it used to re-run the whole sequence each time, and
  `joinAllGroups` moves editors between groups, which re-parents the Claude webview
  and re-creates it, taking an unsent message with it. So the passes are gated on
  `layoutIsSettled()`, `focusClaude()` skips `openLast` when the panel is already
  open, and `applySettings()` compares `inspect(key).globalValue` before writing —
  45 redundant `update()` calls is 45 configuration-change events through the
  workbench while it is still starting.
- **`closeFileTabs()` closes files, never webviews.** The Claude panel *is* a
  webview, and disposing it ends the conversation inside it. So the rescue works
  from an allowlist of text/diff/notebook tabs: misjudging that way leaves a file
  open, which is untidy, while the inverse throws away a turn in flight. Dirty
  tabs are skipped on purpose too — closing one raises a modal save prompt, which
  is the dead end this whole extension exists to avoid.
- **Every `__PLACEHOLDER__` in `bootstrap.sh` needs a matching `sed -e` in
  `stack.js`.** A mismatch ships a literal `__FOO__` to the box. Check with:

  ```bash
  diff <(grep -oE '__[A-Z_]+__' infra/userdata/bootstrap.sh | sort -u) \
       <(grep -oE '__[A-Z_]+__' infra/lib/stack.js | sort -u)
  ```

- **Quoted heredocs in `bootstrap.sh` do not expand variables.** `<<'EOF'` is
  intentional in places that write scripts; those use `__PLACEHOLDER__` + `sed`.
  Adding a `$VAR` inside one silently writes a literal `$VAR`.
- **The login shell is zsh, but the box's environment is still in
  `/etc/profile.d`.** Bedrock region and model, and the GitHub token resolver, are
  written there as `.sh` files, and zsh reads them only because AL2023's zsh
  package does it for us: its `/etc/zshrc` sources `/etc/profile.d/*.sh` for
  non-login shells (a code-server terminal is one), its `/etc/zprofile` sources
  `/etc/profile` for login shells. Nothing in this repo enforces that, and the
  failure is `claude` starting in a terminal without Bedrock credentials. So check
  it holds before changing distro, and keep adding shell environment as
  `/etc/profile.d/*.sh` rather than in a zsh-only file.
  Our own zsh defaults are in `/etc/claude-web-zshrc`, which `bootstrap.sh` owns
  and rewrites; `~/.zshrc` only sources it, so edits on the box survive a deploy.
  They cannot move into `/etc/profile.d`: zsh sources those under `emulate -L ksh`,
  which localises options, so a `setopt` there is reverted as the file finishes
  loading.
- **`session-manager.js` mangles the *resolved* path** for transcript lookup, so
  symlinks matter. This is why `migrate.sh` rewrites paths.
- **The landing page's copy button must show exactly what it copies.** When the
  clipboard API is unavailable the script selects the visible `<code>` node
  instead, so an abbreviated label hands the visitor a broken command.
  `deploy-landing.sh` checks this and refuses to deploy on a mismatch.
- **Headless Chrome with `--window-size` alone does not apply the viewport meta**,
  so it lays a responsive page out at desktop width and crops it. That looks
  exactly like a mobile overflow bug and isn't one. Use
  `Emulation.setDeviceMetricsOverride` with `mobile: true`, and confirm with
  `documentElement.scrollWidth` rather than by eye.
- **The screen wake lock has to be re-requested, not acquired.** It is held for as
  long as the app is open and visible, not just during dictation, because hiding the
  page also freezes the WebSocket and suspends the recognizer. The browser releases
  the lock on every hide and never re-takes it, and the OS revokes it silently
  (battery saver) with no event to say you may have it back. So there is one
  `syncWakeLock()` reconciler called from `visibilitychange`, `pageshow`, `focus`
  and a 30s timer — not an `acquireWakeLock()` called once at startup, which is
  awake for exactly one screen-off and asleep forever after. The same reconciler is
  duplicated in `pwa/mobile-overlay.js` (injected raw into code-server, imports
  nothing) and reads the same `claude-keep-awake` localStorage key, so one switch
  governs both surfaces. Covered in `smoke-test.js` against a fake `navigator.wakeLock`,
  because whether a display sleeps is invisible to the page.
- **Dictation stops when the page is hidden, on purpose.** A phone being dictated
  into is a phone nobody is touching, so the display sleeps and the recognizer
  goes with it — silently, because the screen showing "recording" is what turned
  off. The wake lock above is the first defence; the second is treating any stop
  they did not ask for as an event to announce: beep, vibrate, and a banner that
  outlives the screen going dark. Do not "improve" this by letting dictation carry
  on through `visibilitychange` and hoping — that is the original bug, and the
  failure is invisible from a desktop browser. The interruption path is covered in
  `smoke-test.js` for exactly that reason.
- **The `record` (whisper) dictation path stops by transcribing.** An interrupted
  recording still yields the words spoken before the interruption, so an unexpected
  stop must call `recorder.stop()` rather than discarding the chunks.
- **The dictation cleanup pass may only ever improve text that is already there.**
  Neither transcriber can punctuate a whole utterance — the browser recognizer emits
  none at all, and whisper sees one pause-delimited phrase at a time — so
  `POST /api/polish` (`polish.js`) makes one Bedrock Haiku pass over the finished
  text. Four rules, and none of them are optional: the raw transcript is written
  into the composer *first* and every failure path leaves it exactly there; the pass
  runs only after dictation ended and the phrase queue drained, never mid-sentence
  and never after an interruption (Resume continues that dictation); the result is
  discarded unless the dictated span is still untouched, because a reply about text
  the user has since edited or sent would overwrite newer work; and the dictated
  text is data, never an instruction — the prompt says so, and `looksLikeCleanup()`
  rejects a model that answered instead of editing. In the overlay the clipboard
  write happens inside the tap, *before* the pass, both because iOS refuses a write
  issued after an `await` and because the copy is the only handover. Covered in
  `smoke-test.js` (span guards, the switch, a send that waits) and `overlay-test.js`
  (copy order, a 503).
- **The CLI's flags are process arguments**, so model, permission mode and effort
  are fixed for the life of a conversation. Settings changes apply to new chats
  only. This is not a bug to fix.
- **The broker is byte-transparent, and must stay that way.**
  `chat-service/session-manager.js` translates stream-json into a small vocabulary
  for its own UI; `claude-broker/broker.js` deliberately does not, because it is
  standing in for a pipe in front of a UI it does not own. It parses exactly one
  thing — the `system` event carrying `session_id`, so a session opened with no id
  can be re-keyed and found by the next device resuming that id. Everything else is
  forwarded verbatim. Interpreting more would couple it to a vendor bundle that
  updates on its own schedule.
- **Replay is all-or-nothing, so it is capped.** A page joining mid-conversation is
  sent every byte written so far, because a partial stream cannot be rendered. Past
  64 MB the session stops accepting new pages instead of handing one a broken
  stream — and a refused page just gets its own process, which is only the old
  behaviour. Do not "fix" the cap by replaying a suffix.
- **The panel spawns two `claude` processes per page load, and only speaks to
  one.** Before the conversation itself it starts a probe — `--permission-mode
  default`, no `--resume` — that it never writes a byte to. Through the broker
  that probe became a resident process nobody could ever name, because a session
  with no id is keyed `pending:` and only the CLI's init event (which needs input)
  re-keys it. Ten of them were live on the box at ~205 MB each, 2.0 GB of 7.8 GB,
  one per reload. So `Session#detach` stops a session that has never been written
  to once its last client leaves. Keyed on input, not on the `pending:` key,
  deliberately: a session that *was* spoken to may have a turn in flight and must
  survive to `IDLE_MS` even when nothing can name it. If you widen that condition,
  the thing you are risking is killing live work.
- **The wait when you open a conversation on another device is not the broker's,
  and cannot be fixed there.** It is the panel reloading the transcript: measured
  1.75–3.97 s in the extension host between the webview asking for the session and
  `claude` being launched, across twelve page loads, all of it *before* the broker
  is contacted. For comparison, the broker's replay of the same conversation was
  4 ms to first byte and 7 ms complete, and the real CLI on `--resume` with no
  input emits **0 bytes** — history never travels through the broker; the extension
  reads the `.jsonl` itself. The panel also renders oldest-first, so the newest
  message, the one you need in order to reply, arrives last. All of that is inside a
  proprietary webview: there is no setting for it among the extension's 19, and
  nothing in this repo can reorder it. The only lever we have is transcript size,
  which the wait scales with. What we did instead was answer the question from
  outside the panel — see `chat-service/claude-status.js` and the chip in
  `pwa/mobile-overlay.js` — so you can tell whether the wait is worth sitting
  through. If someone reports this as slow, do not go looking in `broker.js`.
- **A transcript cannot tell you whether Claude is working.** There is no turn-end
  marker on disk: 0 `"type":"result"` entries across every transcript on the box,
  against 5606 `assistant` entries. Only the process holding the stream sees the
  `result` event, which is why `broker.js` tracks `turnInFlight` and answers
  `op: 'status'`, and why that op is the authority. The transcript can be *inferred*
  from the last `stop_reason` (`tool_use` means a tool is running, `end_turn` means
  the turn is over) but that is the state the conversation was **left** in, not
  proof anything is still running it — a conversation abandoned mid-turn reads as
  "working" forever. Keep the two labelled apart, as `claude-status.js` does with
  `source`. Conflating them puts "Claude is working…" over a conversation that will
  never answer.
- **`op: 'status'` needs a broker restart to appear, and a restart ends every live
  conversation.** Same rule as any `broker.js` change (see above): `install.sh` uses
  `enable --now`, never `restart`, so new code sits on disk until someone chooses a
  moment when losing the running work is acceptable. Until then a broker without the
  op reads the status frame as a handshake and refuses it — which callers treat as
  "cannot say" and fall back to the transcript, so the chip degrades to an inferred
  answer rather than a wrong one. That is the intended behaviour, not a bug to fix
  by restarting the unit from a deploy path.
- **Reading the last message aloud is in the overlay, and there is nowhere else it
  could be.** The Read aloud button in the status sheet is the other half of the
  mic: dictation carries a phone-shaped question in, this carries the answer back
  out. It cannot be done from the extension — the panel is a proprietary webview,
  and the extension host is a node process with no audio device, so neither can
  make a sound — and it needs no new route, because `/api/claude-status` already
  returns the text. So the workbench page speaks, using the Web Speech API, and the
  panel is untouched. Two rules hold it together, both of them ones the dictation
  sheet already lives with: the first utterance is queued **synchronously inside the
  click**, because iOS refuses speech that did not start in a gesture (the same
  reason `Copy` writes the clipboard before it awaits anything), and utterances are
  queued **one at a time, chained on `end`**, because iOS speaks the first of a long
  queue and drops the rest. It is also a button on purpose and has no timer or
  subscription anywhere: a turn can end while you are talking to someone, and a
  phone that starts speaking by itself is worse than one that stays quiet. While it
  reads, the bar's status button *is* Stop — it pulses, its glyph changes, and it
  does not reopen the sheet — because the sheet is dismissed by tapping beside it
  and the voice carries on afterwards, so at that point the bar holds the only
  control there is. Do not "fix" it back into a plain open-the-sheet button. And it
  never speaks over a live microphone — `startDictation` stops it and `speak`
  refuses while the mic button carries `cmo-rec` — because the recognizer would
  otherwise dictate Claude's own reply into the composer and the whisper recorder
  would upload it to be transcribed.
- **The markdown is reduced before it is spoken, and the reduction is
  deliberately lossy.** A final message is written to be read: spoken literally it
  is "asterisk asterisk Done asterisk asterisk", every slash of every path read
  out, and a fenced diff pronounced one bracket at a time. So `speakable()` in
  `pwa/mobile-overlay.js` strips the markup, says " Code block. " where a fence was,
  says "link" where a URL was, reduces a path to its file name and `auth.js:42-51`
  to "auth.js, line 42 to 51", and cuts at the last full stop inside 2400
  characters — saying that it has, because a summary that just stops sounds like the
  answer ending there. Two decisions in it are not obvious and both have a test:
  **a blank line ends a sentence and a single newline does not**, which is what those
  two mean in markdown and also how they sound — a full stop dropped into
  hard-wrapped prose is heard as a real one and changes what the sentence says, so
  headings, bullets and table rows are terminated earlier, in the pass where their
  marker is still there to prove they were one; and **anything spoken before the
  message is passed as `speak`'s `lead`, not concatenated in front of it**, because
  the strips are anchored to the start of a line, so text put ahead of the first line
  hides the marker on it (`## Done` was read out as "hash hash Done" that way). It is
  all deterministic and local rather than a call to `polish.js`, which would do it
  better: a model round trip between the tap and the first word is exactly what iOS
  will not allow.
- **Three things now read the same markdown, and they want different reductions.**
  `renderMarkdown()` draws the status sheet, `plainLine()` feeds the chip and the
  conversation list, `speakable()` feeds the voice — and the temptation on finding
  three is to unify them. Don't: a heading is an element in the sheet, nothing at all
  on a one-line chip, and a sentence boundary out loud. What *is* shared is the one
  rule none of them may break, which is that a message from a model is text.
  `renderMarkdown` returns a `DocumentFragment` built with `createElement` and
  `textContent`; it never assembles markup, and the escape-then-`innerHTML` pattern
  in `chat-service/public/app.js` is not the precedent to copy into the editor,
  because this script runs in a page that can drive the workbench. The single
  attribute taken from a message is a link's `href`, and it is only set when it
  matches `/^(https?:\/\/|\/)/` — a `javascript:` URL in a reply must never become
  something a tap runs. `overlay-test.js` puts an `<img onerror=…>`, a `<b>` inside a
  fence and a `javascript:` link through it for exactly that reason, and those three
  checks are the ones to keep if anything here is ever rewritten. One consequence
  worth knowing before you write an assertion: the sheet's `textContent` is no longer
  the message, because the markers are gone from it. And one judgement already made
  and reversed, so it does not get made again: tables were left out of the first
  version on the grounds that they do not fit a phone. They are most of what a status
  answer is made of — surface, check, result — and a table left as source does not fit
  a phone either, it is a screenful of pipes. They render now, scrolling sideways as a
  unit rather than wrapping every cell, which would lose the alignment that made the
  thing a table.
- **A `setTimeout(closeSheet, …)` closes whatever sheet is open when it fires, not
  the one that scheduled it.** Tap `Copy & close` in the dictation sheet and then
  open the status sheet within 700 ms, and the delayed close dismisses the new one.
  Latent for as long as the delay existed, and it surfaced as a *test* flake — 3 of
  10 parallel `overlay-test.js` runs against 0 for HEAD — because the speech work
  added just enough latency for the race to land. Hence `openSheet` bumps
  `sheetGeneration` and `closeSheetLater(ms)` only closes if the generation still
  matches. Use `closeSheetLater`, never a bare `setTimeout(closeSheet, …)`.
- **No regex lookbehind in `pwa/mobile-overlay.js`.** `/(?<=[.!?])\s+/` is the
  obvious way to split sentences and the one thing that must not be written here: an
  unsupported lookbehind is a **parse** error, so the whole file fails to load and
  every button on the bar disappears — the exact silent failure `overlay-test.js`
  exists for, and the one it cannot catch, because it runs on node where the syntax
  is fine. `splitSentences()` is a hand-written scanner for that reason. The same
  caution applies to anything else that is a syntax error rather than a runtime one
  in an older Safari.
- **"Claude is working" means a message was sent, not that bytes were written.**
  The panel runs with `--permission-prompt-tool stdio`, so it writes to the CLI's
  stdin constantly with nobody typing: `control_request` / `control_response`
  frames for every tool approval, `set_permission_mode`, `auth_status`. None of
  them draws a `result`, so the first version of `claude-broker`, which treated any
  write as the start of a turn, latched `turnInFlight` on and never cleared it —
  **11 of 13 live sessions on the box reported "working", nine of them processes
  that had never run a single turn.** `Session#write` therefore parses whole lines
  out of the input and only claims a turn for `{"type":"user",…}` (see
  `#noteTurnStart`, and `MAX_INPUT_LINE` for the pasted-file case). Being wrong in
  the two directions is not symmetrical, which is why it is written this way round:
  a *missed* message leaves a stale "working", which makes you wait and look again,
  where a false one makes the badge say "your turn" over a live turn and invites
  typing over it.
- **That same flag is what reaps the panel's probes, so do not add `sessionId` to
  the test.** `detach()` stops a session only when it was never spoken to, which is
  how the probe the panel spawns on every page load (no `--resume`, never written
  to) stops costing ~210MB for `IDLE_MS`. It is tempting to also require
  `!this.sessionId` there — an id looks like proof of a conversation — but **every**
  process announces one in its own `system`/`init` event, probe included, so that
  clause silently parks every probe again. `broker-test.js` catches it.
- **Which conversation is on screen cannot be known from outside the panel, so the
  answer names its guess.** The panel is a vendor webview: it reports nothing about
  itself and fires no page event when you switch conversations. The first version of
  `claude-status.js` answered per *project* — least-idle live session wins — and a
  project here has four live conversations, so switching left a badge confidently
  describing a different one. `guessConversation()` now picks among the sessions
  that hold a broker client (the panel drops the client when it moves on; exactly
  one of the four had one), breaks ties on `spokeMs` rather than `idleMs` (resuming
  a conversation produces output with nobody typing, so only `spokeMs` says which
  one is being *used*), and the reply carries `title`, `sessionId` and every other
  conversation in the project so the overlay can name the guess and let a tap pin a
  different one (`&sessionId=`). Keep it that way: a wrong guess that is named is
  correctable, where a silent one reads as a stale badge. Nothing outside the panel
  will ever be able to do better than this, so do not "fix" it by removing the list.
- **A stale "working" is corrected by the transcript, and that override is what
  makes this deployable.** `OVERRIDE_QUIET_MS` (10s) in `claude-status.js` lets a
  finished-looking transcript overrule a broker that says "working" — but only when
  the stream has been silent that long, because a turn in flight is never silent
  (deltas arrive, tools announce themselves). It exists because the broker's fix
  above only takes effect when the daemon restarts, and **restarting
  `claude-broker` ends every live conversation** — so the client half has to be
  correct on its own against a broker that is still latching. The bound also
  protects the opposite race: a message sent a moment ago and not yet on disk.
- **A panel-internal conversation switch fires no page event, so the overlay
  re-asks on a timer.** `STATUS_HEARTBEAT_MS` (15s, visible tabs only, skipped
  while the 4s working poll is running) plus a silent refresh on window `focus`.
  Without them nothing re-checked after a switch, which is what "the status is
  stale when you switch conversation" was. A silent refresh only puts the chip back
  when the conversation changed or a turn finished — never merely because the timer
  fired, or a dismissed chip would return every fifteen seconds.
- **A deploy cannot apply an `infra/userdata/bootstrap.sh` edit to a running
  instance.** cloud-init runs `scripts-user` once per instance *ever*
  (`/var/lib/cloud/instances/<id>/sem/config_scripts_user`), so `/opt/bootstrap.sh`
  stays whatever first boot wrote, and the deploy's reprovision step re-runs that
  stale copy. A stack update usually stop/starts the instance rather than replacing
  it — verified on 2026-09-17: same instance id, new boot time, `/opt/bootstrap.sh`
  two days old, zsh and `claude-tmux.service` simply absent after a "successful"
  deploy. Anything that must actually land goes in the payload, which is why
  `claude-broker/install.sh` exists and why `cc` is installed from there too.

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
- Do not end a piece of work uncommitted, unpushed, or undeployed without saying
  so. See ["Finishing" is committed, pushed, and
  deployed](#finishing-is-committed-pushed-and-deployed) — it is the first thing
  in this file for a reason.

## Verifying your work

There is no staging environment, so local verification is what you have:

```bash
npm test                                   # auth + client + panes + overlay + polish
                                           # + project lifecycle + per-project manifest
                                           # + operations surface + conversation status
                                           # + push + turn watcher + broker
cd infra && npx cdk synth --quiet          # stack compiles
bash -n deploy.sh migrate.sh infra/userdata/bootstrap.sh claude-broker/install.sh
node --check chat-service/server.js
```

One caveat for the broker: `npm test` proves it shares a process and falls back
safely, using a fake CLI over a real socket. It cannot prove the *panel* renders a
replayed stream correctly, because that is the vendor's UI reacting to bytes it
normally sees live. Only two real devices show that.

`nginx -t` cannot run locally unless nginx is installed; `deploy.sh` runs it on
the instance and fails the deploy if the config is invalid.

Be honest about what you did and did not verify. "Synthesizes and passes the auth
tests, not deployed" is a useful, accurate statement. "Works" is not, unless you
watched it work.

And "not deployed" is a statement about an unfinished job, not a resting place:
verifying is the step before shipping, never instead of it. Go back to ["Finishing"
is committed, pushed, and
deployed](#finishing-is-committed-pushed-and-deployed) and finish.
