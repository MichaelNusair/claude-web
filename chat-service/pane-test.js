/**
 * Several conversations open at once, on one phone.
 *
 * A second window is only worth having because the first one keeps working while
 * you are not looking at it — which is exactly the part no browser can show you,
 * since everything interesting happens in a thread that is off screen. So the pane
 * model is driven directly here: fake sockets that can be accepted, answered and
 * dropped on demand, and a fake `/api/live` for the tabs that have no socket.
 *
 * The assertions that matter most are about what is *not* done:
 *  - closing a tab must never stop a conversation. The process keeps running, the
 *    transcript is on disk, and the box is still spending money on it, so closing
 *    a tab and ending a turn cannot be the same gesture.
 *  - the live cap must never cool a chat that is working. A cooled tab goes quiet;
 *    doing that to a working one hides the very thing tabs exist to report.
 *  - two panes must never share one session id. Two sockets appending to one
 *    transcript is the divergence this project has already had once, and it is why
 *    the server keys conversations by cwd|sessionId.
 *
 * Run: node chat-service/pane-test.js
 */
import { readFileSync } from 'fs';
import { dirname, join as joinPath } from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = joinPath(here, 'public');
const html = readFileSync(joinPath(publicDir, 'index.html'), 'utf8');
const js = readFileSync(joinPath(publicDir, 'app.js'), 'utf8');

const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

const DEMO = '/workspace/projects/demo';
const API = '/workspace/projects/api';
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Let the in-flight fetches land before the window goes away.
 *
 * A closed jsdom window has no `document`, so a list refresh still in flight
 * would throw inside the *test*, from a realm nothing can catch it in. Closing at
 * all is only to stop the client's repeating timers.
 */
const finish = async (h) => {
  await settle();
  h.dom.window.close();
};

/**
 * What the box has on disk. `live`/`busy` come from `/api/projects` itself, which
 * is how the list looks right on its first paint instead of a poll interval later.
 */
function projectsPayload() {
  const now = Date.now();
  return {
    projects: [
      {
        name: 'demo',
        path: DEMO,
        sessions: [
          { sessionId: 'aaa', mtime: now, title: 'the one still running', live: true, busy: true },
          { sessionId: 'bbb', mtime: now - 60_000, title: 'a finished task' },
          { sessionId: 'ddd', mtime: now - 90_000, title: 'a fourth chat' },
        ],
      },
      {
        name: 'api',
        path: API,
        sessions: [
          { sessionId: 'ccc', mtime: now - 120_000, title: 'an api chat' },
          { sessionId: 'eee', mtime: now - 180_000, title: 'a fifth chat' },
        ],
      },
    ],
  };
}

/**
 * Boot the client into its own DOM.
 *
 * `saved` is written to localStorage *before* the script runs, because that is the
 * only way to test the case that matters most for a phone's memory: a cold PWA
 * launch with several tabs already open.
 */
