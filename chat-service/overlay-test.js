/**
 * Boot the editor's mobile overlay in a real DOM and prove its escape hatch works.
 *
 * The overlay is injected raw into code-server by nginx, so nothing else ever
 * loads it: a runtime error at the top means the mic, the project switcher and
 * the layout rescue all silently vanish from the editor, and the only symptom is
 * buttons that aren't there. It has also mounted twice before, inside the Claude
 * panel's iframe, which is covered here too.
 *
 * The layout rescue gets the most attention because it is the part that cannot
 * report its own failure. It drives the mobile extension through a synthesised
 * keyboard chord, which is a contract between two files that share no code —
 * `pwa/mobile-overlay.js` decides which keys to send, `mobile-extension/
 * package.json` decides which keys mean something. If those drift apart, the
 * button stops working and nothing anywhere throws. So the chords are read out
 * of the extension's manifest and compared against what the buttons actually
 * dispatch.
 *
 * Run: node chat-service/overlay-test.js
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { JSDOM, VirtualConsole } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const overlayJs = readFileSync(join(root, 'pwa', 'mobile-overlay.js'), 'utf8');
const manifest = JSON.parse(readFileSync(join(root, 'mobile-extension', 'package.json'), 'utf8'));

const failures = [];
const fail = (msg) => failures.push(msg);
let checks = 0;
const ok = (msg, cond) => {
  checks++;
  if (!cond) fail(msg);
};

// ---------------------------------------------------------------- the chords
/**
 * What VS Code's keybinding service reads off a keydown, derived from a
 * `contributes.keybindings` entry. Function keys are the only ones used, so the
 * mapping stays deliberately narrow: guessing at a wider table would invent
 * agreement that hasn't been checked.
 */
function parseKeybinding(key) {
  const parts = key.toLowerCase().split('+');
  const base = parts.pop();
  const fn = /^f(\d{1,2})$/.exec(base);
  if (!fn) return null;
  return {
    key: base.toUpperCase(),
    keyCode: 111 + Number(fn[1]), // F1 is 112
    ctrlKey: parts.includes('ctrl'),
    altKey: parts.includes('alt'),
    shiftKey: parts.includes('shift'),
  };
}

const bound = new Map();
for (const kb of manifest.contributes?.keybindings ?? []) {
  const parsed = parseKeybinding(kb.key);
  if (!parsed) {
    fail(`keybinding for ${kb.command} is not a function-key chord: ${kb.key}`);
    continue;
  }
  bound.set(kb.command, parsed);
}

ok(
  'mobile-extension binds no keybinding for claudeMobile.backToClaude — the overlay ' +
    'button has nothing to trigger',
  bound.has('claudeMobile.backToClaude'),
);
ok(
  'mobile-extension binds no keybinding for claudeMobile.toggleChrome',
  bound.has('claudeMobile.toggleChrome'),
);
ok(
  'mobile-extension binds no keybinding for claudeMobile.toggleTerminal — the bar’s ' +
    'terminal button has nothing to trigger',
  bound.has('claudeMobile.toggleTerminal'),
);

/*
 * The terminal has to open in the *editor area*. `workbench.panel.defaultLocation`
 * is `right` on this surface, so a panel terminal is a narrow column beside Claude
 * with the soft keyboard over it. Checked in the source because there is no VS Code
 * API to run against here, and the failure it guards is silent: a panel terminal
 * still works, it is just unusable on the device this exists for.
 */
const extensionJs = readFileSync(join(root, 'mobile-extension', 'extension.js'), 'utf8');
ok(
  'the extension registers no handler for claudeMobile.toggleTerminal',
  extensionJs.includes("registerCommand('claudeMobile.toggleTerminal'"),
);
ok(
  'the terminal is not opened in the editor area (TerminalLocation.Editor)',
  /TerminalLocation\.Editor/.test(extensionJs),
);
ok(
  'nothing reuses an existing terminal, so every press or reload stacks a new shell',
  /vscode\.window\.terminals/.test(extensionJs),
);

const declared = new Set((manifest.contributes?.commands ?? []).map((c) => c.command));
for (const command of bound.keys()) {
  ok(`${command} is bound to a key but not declared in contributes.commands`, declared.has(command));
}

