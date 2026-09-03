/* Chat client. Deliberately dependency-free — it has to boot fast on a phone. */

// Report load failures to the server. A script error on a phone is otherwise
// invisible — the page just sits on "Loading…" with no way to see why — and
// device-specific parse errors can't be reproduced from a desktop.
window.addEventListener('error', (e) => {
  try {
    navigator.sendBeacon?.(
      '/api/client-error',
      JSON.stringify({
        message: e.message,
        source: e.filename,
        line: e.lineno,
        column: e.colno,
        stack: e.error?.stack?.slice(0, 800),
        ua: navigator.userAgent,
      }),
    );
  } catch {
    /* reporting must never itself break the page */
  }
});

window.addEventListener('unhandledrejection', (e) => {
  try {
    navigator.sendBeacon?.(
      '/api/client-error',
      JSON.stringify({
        message: `unhandled rejection: ${e.reason?.message || e.reason}`,
        stack: e.reason?.stack?.slice(0, 800),
        ua: navigator.userAgent,
      }),
    );
  } catch {
    /* ignore */
  }
});

const $ = (sel) => document.querySelector(sel);

// --- authentication ---------------------------------------------------------

/**
 * Sessions outlive a phone in a pocket but not forever, so any request can come
 * back 401. Send the user to the login page, remembering where they were so
 * they land back in the same conversation afterwards.
 */
let redirecting = false;
function redirectToLogin() {
  if (redirecting) return; // Several in-flight requests can 401 at once.
  redirecting = true;
  const next = encodeURIComponent(location.pathname + location.search);
  location.replace(`/login?next=${next}`);
}

/**
 * Every call to the API goes through this. A bare `fetch` that forgets the 401
 * case shows the user a generic "couldn't load" error and no way forward, which
 * is indistinguishable from the server being broken.
 */
async function api(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    redirectToLogin();
    throw new Error('not signed in');
  }
  return res;
}

// Declared before `state`, which calls loadSettings() during initialisation.
// `const` is not hoisted, so defining this later puts it in a temporal dead
// zone and throws a ReferenceError that kills the whole script at parse time.
const DEFAULTS = {
  model: 'us.anthropic.claude-opus-5',
  permissionMode: 'bypassPermissions',
  effort: 'max',
};

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('claude-chat') || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

// The chat that was open when this device last had the app in the foreground.
// Persisted so a refresh, an app-switch on iOS, or reopening the PWA resumes
// the same conversation instead of dropping back to the list and starting over.
const OPEN_CHAT_KEY = 'claude-chat-open';

function saveOpenChat(chat) {
  try {
    if (chat) localStorage.setItem(OPEN_CHAT_KEY, JSON.stringify(chat));
    else localStorage.removeItem(OPEN_CHAT_KEY);
  } catch {
    /* private mode; device-switching still works via the session id */
  }
}
function loadOpenChat() {
  try {
    return JSON.parse(localStorage.getItem(OPEN_CHAT_KEY) || 'null');
  } catch {
    return null;
  }
}

const state = {
  ws: null,
  conversationId: null,
  // The CLI's own session id: the durable, cross-device name for this chat.
  // `conversationId` only identifies the process to this browser, so it is
  // useless after a refresh and meaningless on another device.
  sessionId: null,
  cwd: null,
  title: null,
  projects: [],
  busy: false,
  streamingEl: null,     // the assistant bubble currently being appended to
  typingEl: null,
  toolEls: new Map(),    // tool_use id -> card element, so results can attach
  echoedMessages: new Set(), // locally-rendered sends, to drop the server echo
  settings: loadSettings(),
  reconnectDelay: 500,
};
function saveSettings() {
  localStorage.setItem('claude-chat', JSON.stringify(state.settings));
}

// --- navigation -------------------------------------------------------------
const screens = ['list', 'new', 'chat'];
const navStack = ['list'];