function bootClient({ saved = null, live = [] } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://claude.example.com/' });
  const w = dom.window;
  if (saved) w.localStorage.setItem('claude-chat-panes', JSON.stringify(saved));

  const sockets = [];
  const calls = [];
  // Mutable so a test can change what the box is doing between polls.
  const box = { live };

  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = FakeSocket.CONNECTING;
      this.sent = [];
      this.closedByClient = false;
      this.handlers = new Map();
      sockets.push(this);
    }

    addEventListener(type, fn) {
      const list = this.handlers.get(type) || [];
      list.push(fn);
      this.handlers.set(type, list);
    }

    send(frame) {
      this.sent.push(JSON.parse(frame));
    }

    close() {
      this.closedByClient = true;
      this.readyState = FakeSocket.CLOSED;
      this.emit('close', {});
    }

    emit(type, event) {
      for (const fn of [...(this.handlers.get(type) || [])]) fn(event);
    }

    /** The server accepted the upgrade. */
    accept() {
      this.readyState = FakeSocket.OPEN;
      this.emit('open', {});
    }

    deliver(msg) {
      this.emit('message', { data: JSON.stringify(msg) });
    }
  }
  FakeSocket.CONNECTING = 0;
  FakeSocket.OPEN = 1;
  FakeSocket.CLOSING = 2;
  FakeSocket.CLOSED = 3;

  w.WebSocket = FakeSocket;
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  // jsdom reports 'prerender', and the client treats anything but 'visible' as a
  // phone in a pocket: no polling, no reconnecting. Made settable because that
  // rule is one of the things worth asserting.
  let visibility = 'visible';
  Object.defineProperty(w.document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  const json = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  w.fetch = (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/api/live')) return json({ sessions: box.live, at: Date.now() });
    if (u.includes('/api/projects')) return json(projectsPayload());
    if (u.includes('/api/auth-check')) return json({ ok: true });
    return json({ models: [{ id: 'us.anthropic.claude-opus-5', label: 'Opus 5' }] });
  };

  const thrown = [];
  w.addEventListener('error', (e) => thrown.push(e.message));
  try {
    w.eval(js);
  } catch (err) {
    console.error(`FAIL: app.js threw on load — ${err.constructor.name}: ${err.message}`);
    console.error(err.stack?.split('\n').slice(0, 5).join('\n'));
    process.exit(1);
  }

  const $ = (sel) => w.document.querySelector(sel);
  return {
    dom, w, sockets, calls, box, thrown, $,
    setVisibility(value) {
      visibility = value;
      w.document.dispatchEvent(new w.Event('visibilitychange'));
    },
    hooks: w.__panesForTest,
    drafts: w.__draftForTest,
    chips: () => [...w.document.querySelectorAll('#tabs .chip')],
    chipNames: () => [...w.document.querySelectorAll('#tabs .chip-name')].map((c) => c.textContent),
    threads: () => [...w.document.querySelectorAll('#threads .thread')],
    livePanes: () => [...w.__panesForTest.panes.values()].filter((p) => !p.cold),
    toast: () => $('#toast').textContent,
    rows: () => [...w.document.querySelectorAll('#list-body .row')],
  };
}

/** Everything the server says between an accepted upgrade and a usable chat. */
function joinConversation(sock, { sessionId = null, busy = false } = {}) {
  sock.accept();
  sock.deliver({ type: 'ready' });
  if (sessionId) sock.deliver({ type: 'history', messages: [], truncated: 0 });
  sock.deliver({
    type: 'attached',
    conversationId: `conv-${sessionId || 'new'}`,
    cwd: DEMO,
    busy,
    sessionId,
  });
  if (busy) sock.deliver({ type: 'joined', busy: true });
}

// --- 1. A cold launch --------------------------------------------------------
console.log('\nComes back to every tab without opening every socket:');
{
  const saved = {
    panes: [
      { cwd: DEMO, title: 'the one still running', sessionId: 'aaa' },
      { cwd: DEMO, title: 'a finished task', sessionId: 'bbb' },
      { cwd: API, title: 'an api chat', sessionId: 'ccc' },
    ],
    activeKey: null,
  };
  const h = bootClient({ saved });
  await settle();

  check('restores every tab that was open', h.chipNames().length === 3, h.chipNames().join(', '));
  check('names them from what was saved', h.chipNames().includes('an api chat'));
  check(
    'opens no socket for a tab nobody is looking at',
    h.sockets.length === 0,
    `${h.sockets.length} sockets`,
  );
  check('builds no thread for one either', h.threads().length === 0);
  check('every restored tab is cold', [...h.hooks.panes.values()].every((p) => p.cold));
  check('lands on the list when no tab was on screen', h.$('#screen-list').classList.contains('active'));
  check('shows the tab strip', !h.$('#tabs').classList.contains('hidden'));
  check('offers a way to open another chat', Boolean(h.$('#tabs .chip-add')));

  // Looking at one is what connects it — and only it.
  const pane = h.hooks.panes.get(h.hooks.paneKey(DEMO, 'bbb'));
  h.hooks.activatePane(pane);
  check('activating a cold tab connects exactly one socket', h.sockets.length === 1);
  h.sockets[0].accept();
  const start = h.sockets[0].sent[0];
  check(
    'joins the conversation by session id rather than starting a new one',
    start?.type === 'start' && start.resumeSessionId === 'bbb' && start.cwd === DEMO,
    JSON.stringify(start),
  );
  check('builds the thread it is about to render into', h.threads().length === 1);
  check('the reheated tab is no longer cold', !pane.cold && !pane.chip.classList.contains('cold'));
  check('the other tabs stay cold', h.livePanes().length === 1);
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  await finish(h);
}