// ------------------------------------------------------------- the top frame
// jsdom logs unimplemented navigation as a jsdomError; that is not a failure.
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', () => {});
virtualConsole.on('error', (m) => fail(`console error: ${m}`));

const dom = new JSDOM(
  '<!doctype html><html><head></head><body><iframe id="panel" srcdoc="<p>webview</p>"></iframe></body></html>',
  {
    runScripts: 'outside-only',
    // Any HTTPS origin will do; localStorage needs a real one.
    url: 'https://claude.example.com/editor/?folder=%2Fworkspace%2Fprojects%2Fdemo',
    virtualConsole,
  },
);
const w = dom.window;
w.addEventListener('error', (e) => fail(`uncaught: ${e.message}`));

// The project switcher's only source of truth. Two projects, one of them the
// folder this window already has open (see the URL above).
// What the dictation cleanup route answers, and what it was asked. `null` is the
// route being unavailable, which is a case the sheet has to survive rather than a
// case it can report.
let polishReply = null;
const polishCalls = [];

/*
 * What the status route answers, and what it was asked.
 *
 * It starts as `null` — the route unreachable — because that is the state the
 * overlay has to survive silently, and the initial check runs at load, before any
 * test can intervene. A phone whose chat-service session has lapsed gets a 401
 * here, and the one thing it must not get is a banner across the editor.
 */
let statusReply = null;
const statusCalls = [];

w.fetch = (url, options = {}) => {
  const target = String(url);
  if (target.includes('/api/claude-status')) {
    statusCalls.push(target);
    if (!statusReply) {
      return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(statusReply) });
  }
  if (target.includes('/api/projects')) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        projects: [
          { name: 'demo', path: '/workspace/projects/demo' },
          { name: 'other', path: '/workspace/projects/other' },
        ],
      }),
    });
  }
  if (target.includes('/api/polish')) {
    polishCalls.push(JSON.parse(options.body || '{}').text);
    if (!polishReply) {
      return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(polishReply) });
  }
  return Promise.reject(new Error(`unexpected fetch: ${target}`));
};

// jsdom has no clipboard, and the clipboard is the only way text leaves the
// dictation sheet, so it is recorded rather than stubbed away.
const copied = [];
Object.defineProperty(w.navigator, 'clipboard', {
  configurable: true,
  value: { writeText: (text) => { copied.push(String(text)); return Promise.resolve(); } },
});