function show(name) {
  for (const s of screens) $(`#screen-${s}`).classList.toggle('active', s === name);
  if (navStack[navStack.length - 1] !== name) navStack.push(name);
}
function back() {
  navStack.pop();
  const target = navStack[navStack.length - 1] || 'list';
  for (const s of screens) $(`#screen-${s}`).classList.toggle('active', s === target);
  if (target === 'list') {
    // Deliberately leaving the chat, so don't reopen it on the next launch.
    // The server process keeps running; the chat is still in the list.
    saveOpenChat(null);
    refreshList();
  }
}
document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', back));

function toast(message, ms = 3200) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), ms);
}

// --- conversation list ------------------------------------------------------
async function refreshList() {
  const body = $('#list-body');
  try {
    // Bound the request: on a flaky mobile connection a hung fetch would
    // otherwise leave the list stuck on "Loading…" forever.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await api('/api/projects', { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    const data = await res.json();
    state.projects = data.projects || [];
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'the server timed out' : err.message;
    body.innerHTML =
      `<div class="empty">Couldn't load chats — ${escapeHtml(reason)}.` +
      `<br><br><button class="wide" id="btn-retry">Retry</button></div>`;
    $('#btn-retry')?.addEventListener('click', refreshList);
    return;
  }

  const rows = [];
  for (const project of state.projects) {
    for (const session of project.sessions) {
      rows.push({ project, session });
    }
  }
  rows.sort((a, b) => b.session.mtime - a.session.mtime);

  if (!rows.length) {
    body.innerHTML =
      '<div class="empty">No chats yet.<br><br>Tap + to start one.</div>';
    return;
  }

  body.innerHTML = '';
  for (const { project, session } of rows) {
    const row = document.createElement('button');
    row.className = 'row';
    // A chat that is still live on the server is labelled, so it's clear that
    // opening it joins the running session — including one left working on
    // another device.
    const status = session.busy
      ? '<span class="row-live">working…</span>'
      : session.live
        ? '<span class="row-live">live</span>'
        : '';
    row.innerHTML = `
      <div class="avatar">${escapeHtml(project.name.slice(0, 2).toUpperCase())}</div>
      <div class="row-main">
        <div class="row-title">${escapeHtml(session.title)}</div>
        <div class="row-sub">${escapeHtml(project.name)} · ${relTime(session.mtime)} ${status}</div>
      </div>`;
    row.addEventListener('click', () =>
      openChat({ cwd: project.path, title: session.title, resumeSessionId: session.sessionId }),
    );
    body.appendChild(row);
  }
}

// --- new chat ---------------------------------------------------------------
$('#btn-new').addEventListener('click', async () => {
  await refreshList();
  const picker = $('#project-picker');
  picker.innerHTML = '';

  if (!state.projects.length) {
    picker.innerHTML = '<div class="empty">No projects yet. Create one below.</div>';
  }
  for (const project of state.projects) {
    const row = document.createElement('button');
    row.className = 'row';
    row.innerHTML = `
      <div class="avatar">${escapeHtml(project.name.slice(0, 2).toUpperCase())}</div>
      <div class="row-main">
        <div class="row-title">${escapeHtml(project.name)}</div>
        <div class="row-sub">${project.sessions.length} chat${project.sessions.length === 1 ? '' : 's'}</div>
      </div>`;
    row.addEventListener('click', () => openChat({ cwd: project.path, title: project.name }));
    picker.appendChild(row);
  }
  show('new');
});

$('#form-project').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#input-project');
  const status = $('#new-project-status');
  const name = input.value.trim();
  if (!name) return;

  const wantsGithub = $('#opt-github')?.checked ?? false;
  status.textContent = wantsGithub
    ? 'Creating folder, git repo and GitHub remote…'
    : 'Creating…';

  try {
    const res = await api('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        github: wantsGithub,
        private: $('#opt-private')?.checked ?? true,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'could not create project');

    // Report per-step outcomes: a local repo whose remote failed is a different
    // result from a fully wired project, and opening the chat would hide that.
    const failed = (data.project.steps || []).filter((s) => !s.ok);
    if (failed.length) {
      status.textContent =
        `Created "${name}", but ` +
        failed.map((s) => `${s.step} failed: ${s.error || 'unknown'}`).join('; ');
      return;
    }

    const repo = (data.project.steps || []).find((s) => s.step === 'github' && s.ok);
    status.textContent = repo?.url ? `Pushed to ${repo.url}` : '';
    input.value = '';
    openChat({ cwd: data.project.path, title: data.project.name });
  } catch (err) {
    status.textContent = '';
    toast(err.message);
  }
});

