#!/usr/bin/env node
//
// Stands in for the `claude` binary when the VS Code extension launches it.
//
// The extension's setting `claudeCode.claudeProcessWrapper` is documented as
// "Executable path used to launch the Claude process", and the bundle calls it
// like this:
//
//   pathToClaudeCodeExecutable: <wrapper>
//   executableArgs: [<real claude path>]      then the extension's own args
//
// so argv is: [node, wrapper.js, /path/to/real/claude, --output-format, ...].
//
// Why it exists: the panel's `claude` is a child of the extension host, and
// code-server builds one extension host PER BROWSER PAGE. Two devices therefore
// get two processes that both `--resume` the same session id and then diverge,
// appending to one transcript. This wrapper routes the panel's stdio to a broker
// that owns one real `claude` per conversation, so both pages drive the same
// process — the property tmux gave the terminal, without leaving the panel.
//
// The single most important property here is that it FAILS SAFE. Every error
// path — no broker, stale socket, refused join, bad handshake — falls through to
// exec'ing the real binary, which is exactly today's behaviour. A broken broker
// must degrade to "the panel forks again", never to "the panel does not start",
// because this sits in front of the user's only interface.
import net from 'net';
import { spawn } from 'child_process';

const SOCKET =
  process.env.CLAUDE_BROKER_SOCKET || '/run/claude-broker/broker.sock';

const realClaude = process.argv[2];
const claudeArgs = process.argv.slice(3);

/**
 * Run the real binary and become transparent. Used for everything the broker
 * should not or cannot handle.
 */
function passthrough(why) {
  if (!realClaude) {
    process.stderr.write('claude-broker wrapper: no claude path in argv\n');
    process.exit(64);
  }
  if (process.env.CLAUDE_BROKER_DEBUG) {
    process.stderr.write(`claude-broker wrapper: direct (${why})\n`);
  }
  const child = spawn(realClaude, claudeArgs, { stdio: 'inherit' });
  child.on('error', (err) => {
    process.stderr.write(`claude-broker wrapper: ${err.message}\n`);
    process.exit(126);
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code == null ? 0 : code);
  });
}

/**
 * Only a long-lived stream-json conversation is worth sharing. The extension
 * also runs the binary for one-shot jobs (version checks, doctor, short
 * queries); merging those onto a conversation's process would be actively
 * wrong, so anything that does not look like an interactive session goes
 * straight through.
 */
function isSharableSession(args) {
  const joined = args.join(' ');
  if (!joined.includes('--input-format') || !joined.includes('stream-json')) {
    return false;
  }
  // --fork-session is an explicit request for a separate conversation. Honour it.
  if (args.includes('--fork-session')) return false;
  return true;
}

/** The session id the extension is resuming, if any. It is the merge key. */
function resumeIdFrom(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--resume=')) return arg.slice('--resume='.length) || null;
    if (arg === '--resume') {
      const next = args[i + 1];
      // `--resume` with no value means "pick interactively", which is not a key.
      if (next && !next.startsWith('-')) return next;
      return null;
    }
  }
  return null;
}

// Exactly one of these describes us at any moment, and a socket event means
// different things in each — which is worth a variable rather than two booleans,
// because getting it wrong is silent. An early version tracked this with a
// `handshakeDone` flag, so the `close` that always follows a failed `connect`
// looked like "the broker died mid-conversation" and killed the fallback process
// a millisecond after starting it.
//
//   connecting — nothing committed; any failure can still fall back
//   brokered   — the broker owns our stdio; a close is a real failure
//   detaching  — we said goodbye; a close is expected and clean
//   direct     — we gave up and are running the real binary; socket events are
//                no longer any of our business
let state = 'connecting';

function viaBroker() {
  const socket = net.connect(SOCKET);
  let buffered = '';

  // Until the broker accepts us, hold the extension's stdin rather than dropping
  // it: the extension can write its first message before we have a process to
  // send it to, and losing that message would look like Claude ignoring a prompt.
  process.stdin.pause();

  /** Abandon the broker and run Claude ourselves. Only valid before handover. */
  const giveUp = (why) => {
    if (state !== 'connecting') return;
    state = 'direct';
    socket.destroy();
    passthrough(why);
  };

  socket.on('connect', () => {
    socket.write(
      `${JSON.stringify({
        v: 1,
        cwd: process.cwd(),
        claude: realClaude,
        args: claudeArgs,
        resume: resumeIdFrom(claudeArgs),
        env: process.env,
      })}\n`,
    );
  });

  // Any failure before the broker has taken over is recoverable: nothing has
  // been written to our stdout yet, so the extension cannot tell the difference.
  socket.on('error', (err) => {
    if (state === 'connecting') giveUp(`socket: ${err.message}`);
    else if (state === 'brokered') process.exit(1);
  });

  socket.on('data', (chunk) => {
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

      if (state === 'connecting') {
        if (!frame.ok) {
          // The broker declined (its replay buffer overflowed, or the
          // conversation is unshareable). Better a fork than a failure.
          giveUp(`broker declined: ${frame.why || 'unknown'}`);
          return;
        }
        state = 'brokered';
        // The broker owns the conversation now, so start pumping the
        // extension's input into it.
        process.stdin.on('data', (d) => {
          socket.write(`${JSON.stringify({ s: 'in', d: d.toString('base64') })}\n`);
        });
        process.stdin.on('end', () => {
          // Deliberately not closing claude's stdin: another device may still be
          // driving this conversation. This page is leaving, not the session.
          state = 'detaching';
          socket.write(`${JSON.stringify({ s: 'detach' })}\n`);
        });
        process.stdin.resume();
        continue;
      }

      switch (frame.s) {
        case 'out':
          process.stdout.write(Buffer.from(frame.d, 'base64'));
          break;
        case 'err':
          process.stderr.write(Buffer.from(frame.d, 'base64'));
          break;
        case 'exit':
          process.exit(frame.code == null ? 0 : frame.code);
          break;
        default:
          break;
      }
    }
  });

  socket.on('close', () => {
    // Leaving is normal — the conversation carries on in the broker, and this
    // page is simply gone, so report success. A close we did NOT ask for means
    // the broker went away mid-conversation; we cannot restart transparently
    // because stdout already carries half a stream, so exit non-zero and let the
    // extension's own restart path handle it.
    if (state === 'detaching') process.exit(0);
    if (state === 'brokered') process.exit(1);
  });
}

if (isSharableSession(claudeArgs)) viaBroker();
else passthrough('not a stream-json session');
