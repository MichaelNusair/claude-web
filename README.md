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
- **Reconnect-safe** — the server keeps the process alive when your phone locks or
  the network drops. Reattaching resumes the same conversation mid-task, including
  work started from another device.
- **One-tap new project** — creates the directory, a git repo, and optionally a
  GitHub remote.

## Voice

Tap the mic, talk, tap to stop. The transcript is inserted **at your cursor** with
sensible spacing, so you can dictate into the middle of a half-typed message, move
the caret, and dictate again.

Transcription runs **on the instance** (`whisper.cpp`, `base.en`): no API key, no
quota request, nothing per request, and audio never leaves the box. Measured on 2
vCPUs, ~4s for 11s of audio.

Two details worth knowing:

- **The browser converts audio to 16 kHz mono WAV before uploading.** Browsers
  record webm/**opus**, and the bundled decoder (miniaudio) handles WAV/MP3/FLAC/
  Vorbis but *not* Opus — and Amazon Linux 2023 has no ffmpeg package. The browser
  already has an Opus decoder, so it does the conversion via WebAudio. 16 kHz mono
  is also exactly what Whisper wants, so uploads shrink.
- **`base.en` is English-only.** For other languages, swap `WHISPER_MODEL` to a
  multilingual build (`ggml-base.bin`) in `/etc/claude-voice.env`.

Azure OpenAI Whisper is supported as an optional override, falling back to local
if Azure errors. See [docs/DEPLOY.md](docs/DEPLOY.md).

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

## Working on it

`AGENTS.md` (and `CLAUDE.md`) orient both people and AI agents: repo map, the
rules that matter, and the gotchas that have burned people. Contributions welcome
— see [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
npm test                              # auth + client tests
cd infra && npx cdk synth --quiet     # stack compiles
```

## License

MIT — see [LICENSE](LICENSE).