// --- chat -------------------------------------------------------------------
function openChat({ cwd, title, resumeSessionId }) {
  state.cwd = cwd;
  state.title = title || 'Claude';
  // Not a handle on anything yet — the server assigns one on attach. The
  // session id is what carries identity across refreshes and devices.
  state.conversationId = null;
  state.sessionId = resumeSessionId || null;
  state.toolEls.clear();
  state.echoedMessages.clear();
  state.streamingEl = null;
  $('#chat-title').textContent = state.title;
  $('#thread').innerHTML = '';
  setBusy(false);
  show('chat');
  // Remember it now, so a crash or a force-quit before the first reply still
  // leaves this device able to rejoin.
  if (resumeSessionId) saveOpenChat({ cwd, title: state.title, sessionId: resumeSessionId });
  connect({ cwd, resumeSessionId });
}

function connect({ cwd, resumeSessionId }) {
  setSub('connecting…');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  state.ws = ws;

  ws.addEventListener('open', () => {
    state.reconnectDelay = 500;
    if (state.conversationId) {
      // Same page, same socket generation: the fast path.
      ws.send(JSON.stringify({ type: 'reattach', conversationId: state.conversationId }));
    } else {
      // No process handle — either a refresh, or another device. `start` with a
      // session id adopts the running process if there is one, so this is a
      // join, not a restart. The thread is rebuilt from scratch, so clear it to
      // avoid duplicating what is already on screen.
      const sessionId = resumeSessionId || state.sessionId;
      if (sessionId) {
        $('#thread').innerHTML = '';
        state.toolEls.clear();
        state.streamingEl = null;
      }
      ws.send(JSON.stringify({
        type: 'start',
        cwd,
        resumeSessionId: sessionId,
        model: state.settings.model,
        permissionMode: state.settings.permissionMode,
        effort: state.settings.effort,
      }));
    }
  });

  ws.addEventListener('message', (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    handleEvent(msg);
  });

  // If the socket neither opens nor errors (captive portal, dead cell data),
  // give up rather than spin forever.
  const openTimer = setTimeout(() => {
    if (ws.readyState === WebSocket.CONNECTING) {
      setSub('connection failed');
      toast("Couldn't reach the server — check your connection.");
      ws.close();
    }
  }, 15000);
  ws.addEventListener('open', () => clearTimeout(openTimer));

  ws.addEventListener('error', () => setSub('connection error'));

  ws.addEventListener('close', () => {
    clearTimeout(openTimer);
    setSub('reconnecting…');
    // The server keeps the claude process alive, so reattaching resumes the
    // same conversation — important when a phone locks mid-task.
    setTimeout(async () => {
      if (!$('#screen-chat').classList.contains('active')) return;
      // A rejected upgrade closes the socket with the same code as a dropped
      // network, so ask an authenticated route which one it was. Without this an
      // expired session shows "reconnecting…" forever with no way to sign in.
      try {
        const res = await fetch('/api/auth-check');
        if (res.status === 401) {
          redirectToLogin();
          return;
        }
      } catch {
        /* offline: fall through and retry, which is the right move */
      }
      connect({ cwd, resumeSessionId });
    }, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, 8000);
  });
}

/** Record the durable session id and make this device able to rejoin later. */
function rememberSession(sessionId) {
  state.sessionId = sessionId;
  saveOpenChat({ cwd: state.cwd, title: state.title, sessionId });
}