try {
  w.eval(overlayJs);
} catch (err) {
  console.error(`FAIL: mobile-overlay.js threw on load — ${err.constructor.name}: ${err.message}`);
  console.error(err.stack?.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}

const doc = w.document;
for (const id of ['cmo-fab', 'cmo-layout', 'cmo-projects', 'cmo-status', 'cmo-mic']) {
  ok(`#${id} did not mount`, doc.getElementById(id));
}

// --------------------------------------------------------- is Claude working
/*
 * The chip answers, on arrival, the question the Claude panel makes you wait
 * seconds for: is Claude still working, and if not, what did it last say. The
 * panel loads the whole transcript on every page load and renders it oldest-first,
 * so the newest message — the one needed in order to reply — arrives last.
 *
 * The failure that matters most is the quiet one. The editor and the chat API are
 * gated separately, so a device signed into code-server alone gets a 401 here, and
 * an older deployment has no such route at all. Both must leave the editor exactly
 * as it was: this thing floats over someone's screen, and being wrong about that
 * is worse than not being there.
 */
await new Promise((resolve) => setTimeout(resolve, 20)); // the check at load
ok('the status route was never asked, so the chip cannot appear at all', statusCalls.length === 1);
ok(
  'an unreachable status route still put a chip over the editor — a lapsed chat ' +
    'session or an older deployment would show it on every page load',
  !doc.getElementById('cmo-chip'),
);

// ------------------------------------------------------------ the load history
/*
 * Every load leaves a line behind, because a workbench that reloads itself on a
 * phone cannot be diagnosed from the instance — the server sees an identical dead
 * extension host whichever cause it was.
 */
const loads = () => JSON.parse(w.localStorage.getItem('claude-editor-loads') || '[]');
ok('the load was not recorded, so a reload leaves no evidence', loads().length === 1);
ok(
  'the recorded load does not say which folder it opened',
  loads()[0]?.folder === '/workspace/projects/demo',
);

// ------------------------------------------------------------- the iframe case
/*
 * The Claude panel is served from this same origin, so nginx's injection reached
 * it and a second mic and project switcher mounted inside the panel — a few
 * pixels off the workbench's own. The overlay refuses to run outside the top
 * frame; this is that refusal.
 */
const inner = doc.getElementById('panel').contentWindow;
try {
  inner.eval(overlayJs);
} catch (err) {
  fail(`overlay threw inside a subframe: ${err.message}`);
}
ok(
  'the overlay mounted inside a subframe — the Claude panel will show a second ' +
    'set of buttons',
  !inner.document.getElementById('cmo-fab'),
);
ok(
  'a subframe recorded a page load, which would count every webview as a reload',
  loads().length === 1,
);

// -------------------------------------------------------------- layout rescue
doc.getElementById('cmo-layout').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

const sheet = doc.getElementById('cmo-sheet');
ok('the Layout button did not open the sheet', sheet.classList.contains('cmo-open'));
for (const id of ['cmo-back', 'cmo-chrome', 'cmo-reload', 'cmo-layout-close']) {
  ok(`the Layout sheet is missing #${id}`, doc.getElementById(id));
}
ok(
  'the Layout sheet does not link the device reset, which is the last resort when ' +
    'a reload comes back broken',
  /reset\.html/.test(doc.getElementById('cmo-panel').innerHTML),
);
ok(
  'the Layout sheet does not show the load history — the one place a phone-only ' +
    'reload becomes readable evidence',
  /load/.test(doc.getElementById('cmo-loads')?.textContent ?? ''),
);

/*
 * Listen on the *window*, which is where VS Code's keybinding service listens,
 * and put focus somewhere else first — in the editor the focused element is
 * usually the Claude panel's iframe. A chord that only reaches its own button is
 * a chord VS Code never sees.
 */
const seen = [];
w.addEventListener('keydown', (e) => {
  seen.push({
    key: e.key,
    code: e.code,
    keyCode: e.keyCode,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    shiftKey: e.shiftKey,
  });
});

function chordFor(buttonId) {
  seen.length = 0;
  doc.getElementById('panel').focus();
  doc.getElementById(buttonId).dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  return seen;
}

function assertChord(buttonId, command) {
  const want = bound.get(command);
  if (!want) return; // already reported above
  const got = chordFor(buttonId);
  checks++;
  const match = got.find(
    (e) =>
      e.keyCode === want.keyCode &&
      e.ctrlKey === want.ctrlKey &&
      e.altKey === want.altKey &&
      e.shiftKey === want.shiftKey,
  );
  if (!match) {
    fail(
      `#${buttonId} did not send ${command}'s chord to the window. ` +
        `expected keyCode ${want.keyCode} with ctrl/alt/shift ` +
        `${want.ctrlKey}/${want.altKey}/${want.shiftKey}; saw ` +
        (got.length ? JSON.stringify(got) : 'no keydown at all'),
    );
    return;
  }
  ok(`#${buttonId} sent keyCode ${match.keyCode} but key "${match.key}"`, match.key === want.key);
}

assertChord('cmo-back', 'claudeMobile.backToClaude');

// The sheet closes itself a moment after each tap, so reopen for the next one.
doc.getElementById('cmo-layout').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
assertChord('cmo-chrome', 'claudeMobile.toggleChrome');

// This one is on the bar rather than in a sheet: one tap, from wherever you are.
assertChord('cmo-terminal', 'claudeMobile.toggleTerminal');

// --------------------------------------------------------- the project switcher
/*
 * Tapping the project you are already in used to navigate anyway, which reloads
 * the whole workbench, restarts the extension host and discards anything typed
 * into the Claude panel — to arrive exactly where you already were. The switcher
 * is also the natural thing to open just to check which project this window has,
 * so that tap is normal, not a mistake.
 *
 * jsdom cannot navigate, so the observable difference is the sheet: the no-op path
 * closes it, the navigating path leaves it open.
 */
doc.getElementById('cmo-projects').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 20)); // the fetch above

const items = [...doc.querySelectorAll('.cmo-item')];
ok('the project switcher listed no projects', items.length === 2);
const currentItem = items.find((el) => el.dataset.path.includes('demo'));
const otherItem = items.find((el) => el.dataset.path.includes('other'));
ok(
  'the project this window already has open is not marked as open',
  currentItem?.dataset.open === '1' && /open/.test(currentItem.textContent),
);
ok('a project that is not open was marked as open', otherItem && !otherItem.dataset.open);

