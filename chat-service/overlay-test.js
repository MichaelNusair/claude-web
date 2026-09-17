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

const tapStatus = async () => {
  doc.getElementById('cmo-status').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
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

// ------------------------------------------------------------------- results
if (failures.length) {
  console.error(`\noverlay test: ${failures.length} failure(s) of ${checks} checks\n`);
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}
console.log(`overlay test: ${checks}/${checks} checks passed`);
process.exit(0);
