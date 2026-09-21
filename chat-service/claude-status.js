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
 * A third question, asked from the same file and answered the same way round:
 *
 *   how did this start?  ->  the head of the transcript. The prompt a conversation
 *                            began with is the one thing in it that never changes,
 *                            and it is the hardest to get back to — see
 *                            `firstPrompt`.
 *
 * Deliberately free of chat-service internals beyond the transcript path helper.
 * The chat service is the only authenticated HTTP surface on the box, so the route
 * lives there, but the surface is meant to be retired — and when it is, this file
 * should move without being rewritten.
 */
import net from 'net';
import { open, readdir, stat } from 'fs/promises';
import { join } from 'path';
// isSyntheticUserText is the one piece of chat-service that is really about
// transcripts rather than about the chat: the CLI writes skill loaders, hook
// output and compaction preambles through the same `user` channel as things a
// person typed. Imported rather than copied — two lists of those patterns would
// drift, and the cost of the drift is showing someone a "prompt" they never sent.
import {
  CLAUDE_HOME,
  PROJECTS_ROOT,
  mangleCwd,
  isSyntheticUserText,
} from './session-manager.js';

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

/*
 * How much of the *start* of a transcript to read, to find the prompt it began with.
 *
 * Measured on the 92 transcripts on this box: the opening prompt sits a median of
 * 994 bytes in, and 87 of them are inside the first 64KB. The five that are not are
 * why the first window is 256KB and why there is a second one at all — a screenshot
 * pasted into the opening message is 350KB of base64 ahead of the text, and one
 * conversation's first human prompt is 997KB and 284 entries in, behind a resume
 * preamble. Bounded either way: a transcript here reaches 12MB and this never
 * reads one.
 */
const HEAD_WINDOWS = [256 * 1024, 4 * 1024 * 1024];

/*
 * One window, and a small one, for the other conversations in the project.
 *
 * They are listed so that the answer can be checked rather than trusted — see
 * `claudeStatus` — and a list needs one line each, not the whole message. A
 * conversation whose last message is not in 64KB simply contributes no preview.
 */
const SUMMARY_WINDOW = [64 * 1024];

/** How many conversations to describe. A project's history is unbounded; this is not. */
const LIST_LIMIT = 6;

/** Bounded so a status request cannot outlive the patience of the thing asking. */
const BROKER_TIMEOUT_MS = 400;

/*
 * How quiet a stream must be before the transcript is allowed to overrule a
 * broker that says "working".
 *
 * A turn in flight is not silent: text arrives in deltas, tools announce
 * themselves. So a session whose stream has said nothing for this long, whose
 * transcript ends with a *finished* assistant turn, is not working — whatever the
 * broker's in-flight flag says. This matters for two reasons: a broker predating
 * the input-side turn detection latches that flag on for good (11 of 13 sessions,
 * measured), and even a correct one can only miss a `result`, never invent one.
 *
 * The bound exists to protect the opposite race: a message sent a moment ago, not
 * yet on disk, whose transcript still ends with the previous turn. That stream is
 * busy, so it never reaches this threshold.
 */
const OVERRIDE_QUIET_MS = 10 * 1000;

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
 * Read the first `bytes` of a file.
 *
 * The mirror image of `readTail`, and it relies on the same property: the one line
 * that may be a fragment — here the last, cut off at the far edge of the window —
 * cannot parse as JSON, so it drops out of a line-by-line read on its own. That
 * covers a multi-byte character split by the window too.
 */