currentItem?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
ok(
  'tapping the already-open project did not just close the sheet — it reloads the ' +
    'editor for nothing',
  !sheet.classList.contains('cmo-open'),
);

// ----------------------------------------------------------- dictation drafts
/*
 * The Claude panel is a sandboxed iframe, so dictated words have to wait in the
 * overlay's textarea until they are copied across — and the workbench reloads
 * itself whenever the browser restores the page from the back/forward cache, which
 * on a phone is every app switch. A paragraph of speech exists nowhere else, so it
 * has to survive that.
 */
const openMic = () =>
  doc.getElementById('cmo-mic').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

openMic();
const textarea = doc.getElementById('cmo-text');
ok('the mic button did not open a dictation sheet', textarea);
if (textarea) {
  textarea.value = 'a paragraph nobody typed twice';
  textarea.dispatchEvent(new w.Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 500)); // the save is debounced
  ok(
    'dictated text left no draft behind, so a reload takes the whole paragraph',
    /nobody typed twice/.test(w.localStorage.getItem('cmo-dictation-draft') || ''),
  );

  // What a reload looks like from here: the sheet is built again from scratch.
  openMic();
  ok(
    'reopening the dictation sheet did not recover the words already spoken',
    doc.getElementById('cmo-text')?.value === 'a paragraph nobody typed twice',
  );

  // Cancel is an explicit decision to throw the text away; dismissing the sheet by
  // tapping outside it is not, and those two are one stray tap apart.
  doc.getElementById('cmo-cancel').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  ok(
    'Cancel left the discarded dictation in storage, so it comes back next time',
    !w.localStorage.getItem('cmo-dictation-draft'),
  );
}

// -------------------------------------------------------- copying the dictation
/*
 * What leaves this sheet is whatever is on the clipboard, so the cleanup pass is
 * only allowed to improve it, never to be the thing that produces it. Two orders
 * are asserted: the raw text is copied inside the tap (a clipboard write issued
 * after an `await` is refused on iOS), and the punctuated version replaces it only
 * once it has actually arrived.
 */
const copy = async () => {
  doc.getElementById('cmo-copy').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 30));
};

const dictate = async (text) => {
  openMic();
  const box = doc.getElementById('cmo-text');
  box.value = text;
  box.dispatchEvent(new w.Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 20));
};

const spoken = 'the transcript nobody punctuated';
const punctuated = 'The transcript nobody punctuated.';

copied.length = 0;
polishCalls.length = 0;
polishReply = { text: punctuated, changed: true };
await dictate(spoken);
await copy();

ok('Copy did not send the dictation to be punctuated', polishCalls[0] === spoken);
ok(
  'Copy did not put the raw text on the clipboard first — a cleanup that fails or ' +
    'a clipboard that only allows writes inside the tap would lose the dictation',
  copied[0] === spoken,
);
ok('the punctuated text never reached the clipboard', copied[1] === punctuated);
ok(
  'the punctuated text was copied but not shown — it arrives in Claude looking ' +
    'like something the user never dictated',
  doc.getElementById('cmo-text')?.value === punctuated,
);
ok(
  'the handed-over dictation is still stored, so it comes back on the next tap',
  !w.localStorage.getItem('cmo-dictation-draft'),
);

// The route being unreachable (no Bedrock access, a lapsed chat session, a
// timeout) must be indistinguishable from the feature not being there.
copied.length = 0;
polishReply = null;
await dictate('another sentence nobody punctuated');
await copy();
ok(
  'a failed cleanup pass took the dictation with it instead of copying it as-is',
  copied.length === 1 && copied[0] === 'another sentence nobody punctuated',
);
ok(
  'a failed cleanup pass left the dictation in storage as well as on the clipboard',
  !w.localStorage.getItem('cmo-dictation-draft'),
);

// ---------------------------------------------------- what Claude last said
/*
 * The idle branch. This is the one that saves the wait: nothing is running, so
 * there is nothing to wait for, and the last message is the whole payload.
 *
 * The message is model output. It routinely contains code, angle brackets and
 * things that look like markup, and it lands in a sheet built from a template
 * string — so the check is not that it renders, but that it renders as *text*.
 */
