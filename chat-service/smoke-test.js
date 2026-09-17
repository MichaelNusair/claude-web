/**
 * Boot the client in a real DOM and assert it renders.
 *
 * `node --check` only parses — it cannot catch a runtime ReferenceError like
 * using a `const` before its declaration, which kills the whole script and
 * leaves the page stuck on "Loading…". That exact bug shipped once; this test
 * exists so it can't again.
 *
 * Run: node chat-service/smoke-test.js
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, 'public');

const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
const js = readFileSync(join(publicDir, 'app.js'), 'utf8');

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  // Any HTTPS origin works; the client only reads location.protocol and .host to
  // build the WebSocket URL. Kept deliberately generic so this test is not tied
  // to one deployment's hostname.
  url: 'https://claude.example.com/',
});
const w = dom.window;

const calls = [];
// Transcripts the fake server hands back, in order, one per /api/transcribe.
const transcripts = [];
// What the fake cleanup pass returns, and what it was asked to clean. `null`
// means "hand it back untouched", which is also what the real route does when
// Bedrock is unreachable — so the default here is the failure path.
let polishReply = null;
const polished = [];
w.fetch = (url, options = {}) => {
  calls.push(String(url));
  if (String(url).includes('/api/polish')) {
    const asked = JSON.parse(options.body || '{}').text;
    polished.push(asked);
    const text = polishReply ?? asked;
    // Deliberately not immediate: the composer is live during this, and the
    // window between asking and answering is where this feature can do damage.
    return new Promise((resolve) =>
      setTimeout(() => resolve({
        ok: true,
        json: () => Promise.resolve({ text, changed: text !== asked }),
      }), 40));
  }
  if (String(url).includes('/api/transcribe')) {
    const text = transcripts.shift() ?? '';
    // Deliberately answer earlier phrases *slower* than later ones. If phrases
    // were transcribed concurrently they would finish in reverse and the
    // transcript would come out scrambled, so this is what makes the ordering
    // assertion below prove something rather than pass by luck.
    const delay = Math.max(0, 60 - 20 * calls.filter((u) => u.includes('/api/transcribe')).length);
    return new Promise((resolve) =>
      setTimeout(() => resolve({ ok: true, json: () => Promise.resolve({ text }) }), delay));
  }
  // Polled every few seconds for the tab dots and the list badges. Answered
  // properly rather than left to the fallback below, because a boot that throws
  // in the poller is exactly the kind of break this file exists to catch.
  if (String(url).includes('/api/live')) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ sessions: [] }) });
  }
  const body = String(url).includes('/api/projects')
    ? {
        projects: [
          {
            name: 'demo',
            path: '/workspace/projects/demo',
            sessions: [{ sessionId: 'abc123', mtime: Date.now(), title: 'a past chat' }],
          },
        ],
      }
    : { models: [{ id: 'us.anthropic.claude-opus-5', label: 'Opus 5' }] };
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
};

// Minimal WebSocket stand-in: the list screen must render without a live socket.
w.WebSocket = function () {
  this.addEventListener = () => {};
  this.send = () => {};
  this.close = () => {};
  this.readyState = 0;
};
w.WebSocket.CONNECTING = 0;
w.WebSocket.OPEN = 1;
w.matchMedia = () => ({ matches: false, addEventListener() {} });

const failures = [];
w.addEventListener('error', (e) => failures.push(`uncaught: ${e.message}`));

try {
  w.eval(js);
} catch (err) {
  console.error(`FAIL: app.js threw on load — ${err.constructor.name}: ${err.message}`);
  console.error(err.stack?.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}

// Give the boot-time fetches a tick to settle.
await new Promise((resolve) => setTimeout(resolve, 300));

const listBody = w.document.querySelector('#list-body')?.innerHTML ?? '';

if (!calls.some((u) => u.includes('/api/projects'))) {
  failures.push('never fetched /api/projects');
}
if (listBody.includes('Loading')) {
  failures.push('list still shows "Loading…" after boot');
}
if (!listBody.includes('class="row"')) {
  failures.push('no conversation rows rendered');
}
if (!listBody.includes('a past chat')) {
  failures.push('session title missing from the rendered list');
}

// A resumed conversation arrives as one `history` frame. Assert the client can
// render it — this path is what a phone hits when opening an existing chat.
// Everything that renders now belongs to a pane, so one has to be open first;
// pane-test.js covers what happens with several of them.
const handler = w.__handleEventForTest;
const panesHooks = w.__panesForTest;
let chat = null;
if (typeof handler === 'function' && panesHooks) {
  try {
    chat = panesHooks.openChat({
      cwd: '/workspace/projects/demo',
      title: 'a past chat',
      resumeSessionId: 'abc123',
    });
    handler({
      type: 'history',
      truncated: 340,
      messages: [
        { type: 'user_message', text: 'a question' },
        { type: 'assistant_text', text: 'an **answer** with `code`' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a/b.txt' } },
      ],
    }, chat);
    const thread = chat.thread?.innerHTML ?? '';
    if (!thread.includes('a question')) failures.push('history: user message not rendered');
    if (!thread.includes('answer')) failures.push('history: assistant message not rendered');
    if (!thread.includes('class="tool"')) failures.push('history: tool card not rendered');
    if (!thread.includes('340 earlier')) failures.push('history: truncation notice missing');
    // The thread is the pane's own element, not a fixed one in index.html.
    if (chat.thread?.parentElement?.id !== 'threads') {
      failures.push("history: the pane's thread is not inside #threads");
    }
  } catch (err) {
    failures.push(`history render threw: ${err.message}`);
  }
} else {
  failures.push('client did not expose handleEvent and the pane hooks for testing');
}

// Dictation that stops on its own must never do so quietly: the bug this guards
// against is a phone whose screen slept mid-sentence, where the only evidence
// was a mic button the user could no longer see.
{
  const hooks = w.__voiceForTest;
  if (!hooks) {
    failures.push('client did not expose the voice hooks for testing');
  } else {
    const box = w.document.querySelector('#input');
    box.value = 'a half-finished sentence';
    hooks.voice.active = true;
    hooks.voice.startedAt = Date.now();
    hooks.stopVoice({ reason: 'the app went to the background' });

    const bar = w.document.querySelector('#dictation-bar');
    if (bar.classList.contains('hidden')) {
      failures.push('interrupted dictation left no visible notice');
    }
    if (!/stopped/i.test(bar.textContent)) {
      failures.push('dictation notice does not say dictation stopped');
    }
    if (w.document.querySelector('#btn-dictation-resume').classList.contains('hidden')) {
      failures.push('interrupted dictation offers no way to resume');
    }
    if (box.value !== 'a half-finished sentence') {
      failures.push('interrupted dictation discarded the text already dictated');
    }

    // Resume must continue where the interruption left off. The composer is
    // deliberately left unfocused behind the banner, and an unfocused textarea
    // reports selectionStart 0 — which put resumed words at the front of the box
    // and shunted the earlier dictation behind them, reading as a doubled phrase.
    hooks.voice.anchor = 4;
    hooks.voice.committed = ' dictated words';
    hooks.voice.active = true;
    hooks.stopVoice({ reason: 'the screen turned off' });
    box.setSelectionRange(0, 0);
    if (hooks.nextDictationAnchor() !== 4 + ' dictated words'.length) {
      failures.push('resuming dictation did not continue where it stopped');
    }

    // A stop the user asked for is not an alarm.
    hooks.voice.active = true;
    hooks.stopVoice();
    if (!w.document.querySelector('#dictation-bar').classList.contains('hidden')) {
      failures.push('a deliberate stop still showed the interruption notice');
    }
    // ...and it hands the anchor back to the caret rather than pinning it.
    box.value = 'typed';
    box.setSelectionRange(2, 2);
    if (hooks.nextDictationAnchor() !== 2) {
      failures.push('a deliberate stop still pinned the next dictation anchor');
    }

    // Two taps on the mic must not open two recorders: both would capture the
    // same speech into one upload and it would come back transcribed twice.
    let micOpens = 0;
    Object.defineProperty(w.navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => { micOpens++; return new Promise(() => {}); } },
    });
    hooks.voice.mode = 'record';
    hooks.voice.active = false;
    hooks.startVoice();
    hooks.startVoice();
    if (micOpens !== 1) {
      failures.push(`overlapping mic taps opened the microphone ${micOpens} times, expected 1`);
    }

    // Whisper narrates non-speech in brackets and, on near-silence, sometimes
    // emits a stock phrase. Chunked dictation feeds it many short quiet
    // segments, so any of this reaching the composer would be constant.
    const junk = [['[BLANK_AUDIO]', ''], ['(wind blowing)', ''], ['Thank you.', ''],
                  ['  Hello   there. ', 'Hello there.'], ['[MUSIC] real words', 'real words']];
    for (const [raw, want] of junk) {
      const got = hooks.cleanTranscript(raw);
      if (got !== want) failures.push(`cleanTranscript(${JSON.stringify(raw)}) = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
    if (hooks.joinPhrases('First one.', 'Second one.') !== 'First one. Second one.') {
      failures.push('joinPhrases did not space two phrases correctly');
    }
  }
}

// Where the audio gets cut is the whole feature: cuts must land in silence so no
// word is split across two transcription requests. Driven with synthetic frames
// because a real ScriptProcessor callback cannot be exercised here.
{
  const hooks = w.__voiceForTest;
  if (hooks) {
    const RATE = 16000;
    const FRAME = 512;                       // 32ms at 16 kHz
    const frames = (ms, rms) => {
      const out = [];
      for (let n = 0; n < Math.round((ms / 1000) * RATE / FRAME); n++) {
        const f = new Float32Array(FRAME);
        // A constant magnitude gives exactly this RMS.
        for (let i = 0; i < FRAME; i++) f[i] = i % 2 ? rms : -rms;
        out.push(f);
      }
      return out;
    };
    const LOUD = hooks.VAD.speech * 3;
    const QUIET = hooks.VAD.silence / 3;

    const run = (script) => {
      const cuts = [];
      const cutter = hooks.createPhraseCutter(RATE, (s) => cuts.push(s.length / RATE));
      for (const f of script) cutter.push(f);
      cutter.flush();
      return cuts;
    };

    // Two sentences with a clear pause between them: two phrases.
    const two = run([
      ...frames(1200, LOUD),
      ...frames(hooks.VAD.hangoverMs + 200, QUIET),
      ...frames(1000, LOUD),
    ]);
    if (two.length !== 2) {
      failures.push(`speech-pause-speech produced ${two.length} phrases, expected 2`);
    }

    // A short pause *within* a sentence must not cut: that is what split words
    // mid-phrase and made the old path need overlap-guessing to recover.
    const one = run([
      ...frames(900, LOUD),
      ...frames(Math.max(60, hooks.VAD.hangoverMs - 300), QUIET),
      ...frames(900, LOUD),
    ]);
    if (one.length !== 1) {
      failures.push(`a brief pause mid-sentence produced ${one.length} phrases, expected 1`);
    }

    // Silence alone is never a phrase.
    if (run(frames(3000, QUIET)).length !== 0) {
      failures.push('silence alone produced a phrase');
    }

    // One long unbroken sentence must still be cut, or nothing is transcribed
    // until the user stops talking.
    const long = run(frames(hooks.VAD.maxPhraseMs + 3000, LOUD));
    if (long.length < 2) {
      failures.push(`${(hooks.VAD.maxPhraseMs + 3000) / 1000}s of unbroken speech produced ${long.length} phrases, expected a forced cut`);
    }
    if (long.some((d) => d * 1000 > hooks.VAD.maxPhraseMs + hooks.VAD.frameMs * 4)) {
      failures.push(`a forced cut exceeded maxPhraseMs: ${JSON.stringify(long)}`);
    }
  }
}

// The streaming path replaced a word-overlap heuristic that stitched fragments
// from the browser recognizer — the thing that produced doubled words. What
// matters now is that separately-transcribed phrases land in the order spoken,
// exactly once each, with the junk dropped.
{
  const hooks = w.__voiceForTest;
  if (hooks) {
    const box = w.document.querySelector('#input');
    box.value = '';
    box.setSelectionRange(0, 0);
    hooks.voice.resumeFromEnd = false;
    hooks.voice.anchor = 0;
    hooks.voice.committed = '';
    hooks.voice.finalText = '';
    hooks.voice.queue = [];
    hooks.voice.pumping = false;
    hooks.voice.active = false;
    hooks.voice.sampleRate = 16000;

    transcripts.length = 0;
    transcripts.push('Let me know when it is deployed', '[BLANK_AUDIO]', 'so I can test it.');

    // Long enough to clear the minimum-phrase gate; contents are irrelevant
    // because the fake server does not look at the audio.
    const phrase = () => new Float32Array(Math.ceil(0.6 * 16000));
    hooks.enqueuePhrase(phrase());
    hooks.enqueuePhrase(phrase());
    hooks.enqueuePhrase(phrase());
    // A phrase too short to be speech must never be sent at all.
    hooks.enqueuePhrase(new Float32Array(64));

    await new Promise((resolve) => {
      const wait = () => (hooks.voice.pumping || hooks.voice.queue.length
        ? setTimeout(wait, 10)
        : resolve());
      wait();
    });

    const want = 'Let me know when it is deployed so I can test it.';
    if (box.value !== want) {
      failures.push(`streamed phrases assembled as ${JSON.stringify(box.value)}, want ${JSON.stringify(want)}`);
    }
    const sent = calls.filter((u) => u.includes('/api/transcribe')).length;
    if (sent !== 3) {
      failures.push(`sent ${sent} phrases for transcription, expected 3 (the 64-sample one is noise)`);
    }
  }
}

// Punctuating a finished dictation. The reason this is worth testing is not the
// happy path — it is that the pass answers a second or two after the words land,
// while the composer is live, and it rewrites text in place. Overwriting what
// somebody typed in that window, or pasting a stale sentence over a fresh
// dictation, would be far worse than the missing full stops it fixes.
{
  const hooks = w.__voiceForTest;
  if (typeof hooks?.polishDictation !== 'function') {
    failures.push('client did not expose the dictation cleanup for testing');
  } else {
    const box = w.document.querySelector('#input');
    const RAW = 'compared to Georgia PT and Germany apps for consumers';
    const CLEAN = 'compared to ChatGPT and Gemini apps for consumers.';

    // An earlier block leaves a start pending on a getUserMedia that never
    // resolves; the cleanup pass correctly refuses to touch the box while
    // dictation is starting, so that has to be cleared first.
    const idle = () => {
      hooks.voice.active = false;
      hooks.voice.starting = false;
      hooks.voice.polishing = null;
    };

    // The ordinary case: the dictated span is replaced, and text typed around it
    // is left exactly where it was.
    idle();
    box.value = `before ${RAW} after`;
    hooks.voice.anchor = 'before '.length;
    hooks.voice.committed = RAW;
    polishReply = CLEAN;
    polished.length = 0;
    await hooks.polishDictation();
    if (box.value !== `before ${CLEAN} after`) {
      failures.push(`cleanup produced ${JSON.stringify(box.value)}, want ${JSON.stringify(`before ${CLEAN} after`)}`);
    }
    if (polished[0] !== RAW) {
      failures.push(`cleanup sent ${JSON.stringify(polished[0])} to the server, want the dictated text`);
    }

    // Carrying on typing while the pass is in flight. What was typed must survive
    // untouched, the dictation must still get punctuated, and the caret must end
    // up where the typing left it rather than back at the end of the dictation.
    idle();
    box.value = RAW;
    hooks.voice.anchor = 0;
    hooks.voice.committed = RAW;
    polishReply = CLEAN;
    const inFlight = hooks.polishDictation();
    box.value = `${RAW} and one more thought`;
    box.setSelectionRange(box.value.length, box.value.length);
    await inFlight;
    if (box.value !== `${CLEAN} and one more thought`) {
      failures.push(`cleanup mishandled text typed while it was in flight: ${JSON.stringify(box.value)}`);
    }
    if (box.selectionStart !== box.value.length) {
      failures.push(`cleanup left the caret at ${box.selectionStart}, want the end of what was typed (${box.value.length})`);
    }

    // Editing the dictated words themselves is different: the reply describes the
    // sentence that was there before, so applying it would undo the correction.
    idle();
    box.value = RAW;
    hooks.voice.anchor = 0;
    hooks.voice.committed = RAW;
    polishReply = CLEAN;
    const edited = hooks.polishDictation();
    box.value = RAW.replace('Georgia PT', 'ChatGPT');
    await edited;
    if (box.value !== RAW.replace('Georgia PT', 'ChatGPT')) {
      failures.push(`cleanup undid an edit to the dictated words: ${JSON.stringify(box.value)}`);
    }

    // Starting a new dictation is the same problem with a worse outcome: the
    // reply describes the previous utterance.
    idle();
    box.value = RAW;
    hooks.voice.anchor = 0;
    hooks.voice.committed = RAW;
    polishReply = CLEAN;
    const stale = hooks.polishDictation();
    hooks.voice.active = true;
    await stale;
    if (box.value !== RAW) {
      failures.push(`cleanup rewrote the box under a new dictation: ${JSON.stringify(box.value)}`);
    }

    // Off means no request at all, not a request whose answer is discarded: it
    // costs tokens and it is somebody's dictation leaving the box.
    idle();
    hooks.setPolishDictation(false);
    box.value = RAW;
    hooks.voice.anchor = 0;
    hooks.voice.committed = RAW;
    polished.length = 0;
    await hooks.polishDictation();
    if (polished.length !== 0) {
      failures.push('cleanup called the server with the setting turned off');
    }
    hooks.setPolishDictation(true);

    // Sending immediately after speaking is the normal way to use dictation, so a
    // send must not race the pass and ship the unpunctuated version.
    idle();
    const sent = [];
    // The socket belongs to the pane the composer is pointing at, which is the
    // one opened above.
    if (chat) chat.ws = { readyState: 1, send: (frame) => sent.push(JSON.parse(frame)) };
    box.value = RAW;
    hooks.voice.anchor = 0;
    hooks.voice.committed = RAW;
    polishReply = CLEAN;
    hooks.polishDictation();
    await hooks.sendMessage();
    if (sent[0]?.text !== CLEAN) {
      failures.push(`sending mid-cleanup sent ${JSON.stringify(sent[0]?.text)}, want the punctuated text`);
    }
    if (chat) chat.ws = null;
    polishReply = null;
  }
}

// Keeping the display awake for as long as the app is open. None of this is
// observable from a desktop browser — whether a screen sleeps is invisible to the
// page — so the reconciler is driven against a fake wakeLock. What the fake
// models is the part that actually bites: the browser drops the lock on every
// hide and never takes it back, and the OS revokes it whenever it likes, so
// anything that acquires once is awake for one screen-off and asleep after.
{
  const screen = w.__screenForTest;
  const vhooks = w.__voiceForTest;
  if (!screen) {
    failures.push('client did not expose the screen hooks for testing');
  } else {
    let requests = 0;
    let released = 0;
    let lastLock = null;
    let visibility = 'visible';
    let refuse = false;

    Object.defineProperty(w.document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
    Object.defineProperty(w.navigator, 'wakeLock', {
      configurable: true,
      value: {
        request: () => {
          requests++;
          if (refuse) return Promise.reject(new Error('refused by the OS'));
          const listeners = [];
          lastLock = {
            addEventListener: (_type, fn) => listeners.push(fn),
            release: () => { released++; listeners.forEach((fn) => fn()); },
          };
          return Promise.resolve(lastLock);
        },
      },
    });

    // The reconciler resolves through a promise, and setKeepAwake deliberately
    // does not await it, so assertions read state one tick later.
    const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

    screen.setKeepAwake(true);
    await settle();
    if (!screen.wakeLockHeld()) {
      failures.push('no wake lock taken while the app was open and visible');
    }

    // Idempotent: this runs on a timer and on every visibility change, so a
    // second call must not stack up a second lock.
    const beforeRepeat = requests;
    await screen.syncWakeLock();
    if (requests !== beforeRepeat) {
      failures.push('syncWakeLock re-requested a lock it was already holding');
    }

    // Hidden: the browser has already released it, and requesting would reject.
    visibility = 'hidden';
    await screen.syncWakeLock();
    await settle();
    if (screen.wakeLockHeld()) {
      failures.push('claimed to hold the wake lock while the page was hidden');
    }

    // Back in the foreground it must be taken again. This is the whole point:
    // nothing re-acquires it for us.
    visibility = 'visible';
    await screen.syncWakeLock();
    await settle();
    if (!screen.wakeLockHeld()) {
      failures.push('wake lock not re-acquired when the app returned to the foreground');
    }

    // The OS revokes it at will — battery saver, low battery. The handle is dead
    // and the next sync has to ask again rather than trust it.
    lastLock.release();
    if (screen.wakeLockHeld()) {
      failures.push('kept a wake lock handle the OS had already revoked');
    }
    const beforeRetry = requests;
    await screen.syncWakeLock();
    await settle();
    if (requests <= beforeRetry || !screen.wakeLockHeld()) {
      failures.push('did not re-request the wake lock after the OS revoked it');
    }

    // Turning it off must actually let go, or the switch is decorative.
    const beforeOff = released;
    screen.setKeepAwake(false);
    await settle();
    if (screen.wakeLockHeld() || released <= beforeOff) {
      failures.push('turning the setting off did not release the wake lock');
    }

    // Dictation overrides the setting: off means "don't burn battery while I
    // read", not "cut me off mid-sentence".
    vhooks.voice.active = true;
    if (!screen.wantsScreenAwake()) {
      failures.push('dictation did not override the setting being off');
    }
    await screen.syncWakeLock();
    await settle();
    if (!screen.wakeLockHeld()) {
      failures.push('dictation ran without holding the screen awake');
    }
    vhooks.voice.active = false;
    screen.setKeepAwake(false);
    await settle();

    // A refusal must not be reported as success: that boolean is what the status
    // bar's "screen may sleep and cut this off" warning reads.
    refuse = true;
    screen.setKeepAwake(true);
    await settle();
    if (screen.wakeLockHeld()) {
      failures.push('a refused wake lock was reported as held');
    }
    refuse = false;
  }
}

// A half-typed message must survive the page being taken away. The reload is not
// this app's decision — iOS discards a backgrounded tab, the editor surface
// reloads itself — and the report this guards against was minutes of dictation
// destroyed "without any backup". jsdom cannot reload, so the save and the
// restore are driven directly, which is also the only way to assert the scoping.
{
  const drafts = w.__draftForTest;
  if (!drafts || !chat) {
    failures.push('client did not expose the draft hooks for testing');
  } else {
    const box = drafts.input;
    // Typing happens with a chat open, and which chat is what the draft records.
    // The pane opened above is the one on screen, so it is the one the composer
    // and every draft written below belong to.
    panesHooks.activatePane(chat);
    const key = drafts.draftKeyFor(chat);

    box.value = 'a paragraph of dictated code';
    drafts.saveDraft({ now: true });
    if (!w.localStorage.getItem(key)) {
      failures.push('typing left no draft behind to recover');
    }

    // What a reload looks like from here: the box is empty again, and the chat
    // being reopened is the one the draft was typed in.
    box.value = '';
    if (!drafts.restoreDraft(chat)) {
      failures.push('reopening the same chat did not restore the draft');
    }
    if (box.value !== 'a paragraph of dictated code') {
      failures.push('restored draft does not match what was typed');
    }

    // A draft belongs to one conversation. Restoring it under a different one
    // would put the user's words into a chat they were not written for.
    box.value = '';
    if (drafts.restoreDraft({ cwd: '/workspace/projects/other', sessionId: 'abc123' })) {
      failures.push('draft leaked into a different project');
    }
    if (drafts.restoreDraft({ cwd: chat.cwd, sessionId: 'zzz999' })) {
      failures.push('draft leaked into a different session in the same project');
    }
    if (box.value !== '') {
      failures.push('a rejected draft still wrote into the composer');
    }

    // Text already in the box is more current than anything saved earlier.
    box.value = 'something newer';
    if (drafts.restoreDraft(chat)) {
      failures.push('restoring overwrote text already in the composer');
    }
    if (box.value !== 'something newer') {
      failures.push('restore clobbered the composer it was told to leave alone');
    }

    // Sending clears the box, and that has to clear the draft too — otherwise the
    // next reload puts an already-sent message back.
    box.value = '';
    drafts.saveDraft({ now: true });
    if (w.localStorage.getItem(key)) {
      failures.push('an emptied composer left a stale draft behind');
    }
  }
}

if (failures.length) {
  console.error('FAIL:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

// Stops jsdom's timers — the client now holds a repeating one for the wake lock.
dom.window.close();

console.log(
  'PASS: client boots, lists conversations, renders resumed history, ' +
  'announces interrupted dictation, holds the screen awake, keeps an ' +
  'unsent message across a reload, and punctuates dictation without ' +
  'overwriting what was typed',
);
