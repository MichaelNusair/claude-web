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

/*
 * The head starts with a manifest link that is not this project's, because that is
 * the case that fails silently: a browser installs the first manifest it finds, and
 * code-server is free to grow one of its own between releases. The switcher section
 * below checks that exactly one survives, and which.
 */
const dom = new JSDOM(
  '<!doctype html><html><head><link rel="manifest" href="/editor/manifest.json"></head>' +
    '<body><iframe id="panel" srcdoc="<p>webview</p>"></iframe></body></html>',
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

/*
 * Switching project used to cost you the window you were in: the sheet assigned
 * `location.href`, so project B replaced project A and nothing offered a second
 * one. The chat app already gives a project its own window; this is the editor
 * catching up, and the mechanism is that a project row is a real link.
 *
 * jsdom cannot open tabs or long-press, so what is checked here is the contract
 * that makes both possible in a browser: a real `href` on every row (the only
 * thing a long-press menu can act on — and the only route to a separate *window*),
 * a `target="_blank"` sibling for a new tab, and which of the two this file
 * handles itself. That last one is the part that breaks silently: swallow the
 * click on the ⧉ anchor and it stops opening a tab, with nothing to show for it.
 */
const rows = [...doc.querySelectorAll('.cmo-item-row')];
ok('a project is no longer a row that can hold a second control', rows.length === 2);
ok(
  'a project row is not a link, so a long press offers nothing to open elsewhere',
  items.length === 2 &&
    items.every((el) => el.tagName === 'A' && /^\/editor\/\?folder=/.test(el.getAttribute('href'))),
);
ok(
  'the project row links somewhere other than the folder it names',
  otherItem?.getAttribute('href') === `/editor/?folder=${encodeURIComponent('/workspace/projects/other')}`,
);

const newTabs = [...doc.querySelectorAll('.cmo-item-new')];
ok('no "open in a new tab" control was offered per project', newTabs.length === 2);
ok(
  'the new-tab control does not open a new tab, or leaks the opener to it',
  newTabs.every(
    (el) => el.getAttribute('target') === '_blank' && /noopener/.test(el.getAttribute('rel') || ''),
  ),
);
ok(
  'the new-tab control points somewhere other than its own project',
  newTabs.some(
    (el) =>
      el.getAttribute('href') ===
      `/editor/?folder=${encodeURIComponent('/workspace/projects/other')}`,
  ),
);

/*
 * Who handles the tap. The row is this file's business — a plain tap still means
 * "open it here", so the anchor's own navigation has to be suppressed. The ⧉ is
 * the browser's business, and a `preventDefault` anywhere near it would quietly
 * turn it into a button that does nothing.
 */
const rowTap = new w.MouseEvent('click', { bubbles: true, cancelable: true });
otherItem?.dispatchEvent(rowTap);
ok('a tap on the project row was left to the anchor, opening it twice', rowTap.defaultPrevented);
ok(
  'tapping another project closed the sheet, which hides the switch from the user',
  sheet.classList.contains('cmo-open'),
);

const newTabTap = new w.MouseEvent('click', { bubbles: true, cancelable: true });
newTabs[0]?.dispatchEvent(newTabTap);
ok(
  'something swallowed the tap on ⧉, so it no longer opens a tab',
  !newTabTap.defaultPrevented,
);

// ------------------------------------------------- a window per project
/*
 * A home-screen icon per project, which on Android is the only way to have two
 * projects open at once.
 *
 * A phone gives an installed web app exactly one window and no API opens a second,
 * so the lever is app *identity*: a manifest with an unfamiliar `id` is a distinct
 * application even when served from the same URL, and a distinct application is a
 * distinct icon with its own task. chat-service/manifest-test.js covers the ids
 * themselves; what is checked here is the half that lives in the page, and every
 * one of these fails silently on a phone if it is wrong:
 *
 *   the link is in *this* document, because the manifest a browser installs is the
 *   one linked from the page you install from, and this page is code-server's;
 *
 *   exactly one link survives, because the first one found is the one installed;
 *
 *   `use-credentials`, because a manifest is fetched with credentials omitted by
 *   default and the route serving it is behind the session gate — without it the
 *   fetch is a 401 and the install offer never appears at all;
 *
 *   `beforeinstallprompt` is captured rather than left alone, because the offer
 *   belongs next to the project it is about, not in a strip across the workbench.
 */
const links = [...doc.head.querySelectorAll('link[rel="manifest"]')];
ok(
  'more than one manifest is linked, and the browser installs whichever comes ' +
    'first — the foreign one was left in front of this project’s',
  links.length === 1,
);
ok(
  'the linked manifest is not this project’s, so installing gives another icon for ' +
    'whatever that one describes',
  links[0]?.getAttribute('href') === '/chat/manifest.webmanifest?project=demo',
);
ok(
  'the manifest is linked without use-credentials — it is fetched with credentials ' +
    'omitted by default, so the gated route answers 401 and nothing is installable',
  links[0]?.getAttribute('crossorigin') === 'use-credentials',
);

const openSwitcher = async () => {
  doc.getElementById('cmo-projects').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 20));
};

