/**
 * Notice when a Claude session finishes a turn, and push it to the phone.
 *
 * Only sessions this app is *not* driving. A conversation held in the chat app
 * already announces itself on screen — the notification is for the ones the app
 * cannot see: the editor panel, and anything running under tmux. Those are the
 * sessions you start and then walk away from, which is the whole reason to want a
 * buzz in your pocket. The exclusion is by session id, taken from the manager's
 * own live list, so it stays right without either side knowing about the other.
 *
 * Why transcripts and not the broker. claude-broker owns the panel's process and
 * could in principle be asked to announce a turn ending, but it is a long-lived
 * process that predates this file and restarting it ends every live conversation
 * on the box. The transcripts are already the source of truth for
 * `/api/claude-status`, they are written by Claude Code itself for every surface
 * equally, and reading them needs nobody's cooperation. This costs one `stat` per
 * transcript every few seconds — 77 files here, about two milliseconds — and reads
 * only the ones that changed.
 *
 * What counts as "finished", and the two ways this could be annoying instead of
 * useful:
 *
 *   the transcript must be *left* idle — `stop_reason: end_turn`, not `tool_use` —
 *   and carry assistant text that is not the text already reported for that
 *   session. A turn that ends by running a tool is mid-thought, and the same text
 *   seen twice is a transcript being rewritten, not a new answer;
 *
 *   the message must be recent. A restored backup, a `git checkout` of a workspace,
 *   or anything else that touches many files at once must not fire a notification
 *   per conversation, so anything older than ten minutes is read for its state and
 *   never announced.
 *
 * And one thing that is announced without having finished at all: a turn that stopped
 * to ask you something. `state: 'question'` from claude-status.js — an `AskUserQuestion`
 * at the end of a transcript with no result under it. It fails both tests above, being
 * neither idle nor a new message, and it is the single most useful buzz this file can
 * send: nothing will happen in that conversation until a person goes and answers it.
 * On the transcripts here the median answer took three minutes and the slowest 5.9
 * hours, all of it reading as "Claude is working…" to anyone who looked.
 *
 * A turn that was *killed* is idle by both of those tests and is not finished, which
 * this used to announce as "Claude finished" over a body reading "No response
 * requested." — the harness artifact that stands where the answer would have been.
 * That is the one moment the person has to do something (come back and say
 * continue), described as the one moment they do not. So a cut-off turn is announced
 * in its own words; `cutOff` from claude-status.js is what tells them apart.
 *
 * And the first scan of a process announces nothing at all: a deploy restarts this
 * service, and a restart is not something Claude just said.
 */
import { readdir, stat } from 'fs/promises';
import { basename, join } from 'path';
import { createHash } from 'crypto';
import { CLAUDE_HOME, PROJECTS_ROOT, mangleCwd } from './session-manager.js';
import { lastExchange } from './claude-status.js';
import { listSubscriptions, notifyAll, topicFor } from './push.js';

/** How often to look. Fast enough to feel immediate, slow enough to be free. */
const POLL_MS = 5000;

/**
 * How far back a message can be and still be worth a notification.
 *
 * Ten minutes. This is the guard against a stampede: the trigger is "the file
 * changed and the last message is new to us", and a bulk mtime change would make
 * that true for every transcript on the box at once.
 */
const FRESH_MS = 10 * 60 * 1000;

/**
 * One window, not the widening pair `claude-status.js` uses by default.
 *
 * A file that just changed changed at the end, so the answer is in the tail; and a
 * fallback that re-reads four megabytes would run on every poll of a busy
 * conversation rather than once on a screen being drawn.
 */
const WINDOWS = [256 * 1024];

/** As much of the message as a lock screen will show before it truncates anyway. */
const PREVIEW_CHARS = 150;

/** Stable, short, and independent of how long the message is. */
const digest = (text) => createHash('sha256').update(text).digest('base64url').slice(0, 16);

/**
 * The first PREVIEW_CHARS of what Claude said, as one line.
 *
 * Transcript text is markdown with hard-wrapped paragraphs, lists and code fences;
 * a lock screen collapses that into a smear of single spaces anyway, so it is
 * collapsed here where the ellipsis can be put on a word boundary instead of
 * mid-token.
 */
