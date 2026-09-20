#!/usr/bin/env node
//
// One `claude` process per conversation, shared by every browser page.
//
// The problem it solves: code-server creates one extension host per browser
// page, and the Claude Code panel's `claude` is a child of that host. Open the
// same project on a phone and a laptop and you get two processes resuming one
// session id, both appending to one transcript, telling two different stories.
// Observed on this box: two extension hosts, three `claude` processes, one
// project. The panel cannot fix this itself — nothing shares an extension host
// between two page loads.
//
// So the panel's stdio is routed here through claude-broker/wrapper, and this
// keeps the process. Both pages then drive the same conversation.
//
// It is deliberately BYTE-TRANSPARENT. It does not translate the stream-json
// vocabulary the way chat-service/session-manager.js does, because it is not
// building a UI — it is standing in for a pipe. Whatever the CLI writes, each
// attached page receives verbatim, which is what lets the extension's own UI
// keep working without knowing any of this is happening.
//
// Security: the control channel is a unix socket inside a 0700 directory owned by
// the service user, never a TCP port. Anything that can write to it can run
// `claude` as that user — but anything that can write to it already has that
// user's shell, so this adds no reachable surface. Do not move it to a port.
import net from 'net';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const SOCKET =
  process.env.CLAUDE_BROKER_SOCKET || '/run/claude-broker/broker.sock';

// Replay is all-or-nothing: a page that joins mid-conversation is sent every
// byte the CLI has written, because a partial stream cannot be rendered
// coherently. So the buffer is capped, and a conversation that outgrows it stops
// accepting new pages rather than handing one a broken stream — that page then
// gets its own process, which is only today's behaviour, not a failure.
const MAX_LOG_BYTES = Number(process.env.CLAUDE_BROKER_MAX_LOG || 64 * 1024 * 1024);

// A conversation nobody is watching is still worth keeping — that is the entire
// point — but not forever, or every conversation ever opened stays resident.
const IDLE_MS = Number(process.env.CLAUDE_BROKER_IDLE_MS || 12 * 60 * 60 * 1000);

/*
 * The end of a turn, as it appears in the stream.
 *
 * This is the one thing about a conversation that cannot be recovered from disk.
 * A transcript records what was said, not whether anything is still saying it:
 * there is no turn-end marker in the .jsonl at all — 0 `result` entries across
 * every transcript on the box, against 5606 `assistant` entries. So "is Claude
 * working right now, or is it my turn" exists in this process and nowhere else,
 * which is what `op: 'status'` is for.
 *
 * Matched as a substring rather than by parsing each line. This runs on every
 * chunk of every conversation, and one bit does not justify JSON.parse over a
 * stream that can reach MAX_LOG_BYTES. The failure mode is also the harmless
 * one: a missed `result` leaves the answer at "working" until the next turn
 * ends, which is a stale badge, not a broken conversation.
 */
const RESULT_EVENT = '"type":"result"';

/*
 * The start of a turn: a user message, and ONLY a user message.
 *
 * The panel's stdin carries far more than what someone typed. It launches Claude
 * with `--permission-prompt-tool stdio`, `--enable-auth-status` and
 * `--setting-sources`, and every permission decision, mode change and auth probe
 * comes back down this same pipe as a `control_request`/`control_response` frame.
 *
 * Treating any write as the beginning of a turn therefore latched `turnInFlight`
 * on permanently, because a control frame draws no `result` to clear it. Measured
 * on the box before this fix: 11 of 13 live sessions reported "working", nine of
 * them processes that had never run a single turn. A badge that says "working"
 * about everything answers nothing.
 *
 * So the input side is parsed by line, unlike the output side. It can afford to
 * be: this is what a person typed, not what the model produced.
 */
const USER_MESSAGE = '"type":"user"';

/*
 * A single input line is normally tiny, but a pasted file is one line and can be
 * megabytes. Past this, stop waiting for the newline and decide on what is here.
 */
const MAX_INPUT_LINE = 256 * 1024;

const log = (...args) => console.log(new Date().toISOString(), ...args);

/** Sessions by merge key, plus a lookup by the id the CLI reports. */
const sessions = new Map();

function keyFor(cwd, id) {
  return `${cwd}|${id}`;
}