ok(
  'the switcher does not offer this project its own window, which is the whole ' +
    'feature — and the only place it can be offered is next to the project list',
  doc.getElementById('cmo-install'),
);
ok(
  'the install button does not name the project it would install, so it reads as ' +
    '"install this website"',
  /demo/.test(doc.getElementById('cmo-install')?.textContent ?? ''),
);
ok(
  'the sheet does not explain that a phone gives one window per installed app — ' +
    'without it, an icon per project looks like clutter rather than the answer',
  /one window/.test(doc.getElementById('cmo-panel')?.textContent ?? ''),
);

/*
 * With no `beforeinstallprompt` in hand there is nothing to prompt with — the app
 * is already installed, or this is a browser that never fires it (every one on
 * iOS). The manifest is linked either way, so the browser's own menu installs the
 * same thing, and saying so is the whole job of the button in that state.
 */
doc.getElementById('cmo-install').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 10));
ok(
  'a browser with no install event was told nothing, so the button looks broken on ' +
    'every iPhone',
  /Home screen/i.test(doc.getElementById('cmo-install-status')?.textContent ?? ''),
);

// Chrome's event, as far as this feature can tell one from the real thing.
let prompts = 0;
const installEvent = new w.Event('beforeinstallprompt', { cancelable: true });
installEvent.prompt = () => {
  prompts += 1;
  return Promise.resolve();
};
installEvent.userChoice = Promise.resolve({ outcome: 'accepted' });
w.dispatchEvent(installEvent);
ok(
  'the mini-infobar was left to appear across the workbench, where there is no room ' +
    'for it and no explanation of what it is offering',
  installEvent.defaultPrevented,
);

await openSwitcher();
doc.getElementById('cmo-install').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 10));
ok('the install button never showed the browser’s own prompt', prompts === 1);
ok(
  'an accepted install said nothing, so there is no way to tell it worked from ' +
    'inside the window it was done from',
  /home screen/i.test(doc.getElementById('cmo-install-status')?.textContent ?? ''),
);

// Re-queried, because the sheet has been drawn again since `currentItem` was found
// and a tap on the node it replaced proves nothing about the sheet on screen.
const openRow = [...doc.querySelectorAll('.cmo-item')].find((el) => el.dataset.open === '1');
openRow?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
ok(
  'tapping the already-open project did not just close the sheet — it reloads the ' +
    'editor for nothing',
  openRow && !sheet.classList.contains('cmo-open'),
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
/*
 * The message is rendered as markdown, so the sheet's text is the message *without*
 * its markers — the backticked span here becomes an element and its backticks stop
 * being characters. What has to survive is every other character, including the ones
 * that look like markup.
 */
const saidEl = () => doc.getElementById('cmo-status-said');
ok(
  'the sheet shows a truncated message — the point of it is that one line was not enough',
  (saidEl()?.textContent ?? '').includes('Done. Try <img src=x onerror="alert(1)"> and'),
);
ok(
  'the second paragraph of the message is missing from the sheet',
  /Second line\./.test(saidEl()?.textContent ?? ''),
);
ok(
  'the message was injected as markup, not text: an <img> from a model reply built ' +
    'an element in the editor',
  !doc.querySelector('#cmo-status-said img'),
);
ok(
  'a backticked span in the message was not rendered as code, so the sheet still ' +
    'shows the backticks it was written with',
  saidEl()?.querySelector('code')?.textContent === 'a < b',
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
/*
 * How long a piece takes to be spoken. Zero — the next turn of the loop — for
 * everything that only cares about the order pieces arrive in. The section on
 * following the sheet raises it, because interrupting a message that has already
 * finished proves nothing about interrupting one.
 */
let speechMs = 0;

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
    }, speechMs);
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

// --------------------------------------------- following the sheet while it is open
/*
 * The sheet answers a question whose answer changes while it is on screen: a turn
 * ends, another message is written mid-turn, someone types into the panel. Left
 * alone it kept showing the snapshot from the tap that opened it, and the way to
 * see anything newer was to keep tapping Refresh. So while it is open it asks
 * again every five seconds, and reads out what it finds.
 *
 * Reading out is the part that has to be fenced in rather than merely working:
 * every other utterance in this file starts inside a tap, and these do not. The
 * fence is the sheet — open only because it was just tapped open, on screen while
 * it happens, and dismissing it ends it — so the checks below are mostly about
 * what does *not* speak: an unchanged message, a message that was already there
 * when the sheet opened, and anything at all once the sheet is gone.
 *
 * Everything on a timer in the overlay is gated on the tab being visible, and
 * jsdom reports `prerender`, so nothing above this line has ever run one. It is
 * overridden here rather than at the top deliberately: it also releases the
 * fifteen-second heartbeat, which would otherwise turn up inside the counts below.
 */
Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => 'visible' });

