/*
 * "Is Claude working, and what did it last say?" — answered in tens of
 * milliseconds, for a device that has just opened a conversation.
 *
 * The problem this exists for: the Claude Code panel re-reads and re-renders the
 * whole transcript every time a page loads, because code-server gives each browser
 * page its own extension host and nothing survives between them. On a large
 * conversation that is seconds of watching history scroll past — measured at
 * 1.75–3.97s in the extension host before the CLI is even launched, on transcripts
 * up to 8.7MB — and the panel renders oldest-first, so the newest message, the one
 * you actually need before replying, arrives last.
 *
 * None of that is reachable from here: it happens inside a proprietary webview
 * bundle. What is reachable is the answer itself, from outside the panel, while the
 * panel is still working. Two questions, two sources:
 *
 *   is Claude working?   ->  claude-broker, over its unix socket. Only the process
 *                            holding the stream knows this; see RESULT_EVENT in
 *                            broker.js for why the transcript cannot say.
 *   what did it say?     ->  the tail of the transcript. ~40ms for the last
 *                            message out of 8.7MB, because it reads backwards from
 *                            the end instead of forwards from the start.
 *
 * Deliberately free of chat-service internals beyond the transcript path helper.
 * The chat service is the only authenticated HTTP surface on the box, so the route
 * lives there, but the surface is meant to be retired — and when it is, this file
 * should move without being rewritten.
 */
import net from 'net';
import { open, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { CLAUDE_HOME, PROJECTS_ROOT, mangleCwd } from './session-manager.js';

const BROKER_SOCKET =
  process.env.CLAUDE_BROKER_SOCKET || '/run/claude-broker/broker.sock';

/*
 * How much of the end of a transcript to read.
 *
 * The first window is sized to hold the last exchange of a normal conversation.
 * The second exists because "normal" is not guaranteed: one 300KB tool result can
 * push the last assistant message out of any small window, and answering "nothing
 * to show" on a conversation that plainly has something to show is worse than
 * spending another read on it. Both are still bounded — the point of this file is
 * to never read a whole transcript.
 */
const TAIL_WINDOWS = [256 * 1024, 4 * 1024 * 1024];

/** Bounded so a status request cannot outlive the patience of the thing asking. */
const BROKER_TIMEOUT_MS = 400;

/**
 * Ask the broker what it is running.
 *
 * Returns null for every kind of "cannot say" — no broker, no socket, a timeout,
 * or a broker too old to understand the question (one without `op: 'status'`
 * reads the frame as a handshake and refuses it, which arrives here as a reply
 * with no `sessions` array). Callers treat null as "fall back to the transcript",
 * never as "nothing is running": claiming a conversation is idle when the answer
 * is unknown is how you type over a turn in flight.
 */
export function brokerSessions({ socket = BROKER_SOCKET } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client.destroy();
      } catch {
        /* already gone */
      }
      resolve(value);
    };

    const client = net.connect(socket);
    const timer = setTimeout(() => done(null), BROKER_TIMEOUT_MS);
    let buffered = '';

    client.on('error', () => done(null));
    client.on('connect', () => client.write(`${JSON.stringify({ v: 1, op: 'status' })}\n`));
    client.on('data', (chunk) => {
      buffered += chunk.toString();
      if (!buffered.includes('\n')) return;
      try {
        const reply = JSON.parse(buffered.split('\n')[0]);
        done(Array.isArray(reply.sessions) ? reply.sessions : null);
      } catch {
        done(null);
      }
    });
    // A broker that accepts the connection and says nothing.
    client.on('close', () => done(null));
  });
}

/**
 * Read the last `bytes` of a file.
 *
 * The first line of the result is almost always a fragment, and that is fine:
 * every caller parses line by line and skips what will not parse. A line cut off
 * at the front cannot parse as JSON, so it drops out on its own rather than
 * needing to be recognised.
 */
async function readTail(file, bytes) {
  const handle = await open(file, 'r');
  try {
    const { size, mtimeMs } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, size - length));
    return { text: buffer.toString('utf8'), size, mtimeMs, complete: length === size };
  } finally {
    await handle.close();
  }
}

/**
 * The state a transcript was left in, when the broker cannot be asked.
 *
 * `stop_reason` is what makes this possible: an assistant turn that ended says
 * `end_turn` (or `stop_sequence`, or `refusal`), while one that stopped to run a
 * tool says `tool_use` and is therefore mid-turn. A trailing `user` entry — a
 * prompt, or a tool result being fed back — means Claude owes an answer.
 *
 * Read what this can and cannot tell you. It is the last state the conversation
 * was *left* in, not proof that anything is still running it: a conversation
 * abandoned mid-turn reads as "working" forever, because on disk that is
 * indistinguishable from a turn still in progress. Only the broker knows whether a
 * process exists, which is why this is reported with `source: 'transcript'` and
 * never conflated with a broker answer.
 */