class Session {
  constructor({ cwd, claude, args, env, key }) {
    this.cwd = cwd;
    this.key = key;
    this.clients = new Set();
    this.chunks = [];
    this.logBytes = 0;
    this.truncated = false;
    this.sessionId = null;
    this.lastActivity = Date.now();
    /*
     * When a PERSON last had anything to do with this conversation: it was
     * created, a page attached or detached, or something was written to it.
     * Deliberately not bumped by the CLI's own output, which is what separates
     * this from `lastActivity`.
     *
     * IDLE_MS is measured against this, and has to be, or a parked conversation
     * never dies. `lastActivity` moves on every byte the CLI writes, and these
     * processes are launched by the panel with `--debug --debug-to-stderr`, so
     * they chatter while nobody is watching. Measured on the box before this
     * fix: five parked conversations, last spoken to between 1.6h and 22.8h
     * earlier, every one of them reporting an idle time of 194 seconds and all
     * five advancing in lockstep — one shared event resetting all five clocks,
     * over and over. The 12-hour reaper had therefore never fired for any of
     * them, and nine processes held ~2.0GB until someone found the Stop button.
     */
    this.attendedAt = Date.now();
    this.exited = false;
    // Whether anyone has ever sent this process a MESSAGE — not merely bytes. A
    // session that has not been spoken to holds no conversation: nothing was
    // asked, nothing is running, and its transcript is empty. See `detach`, and
    // see USER_MESSAGE for why the distinction is not academic: the panel writes
    // control frames to the probes it never uses, and counting those as being
    // spoken to parked nine of them on this box at ~210MB each.
    this.spokenTo = false;
    // Whether Claude owes an answer: set by a user message going in, cleared by
    // the `result` event that ends the turn. This is the stop-button-vs-send-button
    // bit, and the reason anything asks this service for status at all.
    this.turnInFlight = false;
    // Trailing bytes of the last chunk, so a `result` split across two chunks is
    // still seen. Copied rather than kept as a view into a stream buffer.
    this.turnTail = Buffer.alloc(0);
    // Partial input line, so a message split across two writes is still seen as
    // one frame. See #noteTurnStart.
    this.inputBuffer = '';
    // When someone last actually said something to this conversation, as opposed
    // to when the CLI last wrote a byte. This is what identifies the conversation
    // a person is in: a resumed one emits output while being read back, but only
    // the one being used is spoken to.
    this.spokeAt = null;
    // Only used to spot the init event; forwarding never waits on it.
    this.lineBuffer = '';

    this.proc = spawn(claude, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });

    this.proc.stdout.on('data', (chunk) => {
      this.lastActivity = Date.now();
      this.#record(chunk);
      this.#broadcast('out', chunk);
      this.#sniffSessionId(chunk);
      this.#noteTurnEnd(chunk);
    });

    this.proc.stderr.on('data', (chunk) => {
      this.lastActivity = Date.now();
      // Not recorded for replay: stderr is diagnostics, and replaying old
      // warnings to a page that just joined would surface them as if they had
      // happened now. The extension watches stderr for real errors, so live
      // delivery still matters.
      this.#broadcast('err', chunk);
    });

    this.proc.on('exit', (code) => {
      this.exited = true;
      log(`session ${this.key} exited code=${code} clients=${this.clients.size}`);
      for (const client of this.clients) {
        this.#send(client, { s: 'exit', code });
      }
      this.#unregister();
    });