// Read out of the overlay rather than restated, because the number is the
// requirement: five seconds is what was asked for, and the waits below are timed
// against whatever the file actually says.
const numberOf = (name) => Number(new RegExp(`const ${name} = (\\d+)`).exec(overlayJs)?.[1]);
const SHEET_POLL_MS = numberOf('SHEET_POLL_MS');
const HEARTBEAT_MS = numberOf('STATUS_HEARTBEAT_MS');
ok('the open sheet no longer refreshes every five seconds, which is what was asked for', SHEET_POLL_MS === 5000);

/*
 * Give each piece a duration for the rest of the file, and watch for the reading
 * to *start* rather than checking whether it is still going after a fixed wait.
 * A reading that began and finished inside one `settle` looks identical to one
 * that never began, and this box runs several of these suites at once.
 */
speechMs = 40;
const rise = async (limit = 3000) => {
  const until = Date.now() + limit;
  while (!barBtn.classList.contains('cmo-speaking') && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return barBtn.classList.contains('cmo-speaking');
};

const answer = (text) => ({
  ...statusReply,
  state: 'idle',
  clients: 0,
  last: { role: 'assistant', text, at: new Date().toISOString() },
});

const firstAnswer = 'First answer. The migration script is written.';
statusReply = answer(firstAnswer);
utterances.length = 0;
await tapStatus();
ok(
  'opening the sheet read out the message that was already on it — every tap on the ' +
    'bar would start the phone talking',
  utterances.length === 0,
);

const followHint = () => doc.getElementById('cmo-status-follow')?.textContent ?? '';
ok(
  'the sheet refreshes itself and says nothing about it, so a phone that starts ' +
    'talking has nothing on screen explaining why',
  /every 5 seconds/.test(followHint()),
);
ok('the sheet does not say that a new message will be read aloud', /read/i.test(followHint()));
ok('the sheet does not say how to stop it', /Stop/.test(followHint()));

/*
 * A change found by a background ask. The window regaining focus is one of them,
 * and it takes exactly the path the five-second poll takes — a silent
 * `refreshStatus` — so it stands in for the timer in every check but the cadence
 * one below, which is the only place worth spending real seconds on.
 */
const secondAnswer = 'Second answer. The migration is done, and the tests pass.';
statusReply = answer(secondAnswer);
w.dispatchEvent(new w.Event('focus'));
const startedOnItsOwn = await rise();
await drain();
ok(
  'a message that arrived while the sheet was open never reached it — the sheet is ' +
    'still showing the answer from the tap that opened it',
  doc.getElementById('cmo-status-said')?.textContent === secondAnswer,
);
ok('the message that arrived was not read out', /migration is done/.test(utterances.join(' ')));
ok(
  'a voice that started on its own did not open with why it is talking',
  /^Claude finished\./.test(utterances[0] || ''),
);
ok(
  'the bar offers no Stop for a reading nobody asked for, which is the one that ' +
    'most needs one',
  startedOnItsOwn,
);

utterances.length = 0;
w.dispatchEvent(new w.Event('focus'));
await settle();
ok(
  'the same message was read out again on the next ask — a sheet left open would ' +
    'repeat it every five seconds',
  utterances.length === 0,
);

/*
 * The cadence itself, which is the one thing here that costs real seconds to
 * prove: nothing is touched, and five seconds later the sheet has asked again and
 * read out what came back.
 *
 * The heartbeat is the only other thing that asks unprompted — every fifteen
 * seconds since the page loaded — so the window is nudged clear of it. Otherwise a
 * coincidence and a poll that is really there look the same from here.
 */
const loadedAt = loads()[0].t;
const untilHeartbeat = () => HEARTBEAT_MS - ((Date.now() - loadedAt) % HEARTBEAT_MS);
if (untilHeartbeat() < SHEET_POLL_MS + 900) {
  await new Promise((resolve) => setTimeout(resolve, untilHeartbeat() + 300));
}

const thirdAnswer = 'Third answer. Deployed, and the box is green.';
statusReply = answer(thirdAnswer);
utterances.length = 0;
const asksBefore = statusCalls.length;
await new Promise((resolve) => setTimeout(resolve, SHEET_POLL_MS + 800));
ok(
  'the open sheet never asked again on its own, so it goes on showing the answer ' +
    'from the tap that opened it',
  statusCalls.length > asksBefore,
);
ok(
  'the poll found a newer message and did not put it on the sheet',
  doc.getElementById('cmo-status-said')?.textContent === thirdAnswer,
);
ok('the poll found a newer message and did not read it out', /box is green/.test(utterances.join(' ')));

/*
 * The newest message is the one wanted, so one that lands while the previous is
 * still being read replaces it instead of queueing behind it — a phone reading two
 * answers in a row, oldest first, is worse than one that reads neither.
 */
const longAnswer = 'This is one sentence of a long answer. '.repeat(30);
statusReply = answer(longAnswer);
utterances.length = 0;
w.dispatchEvent(new w.Event('focus'));
// Caught while it is still reading — many pieces at 40 ms each — so the change
// below lands on a message in flight rather than on one already finished.
ok('nothing was still being read, so nothing here can show an interruption', await rise());

const newest = 'Newest answer. Ignore everything above this line.';
statusReply = answer(newest);
utterances.length = 0;
w.dispatchEvent(new w.Event('focus'));
await settle(150);
const afterInterrupt = utterances.join(' ');
ok(
  'a newer message queued behind the one being read instead of replacing it',
  /Ignore everything above/.test(afterInterrupt) && !/one sentence of a long answer/.test(afterInterrupt),
);
await drain();

// A message written mid-turn is not the answer, and being read one that is not the
// answer without being told is how you end up replying to a turn still running.
statusReply = { ...answer('Fourth answer. Running the test suite now.'), state: 'working', clients: 1 };
utterances.length = 0;
w.dispatchEvent(new w.Event('focus'));
await settle();
ok(
  'a message read out mid-turn did not say the turn is still running',
  /^Still working\./.test(utterances[0] || ''),
);
await drain();

/*
 * Dismissing the sheet is how you stop it. The voice already reading a message
 * outlives the sheet on purpose — that is checked further up — but nothing new
 * starts. This is the worst outcome the feature has: a phone talking about a
 * conversation with the sheet that explains it gone, and no Stop in sight but the
 * one on the bar.
 */
doc.getElementById('cmo-status-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
statusReply = answer('Fifth answer, said after the sheet was dismissed.');
utterances.length = 0;
w.dispatchEvent(new w.Event('focus'));
await settle();
ok('a message that arrived after the sheet was dismissed was read out anyway', utterances.length === 0);
ok(
  'the dismissed sheet was redrawn behind the scenes, so reopening it skips past the ' +
    'message it was showing',
  !/dismissed/.test(doc.getElementById('cmo-panel')?.textContent ?? ''),
);

/*
 * Another sheet in front of it is the same answer. Layout and the project switcher
 * are one tap from the status sheet and replace it in place, so the conversation it
 * was following is no longer what anyone is looking at — and a voice reading a
 * message out under a sheet about something else is the same wrong as reading one
 * out under a sheet about another conversation, which is checked further up.
 */
await tapStatus();
doc.getElementById('cmo-layout').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
statusReply = answer('Sixth answer, said while the Layout sheet was open.');
utterances.length = 0;
w.dispatchEvent(new w.Event('focus'));
await settle();
ok(
  'a change was read out under a different sheet, which is describing something else',
  utterances.length === 0,
);
speechMs = 0;

// ----------------------------------------------------- being told from here
/*
 * The notification switch on the editor's own sheet.
 *
 * The push feature notifies about sessions *out here* — the Claude Code panel in
 * this editor, and anything under tmux — and until now the only switch for it was
 * in the chat app's Settings sheet. Someone who only ever opens the editor, which
 * is how this box is actually used, had no way to turn on the one feature written
 * for them; the report that started this was "I don't see push notifications, I
 * don't know how to enable them".
 *
 * The order of the first three acts is the whole of what can go silently wrong:
 * permission must be asked while the tap still counts as user activation (mobile
 * Chrome refuses a prompt that comes after a network round trip), the worker must
 * be the chat app's one so both surfaces share a subscription, and the key must be
 * the server's — a subscription made with the wrong one looks healthy here and
 * fails at the push service for good. None of those report themselves on a phone.
 */
const KEY = 'BOe1x_hUOKzZBnbTz5xLNlOaqZ3Ah3ll7SzKfHRSfrnRHkTKuNJlvBQCLGnJJKKUpUKzIxq2xR2oyF6qkkeGaAo';
const ENDPOINT = 'https://push.example.com/device/abc123';
// Ordered log of everything the switch did, so "asked permission first" and
// "told the server before the browser forgot" can be asserted rather than assumed.
const acts = [];
const registered = [];
const lookups = [];
const posted = {};
let subscribeOpts = null;
let unsubscribeCalls = 0;
let subscription = null;

const makeSubscription = (key) => ({
  endpoint: ENDPOINT,
  options: { applicationServerKey: key },
  // What the browser sends the server: the real thing has a toJSON, and posting
  // the object without it would send `{}`.
  toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: 'p256dh-bytes', auth: 'auth-bytes' } }),
  unsubscribe: () => {
    acts.push('browser-unsubscribe');
    unsubscribeCalls += 1;
    subscription = null;
    return Promise.resolve(true);
  },
});