function handleEvent(msg) {
  switch (msg.type) {
    case 'ready':
      // Server acknowledged the socket; the start/reattach we sent on open is
      // in flight. Nothing to do but stop looking stalled.
      setSub('starting…');
      return;

    case 'history':
      renderHistory(msg.messages, msg.truncated);
      return;

    case 'attached':
      state.conversationId = msg.conversationId;
      if (msg.sessionId) rememberSession(msg.sessionId);
      setBusy(msg.busy);
      if (!msg.busy) setSub('ready');
      return;

    case 'session':
      // A new session's id arrives here; persist it so this chat is now
      // reachable from any other device and survives a refresh.
      if (msg.sessionId) rememberSession(msg.sessionId);
      setSub(state.busy ? 'working…' : 'ready');
      return;

    case 'joined':
      // Attached to a process that was already running, possibly started on
      // another device. Reflect its real state rather than assuming idle.
      setBusy(msg.busy);
      setSub(msg.busy ? 'working…' : 'ready');
      return;

    case 'user_message':
      // Skip the server's echo of a message we already rendered locally.
      if (state.echoedMessages.delete(msg.text)) return;
      addBubble('user', msg.text);
      return;

    case 'delta':
      appendStream(msg.text);
      return;

    case 'assistant_text':
      // The final text for a block; replaces whatever the deltas built so the
      // bubble matches the authoritative content exactly.
      finalizeStream(msg.text);
      return;

    case 'tool_use':
      addToolCard(msg);
      return;

    case 'tool_result':
      attachToolResult(msg);
      return;

    case 'turn_complete':
      setBusy(false);
      state.streamingEl = null;
      setSub(msg.costUsd ? `ready · $${msg.costUsd.toFixed(3)}` : 'ready');
      return;

    case 'interrupted':
      setBusy(false);
      addBubble('system', 'Stopped.');
      return;

    case 'error':
      setBusy(false);
      addBubble('error', msg.message);
      return;

    case 'exit':
      setBusy(false);
      setSub('session ended');
      return;
  }
}

// --- rendering --------------------------------------------------------------
function threadEl() { return $('#thread'); }

function atBottom() {
  const t = threadEl();
  return t.scrollHeight - t.scrollTop - t.clientHeight < 120;
}
function scrollDown(force) {
  const t = threadEl();
  if (force || atBottom()) t.scrollTop = t.scrollHeight;
}

/**
 * Render a resumed conversation in one pass.
 *
 * Built into a DocumentFragment and appended once: appending 400 bubbles
 * individually forces a layout per node, which locks up a phone long enough
 * that the UI looks broken and later messages never paint.
 */
function renderHistory(messages, truncated) {
  const frag = document.createDocumentFragment();

  if (truncated > 0) {
    const note = document.createElement('div');
    note.className = 'msg system';
    note.textContent = `${truncated} earlier message${truncated === 1 ? '' : 's'} not shown — Claude still has the full context`;
    frag.appendChild(note);
  }

  for (const m of messages) {
    if (m.type === 'user_message') {
      frag.appendChild(makeBubble('user', m.text));
    } else if (m.type === 'assistant_text') {
      frag.appendChild(makeBubble('claude', m.text));
    } else if (m.type === 'tool_use') {
      frag.appendChild(makeToolCard(m, false));
    }
  }

  threadEl().appendChild(frag);
  scrollDown(true);
}

/** Build a bubble without touching the DOM tree. */
function makeBubble(kind, text) {
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  if (kind === 'claude') el.innerHTML = renderMarkdown(text);
  else el.textContent = text;
  return el;
}

function addBubble(kind, text) {
  const stick = atBottom();
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  if (kind === 'claude') el.innerHTML = renderMarkdown(text);
  else el.textContent = text;
  threadEl().appendChild(el);
  scrollDown(stick);
  return el;
}

function appendStream(text) {
  hideTyping();
  const stick = atBottom();
  if (!state.streamingEl) {
    state.streamingEl = document.createElement('div');
    state.streamingEl.className = 'msg claude';
    state.streamingEl.dataset.raw = '';
    threadEl().appendChild(state.streamingEl);
  }
  state.streamingEl.dataset.raw += text;
  state.streamingEl.innerHTML = renderMarkdown(state.streamingEl.dataset.raw);
  scrollDown(stick);
}

function finalizeStream(text) {
  hideTyping();
  if (state.streamingEl) {
    state.streamingEl.innerHTML = renderMarkdown(text);
    state.streamingEl.dataset.raw = text;
    state.streamingEl = null;
  } else {
    addBubble('claude', text);
  }
  scrollDown(false);
}