const said = 'Done. Try <img src=x onerror="alert(1)"> and `a < b` in one line.\n\nSecond line.';
statusReply = {
  cwd: '/workspace/projects/demo',
  sessionId: 'abc123',
  state: 'idle',
  source: 'broker',
  clients: 0,
  last: { role: 'assistant', text: said, at: new Date().toISOString() },
  bytes: 5.1 * 1024 * 1024,
  at: Date.now(),
};

/*
 * Scoped to the bar, not `getElementById`: the dictation sheet has a
 * `<p id="cmo-status">` of its own, so while that sheet is open the plain lookup
 * is ambiguous and returns whichever comes first in the document. It happens to
 * be this button — which is a fact about the order two elements are appended in,
 * not something to build every later check on.
 */
const tapStatus = async () => {
  doc.querySelector('#cmo-fab #cmo-status').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 30));
};

await tapStatus();
const chipEl = doc.getElementById('cmo-chip');
ok('an idle conversation showed no chip, so the last message is still unread', chipEl);
ok(
  'the chip does not show what Claude said — the only thing that saves the wait',
  /Done\. Try/.test(chipEl?.querySelector('.cmo-chip-text')?.textContent ?? ''),
);
ok(
  'the chip is on one line, so a long message pushes the editor around',
  /nowrap/.test(w.getComputedStyle(chipEl.querySelector('.cmo-chip-text')).whiteSpace || 'nowrap'),
);
ok(
  'an idle conversation is shown with the working animation',
  !chipEl?.querySelector('.cmo-dot')?.classList.contains('cmo-busy'),
);
ok(
  'the status sheet did not open',
  sheet.classList.contains('cmo-open') && doc.getElementById('cmo-status-said'),
);
ok(
  'the sheet shows a truncated message — the point of it is that one line was not enough',
  doc.getElementById('cmo-status-said')?.textContent === said,
);
ok(
  'the message was injected as markup, not text: an <img> from a model reply built ' +
    'an element in the editor',
  !doc.querySelector('#cmo-status-said img'),
);
ok(
  'the sheet does not say where the verdict came from — the broker knows, the ' +
    'transcript only shows the state a conversation was left in',
  /broker/.test(doc.getElementById('cmo-status-detail')?.textContent ?? ''),
);
ok(
  'the sheet does not say how big the transcript is, which is the only number that ' +
    'explains the wait',
  /5\.1 MB/.test(doc.getElementById('cmo-panel')?.textContent ?? ''),
);

// ------------------------------------------------------------ the other branch
/*
 * The working branch. Here the wait *is* worth it — the answer has not been said
 * yet — so the chip says so and does not offer a stale message as if it were the
 * reply. Getting this backwards is the expensive direction: it invites typing over
 * a turn that is still running.
 */
statusReply = { ...statusReply, state: 'working', clients: 1 };
await tapStatus();
const busyChip = doc.getElementById('cmo-chip');
ok(
  'a conversation with a turn in flight is not reported as working',
  /working/i.test(busyChip?.querySelector('.cmo-chip-text')?.textContent ?? ''),
);
ok(
  'the working chip still shows the previous message, which reads as the reply',
  !/Done\. Try/.test(busyChip?.querySelector('.cmo-chip-text')?.textContent ?? ''),
);
ok(
  'the working chip is not animated, so it looks the same as a finished one',
  busyChip?.querySelector('.cmo-dot')?.classList.contains('cmo-busy'),
);
ok(
  'the sheet does not say Claude is working',
  /working/i.test(doc.querySelector('#cmo-panel .cmo-title')?.textContent ?? ''),
);

// ---------------------------------------------------------- reading it aloud
/*
 * Say the last message out loud.
 *
 * Three things here can fail silently on the device this is for and nowhere else,
 * which is why they are asserted rather than tried by hand:
 *
 *   iOS refuses speech that did not start inside the tap, so the first utterance
 *   has to be queued synchronously from the click — the same rule the clipboard
 *   write in the dictation sheet follows, and the same way of getting it wrong.
 *
 *   iOS also speaks only the first of a long queue and drops the rest, so the
 *   pieces are chained on `end`. A broken chain reads as a summary that stops
 *   after one sentence, which sounds like the answer ending there.
 *
 *   Speech over a live microphone is dictated straight back into the composer, so
 *   Claude ends up quoting itself as the user's next message.
 *
 * The reduction is checked too, because a final message is written to be read: a
 * literal reading is "asterisk asterisk Done asterisk asterisk" and every slash of
 * every path, out loud.
 */