    this.proc.on('error', (err) => {
      this.exited = true;
      log(`session ${this.key} failed to start: ${err.message}`);
      for (const client of this.clients) {
        this.#send(client, { s: 'exit', code: 126 });
      }
      this.#unregister();
    });
  }

  #record(chunk) {
    if (this.truncated) return;
    this.logBytes += chunk.length;
    if (this.logBytes > MAX_LOG_BYTES) {
      this.truncated = true;
      this.chunks = [];
      this.logBytes = 0;
      log(`session ${this.key} exceeded ${MAX_LOG_BYTES} bytes; no longer joinable`);
      return;
    }
    this.chunks.push(Buffer.from(chunk));
  }

  /**
   * The CLI announces the real session id in its `system`/`init` event. A page
   * that started a NEW conversation had no id to key on, so the session is
   * re-keyed here — that is what lets a second device, which arrives with
   * `--resume=<that id>`, find this live process instead of starting its own.
   */
  #sniffSessionId(chunk) {
    if (this.sessionId) return;
    this.lineBuffer += chunk.toString();
    const lines = this.lineBuffer.split('\n');
    this.lineBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim() || !line.includes('session_id')) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === 'system' && event.session_id) {
        this.sessionId = event.session_id;
        const newKey = keyFor(this.cwd, event.session_id);
        if (newKey !== this.key) {
          sessions.delete(this.key);
          this.key = newKey;
          sessions.set(newKey, this);
          log(`session re-keyed to ${newKey}`);
        }
        // Stop accumulating; this buffer exists only for this one lookup.
        this.lineBuffer = '';
        return;
      }
    }
  }

  /**
   * Notice the turn ending, so `op: 'status'` can answer the only question a
   * joining device cannot answer for itself. Runs after the chunk has already
   * been forwarded: this is a badge, and nothing waits on it.
   */
  #noteTurnEnd(chunk) {
    if (!this.turnInFlight) return;
    // Enough trailing bytes to bridge two chunks: an occurrence that straddles the
    // boundary has at most this many bytes on the far side of it.
    const span = RESULT_EVENT.length - 1;

    // The chunk on its own first — the common case, and it copies nothing.
    let ended = chunk.includes(RESULT_EVENT);
    if (!ended && this.turnTail.length) {
      ended = Buffer.concat([this.turnTail, chunk.subarray(0, RESULT_EVENT.length)])
        .includes(RESULT_EVENT);
    }
    if (ended) {
      this.turnInFlight = false;
      this.turnTail = Buffer.alloc(0);
      return;
    }

    // The tail of the STREAM, not of this chunk. Keeping only the last chunk's
    // tail looks equivalent and is not: a CLI flushing a byte at a time — which it
    // does whenever a flush lands mid-token — then never accumulates enough
    // context to recognise anything, and the turn never appears to end.
    this.turnTail = chunk.length >= span
      ? Buffer.from(chunk.subarray(chunk.length - span))
      : Buffer.concat([this.turnTail, chunk]).subarray(-span);
  }

  /**
   * Whether these bytes contain the start of a turn.
   *
   * Line-buffered and parsed, rather than matched as a substring the way the
   * output side is, because the difference that matters here is between a frame
   * whose `type` is `user` and a control frame that merely mentions one — a
   * permission response carrying a tool input, say. A substring match on the
   * whole stream would call that a turn and latch the badge on, which is the bug
   * this replaces.
   */
  #noteTurnStart(chunk) {
    this.inputBuffer += chunk.toString();
    const lines = this.inputBuffer.split('\n');
    this.inputBuffer = lines.pop() || '';

    if (this.inputBuffer.length > MAX_INPUT_LINE) {
      // A very long line: decide on what has arrived and stop accumulating. A
      // false positive here costs a badge that says "working" until the turn that
      // is almost certainly starting anyway ends.
      const looksLikeMessage = this.inputBuffer.includes(USER_MESSAGE);
      this.inputBuffer = '';
      if (looksLikeMessage) return true;
    }

    for (const line of lines) {
      // Cheap gate before parsing: every frame this cares about contains the
      // word, and the ones it does not care about are the common case.
      if (!line.includes('user')) continue;
      try {
        if (JSON.parse(line).type === 'user') return true;
      } catch {
        /* not a frame we can read; not a turn we can claim */
      }
    }
    return false;
  }

  #send(client, frame) {
    if (client.destroyed) return;
    client.write(`${JSON.stringify(frame)}\n`);
  }

  #broadcast(kind, chunk) {
    const frame = { s: kind, d: chunk.toString('base64') };
    for (const client of this.clients) this.#send(client, frame);
  }

  #unregister() {
    if (sessions.get(this.key) === this) sessions.delete(this.key);
  }

  attach(client) {
    this.clients.add(client);
    this.lastActivity = Date.now();
    this.attendedAt = Date.now();
    // Everything written so far, so the page can rebuild its view. One frame per
    // recorded chunk keeps the byte stream identical to what a sole client saw.
    for (const chunk of this.chunks) {
      this.#send(client, { s: 'out', d: chunk.toString('base64') });
    }
    log(`session ${this.key} attached; clients=${this.clients.size}`);
  }

  detach(client) {
    this.clients.delete(client);
    this.lastActivity = Date.now();
    // The reaper's clock starts here for a conversation being left behind, which
    // is what keeps "read an old conversation, close the tab, come back" from
    // finding a dead process: leaving is attention too.
    this.attendedAt = Date.now();
    log(`session ${this.key} detached; clients=${this.clients.size}`);

    // Keeping a watched-by-nobody conversation is the entire point of this
    // service — but only if there is a conversation. The panel spawns TWO
    // processes on every page load: a probe (`--permission-mode default`, no
    // `--resume`) that it never writes a byte to, and then the real one. Left to
    // IDLE_MS, each page load therefore parked ~205MB for twelve hours; ten of
    // them were resident on the box (2.0GB of 7.8GB) after an afternoon of
    // reloading. Measured, not estimated: none of the ten had a transcript.
    //
    // Deliberately keyed on input rather than on the `pending:` key, because it
    // must never abort work. A session that WAS spoken to may have a turn in
    // flight, so it stays until IDLE_MS even when nothing can name it.
    //
    // `spokenTo` now means a real message rather than any byte, and
    // `turnInFlight` is belt and braces around that narrowing: a turn in flight
    // is work, so a message this parser somehow failed to recognise still has to
    // trip the second test before the process can be stopped.
    //
    // What deliberately is NOT tested here is `sessionId`. It is tempting — an
    // id looks like proof of a conversation — but every process announces one in
    // its own `system`/`init` event, probe included, so requiring the absence of
    // one would park every probe again and undo the whole of this.
    if (
      this.clients.size === 0 &&
      !this.spokenTo &&
      !this.turnInFlight &&
      !this.exited
    ) {
      log(`session ${this.key} never spoken to; stopping rather than parking it`);
      this.stop();
    }
  }

  write(data) {
    this.lastActivity = Date.now();
    this.attendedAt = Date.now();
    // Only a message starts a turn; the panel's control traffic does not. The
    // remaining way to be wrong is a missed `result`, which leaves a stale
    // "working" — still the right direction to be wrong in, because "working"
    // makes you wait and look again where "idle" makes you type over a live turn.
    if (this.#noteTurnStart(data)) {
      this.spokenTo = true;
      this.turnInFlight = true;
      this.turnTail = Buffer.alloc(0);
      this.spokeAt = Date.now();
    }
    if (this.proc.stdin.writable) this.proc.stdin.write(data);
  }

  stop() {
    this.proc.kill('SIGTERM');
  }
}