const registration = {
  scope: 'https://claude.example.com/chat/',
  pushManager: {
    getSubscription: () => Promise.resolve(subscription),
    subscribe: (opts) => {
      acts.push('browser-subscribe');
      subscribeOpts = opts;
      subscription = makeSubscription(opts.applicationServerKey);
      return Promise.resolve(subscription);
    },
  },
};

Object.defineProperty(w.navigator, 'serviceWorker', {
  configurable: true,
  value: {
    register: (url) => {
      acts.push('register');
      registered.push(String(url));
      return Promise.resolve(registration);
    },
    // Nothing to hand back until something has registered one, which is what makes
    // "opening the editor installs nothing" checkable.
    getRegistration: (scope) => {
      // Logged in both places: `lookups` is which scope, and `acts` is when — the
      // ordering check below is only worth anything if a read counts as an act, since
      // reading the state is the easiest thing to accidentally await before the
      // permission prompt.
      lookups.push(String(scope));
      acts.push('lookup');
      return Promise.resolve(registered.length ? registration : null);
    },
  },
});
w.PushManager = function PushManager() {};
class FakeNotification {}
FakeNotification.permission = 'default';
let permissionAnswer = 'granted';
FakeNotification.requestPermission = () => {
  acts.push('permission');
  FakeNotification.permission = permissionAnswer;
  return Promise.resolve(permissionAnswer);
};
w.Notification = FakeNotification;