// The tab that was on screen is the one exception: a launch that lands you back
// in a conversation has to have that conversation live.
{
  const h = bootClient({
    saved: {
      panes: [
        { cwd: DEMO, title: 'the one still running', sessionId: 'aaa' },
        { cwd: API, title: 'an api chat', sessionId: 'ccc' },
      ],
      activeKey: `${API}|ccc`,
    },
  });
  await settle();
  check('lands back in the chat that was on screen', h.$('#screen-chat').classList.contains('active'));
  check('with one socket, for that chat only', h.sockets.length === 1);
  h.sockets[0].accept();
  check('resuming the right session', h.sockets[0].sent[0]?.resumeSessionId === 'ccc');
  check('the header names it', h.$('#chat-title').textContent === 'an api chat');
  await finish(h);
}

// --- 2. A conversation nobody is watching -----------------------------------
console.log('\nKeeps a background conversation rendering, and says when it lands:');
{
  const h = bootClient();
  await settle();
  const a = h.hooks.openChat({ cwd: DEMO, title: 'the one still running', resumeSessionId: 'aaa' });
  const sa = h.sockets[0];
  joinConversation(sa, { sessionId: 'aaa', busy: true });
  const b = h.hooks.openChat({ cwd: API, title: 'an api chat', resumeSessionId: 'ccc' });
  const sb = h.sockets[1];
  joinConversation(sb, { sessionId: 'ccc' });

  check('two chats are two tabs', h.chips().length === 2 && h.threads().length === 2);
  check('the second one is on screen', b.thread.classList.contains('active'));
  check('the first one is not', !a.thread.classList.contains('active'));
  check('the tab of a working chat says so', a.chip.classList.contains('busy'));

  // The whole point: this arrives while the user is reading something else.
  sa.deliver({ type: 'user_message', text: 'run the tests' });
  sa.deliver({ type: 'delta', text: 'Running ' });
  sa.deliver({ type: 'delta', text: 'them now' });
  check('a background turn renders into its own thread', a.thread.textContent.includes('Running them now'));
  check('and not into the one on screen', !b.thread.textContent.includes('Running'));
  check('the background thread stays off screen while it renders', !a.thread.classList.contains('active'));

  sa.deliver({ type: 'assistant_text', text: 'Running them now — all green.' });
  sa.deliver({ type: 'turn_complete', costUsd: 0.0123 });
  check(
    'announces a background chat that finished',
    /finished/.test(h.toast()) && h.toast().includes('the one still running'),
    h.toast(),
  );
  check('marks that tab unread', a.chip.classList.contains('unread'));
  check('and stops showing it as working', !a.chip.classList.contains('busy'));
  check('the final text replaced the streamed one exactly once',
    a.thread.textContent.split('all green').length === 2, a.thread.textContent);

  // The chat you are looking at does not announce itself: that would be a toast
  // over the reply you are already reading.
  h.$('#toast').textContent = '';
  sb.deliver({ type: 'turn_complete' });
  check('the chat on screen announces nothing', h.toast() === '', h.toast());
  check('and is never marked unread', !b.chip.classList.contains('unread'));

  h.hooks.activatePane(a);
  check('switching to it clears the unread mark', !a.chip.classList.contains('unread'));
  check('its thread is the one displayed now', a.thread.classList.contains('active') && !b.thread.classList.contains('active'));
  check('the header follows the switch', h.$('#chat-title').textContent === 'the one still running');
  check('and the cost it reported is on screen', h.$('#chat-sub').textContent.includes('0.012'));

  // An error is the other thing worth interrupting for: a chat that died in the
  // background looks identical to one still thinking.
  h.hooks.activatePane(b);
  h.$('#toast').textContent = '';
  sa.deliver({ type: 'error', message: 'the session ended' });
  check('announces a background failure too', h.toast().includes('the session ended'), h.toast());
  sa.deliver({ type: 'exit' });
  check('a chat whose process is gone is marked on its tab', a.chip.classList.contains('trouble'));
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  await finish(h);
}

