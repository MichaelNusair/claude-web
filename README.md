# claude-web

Claude Code as a chat app you can install on your phone, running on your own AWS
account. Send a message, Claude works on your repo, you get an answer. The full
VS Code editor is still there at `/editor/` when you're at a desk and want files,
diffs, and a terminal.

Your sessions live in the cloud, so the conversation you start on a laptop is the
one you pick up on a phone — mid-task, with context intact.

```bash
git clone https://github.com/MichaelNusair/claude-web.git
cd claude-web
cp claude-web.config.example.json claude-web.config.json
$EDITOR claude-web.config.json     # domainName + hostedZoneName
./deploy.sh
```

You need an AWS account, a Route53 hosted zone, and Bedrock model access. Full
walkthrough in [docs/DEPLOY.md](docs/DEPLOY.md).

> **Read [docs/SECURITY.md](docs/SECURITY.md) before you expose this.** It
> deploys a web page that runs shell commands on a machine you own — that's the
> product, not a side effect. Anyone who logs in has a shell. Deploy it as a
> personal workspace, not a shared service.

## Why it's built this way

The first version served VS Code in the browser with the official Anthropic
extension. That works well on a laptop and is genuinely painful on a phone — which
is the device you actually want this on. So the primary interface is a
purpose-built chat, and the editor is the secondary surface.

The chat isn't a reimplementation of Claude's brain; it's a thin UI over the real
`claude` CLI. Each conversation is **one long-lived process** driven over
`--input-format stream-json`, which is what makes it behave like a messaging app
rather than a series of one-shot commands: context, working directory, and session
id all persist, and a follow-up message costs no startup.

```
your-domain.com
  │
  ALB :443  ── ACM cert (created for you), :80 → :443
  │           4000s idle timeout (a turn can run for many minutes)
  │
  EC2 t4g.large (Graviton, arm64) — reachable only from the ALB
  ├── nginx :8080
  │     ├── /          → chat service (:9997)
  │     ├── /chat/     → chat assets
  │     ├── /editor/   → code-server (:9999)
  │     └── /          → code-server, for its own absolute asset URLs
  │
  ├── claude-chat service
  │     ├── authenticates every request itself  ← the security boundary
  │     ├── one `claude` process per conversation, kept alive
  │     ├── stream-json → a small event vocabulary for the UI
  │     └── /api/transcribe → whisper.cpp, on-box, no API key
  │
  ├── code-server + official anthropic.claude-code extension
  │
  └── /workspace  ← persistent EBS, survives instance replacement
        ├── projects/   one directory per repo
        ├── claude/     ~/.claude — session history lives here
        └── code-server-{data,ext}/

  Bedrock via instance role — no model keys in the browser
```

## The chat

- **Conversation list** — every past session across every project, newest first,
  titled by its opening message. Tap to resume; the transcript is replayed and
  Claude still has its context.
- **Tool calls** as collapsible cards (`📖 Read src/main.c`) — tap for arguments
  and full output. Failures auto-expand.
- **Live streaming** text, with a typing indicator while Claude works.
- **Stop button** while a turn is running.
- **Drafts survive the app going away** — a half-typed or half-dictated message is
  saved as you write it and restored with the conversation, because a phone browser
  reloads a backgrounded tab whenever it likes and a paragraph of dictation exists
  nowhere else.
- **Reconnect-safe** — the server keeps the process alive when your phone locks or
  the network drops. Reattaching resumes the same conversation mid-task, including
  work started from another device.
- **One-tap new project** — creates the directory, a git repo, and optionally a
  GitHub remote.
- **Clone an existing GitHub repo** — paste `owner/repo`, or tap one from the list
  of repositories the workspace token can see.
- **Retire a project** — commits, pushes every branch and tag, checks with the
  remote that it really landed, then deletes the folder from the instance. It
  refuses if anything would be lost (no remote, a stash, a push that failed) and
  says which; overriding is a separate, deliberate tap. Chat history is kept.