const jsonReply = (body, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
const priorFetch = w.fetch;
w.fetch = (url, options = {}) => {
  const target = String(url);
  if (target.includes('/api/push/key')) {
    acts.push('key');
    return jsonReply({ key: KEY });
  }
  if (target.includes('/api/push/subscribe')) {
    acts.push('server-subscribe');
    posted.subscribe = JSON.parse(options.body || '{}');
    return jsonReply({ ok: true });
  }
  if (target.includes('/api/push/unsubscribe')) {
    acts.push('server-unsubscribe');
    posted.unsubscribe = JSON.parse(options.body || '{}');
    return jsonReply({ ok: true });
  }
  if (target.includes('/api/push/test')) {
    acts.push('test');
    return jsonReply({ sent: 1 });
  }
  if (target.includes('manifest.webmanifest')) {
    return jsonReply({
      id: '/editor/?folder=%2Fworkspace%2Fprojects%2Fdemo',
      short_name: 'demo',
      scope: '/',
    });
  }
  return priorFetch(url, options);
};

const notifyBtn = () => doc.getElementById('cmo-notify');
const notifyLine = () => doc.getElementById('cmo-notify-status')?.textContent ?? '';
const tapNotify = async () => {
  notifyBtn()?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await settle(80);
};

await tapStatus();
await settle(40);
ok(
  'the status sheet offers no way to be told when a turn ends — the only switch for ' +
    'it is in the chat app, which someone who lives in the editor never opens',
  notifyBtn(),
);
ok(
  'drawing the sheet registered a service worker uninvited — opening the editor must ' +
    'install nothing on a device that has never asked for notifications',
  registered.length === 0,
);
ok(
  'the subscription was looked up outside the chat app’s scope, so the editor and the ' +
    'chat app would each hold one and only one of them would be told to stop',
  lookups.length > 0 && lookups.every((s) => s === '/chat/'),
);
ok(
  'the switch does not say what the notifications are about, so it reads as "notify me ' +
    'about something"',
  /tmux/.test(notifyLine()),
);

// Cleared so that the first act *after the tap* is what is being asserted about,
// rather than whatever drawing the sheet did before it.
acts.length = 0;
await tapNotify();
ok(
  `permission was asked after something was awaited (${acts.join(' → ')}) — mobile ` +
    'Chrome refuses a prompt that is no longer the consequence of the tap',
  acts[0] === 'permission',
);
ok(
  `the worker registered was not the chat app’s: ${JSON.stringify(registered)} — a ` +
    'second worker means a second subscription the chat app cannot see',
  registered.length === 1 && registered[0] === '/chat/sw.js',
);
ok(
  'the subscription was not made userVisibleOnly, which Chrome requires and which is ' +
    'true of every push this app sends',
  subscribeOpts?.userVisibleOnly === true,
);
const sentKey = subscribeOpts?.applicationServerKey;
ok(
  `the application server key is not a P-256 point: ${sentKey?.length} bytes starting ` +
    `${sentKey?.[0]} — a subscription made with the wrong key looks healthy here and ` +
    'fails at the push service forever',
  sentKey?.length === 65 && sentKey[0] === 4,
);
ok(
  'the server was never told which device to send to',
  posted.subscribe?.endpoint === ENDPOINT && Boolean(posted.subscribe?.keys?.auth),
);
ok(
  `the order was wrong: ${acts.join(' → ')} — the key has to be in hand before ` +
    'subscribing, and the server told before anything is sent',
  acts.indexOf('key') < acts.indexOf('browser-subscribe') &&
    acts.indexOf('browser-subscribe') < acts.indexOf('server-subscribe') &&
    acts.indexOf('server-subscribe') < acts.indexOf('test'),
);
ok(
  'no test notification was sent, so a switch that has quietly failed looks exactly ' +
    'like one that worked until the notification that mattered is missed',
  acts.includes('test'),
);
ok(
  'the switch still offers to turn notifications on after turning them on',
  /Turn off/.test(notifyBtn()?.textContent ?? ''),
);
ok('nothing said that a test notification had been sent', /test notification/.test(notifyLine()));

/*
 * The sheet redraws itself every five seconds, and what the switch just said has to
 * survive that: a line reading "a test notification has just been sent" is worth
 * nothing if the poll wipes it two seconds later.
 */
statusReply = answer('Seventh answer, arriving just after the switch was used.');
w.dispatchEvent(new w.Event('focus'));
await settle(120);
await drain();
ok(
  'the sheet’s own refresh wiped what the switch had just said',
  /test notification/.test(notifyLine()),
);
ok(
  'the switch forgot it was on when the sheet refreshed itself',
  /Turn off/.test(notifyBtn()?.textContent ?? ''),
);

await tapNotify();
ok(
  'the server was not told the device is going away — it would go on sending to an ' +
    'endpoint the browser has dropped',
  posted.unsubscribe?.endpoint === ENDPOINT,
);
ok(
  `the browser dropped the subscription before the server was told: ${acts.join(' → ')} ` +
    '— after that the endpoint that identifies this device is gone',
  acts.indexOf('server-unsubscribe') < acts.indexOf('browser-unsubscribe'),
);
ok('the browser still holds a subscription', unsubscribeCalls === 1 && subscription === null);
ok(
  'the switch does not offer to turn notifications back on',
  /Notify me/.test(notifyBtn()?.textContent ?? ''),
);

/*
 * A site that has been refused permission cannot ask again — the browser answers
 * once — so a button there does nothing at all, and the only useful thing to show
 * is where the setting now lives.
 */
FakeNotification.permission = 'denied';
await tapStatus();
await settle(40);
ok(
  'a site with notifications blocked still shows a switch, which cannot do anything ' +
    'and reads as broken',
  !notifyBtn(),
);
ok(
  'a blocked site is not told where the setting now lives, which is the only place it ' +
    'can be changed',
  /Site settings/.test(doc.getElementById('cmo-panel')?.textContent ?? ''),
);

// ------------------------------------------------- why the install was refused
/*
 * "It says this app is already installed" cannot be reproduced anywhere but the
 * phone that said it: whether Chrome offers an install depends on what is on that
 * home screen. Android matches an installed web app to a page by scope, and the
 * chat app's manifest claims the whole origin — so the chat icon is the first
 * suspect, and this check is how the device names it instead of being guessed at
 * from here. It has to print the build too: a workbench left open across a deploy
 * runs the script it loaded, which is the other explanation for a control that
 * appears to do nothing.
 */
Object.defineProperty(w.navigator, 'getInstalledRelatedApps', {
  configurable: true,
  value: () =>
    Promise.resolve([
      { platform: 'webapp', url: 'https://claude.example.com/chat/manifest.webmanifest', id: 'Claude' },
    ]),
});

const buildStamp = /const OVERLAY_BUILD = '([^']+)'/.exec(overlayJs)?.[1];
ok('the overlay carries no build stamp, so a stale page cannot be told from a bug', buildStamp);