const TOOL_ICONS = {
  Read: '📖', Write: '✏️', Edit: '✏️', Bash: '❯', Glob: '🔍', Grep: '🔍',
  WebFetch: '🌐', WebSearch: '🌐', Task: '🤖', TodoWrite: '☑️', NotebookEdit: '📓',
};

function toolSummary(name, input) {
  if (!input) return '';
  if (input.file_path) return input.file_path.replace(/^\/workspace\/projects\/[^/]+\//, '');
  if (input.command) return input.command;
  if (input.pattern) return input.pattern;
  if (input.url) return input.url;
  if (input.query) return input.query;
  if (input.description) return input.description;
  return '';
}

/** Build a tool card. `track` registers it so a later result can attach. */
function makeToolCard({ id, name, input }, track = true) {
  const card = document.createElement('div');
  card.className = 'tool';
  card.innerHTML = `
    <div class="tool-head">
      <span class="tool-icon">${TOOL_ICONS[name] || '🔧'}</span>
      <span class="tool-name">${escapeHtml(name)}</span>
      <span class="tool-arg">${escapeHtml(toolSummary(name, input))}</span>
      <span class="tool-chev">›</span>
    </div>
    <div class="tool-body">
      <pre>${escapeHtml(JSON.stringify(input, null, 2))}</pre>
    </div>`;
  card.querySelector('.tool-head').addEventListener('click', () => card.classList.toggle('open'));
  if (track && id) state.toolEls.set(id, card);
  return card;
}

function addToolCard(msg) {
  hideTyping();
  // A tool call ends the current text block.
  state.streamingEl = null;

  const stick = atBottom();
  threadEl().appendChild(makeToolCard(msg));
  scrollDown(stick);
}

function attachToolResult({ toolUseId, content, isError }) {
  const card = state.toolEls.get(toolUseId);
  if (!card) return;
  if (isError) card.classList.add('failed');
  const body = card.querySelector('.tool-body');
  const pre = document.createElement('pre');
  pre.textContent = content || '(no output)';
  body.appendChild(pre);
  if (isError) card.classList.add('open');
}

function showTyping() {
  if (state.typingEl) return;
  state.typingEl = document.createElement('div');
  state.typingEl.className = 'typing';
  state.typingEl.innerHTML = '<span></span><span></span><span></span>';
  threadEl().appendChild(state.typingEl);
  scrollDown(true);
}
function hideTyping() {
  state.typingEl?.remove();
  state.typingEl = null;
}

function setBusy(busy) {
  state.busy = busy;
  $('#btn-send').classList.toggle('hidden', busy);
  $('#btn-stop').classList.toggle('hidden', !busy);
  if (busy) { setSub('working…'); showTyping(); } else hideTyping();
}

function setSub(text) {
  const el = $('#chat-sub');
  el.textContent = text;
  el.classList.toggle('busy', text === 'working…');
}

/** Tiny markdown subset: fenced code, inline code, bold. Enough for chat. */
function renderMarkdown(text) {
  const parts = String(text).split(/```(?:[a-zA-Z0-9_+-]*)\n?/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return `<pre><code>${escapeHtml(part)}</code></pre>`;
      return escapeHtml(part)
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    })
    .join('');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function relTime(ms) {
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 604800) return `${Math.floor(secs / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

// --- composer ---------------------------------------------------------------
const input = $('#input');

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
});

input.addEventListener('keydown', (e) => {
  // Enter sends on desktop; Shift+Enter makes a newline. On phones the
  // on-screen keyboard's return key inserts a newline as usual.
  if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width: 760px)').matches) {
    e.preventDefault();
    sendMessage();
  }
});

function sendMessage() {
  const text = input.value.trim();
  if (!text) return;
  if (state.ws?.readyState !== WebSocket.OPEN) {
    toast('Still connecting — try again in a second.');
    return;
  }
  state.ws.send(JSON.stringify({ type: 'message', text }));
  // Echo immediately. The server also echoes it back, but waiting for that
  // round trip makes a slow connection look like the tap did nothing.
  addBubble('user', text);
  state.echoedMessages.add(text);
  input.value = '';
  input.style.height = 'auto';
  setBusy(true);
}

$('#btn-send').addEventListener('click', sendMessage);
$('#btn-stop').addEventListener('click', () => {
  state.ws?.send(JSON.stringify({ type: 'interrupt' }));
});

// --- voice ------------------------------------------------------------------
/**
 * Live dictation, Cursor-style: words appear in the box while you speak.
 *
 * Primary path is the browser's own streaming recognizer (SpeechRecognition),
 * which is what Cursor and ChatGPT use — it emits interim results mid-utterance,
 * so there's no wait and no server round trip.
 *
 * Where that isn't available (or it errors), fall back to recording audio and
 * transcribing on the server with whisper.cpp. That path can't be live — you get
 * the text when you stop — but it always works.
 *
 * Both paths insert at the cursor and leave the caret after the inserted text,
 * so you can dictate into the middle of a message and keep going.
 */
const micBtn = $('#btn-mic');
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const voice = {
  mode: SpeechRecognition ? 'live' : 'record',
  active: false,
  recognition: null,
  recorder: null,
  chunks: [],
  stream: null,
  // Where the dictated text is being written, so interim results can be
  // rewritten in place as the recognizer revises them.
  anchor: 0,
  committed: '',
};

function setMicState(state) {
  micBtn.classList.toggle('recording', state === 'recording');
  micBtn.classList.toggle('working', state === 'working');
  $('#composer').classList.toggle('listening', state === 'recording');
}

/**
 * Append a recognizer phrase to `acc`, dropping any leading words that repeat
 * what `acc` already ends with.
 *
 * Two separate things go wrong with the raw transcripts on mobile Safari, and
 * both look like duplication. Chunks carry no guaranteed separator, so
 * "sounds" followed by "sounds" concatenates to "soundssounds"; and the
 * recognizer re-delivers phrases it has already finalised, sometimes as an
 * extra entry in the same results list, sometimes at the start of the next
 * session. Rebuilding from `results` fixes the second only when the repeat
 * lands in the list we re-read — it can't help when the repeat spans a session
 * boundary.
 *
 * Comparing the incoming words against the tail already accumulated catches
 * every variant, whatever produced it, and joining on a space fixes the
 * gluing. Deliberate immediate repetition ("very very") is the cost: a real
 * doubled word gets collapsed. That trades a rare, easily retyped loss for a
 * bug that made dictation unusable.
 */
function appendPhrase(acc, phrase) {
  const head = acc.trim().split(/\s+/).filter(Boolean);
  const tail = phrase.trim().split(/\s+/).filter(Boolean);
  if (!tail.length) return head.join(' ');

  // Longest word-aligned overlap wins, so a repeat of several words collapses
  // in one step rather than leaving a partial echo behind.
  for (let n = Math.min(head.length, tail.length); n > 0; n--) {
    const end = head.slice(head.length - n).join(' ').toLowerCase();
    const start = tail.slice(0, n).join(' ').toLowerCase();
    if (end === start) {
      tail.splice(0, n);
      break;
    }
  }
  return [...head, ...tail].join(' ');
}

/** Replace the interim span with `text`, keeping the caret after it. */
function writeDictation(text) {
  const before = input.value.slice(0, voice.anchor);
  const after = input.value.slice(voice.anchor + voice.committed.length);
  const needsSpaceBefore = before && !/\s$/.test(before);
  const body = (needsSpaceBefore ? ' ' : '') + text;

  input.value = before + body + after;
  voice.committed = body;

  const caret = voice.anchor + body.length;
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event('input'));
}