function handleConnection(client) {
  let session = null;
  let buffered = '';
  let handshook = false;

  client.on('error', () => client.destroy());

  client.on('data', (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split('\n');
    buffered = lines.pop() || '';

    for (const line of lines) {
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }

      if (!handshook) {
        handshook = true;
        // A reader, not a page. It attaches to nothing, starts nothing, and is
        // never counted as a client, so asking for status cannot keep a
        // conversation alive or hold one open.
        if (frame?.op === 'status') {
          respondStatus(client);
          return;
        }
        session = open(frame, client);
        continue;
      }
      if (!session) continue;

      switch (frame.s) {
        case 'in':
          session.write(Buffer.from(frame.d, 'base64'));
          break;
        case 'detach':
          session.detach(client);
          session = null;
          client.destroy();
          break;
        default:
          break;
      }
    }
  });

  client.on('close', () => {
    if (session) session.detach(client);
  });
}

/**
 * Answer "what is running, and is it working" for every live conversation.
 *
 * Why this is here and not read off the disk: opening a conversation on a second
 * device makes the panel re-read and re-render the whole transcript, which is
 * seconds of waiting on a large one — and the thing you actually want to know
 * first is whether to wait at all. If a turn is in flight the answer is coming and
 * the history is worth waiting for; if it is not, the last message is the only
 * thing you need before replying. Nothing on disk distinguishes those two states
 * (see RESULT_EVENT), and this process is the only one that sees the stream.
 *
 * Deliberately narrow. `env` and `args` are not reported: the env is the editor's
 * whole environment, it reaches this daemon only because the wrapper has to pass
 * it through, and a status reader has no use for it. What is here is what a device
 * needs to decide whether to wait, plus the pid, because the thing most likely to
 * be debugged over this socket is which process a conversation is actually in.
 */
function statusSnapshot() {
  const now = Date.now();
  return [...sessions.values()]
    .filter((session) => !session.exited)
    .map((session) => ({
      cwd: session.cwd,
      // Null until the CLI's init event names it — a conversation that has never
      // been spoken to has no id to report. See #sniffSessionId.
      sessionId: session.sessionId,
      working: session.turnInFlight,
      clients: session.clients.size,
      idleMs: now - session.lastActivity,
      // How long since anyone attached, left, or wrote — the clock the reaper
      // actually runs on, so that "why is this still here" has an answer that
      // matches the decision. `idleMs` is since the CLI last wrote a byte, which
      // is a different question and answers nothing about lifetime.
      attendedMs: now - session.attendedAt,
      // How long since anyone said anything to this conversation, as opposed to
      // since the CLI last wrote a byte. Null if nobody ever has. This is what
      // tells "the conversation being used" from "a conversation being read
      // back": resuming one produces output without anyone typing.
      spokeMs: session.spokeAt === null ? null : now - session.spokeAt,
      pid: session.proc.pid,
    }));
}