await openSwitcher();
ok(
  'the switcher offers no way to find out why an install was refused, and the answer ' +
    'only exists on the phone',
  doc.getElementById('cmo-install-why'),
);
doc.getElementById('cmo-install-why').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await settle(80);
const why = doc.getElementById('cmo-install-status')?.textContent ?? '';
ok(
  'the install check does not say which build of the overlay answered — a page open ' +
    'across a deploy is the other explanation for a missing feature',
  why.includes(buildStamp),
);
ok(
  'the install check does not name the manifest this page would install',
  /manifest\.webmanifest\?project=demo/.test(why),
);
ok('the install check does not report the identity the server gave it', /id \/editor/.test(why));
ok(
  'the install check does not say whether Chrome offered an install, which is the ' +
    'thing being asked about',
  /Chrome has not offered/.test(why),
);
ok(
  'the install check does not name the installed app Chrome thinks this page belongs ' +
    'to, which is the whole reason it exists',
  /Claude/.test(why),
);
ok(
  'the install check names the app in the way but not what to do about it',
  /home screen/.test(why),
);

// --------------------------------------------------------- markdown, rendered
/*
 * The sheet is where a final message is read on a phone, and a final message is
 * written: bold, bullets, a fenced diff in the middle of it. It used to show the
 * asterisks.
 *
 * Two kinds of check here, and the second kind is the one that matters. The first
 * is that each form becomes the element it should. The second is that *no* model
 * text ever becomes markup — the renderer builds nodes and puts text through
 * `textContent`, and the way that regresses is someone finding it easier to
 * assemble a string and assign `innerHTML`. Both the HTML in the fenced block and
 * the `javascript:` URL below are there to fail loudly if that happens.
 */