function startLiveDictation() {
  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;   // this is what makes text appear while speaking
  rec.lang = navigator.language || 'en-US';

  // Anchor at the caret so dictation lands where you were typing.
  voice.anchor = input.selectionStart ?? input.value.length;
  voice.committed = '';

  /*
   * Rebuild from `event.results` every event instead of accumulating.
   *
   * This used to do `finalText += chunk` from `event.resultIndex`. On mobile
   * Safari the recognizer re-delivers phrases it has already finalised, with
   * resultIndex back at the start, so each event appended the whole transcript
   * so far again — "okay", then "okay let's", then "okay let's test", giving
   * `okayokay let'sokay let's test`. The growing-prefix shape and the missing
   * separators are both signatures of that append.
   *
   * `results` is authoritative for the current session, so read it whole.
   * Finals from earlier sessions live in `priorSessions`, which only grows in
   * onend — before the restart wipes the list.
   */
  let priorSessions = '';
  let sessionFinal = '';

  rec.onresult = (event) => {
    let finals = '';
    let interim = '';
    for (let i = 0; i < event.results.length; i++) {
      const chunk = event.results[i][0].transcript;
      if (event.results[i].isFinal) finals = appendPhrase(finals, chunk);
      else interim = appendPhrase(interim, chunk);
    }
    sessionFinal = finals;
    const joined = appendPhrase(appendPhrase(priorSessions, finals), interim);
    writeDictation(joined.replace(/\s+/g, ' ').trimStart());
  };

  rec.onerror = (event) => {
    // no-speech and aborted are normal; anything else means fall back.
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    console.warn('speech recognition error:', event.error);
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      toast('Microphone permission denied.');
      stopVoice();
      return;
    }
    // network / language-not-supported: use the server instead, this attempt on.
    toast('Live dictation unavailable — using server transcription.');
    voice.mode = 'record';
    stopVoice();
  };

  rec.onend = () => {
    if (voice.active) {
      // Mobile Safari ends the session on brief pauses; restart to keep going.
      // Commit this session's finals first — the new session starts with an
      // empty `results` list, so anything not banked here is lost.
      if (sessionFinal.trim()) {
        priorSessions = appendPhrase(priorSessions, sessionFinal);
        sessionFinal = '';
      }
      try {
        rec.start();
      } catch {
        stopVoice();
      }
    }
  };

  voice.recognition = rec;
  voice.active = true;
  setMicState('recording');
  rec.start();
}