async function readHead(file, bytes) {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    return { text: buffer.toString('utf8'), size, complete: length === size };
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

/**
 * What Claude Code writes into a transcript *instead of* an answer.
 *
 * These are harness artifacts, not messages. They are assistant entries with a
 * terminal `stop_reason`, so `inferState` correctly calls them idle — nothing is
 * running any more — but they are the opposite of a finished turn: the work was cut
 * off partway. Read as answers they are actively misleading, and they were: 91 of
 * them across the 68 transcripts on this box, each one having announced itself to a
 * phone as "Claude finished · <project>" with the body "No response requested.",
 * which is neither what Claude said nor what happened.
 *
 * So they are recognised by text, which is unpleasant and is also the only signal
 * there is — the stop_reason of a killed turn (`stop_sequence`) is the same one a
 * genuinely completed turn can carry. The failure mode of getting this wrong is
 * bounded in the right direction: an unrecognised artifact reads as a finished turn,
 * which is today's behaviour, and a false positive would only downgrade a
 * notification's wording.
 *
 * The value is why it stopped, because the two want different words on a lock
 * screen: one needs a nudge to carry on, the other cannot carry on at all.
 */
const NO_ANSWER = new Map([
  ['No response requested.', 'interrupted'],
  ['Prompt is too long', 'overflow'],
]);

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
export async function lastExchange(file, windows = TAIL_WINDOWS) {
  let meta = null;

  /*
   * Everything except the message itself outlives the window it was found in.
   *
   * Every window ends at the end of the file, so a name or a state read from a
   * narrow one is the same one a wider one would find again — and the walk is
   * backwards, so the first `ai-title` it meets is the newest. Declaring these
   * inside the loop instead meant the fallback return below reported `null` for a
   * name it had already read: a conversation working through a long tool result,
   * with its last text message further back than the window but its name 1.6KB
   * from the end, was listed as "Untitled conversation". Observed 2026-09-20.
   */
  let state = null;
  let title = null;
  let cutOff = null;

  for (const bytes of windows) {
    let tail;
    try {
      tail = await readTail(file, bytes);
    } catch {
      return null; // transcript vanished, or was never written
    }
    meta = { size: tail.size, mtimeMs: tail.mtimeMs };

    const lines = tail.text.split('\n');
    let last = null;

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i].trim()) continue;
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue; // the leading fragment, or a partially written line
      }

      // What Claude Code called this conversation. Written as an `ai-title` entry
      // and rewritten as the conversation grows, so it is usually in the tail —
      // usually, not always, which is why every caller has a fallback label.
      //
      // The name is in `aiTitle`, not `title`: the entry is
      // `{"type":"ai-title","aiTitle":"…","sessionId":"…"}`. Reading `title` here
      // is what shipped until 2026-09-20, and it never once matched — 3,853
      // `ai-title` entries on this box, none with a bare `title` — so every
      // conversation came back unnamed and the overlay list fell back to showing
      // the last thing said. It went unnoticed because the fixtures that covered
      // it were written from this line rather than from a transcript.
      if (!title && entry.type === 'ai-title' && typeof entry.aiTitle === 'string') {
        title = entry.aiTitle.trim() || null;
      }
      if (entry.type !== 'assistant' && entry.type !== 'user') continue;

      const text = textOf(entry.message).trim();
      // See NO_ANSWER: an artifact stands where an answer would be, so it is never
      // reported as one — the walk continues past it to the last thing really said.
      const artifact = entry.type === 'assistant' ? NO_ANSWER.get(text) : undefined;

      // The nearest message decides the state, even if it carries no text of its
      // own — a tool_use turn is what "working" looks like. An artifact is only the
      // *last* word if nothing came after it: reply to a cut-off turn and the
      // trailing entry is that reply, which is a conversation owed an answer.
      if (!state) {
        state = inferState(entry);
        if (artifact) cutOff = artifact;
      }

      if (!last && entry.type === 'assistant' && text && !artifact) {
        last = { role: 'assistant', text, at: entry.timestamp || null };
      }
      // Both answers found; the rest of the window is history.
      if (last && title) break;
    }

    if (last || tail.complete) return { state: state || 'idle', last, title, cutOff, ...meta };
    // Nothing sayable in this window and there is more file behind it: widen.
  }

  // "Unknown" only when the windows really said nothing. A state read from one of
  // them is knowledge, and reporting it as ignorance sends a device to ask again.
  return { state: state || 'unknown', last: null, title, cutOff, ...meta };
}

/**
 * The prompt a conversation began with.
 *
 * Why this is worth a route of its own: it is the message you most often want to
 * send again — the brief, the standing instructions, the paragraph you spent five
 * minutes writing — and it is the one message a long conversation puts furthest out
 * of reach. Compaction is what makes it feel gone: from the CLI's side the history
 * has been summarised away, and the chat app only renders the last 400 messages of
 * a transcript. What is easy to miss is that nothing actually deleted it. Compaction
 * *appends* to the same transcript — 8 compact summaries in one file on this box —
 * so the opening prompt is still sitting a kilobyte from the start of the file, in
 * full, for every conversation that already exists.
 *
 * That is also the argument against caching it anywhere: a cache written from today
 * onwards would be empty for exactly the conversations this is for, and it would be
 * a second copy of something immutable that is already on disk. So this reads.
 *
 * Telling a typed prompt from an injected one, in that order of preference:
 *
 *   `origin.kind === 'human'`  — what the CLI now stamps on a prompt a person
 *     typed. Present on 57 of the 93 transcripts here and on everything written
 *     since; a `peer` or `system` origin is another agent or the harness talking,
 *     and is skipped outright.
 *   the synthetic-text filter — for the 35 older transcripts with no `origin` at
 *     all, where all there is to go on is what the text looks like.
 *
 * Sidechains are skipped whatever they claim: a subagent's prompt is written into
 * the same file as a `user` entry, and it is not something the user sent.
 */