## Sessions that outlive the browser, and follow you between devices

Start something on your phone, arrive home, open the same project on your laptop,
and keep watching the same run. That works because the editor's Claude runs in a
**tmux** session rather than inside the browser page.

It has to. The extension's own panel runs `claude` as a child of the extension
host, and code-server creates one extension host *per browser page* — then tears
it down within **five seconds** of the last WebSocket closing. So the panel does
not hand off between devices; it *forks*. The second device starts its own
`claude`, resumes the same session from the transcript on disk, and the first one
carries on running, untouched. Both then append to the same file and diverge. What
you see is your laptop showing the conversation sitting idle while your phone is
still working, and the two telling different stories a minute later.

tmux fixes it because the session belongs to a server parented to systemd, not to
any terminal or page:

- closing the editor, the browser, or your laptop changes nothing
- **attaching from a second device joins the same live session** — same screen,
  same scrollback, mid-turn — rather than starting a second Claude
- it survives a reload, a dropped connection, a code-server restart and a redeploy

Verified on a live box: two clients attached at once, one session, one `claude`
process, and the session still running after both detached.

The Claude button on the editor does this for you. From a shell, the same thing by
hand:

```bash
cc                      # list live sessions and projects
cc my-project           # start, or rejoin, a permanent session
cc my-project --kill    # end it
```

Because it is the real CLI, `/model`, permission modes, `@file` references,
thinking and tool output are all the genuine thing rather than a copy of it.

If you would rather have the extension's panel — richer diffs and tool cards, at
the cost of being single-device — set `claudeMobile.claudeSurface` to `panel`.

## Voice

Tap the mic, talk, tap to stop. The transcript is inserted **at your cursor** with
sensible spacing, so you can dictate into the middle of a half-typed message, move
the caret, and dictate again.

Transcription runs **on the instance** (`whisper.cpp`, `base.en`): no API key, no
quota request, nothing per request, and audio never leaves the box. Measured on 2
vCPUs, ~4s for 11s of audio.

**Then it gets punctuated.** Raw speech-to-text is the one place this used to feel
worse than a consumer app: no punctuation, no capitals, and every product name
mangled — "compared to ChatGPT and Gemini apps" arrives as "compared to Georgia PT
and Germany apps". Neither engine can do better on its own, because sentence
boundaries and proper nouns need the whole utterance and both of them work in
fragments: the browser's recognizer emits no punctuation at all, and whisper sees
one pause-delimited phrase at a time so that text keeps up with the speaker.

So when you stop talking, the finished text gets one pass through Claude Haiku on
Bedrock — punctuation, capitals, the names it plainly misheard, filler removed —
and nothing else. It never answers or acts on what you dictated, and it never
rewrites your words. The raw transcript is in the composer first and stays there
if the pass fails, times out, or comes back looking like a reply rather than an
edit; a send that lands mid-pass waits a moment for it. Costs a second or two and
a few tokens per dictation; the switch is in Settings, and it covers the editor
overlay too, where it runs after the text is already on your clipboard.

A long dictation used to end without warning: a phone being talked into is a phone
nobody is touching, so the display sleeps on its idle timer, and the speech
recognizer goes with it. The screen that was showing "recording" is the thing that
turned off, so there was nothing to notice. Now:

- the app **holds the screen awake** for as long as it is open — see below;
- the status bar above the composer counts the seconds, so a stalled recognizer is
  visible at a glance rather than inferred from silence;
- and any stop you did not ask for **beeps, buzzes, and leaves a banner** that is
  still there when you look at the phone again. The words already dictated stay in
  the box, and Resume carries on from where it stopped.

Where a wake lock is not available the status bar says so outright rather than
promising a screen that will sleep anyway.

## Keeping the screen awake