// --- 3. One composer, several chats -----------------------------------------
console.log('\nCarries the composer between tabs without mixing two chats up:');
{
  const h = bootClient();
  await settle();
  const input = h.$('#input');
  const a = h.hooks.openChat({ cwd: DEMO, title: 'the one still running', resumeSessionId: 'aaa' });
  joinConversation(h.sockets[0], { sessionId: 'aaa' });
  const b = h.hooks.openChat({ cwd: API, title: 'an api chat', resumeSessionId: 'ccc' });
  joinConversation(h.sockets[1], { sessionId: 'ccc' });

  input.value = 'half a sentence about the api';
  h.drafts.saveDraft({ now: true });
  h.hooks.activatePane(a);
  check('switching tabs takes the other chat\'s text out of the composer', input.value === '', input.value);

  input.value = 'a different half-sentence';
  h.hooks.activatePane(b);
  check('switching back brings that chat\'s text back', input.value === 'half a sentence about the api', input.value);
  h.hooks.activatePane(a);
  check('and the tab left behind keeps its own', input.value === 'a different half-sentence', input.value);

  const savedFor = (pane) => JSON.parse(h.w.localStorage.getItem(h.drafts.draftKeyFor(pane)) || 'null');
  check('each draft is stored under its own conversation', savedFor(b)?.text === 'half a sentence about the api');
  check('...and the other under its own', savedFor(a)?.text === 'a different half-sentence');
  check('a draft records the chat it was typed in', savedFor(b)?.sessionId === 'ccc' && savedFor(b)?.cwd === API);

  // Sending belongs to the chat on screen and to no other. Getting this wrong
  // sends someone's message into a conversation they were not looking at.
  input.value = 'only for this one';
  await h.w.__voiceForTest.sendMessage();
  const framesOf = (sock) => sock.sent.filter((f) => f.type === 'message');
  check('the message went to the chat on screen', framesOf(h.sockets[0])[0]?.text === 'only for this one');
  check('and to no other', framesOf(h.sockets[1]).length === 0);
  check('the send cleared the composer', input.value === '');
  check('and cleared its draft with it', !h.w.localStorage.getItem(h.drafts.draftKeyFor(a)));
  check('the echo went into the right thread',
    a.thread.textContent.includes('only for this one') && !b.thread.textContent.includes('only for this one'));
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  await finish(h);
}

// --- 4. The live cap --------------------------------------------------------
console.log('\nHolds three conversations live, and cools the one nobody is using:');
{
  const h = bootClient();
  await settle();
  check('three is the cap', h.hooks.MAX_LIVE === 3);

  const p1 = h.hooks.openChat({ cwd: DEMO, title: 'the one still running', resumeSessionId: 'aaa' });
  joinConversation(h.sockets[0], { sessionId: 'aaa' });
  const p2 = h.hooks.openChat({ cwd: DEMO, title: 'a finished task', resumeSessionId: 'bbb' });
  joinConversation(h.sockets[1], { sessionId: 'bbb' });
  const p3 = h.hooks.openChat({ cwd: API, title: 'an api chat', resumeSessionId: 'ccc' });
  joinConversation(h.sockets[2], { sessionId: 'ccc' });
  // jsdom gets through all three inside one millisecond, so the order they were
  // last looked at is stated rather than left to the clock.
  p1.touchedAt = Date.now() - 3000;
  p2.touchedAt = Date.now() - 2000;
  p3.touchedAt = Date.now() - 1000;

  const p4 = h.hooks.openChat({ cwd: DEMO, title: 'a fourth chat', resumeSessionId: 'ddd' });
  check('a fourth chat cools the least recently used one', p1.cold, `cold: ${[p1, p2, p3, p4].map((p) => p.cold).join(',')}`);
  check('and only that one', !p2.cold && !p3.cold && !p4.cold);
  check('cooling drops the socket', h.sockets[0].closedByClient);
  check('cooling drops the thread', p1.thread === null && h.threads().length === 3);
  check('cooling tells the server nothing', !h.sockets[0].sent.some((f) => f.type === 'interrupt'));
  check('a cooled conversation is still a tab', h.chips().length === 4 && p1.chip.classList.contains('cold'));
  check('a cooled tab is still listed as open', JSON.parse(h.w.localStorage.getItem('claude-chat-panes')).panes.length === 4);

  // Everything live is working now. Cooling one of these would be a lie: the tab
  // would go quiet while the box was still spending on it.
  h.sockets[1].deliver({ type: 'joined', busy: true });
  h.sockets[2].deliver({ type: 'joined', busy: true });
  h.sockets[3].deliver({ type: 'joined', busy: true });
  check('all three live chats are working', [p2, p3, p4].every((p) => p.busy));
  h.$('#toast').textContent = '';
  const p5 = h.hooks.openChat({ cwd: API, title: 'a fifth chat', resumeSessionId: 'eee' });
  check('never cools a chat that is working', !p2.cold && !p3.cold && !p4.cold);
  check('exceeds the cap instead', h.livePanes().length === 4);
  check('and says so rather than doing it quietly', /already working/.test(h.toast()), h.toast());
  check('the fifth chat is live and on screen', !p5.cold && p5.thread.classList.contains('active'));

  // Coming back to a cooled tab is the same join another device would do.
  const before = h.sockets.length;
  h.hooks.activatePane(p1);
  check('reheating a cooled tab opens one socket', h.sockets.length === before + 1);
  h.sockets[before].accept();
  check(
    'and rejoins by session id, not by the process handle it had',
    h.sockets[before].sent[0]?.type === 'start' && h.sockets[before].sent[0].resumeSessionId === 'aaa',
    JSON.stringify(h.sockets[before].sent[0]),
  );
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  await finish(h);
}