export async function firstPrompt(file, windows = HEAD_WINDOWS) {
  for (const bytes of windows) {
    let head;
    try {
      head = await readHead(file, bytes);
    } catch {
      return null; // transcript vanished, or was never written
    }

    for (const line of head.text.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // a bookkeeping entry is not JSON's problem; the tail fragment is
      }
      if (entry.type !== 'user' || entry.isSidechain) continue;

      const kind = entry.origin?.kind;
      if (kind && kind !== 'human') continue;

      const content = entry.message?.content;
      const blocks = typeof content === 'string'
        ? [content]
        : (Array.isArray(content) ? content : [])
          .filter((block) => block?.type === 'text')
          .map((block) => block.text);
      // Blocks in order, not just the first: a prompt sent from the editor arrives
      // with an `<ide_selection>` or a `<system-reminder>` block ahead of the words.
      const text = blocks.find(
        (value) => typeof value === 'string' && value.trim() && !isSyntheticUserText(value),
      );
      if (!text) continue;

      return { text: text.trim(), at: entry.timestamp || null };
    }

    if (head.complete) break; // the whole file has been read; there is no prompt in it
  }
  return null;
}

/**
 * The same answer, addressed the way a request addresses it.
 *
 * The path hygiene is `claudeStatus`'s, for the same reason: `cwd` arrives from a
 * browser and ends up in a filesystem path. A null `text` is a real answer — a
 * conversation opened by another session's message, or one with nothing but
 * machinery in its first megabyte — and is not the same as a route that failed.
 */
export async function firstPromptFor(cwd, sessionId) {
  if (!String(cwd || '').startsWith(PROJECTS_ROOT)) {
    throw new Error('cwd must be inside the projects root');
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(sessionId || ''))) {
    throw new Error('sessionId is not a session id');
  }

  const file = join(CLAUDE_HOME, 'projects', await mangleCwd(cwd), `${sessionId}.jsonl`);
  const found = await firstPrompt(file);
  return {
    cwd,
    sessionId,
    text: found?.text || null,
    at: found?.at || null,
    // How long it is, so a client can say so without measuring what it was given.
    chars: found?.text ? found.text.length : 0,
  };
}