async function startRecordingDictation() {
  try {
    voice.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (err) {
    toast(`Microphone blocked: ${err.message}`);
    return;
  }

  voice.anchor = input.selectionStart ?? input.value.length;
  voice.committed = '';
  voice.chunks = [];

  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  const recorder = new MediaRecorder(voice.stream, mimeType ? { mimeType } : undefined);
  recorder.ondataavailable = (e) => { if (e.data.size > 0) voice.chunks.push(e.data); };
  recorder.onstop = transcribeRecording;
  recorder.start();

  voice.recorder = recorder;
  voice.active = true;
  setMicState('recording');
}

function stopVoice() {
  voice.active = false;
  setMicState('idle');

  if (voice.recognition) {
    try {
      voice.recognition.stop();
    } catch {
      /* already stopped */
    }
    voice.recognition = null;
    input.focus();
  }

  if (voice.recorder && voice.recorder.state !== 'inactive') {
    setMicState('working');
    voice.recorder.stop();
  }
}

async function transcribeRecording() {
  voice.stream?.getTracks().forEach((t) => t.stop());
  voice.stream = null;

  const raw = new Blob(voice.chunks, { type: voice.recorder?.mimeType || 'audio/webm' });
  voice.recorder = null;

  try {
    let blob;
    try {
      blob = await toWav(raw);
    } catch (err) {
      // If decoding fails, send the original and let the server try.
      console.warn('wav conversion failed, uploading original:', err);
      blob = raw;
    }

    const form = new FormData();
    form.append('audio', blob, blob.type === 'audio/wav' ? 'recording.wav' : 'recording.webm');
    const res = await api('/api/transcribe', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'transcription failed');

    writeDictation(data.text);
    input.focus();
  } catch (err) {
    toast(err.message);
  } finally {
    setMicState('idle');
  }
}

/**
 * Decode whatever the browser recorded and re-encode as 16 kHz mono WAV.
 *
 * Browsers record webm/opus by default, and the on-server transcriber decodes
 * WAV/MP3/FLAC/Vorbis but not Opus. Rather than ship a codec server-side, let
 * the browser — which already has an Opus decoder — do the conversion. 16 kHz
 * mono is also exactly what Whisper wants, so this shrinks the upload too.
 */
async function toWav(blob) {
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const decoded = await audioCtx.decodeAudioData(await blob.arrayBuffer());

    const targetRate = 16000;
    const frames = Math.ceil(decoded.duration * targetRate);
    const offline = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
      1, frames, targetRate,
    );
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const resampled = await offline.startRendering();

    const samples = resampled.getChannelData(0);
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);          // PCM header size
    view.setUint16(20, 1, true);           // format: PCM
    view.setUint16(22, 1, true);           // channels
    view.setUint32(24, targetRate, true);
    view.setUint32(28, targetRate * 2, true); // byte rate
    view.setUint16(32, 2, true);           // block align
    view.setUint16(34, 16, true);          // bits per sample
    writeStr(36, 'data');
    view.setUint32(40, samples.length * 2, true);

    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
  } finally {
    audioCtx.close();
  }
}