function inferState(entry) {
  if (entry.type === 'assistant') {
    return entry.message?.stop_reason === 'tool_use' ? 'working' : 'idle';
  }
  // A `user` entry: either something typed, or a tool result going back in.
  return 'working';
}

const textOf = (message) => {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
};

/**
 * The last thing Claude said, and the state the transcript was left in.
 *
 * Walks backwards, and stops at the first entry that carries a message. Most
 * entries in a transcript do not: `attachment`, `last-prompt`, `mode`,
 * `atis-latch`, `ai-title`, `file-history-delta` and friends outnumber the real
 * turns, and several of them are written *after* the last assistant message — so
 * "the last line" is the wrong thing to look at, and this filters by type rather
 * than by position.
 */
async function lastExchange(file) {
  let meta = null;

  for (const bytes of TAIL_WINDOWS) {
    let tail;
    try {
      tail = await readTail(file, bytes);
    } catch {
      return null; // transcript vanished, or was never written
    }
    meta = { size: tail.size, mtimeMs: tail.mtimeMs };

    const lines = tail.text.split('\n');
    let state = null;
    let last = null;

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i].trim()) continue;
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue; // the leading fragment, or a partially written line
      }
      if (entry.type !== 'assistant' && entry.type !== 'user') continue;

      // The nearest message decides the state, even if it carries no text of its
      // own — a tool_use turn is what "working" looks like.
      if (!state) state = inferState(entry);

      const text = textOf(entry.message).trim();
      if (entry.type === 'assistant' && text) {
        last = { role: 'assistant', text, at: entry.timestamp || null };
        break;
      }
    }

    if (last || tail.complete) return { state: state || 'idle', last, ...meta };
    // Nothing sayable in this window and there is more file behind it: widen.
  }

  return { state: 'unknown', last: null, ...meta };
}

/** Newest transcript in a project directory — the conversation being looked at. */
async function newestSession(cwd) {
  const dir = join(CLAUDE_HOME, 'projects', await mangleCwd(cwd));
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return null;
  }

  let newest = null;
  for (const file of files) {
    // `._*` are macOS AppleDouble metadata stubs, not transcripts.
    if (!file.endsWith('.jsonl') || file.startsWith('._')) continue;
    try {
      const info = await stat(join(dir, file));
      if (!newest || info.mtimeMs > newest.mtimeMs) {
        newest = { sessionId: file.replace(/\.jsonl$/, ''), mtimeMs: info.mtimeMs };
      }
    } catch {
      /* vanished mid-scan */
    }
  }
  return newest;
}

/**
 * Everything a device needs in order to decide whether to wait for the history.
 *
 * The two branches this serves, and they are not symmetrical:
 *
 *   working  ->  the answer is still coming. The history is worth waiting for,
 *                because the thing you are waiting for has not been said yet.
 *   idle     ->  it is your turn. The last message is all you need, and it is
 *                right here, so there is nothing to wait for.
 *
 * A broker answer beats the transcript whenever there is one — including when the
 * broker reports no session for this directory at all, which is a *definite* idle:
 * no process exists, so nothing can be working, whatever state the transcript was
 * left in.
 */
export async function claudeStatus(cwd) {
  // `cwd` arrives from a browser and ends up in a filesystem path. Reaching this
  // needs a valid session, and anyone with one already has a shell here, so this
  // is hygiene rather than a boundary — but the same hygiene as loadTranscript.
  if (!String(cwd || '').startsWith(PROJECTS_ROOT)) {
    throw new Error('cwd must be inside the projects root');
  }

  const live = await brokerSessions();
  const mine = live
    // A session with no id has never been spoken to — the panel opens one such
    // probe per page load and never writes to it. It holds no conversation.
    ?.filter((session) => session.cwd === cwd && session.sessionId)
    .sort((a, b) => a.idleMs - b.idleMs)[0];

  const sessionId = mine?.sessionId || (await newestSession(cwd))?.sessionId || null;
  const transcript = sessionId
    ? await lastExchange(join(CLAUDE_HOME, 'projects', await mangleCwd(cwd), `${sessionId}.jsonl`))
    : null;

  // Present, but not the source of the verdict when the broker answered.
  const inferred = transcript?.state || 'unknown';

  return {
    cwd,
    sessionId,
    state: live ? (mine?.working ? 'working' : 'idle') : inferred,
    source: live ? 'broker' : 'transcript',
    // How many pages are driving it. 0 with a live session is the case this whole
    // service exists for: a conversation nobody is watching, still running.
    clients: mine?.clients ?? null,
    last: transcript?.last || null,
    transcriptAt: transcript?.mtimeMs || null,
    // Why the panel is slow, in one number the client can show instead of
    // guessing. The wait scales with this.
    bytes: transcript?.size || null,
    at: Date.now(),
  };
}