// The sheet from the working branch above is still open, and jsdom has no
// speechSynthesis — which is also every desktop browser with speech disabled.
ok(
  'a browser that cannot speak was still offered Read aloud, so the button does ' +
    'nothing and reads as something being broken',
  !doc.getElementById('cmo-speak'),
);

/*
 * A synthesiser, as far as this feature can tell one apart from the real thing:
 * it records what it was asked to say, and calls `end` on the next turn of the
 * loop rather than at once, because a chain that only works synchronously is the
 * bug being guarded against.
 */
const utterances = [];
const langs = [];
let cancels = 0;
let speechGeneration = 0;

class FakeUtterance {
  constructor(text) {
    this.text = text;
    this.lang = '';
    this.onend = null;
    this.onerror = null;
  }
}
w.SpeechSynthesisUtterance = FakeUtterance;
w.speechSynthesis = {
  speak(utterance) {
    const generation = speechGeneration;
    utterances.push(utterance.text);
    langs.push(utterance.lang);
    // Cancelled utterances never report `end`; that is what makes Stop stop.
    setTimeout(() => {
      if (generation === speechGeneration && utterance.onend) utterance.onend();
    }, 0);
  },
  cancel() {
    cancels += 1;
    speechGeneration += 1;
  },
};

// A final message shaped like the ones this exists for: a heading, emphasis,
// inline code, a fenced block, a link, a bare URL, a full path, a line reference,
// a check-marked list, and enough prose to need more than one utterance.
const finalMessage = [
  '## Done',
  '',
  '**Fixed** the guard in `pwa/mobile-overlay.js` — it now reads the mic button’s',
  'class instead of `recognition`, which the recorder path never sets. See',
  '/workspace/projects/claude-web/chat-service/auth.js:42-51 and the note in',
  '[AGENTS.md](https://claude.example.com/AGENTS.md).',
  '',
  '```js',
  'const speaking = false; // 3 < 4 && "quoted"',
  '```',
  '',
  '- ✅ `npm run test:auth` passes',
  '- ✅ the overlay still mounts, checked at https://claude.example.com/editor/',
  '- *One* thing left: the entry in AGENTS.md.',
  '',
  'That is everything worth saying about it, and it is deliberately long enough that',
  'a synthesiser has to be handed more than one utterance to get through it, because',
  'a phone that says only the first sentence of a summary is worse than a phone that',
  'says nothing at all — you would believe it had finished.',
].join('\n');

statusReply = {
  ...statusReply,
  state: 'idle',
  clients: 0,
  last: { role: 'assistant', text: finalMessage, at: new Date().toISOString() },
};
await tapStatus();

const speakBtn = () => doc.getElementById('cmo-speak');
const barBtn = doc.querySelector('#cmo-fab #cmo-status');
const tapSpeak = () =>
  speakBtn()?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const settle = async (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));
/*
 * Wait for the queue to drain, rather than for a fixed delay.
 *
 * Every piece is one more turn of the event loop, and a box running twelve of
 * these at once misses a fixed budget often enough to matter — after which every
 * later check starts from "still reading" and three of them fail for one reason.
 * `settle` is still right where the assertion is that nothing happened.
 */