const openFresh = async (text) => {
  doc.getElementById('cmo-status-close')?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await settle(30);
  statusReply = answer(text);
  await tapStatus();
  await settle(30);
  return doc.getElementById('cmo-status-said');
};

const md = await openFresh(
  [
    '## Heading with `code` in it',
    '',
    'Paragraph with **bold**, *italic*, __also bold__ and a [link](https://example.com/x).',
    'Wrapped onto a second line.',
    '',
    '- first bullet, **emphasised**',
    '- second bullet',
    '',
    '3. step three',
    '4. step four',
    '',
    '---',
    '',
    '```js',
    'const a = 1 < 2;',
    '  if (a) console.log("<b>hi</b>");',
    '```',
    '',
    'Tap [here](javascript:alert(1)) to see.',
  ].join('\n'),
);

ok(
  'the message is still shown as its own source — the markdown markers are on screen',
  !/[*`#]/.test(md?.textContent ?? '') && !/^\s*-\s/m.test(md?.textContent ?? ''),
);
ok('a heading was not rendered as one', /Heading with/.test(md?.querySelector('.cmo-md-h')?.textContent ?? ''));
ok(
  'inline markdown inside a heading was left as source, so a heading is the one place ' +
    'backticks still show',
  md?.querySelector('.cmo-md-h code')?.textContent === 'code',
);
ok(
  '**bold** did not become bold, which is the marker that started this',
  [...(md?.querySelectorAll('strong') ?? [])].some((el) => el.textContent === 'bold'),
);
ok('__bold__ did not become bold', [...(md?.querySelectorAll('strong') ?? [])].some((el) => el.textContent === 'also bold'));
ok('*italic* did not become italic', md?.querySelector('em')?.textContent === 'italic');
ok(
  'a wrapped sentence became two paragraphs, so a message reads as though it were ' +
    'broken up',
  [...(md?.querySelectorAll('p') ?? [])].some(
    (el) => /Paragraph with/.test(el.textContent) && /second line/.test(el.textContent),
  ),
);
ok('a bulleted list did not become a list', md?.querySelectorAll('ul li').length === 2);
ok(
  'inline markdown inside a list item was left as source',
  md?.querySelector('ul li strong')?.textContent === 'emphasised',
);
ok('a numbered list did not become one', md?.querySelectorAll('ol li').length === 2);
ok(
  'a numbered list that starts at 3 restarts at 1, so the steps are renumbered under ' +
    'the reader',
  md?.querySelector('ol')?.getAttribute('start') === '3',
);
ok('a rule between sections did not become one', md?.querySelectorAll('hr').length === 1);
ok(
  'a fenced block did not become a code block',
  md?.querySelector('pre code')?.textContent ===
    'const a = 1 < 2;\n  if (a) console.log("<b>hi</b>");',
);
ok(
  'HTML inside a fenced block became an element: model output is being assigned as ' +
    'markup somewhere in the renderer',
  !md?.querySelector('pre b'),
);
ok(
  'a link in the message is not tappable',
  md?.querySelector('a[href="https://example.com/x"]')?.textContent === 'link',
);
ok(
  'a link opens over the workbench instead of beside it',
  md?.querySelector('a[href="https://example.com/x"]')?.target === '_blank' &&
    /noopener/.test(md?.querySelector('a[href="https://example.com/x"]')?.rel ?? ''),
);
ok(
  'a javascript: URL from a model became a link — one tap would run whatever the ' +
    'message asked for, in a page that can drive the editor',
  ![...(md?.querySelectorAll('a') ?? [])].some((el) =>
    /^javascript:/i.test(el.getAttribute('href') || ''),
  ),
);
ok(
  'a link that was refused vanished instead of staying readable as text',
  /here \(javascript:alert\(1\)\)/.test(md?.textContent ?? ''),
);

/*
 * Tables, which are most of what a status answer is made of — surface, check,
 * result — and which were left out of the first version of the renderer on the
 * grounds that they do not fit a phone. A table left as source does not fit a phone
 * either; it is a screenful of pipes. The fixture is shaped like the real thing,
 * including inline code in the cells and a row shorter than its header.
 */
const table = await openFresh(
  [
    'Checked rather than asserted:',
    '',
    '| Surface | Check | Result |',
    '|---|---|---|',
    '| `site/index.html` | local md5 vs S3 ETag | both |',
    '| git | `git status`, `origin/main..HEAD` | clean |',
    '| api/index.js | live |',
    '',
    'Nothing under api/ has changed.',
  ].join('\n'),
);
ok('a table was not rendered as one', table?.querySelectorAll('table').length === 1);
ok(
  'the table has no header row, so the columns are unlabelled',
  [...(table?.querySelectorAll('th') ?? [])].map((el) => el.textContent).join(',') ===
    'Surface,Check,Result',
);
ok('the table lost or gained rows', table?.querySelectorAll('tbody tr').length === 3);
ok(
  'a row shorter than the header was not padded, so every column after the gap ' +
    'misaligns',
  [...(table?.querySelectorAll('tbody tr') ?? [])].every((tr) => tr.cells.length === 3),
);
ok(
  'inline markdown inside a cell was left as source',
  table?.querySelector('tbody td code')?.textContent === 'site/index.html',
);
ok(
  'the alignment row was rendered as a row of dashes instead of being read',
  !/-{3}/.test(table?.textContent ?? ''),
);
ok(
  'the pipes are still on screen, which is the whole complaint',
  !/\|/.test(table?.textContent ?? ''),
);
ok(
  'the table is not wrapped in anything that can scroll sideways, so three columns ' +
    'of prose either wrap into a wall or push the sheet off the screen',
  table?.querySelector('.cmo-md-table > table'),
);
ok(
  'the prose around the table was swallowed by it',
  /Checked rather than asserted:/.test(table?.textContent ?? '') &&
    /Nothing under api\/ has changed\./.test(table?.textContent ?? ''),
);

/*
 * A header alone is ambiguous — plenty of sentences contain a pipe — so it is the
 * alignment row underneath that makes a table. Without this check the renderer
 * turns a shell pipeline into a one-row table.
 */
const piped = await openFresh('Run `ps aux | grep node` and read it.\nThen | tidy up.');
ok(
  'a sentence with a pipe in it became a table',
  !piped?.querySelector('table') && /ps aux \| grep node/.test(piped?.textContent ?? ''),
);

const aligned = await openFresh('| a | b | c |\n|:---|---:|:---:|\n| 1 | 2 | 3 |');
ok(
  'the column alignments in the delimiter row were ignored',
  [...(aligned?.querySelectorAll('thead th') ?? [])].map((el) => el.style.textAlign).join(',') ===
    'left,right,center',
);

/*
 * The chip and the conversation list are one line of plain text each, so they get
 * the markers taken off instead of rendered. The fixture is the artefact from the
 * phone: an answer whose second paragraph opens with `**`, cut to length, arriving
 * in the list as a stray pair of asterisks hanging off the previous sentence.
 */
const marked = 'Done with my half. Here is where things stand.\n\n**Shipped** the `renderer` and:\n\n- one\n- two';
statusReply = {
  ...answer(marked),
  conversations: [
    { sessionId: 'abc123', state: 'idle', said: marked, at: Date.now() },
    { sessionId: 'def456', state: 'idle', said: '## Heading\n\nA second one.', at: Date.now() },
  ],
};
doc.getElementById('cmo-status-close')?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await settle(30);
await tapStatus();
await settle(30);
ok(
  'the chip shows the markdown it was written with, so a one-line summary ends in a ' +
    'stray marker',
  !/[*`#]/.test(doc.getElementById('cmo-chip')?.querySelector('.cmo-chip-text')?.textContent ?? ''),
);
ok(
  'stripping the markers ate the words with them',
  /Done with my half/.test(
    doc.getElementById('cmo-chip')?.querySelector('.cmo-chip-text')?.textContent ?? '',
  ),
);
const listText = [...doc.querySelectorAll('#cmo-convos .cmo-convo-label')]
  .map((el) => el.textContent)
  .join(' | ');
ok(
  'the conversation list shows raw markdown — the list is where a stray ** was ' +
    'noticed on the phone',
  listText && !/[*`#]/.test(listText),
);

/*
 * A transcript is read while it is still being written, so the fence at the end of
 * a half-written block has not arrived yet. Dropping the block until it closes
 * would blank the most recent thing Claude said.
 */
const partial = await openFresh('Here it is:\n\n```\nunfinished output');
ok(
  'a code block that has not been closed yet is dropped, so a message being written ' +
    'loses its tail',
  partial?.querySelector('pre code')?.textContent === 'unfinished output',
);

/*
 * Anything unrecognised has to come out as the characters it went in as — an ASCII
 * diagram or a stack trace is not markdown, and this sheet showed it correctly
 * before there was a renderer at all.
 */
const plain = await openFresh('Layout:\n  a -> b\n  b -> c');
ok(
  'an indented diagram lost its leading spaces, so anything drawn in text collapses',
  /Layout:\n {2}a -> b\n {2}b -> c/.test(plain?.textContent ?? ''),
);

// ------------------------------------------------------------------- results
if (failures.length) {
  console.error(`\noverlay test: ${failures.length} failure(s) of ${checks} checks\n`);
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}
console.log(`overlay test: ${checks}/${checks} checks passed`);
process.exit(0);