/** Every conversation in a project, newest first. One `stat` each, no reads. */
async function transcripts(cwd) {
  const dir = join(CLAUDE_HOME, 'projects', await mangleCwd(cwd));
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const found = [];
  for (const file of files) {
    // `._*` are macOS AppleDouble metadata stubs, not transcripts.
    if (!file.endsWith('.jsonl') || file.startsWith('._')) continue;
    try {
      const info = await stat(join(dir, file));
      found.push({ sessionId: file.replace(/\.jsonl$/, ''), mtimeMs: info.mtimeMs, size: info.size });
    } catch {
      /* vanished mid-scan */
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * The conversation a person is in, when nobody has said which.
 *
 * This is a guess, and it has to be, because the panel is a webview that reports
 * nothing about itself: from outside it there is no way to know which conversation
 * is on screen. What there is:
 *
 *   - a page driving a conversation holds a broker client for it, and the panel
 *     drops that client when it moves on. On this box, with four live
 *     conversations in one project, exactly one had a client: the one on screen.
 *   - among attached conversations, the one spoken to most recently is the one
 *     being used, where the one whose stream was busiest is merely the one being
 *     read back — resuming a conversation produces output without anyone typing.
 *
 * Everything above is a heuristic, so the answer names the conversation it chose
 * and lists the others. A wrong guess is then visibly wrong, which is the most
 * that can honestly be built here; a silently wrong one reads as a stale badge.
 */
function guessConversation(candidates) {
  const attached = candidates.filter((session) => session.clients > 0);
  const ranked = (attached.length ? attached : []).sort((a, b) => {
    const spoke = (s) => (s.spokeMs === null || s.spokeMs === undefined ? Infinity : s.spokeMs);
    return spoke(a) - spoke(b) || a.idleMs - b.idleMs;
  });
  return ranked[0] || null;
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
export async function claudeStatus(cwd, { sessionId: asked = null } = {}) {
  // `cwd` arrives from a browser and ends up in a filesystem path. Reaching this
  // needs a valid session, and anyone with one already has a shell here, so this
  // is hygiene rather than a boundary — but the same hygiene as loadTranscript.
  if (!String(cwd || '').startsWith(PROJECTS_ROOT)) {
    throw new Error('cwd must be inside the projects root');
  }

  const dir = join(CLAUDE_HOME, 'projects', await mangleCwd(cwd));
  const live = await brokerSessions();
  // A session with no id has never been spoken to — the panel opens such probes
  // and never sends them a message. They hold no conversation.
  const candidates = live?.filter((s) => s.cwd === cwd && s.sessionId) || [];
  const liveFor = (id) => candidates.find((s) => s.sessionId === id) || null;

  const files = await transcripts(cwd);
  const sessionId = asked || guessConversation(candidates)?.sessionId || files[0]?.sessionId || null;
  const mine = sessionId ? liveFor(sessionId) : null;

  const transcript = sessionId
    ? await lastExchange(join(dir, `${sessionId}.jsonl`))
    : null;

  /*
   * The verdict, and which of the two sources it came from.
   *
   * A broker answer wins, including when the broker reports no session for this
   * conversation at all — that is a *definite* idle, because no process exists to
   * be working, whatever state the transcript was left in.
   *
   * The exception is a broker that says "working" about a stream that has gone
   * quiet while the transcript shows the turn finished. Then the transcript is
   * right: see OVERRIDE_QUIET_MS.
   */
  const quiet = mine ? mine.idleMs > OVERRIDE_QUIET_MS : false;
  const spokeQuiet = !mine || mine.spokeMs === null || mine.spokeMs === undefined
    ? true
    : mine.spokeMs > OVERRIDE_QUIET_MS;
  const overruled = Boolean(mine?.working) && quiet && spokeQuiet && transcript?.state === 'idle';

  let state;
  let source;
  if (!live) {
    state = transcript?.state || 'unknown';
    source = 'transcript';
  } else if (overruled) {
    state = 'idle';
    source = 'transcript';
  } else {
    state = mine?.working ? 'working' : 'idle';
    source = 'broker';
  }

  return {
    cwd,
    sessionId,
    // What this conversation is called, so an answer about the wrong one can be
    // recognised as such. Null when no title has been written yet.
    title: transcript?.title || null,
    state,
    source,
    // Whether a process for this conversation exists at all. Null when the broker
    // could not be asked, which is not the same as "no".
    live: live ? Boolean(mine) : null,
    // How many pages are driving it. 0 with a live session is the case this whole
    // service exists for: a conversation nobody is watching, still running.
    clients: mine?.clients ?? null,
    idleMs: mine?.idleMs ?? null,
    spokeMs: mine?.spokeMs ?? null,
    last: transcript?.last || null,
    /*
     * Why the last turn produced no answer, when that is what happened: see
     * NO_ANSWER. Only ever reported for a conversation that is idle now — a turn
     * that was cut off and then picked up again is working, and "stopped" would be
     * yesterday's news told in the present tense.
     */
    cutOff: state === 'idle' ? transcript?.cutOff || null : null,
    transcriptAt: transcript?.mtimeMs || null,
    // Why the panel is slow, in one number the client can show instead of
    // guessing. The wait scales with this.
    bytes: transcript?.size || null,
    // Every other conversation in this project, so that the guess above can be
    // checked rather than taken on trust — and so that switching conversations
    // does not mean waiting out the panel again to find out where you are.
    conversations: await summarise(dir, files.slice(0, LIST_LIMIT), { liveFor, live, sessionId }),
    at: Date.now(),
  };
}

/**
 * One line about each conversation in the project: what it is called, what it
 * last said, and whether anything is running it.
 *
 * Small windows and no widening. This is a list, not the answer — the chosen
 * conversation is read properly above, and a preview that costs as much as the
 * answer would defeat the point of the whole file.
 */
async function summarise(dir, files, { liveFor, live, sessionId }) {
  return Promise.all(
    files.map(async (file) => {
      const running = liveFor(file.sessionId);
      const tail = await lastExchange(join(dir, `${file.sessionId}.jsonl`), SUMMARY_WINDOW);
      const quiet = running ? running.idleMs > OVERRIDE_QUIET_MS : false;
      const state = !live
        ? tail?.state || 'unknown'
        : running?.working && !(quiet && tail?.state === 'idle')
          ? 'working'
          : 'idle';
      return {
        sessionId: file.sessionId,
        title: tail?.title || null,
        // Deliberately one line: enough to recognise a conversation by, not enough
        // to be a second copy of the message.
        said: tail?.last?.text ? tail.last.text.replace(/\s+/g, ' ').slice(0, 140) : null,
        state,
        // As above: a list is where "this one stopped without answering" is most
        // worth seeing, because it is the one you would otherwise keep waiting on.
        cutOff: state === 'idle' ? tail?.cutOff || null : null,
        live: live ? Boolean(running) : null,
        clients: running?.clients ?? null,
        at: file.mtimeMs,
        bytes: file.size,
        // Which one of these the answer above is about.
        current: file.sessionId === sessionId,
      };
    }),
  );
}