const drain = async (limit = 5000) => {
  const until = Date.now() + limit;
  while (barBtn.classList.contains('cmo-speaking') && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

ok('the status sheet offers no way to hear the message it is showing', speakBtn());
ok('the Read aloud button does not say what it does', speakBtn()?.textContent === 'Read aloud');

tapSpeak();
ok(
  'nothing was queued inside the tap — speech that starts after an await is refused ' +
    'outright on iOS, which is the only surface this feature is for',
  utterances.length === 1,
);
ok(
  'the bar does not show that it is reading, so dismissing the sheet leaves a phone ' +
    'talking with no visible way to stop it',
  barBtn.classList.contains('cmo-speaking'),
);
ok(
  'the bar button still offers to open the status sheet while it is reading, instead ' +
    'of offering Stop',
  /stop/i.test(barBtn.getAttribute('aria-label') || ''),
);
ok('the sheet button did not turn into Stop', speakBtn()?.textContent === 'Stop');

await drain();
ok(
  'only one utterance was ever utterances — the chain on `end` is what gets iOS past the ' +
    'first piece, and without it a summary stops after one sentence',
  utterances.length > 1,
);
ok(
  'an utterance was queued with no language, so it is read in whatever voice the ' +
    'device defaults to rather than the one dictation uses',
  langs.every((lang) => lang === 'en-US'),
);
ok(
  'a piece longer than the chunk limit was queued, so Stop cannot stop until it ends',
  utterances.every((piece) => piece.length <= 260),
);
ok(
  'the reading did not end on its own, so the bar is left showing Stop for a voice ' +
    'that has finished',
  !barBtn.classList.contains('cmo-speaking'),
);

const heard = utterances.join(' ');
ok('the markup was read out: backticks survived the reduction', !heard.includes('`'));
ok('the markup was read out: bold markers survived the reduction', !heard.includes('**'));
ok('the markup was read out: a heading was read as hashes', !heard.includes('##'));
ok(
  'emphasis was read as asterisks — "asterisk One asterisk thing left"',
  /\bOne thing left\b/.test(heard) && !heard.includes('*'),
);
ok('a list marker was read out instead of being a pause', !/(^|\s)- /.test(heard));
ok(
  'a URL was read out character by character instead of being named',
  !heard.includes('http') && !heard.includes('](') && /\blink\b/.test(heard),
);
ok(
  'a code block was read out loud, or dropped without saying it was there — one is ' +
    'a minute of punctuation names, the other misreports the message',
  /Code block/.test(heard) && !heard.includes('&&'),
);
ok(
  'a full path was read out slash by slash instead of by its file name',
  !heard.includes('/workspace/') && !heard.includes('pwa/') &&
    /\bmobile-overlay\.js\b/.test(heard),
);
ok(
  'a line reference was left as a colon, which runs the number into the next sentence',
  /auth\.js, line 42 to 51/.test(heard),
);
ok('a check mark was pronounced instead of dropped', !heard.includes('✅'));
ok(
  'a hard-wrapped sentence was broken at the wrap — a full stop dropped into the ' +
    'middle of a sentence is heard as a real one, and changes what it says',
  /the mic button’s class instead of recognition/.test(heard),
);
ok(
  'consecutive bullets were run into one sentence, which is what a list sounds like ' +
    'with no pauses in it',
  /passes\. the overlay still mounts/.test(heard),
);
ok(
  'a heading was run into the paragraph under it',
  /^Done\. Fixed/.test(heard),
);
ok(
  'the last sentence was left unterminated, so the voice ends on a rising note and ' +
    'sounds cut off',
  /\.$/.test(utterances[utterances.length - 1] || ''),
);
ok(
  'the message lost its words along with its markup',
  /\bDone\b/.test(heard) && /\bpasses\b/.test(heard) && /believe it had finished/.test(heard),
);

// ------------------------------------------------------------------ stopping
/*
 * Stop, from both controls. The sheet's button is the obvious one; the bar's is the
 * one that matters, because the sheet is dismissed by tapping beside it and the
 * voice carries on afterwards.
 */
tapSpeak();
let cancelsAtStart = cancels;
let utterancesAtStart = utterances.length;
tapSpeak();
await settle();
ok('Stop in the sheet did not cancel the synthesiser', cancels > cancelsAtStart);
ok(
  'Stop in the sheet cancelled the current utterance but the queue carried on',
  utterances.length === utterancesAtStart,
);
ok('Stop left the bar showing that it is still reading', !barBtn.classList.contains('cmo-speaking'));

tapSpeak();
cancelsAtStart = cancels;
utterancesAtStart = utterances.length;
const statusCallsAtStart = statusCalls.length;
barBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await settle();
ok('the bar button did not stop the reading', cancels > cancelsAtStart);
ok('the bar button stopped the current utterance but not the queue', utterances.length === utterancesAtStart);
ok(
  'the bar button asked for the status again while it was reading, so Stop also ' +
    'reopens the sheet over the editor',
  statusCalls.length === statusCallsAtStart,
);

/*
 * Dismissing the sheet is not Stop — the voice is meant to outlive it, so you can
 * go back to watching the panel while it reads. Opening dictation *is*, because a
 * live recognizer hears this and types Claude's own reply into the composer.
 */
tapSpeak();
doc.getElementById('cmo-status-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
ok('closing the sheet also stopped the reading', barBtn.classList.contains('cmo-speaking'));
ok('closing the sheet did not close it', !sheet.classList.contains('cmo-open'));

utterancesAtStart = utterances.length;
openMic();
await settle();
ok('opening the dictation sheet did not open it', doc.getElementById('cmo-text'));
ok(
  'a microphone went live while it was still reading — the recognizer transcribes ' +
    'Claude’s own reply into the composer, and the recorder uploads it',
  !barBtn.classList.contains('cmo-speaking') && utterances.length === utterancesAtStart,
);

// ------------------------------------------------- what it says it is reading
/*
 * A message read out during a turn that is still running is the *previous* answer,
 * and heard on its own it sounds like the reply to whatever is being worked on.
 */
statusReply = { ...statusReply, state: 'working', clients: 1 };
await tapStatus();
utterances.length = 0;
tapSpeak();
ok(
  'the last message was read out during a live turn without saying so, so it is ' +
    'heard as the answer to the thing still being worked on',
  /^Still working\. Last message:/.test(utterances[0] || ''),
);

// The mic being live is the one refusal the sheet has to explain, because the
// button is right there and nothing happens when it is pressed. Drained first, so
// the tap below reopens the sheet instead of being read as Stop.
await drain();
doc.getElementById('cmo-mic').classList.add('cmo-rec');
await tapStatus();
utterances.length = 0;
tapSpeak();
ok('speech started over a live microphone', utterances.length === 0);
ok(
  'nothing was utterances and the sheet said nothing about why',
  /mic/i.test(doc.getElementById('cmo-status-detail')?.textContent ?? ''),
);
doc.getElementById('cmo-mic').classList.remove('cmo-rec');

/*
 * Following a different conversation is leaving this one, and the voice has to go
 * with it: the message being read belongs to the conversation being left, and
 * hearing it under a sheet describing another one is worse than silence.
 */
statusReply = {
  ...statusReply,
  state: 'idle',
  conversations: [
    { sessionId: 'abc123', title: 'This one', state: 'idle', at: Date.now(), current: true },
    { sessionId: 'def456', title: 'The other one', state: 'working', at: Date.now() - 6e5 },
  ],
};
await tapStatus();
ok('the conversations list did not render, so this proves nothing', doc.querySelectorAll('.cmo-convo').length >= 2);
tapSpeak();
ok('nothing was being read, so switching cannot be shown to stop it', barBtn.classList.contains('cmo-speaking'));
utterancesAtStart = utterances.length;
doc.querySelectorAll('.cmo-convo')[1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await settle();
ok(
  'following another conversation left the previous one’s message being read aloud ' +
    'under a sheet describing a different conversation',
  !barBtn.classList.contains('cmo-speaking') && utterances.length === utterancesAtStart,
);
delete statusReply.conversations;

// --------------------------------------------------------------- the long one
/*
 * A message that is minutes of speech gets cut, and says that it was: a summary
 * that just stops sounds like the answer ended there. The rest is on screen, which
 * is the whole reason this is allowed to be lossy.
 */
const essay = `${'Every sentence here is a real sentence with a full stop at the end of it. '.repeat(60)}`;
statusReply = {
  ...statusReply,
  state: 'idle',
  last: { role: 'assistant', text: essay, at: new Date().toISOString() },
};
await tapStatus();
utterances.length = 0;
tapSpeak();
await drain();
const essayHeard = utterances.join(' ');
ok(
  'a very long message was read out in full — this is a phone, and the rest of it is ' +
    'on screen',
  essayHeard.length < 2600 && essayHeard.length > 1200,
);
ok(
  'the reading of a truncated message just stopped, which sounds like the answer ' +
    'ending there',
  /as far as I will read/.test(essayHeard),
);
ok(
  'the cut landed mid-sentence instead of on a full stop',
  /end of it\. That is as far as I will read/.test(essayHeard),
);

// ------------------------------------------------------------------- results
if (failures.length) {
  console.error(`\noverlay test: ${failures.length} failure(s) of ${checks} checks\n`);
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}
console.log(`overlay test: ${checks}/${checks} checks passed`);
process.exit(0);