// --- 5. Closing a tab -------------------------------------------------------
console.log('\nCloses a tab without stopping the conversation behind it:');
{
  const h = bootClient();
  await settle();
  const a = h.hooks.openChat({ cwd: DEMO, title: 'the one still running', resumeSessionId: 'aaa' });
  const sa = h.sockets[0];
  joinConversation(sa, { sessionId: 'aaa', busy: true });
  const b = h.hooks.openChat({ cwd: API, title: 'an api chat', resumeSessionId: 'ccc' });
  joinConversation(h.sockets[1], { sessionId: 'ccc' });

  const framesBefore = sa.sent.length;
  h.hooks.closePane(a);
  check('closing a tab sends nothing at all', sa.sent.length === framesBefore, JSON.stringify(sa.sent.slice(framesBefore)));
  check('in particular, it does not interrupt the turn', !sa.sent.some((f) => f.type === 'interrupt'));
  check('the tab is gone', !h.hooks.panes.has(a.key) && h.chips().length === 1);
  check('its thread is gone with it', h.threads().length === 1);
  check('the socket is dropped, because nobody is showing it', sa.closedByClient);
  check('and it says the conversation keeps working', /keeps working/.test(h.toast()), h.toast());
  check('the chat that is left is the one on screen', h.hooks.activePane() === b);

  // The conversation is still on the box, so it is still in the list and can be
  // reopened — the tab was a view of it, not the thing itself.
  await h.hooks.pollLive();
  const reopened = h.hooks.openChat({ cwd: DEMO, title: 'the one still running', resumeSessionId: 'aaa' });
  check('reopening it is a fresh join of the same conversation', reopened !== a && reopened.sessionId === 'aaa');

  h.hooks.closePane(reopened);
  h.hooks.closePane(b);
  check('closing the last tab goes back to the list', h.$('#screen-list').classList.contains('active'));
  check('the tab strip disappears with the last tab', h.$('#tabs').classList.contains('hidden'));
  check('and nothing is listed as open any more', !h.w.localStorage.getItem('claude-chat-panes'));
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  await finish(h);
}

