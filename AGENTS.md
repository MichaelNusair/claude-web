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
npm run test:auth      # must be 41/41 or better; never fewer checks than before
npm run test:client
npm run test:overlay   # 45/45; the editor overlay, its chords, its drafts, its clipboard
npm run test:polish    # 19/19; the dictation cleanup's bounds, and its failure paths
npm run test:projects  # 53/53; real git repos, real pushes
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
  session-manager.js     One `claude` process per conversation; transcripts;
                         the project lifecycle (create, clone, remove).
  transcribe.js          Voice: local whisper.cpp, optional Azure override.
  polish.js              Makes a finished dictation readable: punctuation,
                         capitals, misheard names. Bedrock Haiku, one bounded
                         pass, returns the raw transcript on any failure.
  smoke-test.js          Boots app.js in jsdom — catches load-time breakage.
  polish-test.js         The cleanup's guard rails: what `looksLikeCleanup`
                         must reject, and that every failure path hands the
                         raw transcript back.
  overlay-test.js        Boots pwa/mobile-overlay.js in jsdom. Nothing else
                         loads that file, and it drives the editor by
                         keybinding, so this is what checks both.
  project-test.js        Project removal against real git repos. Deletes trees,
                         so the refusals are what this tests hardest.
  public/                index.html, app.js, style.css, login.html.

claude-broker/           Keeps the editor panel's `claude` alive and shared
                         between devices. No dependencies beyond node.
  broker.js              The daemon: one process per (cwd, session id), byte
                         transparent, replays the stream to a joining page.
  wrapper.js             What the extension launches instead of `claude`. Every
                         failure path execs the real binary — keep it that way.
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
[`claude-broker/wrapper.js`](claude-broker/wrapper.js) instead of the binary. The
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
- **The CDK CLI reads a narrower slice of `~/.aws/config` than the AWS CLI.** A
  profile whose credentials come from `credential_source = Ec2InstanceMetadata`
  fails the CDK step with "Unable to resolve AWS account to use" while every `aws`
  call in the same script, with the same `--profile`, works. `deploy.sh` resolves
  the profile with `aws configure export-credentials` and hands CDK environment
  credentials instead of the flag. It also checks `sts get-caller-identity` up
  front, because the other way this shows up is a configured profile that no
  longer exists — an instance replacement takes `~/.aws` with the root volume
  while `awsProfile` in the config keeps naming it.
- **The service worker deliberately unregisters itself.** It caches nothing. A
  stale cached shell breaks a live WebSocket client rather than helping, and a
  wedged worker has no user-side escape. Do not add caching.
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

## Verifying your work

There is no staging environment, so local verification is what you have:

```bash
npm test                                   # auth + client + project lifecycle + broker
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