/**
 * `v` and the `sessions` array are how a caller tells a real answer from an older
 * broker's reply. A broker without this op reads the frame as a handshake and
 * answers `{ok:false, why:'bad handshake'}` — which is a clean "cannot answer",
 * so a caller that checks for the array degrades instead of misreporting.
 */
function respondStatus(client) {
  client.write(`${JSON.stringify({ ok: true, v: 1, sessions: statusSnapshot() })}\n`);
  // Ended rather than destroyed, so the reply is flushed first.
  client.end();
}

/**
 * Decide whether this page joins a live conversation or starts one, and reply
 * with the verdict. A refusal is not an error: the wrapper falls back to running
 * the binary directly, so the worst case is the fork we have today.
 */
function open(hello, client) {
  if (!hello || hello.v !== 1 || !hello.cwd || !hello.claude) {
    client.write(`${JSON.stringify({ ok: false, why: 'bad handshake' })}\n`);
    client.destroy();
    return null;
  }

  const wanted = hello.resume ? keyFor(hello.cwd, hello.resume) : null;
  const existing = wanted ? sessions.get(wanted) : null;

  if (existing && !existing.exited) {
    if (existing.truncated) {
      client.write(`${JSON.stringify({ ok: false, why: 'replay buffer full' })}\n`);
      client.destroy();
      return null;
    }
    client.write(`${JSON.stringify({ ok: true, joined: true })}\n`);
    existing.attach(client);
    return existing;
  }

  // A new conversation, or one whose process is gone. `pending:` keys a session
  // that has no id yet; #sniffSessionId re-keys it the moment the CLI says what
  // the id is, which is what makes it findable by the next device.
  const key = wanted || keyFor(hello.cwd, `pending:${process.hrtime.bigint()}`);
  let session;
  try {
    session = new Session({
      cwd: hello.cwd,
      claude: hello.claude,
      args: hello.args || [],
      env: hello.env || process.env,
      key,
    });
  } catch (err) {
    client.write(`${JSON.stringify({ ok: false, why: err.message })}\n`);
    client.destroy();
    return null;
  }
  sessions.set(key, session);
  log(`session ${key} started pid=${session.proc.pid}`);
  client.write(`${JSON.stringify({ ok: true, joined: false })}\n`);
  session.attach(client);
  return session;
}

function reapIdle() {
  const now = Date.now();
  for (const session of [...sessions.values()]) {
    if (session.clients.size > 0) continue;
    // A turn still running is work, whatever the clocks say. `lastActivity` used
    // to stand in for this — a working conversation is a writing one — and that
    // is exactly the conflation that broke the timeout, so the guard is now its
    // own line and says what it means.
    if (session.turnInFlight) continue;
    if (now - session.attendedAt > IDLE_MS) {
      log(`session ${session.key} unattended for ${Math.round((now - session.attendedAt) / 60000)}m; stopping`);
      session.stop();
    }
  }
}

function main() {
  fs.mkdirSync(path.dirname(SOCKET), { recursive: true, mode: 0o700 });
  // A socket left behind by a killed broker would make every connect fail, and
  // the wrapper would silently fall back to forking for every page.
  try {
    fs.unlinkSync(SOCKET);
  } catch {
    /* not there; fine */
  }

  const server = net.createServer(handleConnection);
  server.on('error', (err) => {
    log(`server error: ${err.message}`);
    process.exit(1);
  });
  server.listen(SOCKET, () => {
    fs.chmodSync(SOCKET, 0o600);
    log(`listening on ${SOCKET}`);
  });

  // Once a minute against a twelve-hour timeout, and never coarser than the
  // timeout itself — a fixed minute would enforce a one-second IDLE_MS a minute
  // late, which is the difference between a test that proves the reaper works and
  // one that waits for it.
  setInterval(reapIdle, Math.max(50, Math.min(60 * 1000, Math.floor(IDLE_MS / 4)))).unref();

  // Leave the sessions running on SIGTERM only if we are being replaced; a
  // deploy restarts this unit, and killing every conversation on restart is the
  // failure this whole file exists to prevent. Sessions are children of this
  // process, so they cannot outlive it — hence the unit is never restarted by a
  // deploy (see infra/userdata/bootstrap.sh) and this is only a clean shutdown.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      log(`${signal}: stopping ${sessions.size} session(s)`);
      for (const session of sessions.values()) session.stop();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
}

main();