// --- 6. A brand-new chat getting its name ------------------------------------
console.log('\nGives a new chat its durable name without losing what was typed:');
{
  const h = bootClient();
  await settle();
  const input = h.$('#input');
  const pane = h.hooks.openChat({ cwd: DEMO, title: 'demo' });
  const sock = h.sockets[0];
  sock.accept();
  check('starts a chat rather than resuming one', sock.sent[0]?.type === 'start' && !sock.sent[0].resumeSessionId);
  check('keyed privately until the CLI names it', pane.key === `${DEMO}|new:1` && pane.sessionId === null, pane.key);
  check('and not written down, because nobody could rejoin it', !h.w.localStorage.getItem('claude-chat-panes'));

  // Typed before the first reply, which is the normal way a new chat starts and
  // the one case where the draft's key is about to change underneath it.
  input.value = 'the first thing I typed';
  h.drafts.saveDraft({ now: true });
  const beforeKey = h.drafts.draftKeyFor(pane);
  check('the draft is on disk', JSON.parse(h.w.localStorage.getItem(beforeKey) || 'null')?.text === 'the first thing I typed');

  sock.deliver({ type: 'attached', conversationId: 'conv-new', cwd: DEMO, busy: false, sessionId: null });
  sock.deliver({ type: 'session', sessionId: 'zzz999' });
  check('re-keyed to the durable name', pane.key === `${DEMO}|zzz999` && pane.sessionId === 'zzz999', pane.key);
  check('the pane map agrees', h.hooks.panes.get(`${DEMO}|zzz999`) === pane && h.hooks.panes.size === 1);
  check('the tab on screen is still the tab on screen', h.hooks.activePane() === pane);
  check('the chat is now written down, so a refresh comes back to it',
    JSON.parse(h.w.localStorage.getItem('claude-chat-panes')).panes[0].sessionId === 'zzz999');

  const afterKey = h.drafts.draftKeyFor(pane);
  check('the draft followed the rename', JSON.parse(h.w.localStorage.getItem(afterKey) || 'null')?.text === 'the first thing I typed');
  check('and left nothing behind under the old name', !h.w.localStorage.getItem(beforeKey) || beforeKey === afterKey);
  // The reload this is all for: the box is empty, the chat is reopened, the words
  // are still there.
  input.value = '';
  check('so a reload still restores it', h.drafts.restoreDraft(pane) && input.value === 'the first thing I typed');
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  await finish(h);
}

// --- 7. One pane per conversation -------------------------------------------
console.log('\nRefuses to show one conversation in two tabs:');
{
  const h = bootClient();
  await settle();
  const first = h.hooks.openChat({ cwd: DEMO, title: 'the one still running', resumeSessionId: 'aaa' });
  joinConversation(h.sockets[0], { sessionId: 'aaa' });
  const again = h.hooks.openChat({ cwd: DEMO, title: 'the one still running', resumeSessionId: 'aaa' });
  check('the same chat opened twice is one tab', again === first && h.hooks.panes.size === 1 && h.chips().length === 1);
  check('and one socket', h.sockets.length === 1);

  // The same collision from the other direction: a new chat handed a session id
  // that already has a tab. Two panes on one id would be two sockets appending to
  // one transcript, so the older tab goes.
  const fresh = h.hooks.openChat({ cwd: DEMO, title: 'a new chat' });
  h.sockets[1].accept();
  h.sockets[1].deliver({ type: 'session', sessionId: 'aaa' });
  check('a session id is never held by two panes', h.hooks.panes.size === 1);
  check('the tab that kept it is the one that just claimed it', h.hooks.panes.get(`${DEMO}|aaa`) === fresh);
  check('the tab that lost it was closed, not interrupted', first.closed && !h.sockets[0].sent.some((f) => f.type === 'interrupt'));
  check('and its socket was dropped', h.sockets[0].closedByClient);
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  await finish(h);
}