export function preview(text, limit = PREVIEW_CHARS) {
  const flat = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * What to say when the turn did not finish — see NO_ANSWER in claude-status.js.
 *
 * The distinction is the whole value of these two words on a lock screen: an
 * interrupted turn is waiting for one word to carry on, and an overflowed one cannot
 * carry on in that conversation at all. The last thing really said is appended when
 * there is one, because "stopped" is more useful with "in the middle of what".
 */
const CUT_OFF_REASON = {
  interrupted: 'Stopped before finishing — it needs a nudge to carry on.',
  overflow: 'Stopped: this conversation is too long to continue. Start a new one.',
};

export function cutOffBody(reason, text = '') {
  const said = preview(text, 70);
  return `${CUT_OFF_REASON[reason] || CUT_OFF_REASON.interrupted}${said ? ` Last said: ${said}` : ''}`;
}

/**
 * What a question looks like on a lock screen.
 *
 * The question itself, not a summary of it: the point of this notification is that
 * someone can decide whether it is worth going to the panel for, and "Claude asked you
 * something" cannot be decided on. The option labels follow it when they fit, because
 * they are usually the whole of the decision — and their count when they do not, so a
 * one-tap answer is never mistaken for an essay.
 *
 * `header` leads when there is one. It is Claude Code's own short label for the
 * question and it is the part that reads well truncated, which on a lock screen
 * everything eventually is.
 */
export function questionBody(question) {
  const asked = question?.questions?.[0];
  if (!asked) return 'Claude is waiting for an answer.';
  const head = asked.header ? `${asked.header}: ` : '';
  const options = asked.options || [];
  const body = `${head}${preview(asked.question, 110)}`;
  if (!options.length) return body;
  const listed = options.join(' · ');
  return `${body} — ${listed.length <= 90 ? listed : `${options.length} options`}`;
}

/**
 * A readable name for the project a transcript belongs to.
 *
 * Transcript directories are named after the mangled cwd — every `/` and `.`
 * replaced by `-` — which cannot be turned back into a path, because the mangling
 * is not reversible. So the mapping is built in the other direction: mangle the
 * projects that exist and look the directory up. A conversation whose cwd is not a
 * project (someone's home directory, a checkout elsewhere) keeps the directory name,
 * which is ugly but never wrong.
 */
async function projectNames() {
  const names = new Map();
  let entries = [];
  try {
    entries = await readdir(PROJECTS_ROOT, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    names.set(await mangleCwd(join(PROJECTS_ROOT, entry.name)), entry.name);
  }
  return names;
}

/**
 * The watcher, with its dependencies passed in.
 *
 * `liveSessions` is the manager's `liveSummary()`, and `notify` is push.js — both
 * injected so the test can drive a real scan over a real directory of transcripts
 * without a push service or a session manager anywhere near it.
 */
export function createTurnWatcher({
  liveSessions = () => [],
  notify = notifyAll,
  subscriptions = listSubscriptions,
  now = () => Date.now(),
  pollMs = POLL_MS,
  log = console.error,
} = {}) {
  /**
   * transcript path → mtime and a digest of the last message already accounted for.
   *
   * Keyed by path rather than by session id. A session id is a UUID and in practice
   * unique, but the same id *can* appear under two project directories — resuming a
   * conversation from a different working directory is enough — and two files sharing
   * one entry means each poll sees the other's message as new and notifies for both,
   * forever.
   */
  const seen = new Map();
  /**
   * Every session id this app has ever driven.
   *
   * Not just the ones live *now*: a chat conversation whose process has already
   * exited is no longer in `liveSummary()`, and its final message would otherwise
   * be announced by the poll that follows — a notification for something the person
   * is looking at.
   */
  const ours = new Set();
  let seeded = false;
  let timer = null;
  let scanning = null;
  let lastComplaint = '';

  const projectsDir = () => join(CLAUDE_HOME, 'projects');

  /** One pass. Returns what it sent, which is what the test reads. */
  async function scan() {
    for (const session of liveSessions()) {
      if (session.sessionId) ours.add(session.sessionId);
    }

    // Nothing subscribed: no reason to touch the disk at all. `seeded` is dropped so
    // that the first scan after a phone subscribes learns the current state silently
    // instead of announcing every conversation that finished while nobody was
    // listening.
    const devices = await subscriptions();
    if (!devices.length) {
      seeded = false;
      seen.clear();
      return { sent: [], scanned: 0 };
    }

    let dirs = [];
    try {
      dirs = await readdir(projectsDir(), { withFileTypes: true });
    } catch (err) {
      complain(`turn-watcher: cannot read ${projectsDir()}: ${err.message}`);
      return { sent: [], scanned: 0 };
    }

    const names = await projectNames();
    const sent = [];
    let scanned = 0;

    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      let files = [];
      try {
        files = await readdir(join(projectsDir(), dir.name));
      } catch {
        continue; // removed between the two reads
      }

      for (const name of files) {
        if (!name.endsWith('.jsonl')) continue;
        const file = join(projectsDir(), dir.name, name);
        const sessionId = basename(name, '.jsonl');
        scanned += 1;

        let mtimeMs;
        try {
          ({ mtimeMs } = await stat(file));
        } catch {
          continue;
        }
        const before = seen.get(file);
        if (before && before.mtimeMs === mtimeMs) continue;

        const exchange = await lastExchange(file, WINDOWS);
        if (!exchange) continue;
        const text = exchange.last?.text || '';
        /*
         * A question waiting on a person. Its own kind of news, and the one kind that
         * is announced while the turn is technically still running — see the header.
         */
        const asking = exchange.state === 'question' && Boolean(exchange.question);
        /*
         * The cut-off reason is part of what makes a turn new, not just its text.
         *
         * A killed turn leaves an artifact where its answer would be (see NO_ANSWER
         * in claude-status.js), so the last thing really *said* is the message before
         * it — usually one already announced. Digesting the text alone would make
         * that look like a repeat and swallow the one notification worth having: the
         * turn you are waiting on has stopped and needs a nudge.
         *
         * A question is digested by its tool_use id for the same reason and then
         * some: it carries no text of its own, so it would digest to whatever was
         * said before it — which is either a repeat (silence) or nothing at all
         * (silence). The id is unique per ask, so a second question in the same
         * conversation is news and the same one seen again never is.
         */
        const mark = asking
          ? `question|${exchange.question.id}`
          : exchange.cutOff ? `${exchange.cutOff}|${text}` : text;
        const record = { mtimeMs, text: mark ? digest(mark) : '' };
        const changed = Boolean(record.text) && record.text !== before?.text;
        seen.set(file, record);

        // Read for its state, but never announced: the first pass of a process, a
        // conversation this app is driving, a turn that is still going and not
        // waiting on anyone, a repeat of what was already sent, or something that
        // happened long ago.
        const worthSaying = exchange.state === 'idle' || asking;
        if (!seeded || !changed || ours.has(sessionId) || !worthSaying) continue;
        // A question's clock starts when it was asked, not when the last message was
        // said — that one is older, sometimes by the length of a turn, and a question
        // older than FRESH_MS would be dropped for the age of its own preamble.
        const at = Date.parse((asking ? exchange.question.at : exchange.last?.at) || '') || mtimeMs;
        if (now() - at > FRESH_MS) continue;

        const project = names.get(dir.name) || dir.name;
        const cut = exchange.cutOff;
        const notification = {
          // "Finished" is a claim, and it was being made about turns that were
          // killed partway — the one case where the person needs to come back and
          // say "continue", and the one case the old wording talked them out of.
          // A question is a third claim again: not finished, not stopped, waiting.
          title: `${asking ? 'Claude is waiting for you' : cut ? 'Claude stopped' : 'Claude finished'} · ${project}`,
          body: asking ? questionBody(exchange.question) : cut ? cutOffBody(cut, text) : preview(text),
          // Per conversation, so a session that finishes twice replaces its own
          // notification rather than stacking two on the lock screen.
          tag: `turn-${topicFor(`${dir.name}|${sessionId}`)}`,
          project,
          // So a client can tell them apart without parsing the title.
          cutOff: asking ? null : cut || null,
          question: asking,
          sessionId,
          conversation: exchange.title || null,
          at: new Date(at).toISOString(),
        };
        try {
          await notify(notification, { topic: topicFor(`${dir.name}|${sessionId}`) });
          sent.push(notification);
        } catch (err) {
          complain(`turn-watcher: could not notify for ${project}: ${err.message}`);
        }
      }
    }

    seeded = true;
    return { sent, scanned };
  }

  /** Say it once. This runs every few seconds forever; a broken path must not fill the log. */
  function complain(message) {
    if (message === lastComplaint) return;
    lastComplaint = message;
    log(message);
  }

  async function tick() {
    scanning = scan().catch((err) => {
      complain(`turn-watcher: scan failed: ${err.message}`);
      return null;
    });
    await scanning;
    scanning = null;
    if (timer !== null) arm();
  }

  function arm() {
    timer = setTimeout(tick, pollMs);
    // Never a reason to hold the process open: this is a background observer, and a
    // timer that keeps node alive turns a clean shutdown into a hang.
    timer.unref?.();
  }

  return {
    scan,
    start() {
      if (timer) return;
      arm();
    },
    async stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      await scanning;
    },
    /** For the test, and for the admin surface if it ever wants to show this. */
    stats() {
      return { seeded, tracking: seen.size, ours: ours.size };
    },
  };
}

/** Start watching, with the real manager and the real push service. */
export function startTurnWatcher(options = {}) {
  const watcher = createTurnWatcher(options);
  watcher.start();
  return watcher;
}
