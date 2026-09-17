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
// So the panel's stdio is routed here through claude-broker/wrapper.js, and this
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
    this.exited = false;
    // Only used to spot the init event; forwarding never waits on it.
    this.lineBuffer = '';

    this.proc = spawn(claude, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });

    this.proc.stdout.on('data', (chunk) => {
      this.lastActivity = Date.now();
      this.#record(chunk);
      this.#broadcast('out', chunk);
      this.#sniffSessionId(chunk);
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
    log(`session ${this.key} detached; clients=${this.clients.size}`);
  }

  write(data) {
    this.lastActivity = Date.now();
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
    if (session.clients.size === 0 && now - session.lastActivity > IDLE_MS) {
      log(`session ${session.key} idle; stopping`);
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

  setInterval(reapIdle, 60 * 1000).unref();

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