The phone's display sleeps on its idle timer, and this app is used in long
stretches where nobody is touching the screen: dictating a paragraph, watching a
task run for two minutes, reading a long answer. When the display sleeps the page
is hidden, and hiding the page suspends the recognizer and freezes the WebSocket —
so the idle timer is not a cosmetic annoyance, it ends whatever was in flight.

So the **Screen Wake Lock** is held for as long as the app is open and in front,
not only while dictating. It is on by default, the switch is in Settings, and one
switch covers both the chat and the editor — they are one origin behind nginx, so
they share the setting. Three properties of the API shape the implementation:

- it needs a **visible** document; requesting while hidden is rejected;
- the browser **releases it on every hide and never re-acquires it**, so every
  return to the foreground has to re-request;
- the OS **revokes it whenever it likes** (battery saver, low battery) with no
  event to say you may have it back, so the only way to notice is to keep asking.

Hence one `syncWakeLock()` that reconciles held-against-wanted, called from every
event that can change either, plus a 30s timer for the revocation case. Turning the
setting off still lets dictation hold the screen: "off" means *don't burn my battery
while I read*, not *cut me off mid-sentence*.

What no web page can do is keep the display on once you leave the app or press the
power button — that is the OS's decision and the page is not consulted. Nor is there
a workaround from inside a browser with no wake lock API at all (iOS before 16.4);
there, raise the screen timeout in the OS settings. That residue is why the
"announce every stop we did not ask for" behaviour above still exists rather than
being replaced by the wake lock.

Two more details worth knowing:

- **The browser converts audio to 16 kHz mono WAV before uploading.** Browsers
  record webm/**opus**, and the bundled decoder (miniaudio) handles WAV/MP3/FLAC/
  Vorbis but *not* Opus — and Amazon Linux 2023 has no ffmpeg package. The browser
  already has an Opus decoder, so it does the conversion via WebAudio. 16 kHz mono
  is also exactly what Whisper wants, so uploads shrink.
- **`base.en` is English-only.** For other languages, swap `WHISPER_MODEL` to a
  multilingual build (`ggml-base.bin`) in `/etc/claude-voice.env`.

Azure OpenAI Whisper is supported as an optional override, falling back to local
if Azure errors. See [docs/DEPLOY.md](docs/DEPLOY.md).

## The editor on a phone

`/editor/` is real code-server, with the activity bar, status bar and tabs stripped
so Claude gets the whole screen. A small bar of buttons — dictate, switch project,
terminal, fix the layout — floats over it; long-press any of them to move the bar
to the other edge.

Claude opens **in the editor area**, full width, as the tmux session described
above — so it is the real CLI, and it is the same session on every device you open
it from. The Claude Code extension is still installed and its panel is one setting
away (`claudeMobile.claudeSurface: panel`).

The terminal button opens a second, plain shell, also in the editor area, and
pressing it again hands the window back to Claude — with tabs hidden, the two just
take turns. It reuses the shell you already had rather than opening another,
including across a page reload. It is for the quick things (`git log`, run a test);
that shell dies with its tab, which is exactly why Claude does not live in one.

That shell is **zsh** — completion, shared history, and a two-line prompt with the
git branch, so a long path does not leave you three columns to type in on a phone.
History lives on the workspace volume rather than in `/home`, so a command typed
on a phone can be recalled on a laptop, and it survives the instance being
replaced. Your own additions go in `~/.zshrc`, which a deploy leaves alone.

The layout button is there because of one specific way the editor gets stuck: tap
a file in the transcript and it opens beside the panel, and with no tabs and no
status bar there is nothing on screen that closes it again. The panel keeps
whatever width is left, and reloading brings the file back with it. Three
escalating ways out, because the first two can't confirm they worked:

- **Back to Claude** closes the files and diffs the panel opened and gives Claude
  the whole window. The conversation keeps running; unsaved files are left alone
  rather than raising a save dialog no phone can answer.
- **Show tabs & bars** puts the chrome back so things can be closed by hand.
- **Reload** now recovers on its own — the editor closes restored file tabs at
  startup, so a refresh means what you expect. Set
  `claudeMobile.closeFilesOnStartup` to `false` if you use this as an IDE at a
  desk and want your open editors back after a reload.

A reload of the editor is not free — it restarts the extension host, and the
Claude conversation lives inside it — and it is not always your decision: the
workbench reloads itself when the browser restores the page from its back/forward
cache, which on a phone happens whenever you switch apps and come back. So the
surface no longer adds loads of its own (tapping the project you are already in
does nothing, and the startup layout pass only acts when the layout is actually
wrong), dictated text is saved as you speak it rather than living only in the
overlay's textarea, and the Layout sheet lists this tab's recent loads and what
caused each one — which is the only way that symptom is visible from a phone.

Beyond that, `…/chat/reset.html` clears the service worker, the caches and the
saved workbench state for the device — which is what a black screen or a layout
that survives everything else actually needs. It touches nothing on the server.

## Defaults

Opus 5 on Bedrock, `--permission-mode bypassPermissions`, `--effort xhigh`. All
three are overridable per-chat in the settings sheet, and the deployment-wide
defaults live in `claude-web.config.json`. Changes apply to new chats — an
existing conversation keeps the flags it started with, because they're process
arguments.

`bypassPermissions` means Claude runs commands in the workspace without asking.
That's the point of the UX and the main thing to be aware of; set
`permissionMode` to `acceptEdits` or `plan` if you'd rather have a checkpoint.

## Security

Authentication is enforced inside the application process that spawns `claude` —
not in nginx, not in the load balancer alone. Every route and the WebSocket
upgrade require a session; the server refuses to start without a strong password
and cookie signing key; failed logins are throttled at two layers.

This is stated precisely because an earlier version of this project got it wrong:
the nginx config carried a comment describing an `auth_request` gate that had
never been written, and the chat API sat open to the internet while every document
in the repo said otherwise. So the claim is now checked by machine —
[`chat-service/auth-test.js`](chat-service/auth-test.js) boots the real server and
asserts it, `deploy.sh` refuses to deploy if it fails, and after deploying it
curls the live URL and aborts if the API answers without a login.

```bash
npm run test:auth
```

Full threat model, what it does and does not defend against, and how to reduce the
blast radius: [docs/SECURITY.md](docs/SECURITY.md). Found a hole? Please report it
[privately](https://github.com/MichaelNusair/claude-web/security/advisories/new).

## Install as an app

Open the URL, sign in, then **Add to Home Screen** (iOS Safari) or the install icon
in the address bar (Chrome/Edge/Android). The service worker deliberately caches
nothing — the app is a live WebSocket client, and a stale cached shell would break
it rather than help.

## Cost

Roughly **$75/month** left running: `t4g.large` ~$49, ALB ~$16, 100 GB gp3 ~$8, 40
GB root ~$3, plus Bedrock token usage. Stopping the instance when idle cuts the
compute portion; the workspace volume is retained on stack deletion, so projects
and history survive a stop or a teardown.

## The landing page

[`landing/`](landing/) is the static marketing site — the page at
<https://claude.strikelabs.tech>. It deploys as its own stack (private S3 behind
CloudFront) with no shared resources and no route to the workspace, so public
traffic never touches the machine holding your GitHub token. Optional; skip it
entirely if you're self-hosting for yourself.

```bash
./deploy-landing.sh    # independent of ./deploy.sh
```

## Working on it

`AGENTS.md` (and `CLAUDE.md`) orient both people and AI agents: repo map, the
rules that matter, and the gotchas that have burned people. Contributions welcome
— see [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
npm test                              # auth + client + overlay + dictation + projects
cd infra && npx cdk synth --quiet     # stack compiles
```

## License

MIT — see [LICENSE](LICENSE).