micBtn.addEventListener('click', () => {
  if (voice.active) {
    stopVoice();
    return;
  }
  if (voice.mode === 'live') startLiveDictation();
  else startRecordingDictation();
});
// --- settings ---------------------------------------------------------------
$('#btn-settings').addEventListener('click', () => $('#sheet').classList.remove('hidden'));
document.querySelectorAll('[data-close-sheet]').forEach((el) =>
  el.addEventListener('click', () => $('#sheet').classList.add('hidden')),
);

$('#select-permission').value = state.settings.permissionMode;
$('#select-permission').addEventListener('change', (e) => {
  state.settings.permissionMode = e.target.value;
  saveSettings();
  toast('Applies to new chats');
});

$('#select-effort').value = state.settings.effort;
$('#select-effort').addEventListener('change', (e) => {
  state.settings.effort = e.target.value;
  saveSettings();
  toast('Applies to new chats');
});

(async function initModels() {
  try {
    const res = await api('/api/models');
    const { models } = await res.json();
    const select = $('#select-model');
    select.innerHTML = models
      .map((m) => `<option value="${m.id}">${escapeHtml(m.label)}</option>`)
      .join('');
    select.value = state.settings.model;
    select.addEventListener('change', (e) => {
      state.settings.model = e.target.value;
      saveSettings();
      toast('Applies to new chats');
    });
  } catch {
    /* model list is cosmetic */
  }
})();

// --- boot -------------------------------------------------------------------
// Actively tear down any previously-registered worker. We no longer register
// one: this is a live WebSocket client, caching buys nothing, and a wedged
// worker is a failure mode with no user-side escape.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .getRegistrations()
    .then((regs) => regs.forEach((r) => r.unregister()))
    .catch(() => {});
  if (window.caches) {
    caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
  }
}

// Exposed so smoke-test.js can exercise event rendering without a live socket.
window.__handleEventForTest = handleEvent;

// A device that wakes up may have been asleep for hours: iOS suspends timers
// and freezes sockets when the app is backgrounded, and the close event often
// never fires, so the client believes it is connected to a socket that is gone.
// On resume, verify the socket and rejoin if it died.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;

  if (!$('#screen-chat').classList.contains('active')) {
    refreshList();
    return;
  }

  const ws = state.ws;
  const dead = !ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING;
  if (dead) {
    // Drop the stale process handle: it may belong to a reaped conversation.
    // Rejoining by session id adopts whatever is actually running.
    state.conversationId = null;
    state.reconnectDelay = 500;
    connect({ cwd: state.cwd, resumeSessionId: state.sessionId });
  }
});

// Restore the chat this device had open, so a refresh or a cold PWA launch
// lands back in the conversation rather than on the list. If the same chat is
// still running on the server — including work started from another device —
// this rejoins it.
(function boot() {
  const open = loadOpenChat();
  if (open?.cwd && open?.sessionId) {
    openChat({ cwd: open.cwd, title: open.title, resumeSessionId: open.sessionId });
    // Load the list behind the chat so going back is instant.
    refreshList();
    return;
  }
  refreshList();
})();