// --- 8. Ambient state, for the tabs with no socket ---------------------------
console.log('\nTells a cooled tab what its conversation is doing:');
{
  const h = bootClient({
    saved: { panes: [{ cwd: DEMO, title: 'the one still running', sessionId: 'aaa' }], activeKey: null },
    live: [],
  });
  await settle();
  const pane = h.hooks.panes.get(`${DEMO}|aaa`);
  check('a restored tab starts cold', pane.cold && pane.chip.classList.contains('cold'));

  h.box.live = [{ cwd: DEMO, sessionId: 'aaa', busy: true, lastActivity: Date.now() }];
  await h.hooks.pollLive();
  check('a cooled tab shows work it cannot see itself', pane.busy && pane.chip.classList.contains('busy'));
  check('and is not flagged while its process is there', !pane.trouble);

  // The payoff: a task sent from one tab, read about in another, reported without
  // going to look.
  h.$('#toast').textContent = '';
  h.box.live = [{ cwd: DEMO, sessionId: 'aaa', busy: false, lastActivity: Date.now() }];
  await h.hooks.pollLive();
  check('announces a cooled chat that finished', /finished/.test(h.toast()) && h.toast().includes('the one still running'), h.toast());
  check('and the tab stops showing as working', !pane.busy && !pane.chip.classList.contains('busy'));

  // Every six seconds, forever, is the failure mode here.
  h.$('#toast').textContent = '';
  await h.hooks.pollLive();
  check('a chat that was already idle announces nothing', h.toast() === '', h.toast());

  h.box.live = [];
  await h.hooks.pollLive();
  check('a cooled tab whose process has gone says so', pane.trouble && pane.chip.classList.contains('trouble'));

  // The list's badges, updated in place. Redrawing the list means /api/projects,
  // which stats and reads every transcript to build the titles — fine once per
  // screen, ruinous every few seconds.
  h.box.live = [{ cwd: DEMO, sessionId: 'bbb', busy: true, lastActivity: Date.now() }];
  await h.hooks.pollLive();
  const row = (key) => h.rows().find((r) => r.dataset.key === key);
  check('a working session is labelled in the list', row(`${DEMO}|bbb`)?.querySelector('.row-live').textContent === 'working…');
  check('a session with no process is not', row(`${DEMO}|aaa`)?.querySelector('.row-live').classList.contains('hidden'));
  check('a session already open on this device is marked', !row(`${DEMO}|aaa`)?.querySelector('.row-open').classList.contains('hidden'));
  check('one that is not open on this device is not', row(`${DEMO}|bbb`)?.querySelector('.row-open').classList.contains('hidden'));
  check(
    'polling never re-reads every transcript',
    h.calls.filter((u) => u.includes('/api/projects')).length === 1,
    `${h.calls.filter((u) => u.includes('/api/projects')).length} calls`,
  );

  // A phone in a pocket with this app open must not keep waking the box.
  h.setVisibility('hidden');
  const before = h.calls.length;
  await h.hooks.pollLive();
  check('a hidden page does not poll at all', h.calls.length === before, `${h.calls.length - before} calls`);
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  await finish(h);
}

// --- 9. Coming back to a phone that was asleep -------------------------------
console.log('\nRejoins every live conversation when the phone comes back:');
{
  const h = bootClient();
  await settle();
  const a = h.hooks.openChat({ cwd: DEMO, title: 'the one still running', resumeSessionId: 'aaa' });
  joinConversation(h.sockets[0], { sessionId: 'aaa', busy: true });
  const b = h.hooks.openChat({ cwd: API, title: 'an api chat', resumeSessionId: 'ccc' });
  joinConversation(h.sockets[1], { sessionId: 'ccc' });

  // iOS suspends a backgrounded tab and freezes its sockets, and the close event
  // usually never arrives — so both of these are dead without having said so.
  h.sockets[0].readyState = 3;
  h.sockets[1].readyState = 3;
  h.setVisibility('hidden');
  h.setVisibility('visible');
  await settle();

  check('reconnects both, not just the one on screen', h.sockets.length === 4, `${h.sockets.length} sockets`);
  h.sockets[2].accept();
  h.sockets[3].accept();
  const frames = [h.sockets[2].sent[0], h.sockets[3].sent[0]];
  check(
    'rejoins by session id rather than by the process handle it had',
    frames.every((f) => f?.type === 'start') && frames.map((f) => f.resumeSessionId).sort().join() === 'aaa,ccc',
    JSON.stringify(frames),
  );
  check('the background chat is still the background chat', h.hooks.activePane() === b && !a.thread.classList.contains('active'));

  // The reason a background tab is kept connected at all: it is the one being
  // waited on, and it has to be able to say so on the new socket.
  const rejoined = [h.sockets[2], h.sockets[3]].find((s) => s.sent[0]?.resumeSessionId === 'aaa');
  h.$('#toast').textContent = '';
  rejoined.deliver({ type: 'joined', busy: true });
  rejoined.deliver({ type: 'turn_complete' });
  check('and can still report a turn it finished while away', /finished/.test(h.toast()), h.toast());
  check('nothing threw', h.thrown.length === 0, h.thrown.join('; '));
  await finish(h);
}

// --- results ----------------------------------------------------------------
if (failures.length) {
  console.error(`\nFAIL: ${failures.length} check(s) failed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  '\nPASS: a cold launch restores every tab and opens one socket; a background '
  + 'conversation renders into its own thread and announces itself when it lands; '
  + 'the composer follows the tab on screen and sends nowhere else; the live cap '
  + 'cools an idle chat and never a working one; closing a tab stops nothing; a '
  + 'new chat keeps its draft through being renamed; and no session id is ever '
  + 'held by two panes.',
);
