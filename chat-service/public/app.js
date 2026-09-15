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
  // Leaving the chat: release the mic. The screen wake lock is deliberately not
  // released — it belongs to the app being open, not to this screen. Safe to
  // reach `voice` from here — this only ever runs from a click, long after the
  // script is evaluated — but never call back() during initialisation.
  if (voice.active) stopVoice();
  else hideDictationBar();
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
  renderProjectPicker();
  $('#repo-picker').innerHTML = '';
  $('#clone-status').textContent = '';
  show('new');
});

function renderProjectPicker() {
  const picker = $('#project-picker');
  picker.innerHTML = '';

  if (!state.projects.length) {
    picker.innerHTML = '<div class="empty">No projects yet. Clone one, or create one below.</div>';
    return;
  }
  for (const project of state.projects) {
    const wrap = document.createElement('div');
    wrap.className = 'row-wrap';

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'row';
    row.innerHTML = `
      <div class="avatar">${escapeHtml(project.name.slice(0, 2).toUpperCase())}</div>
      <div class="row-main">
        <div class="row-title">${escapeHtml(project.name)}</div>
        <div class="row-sub">${project.sessions.length} chat${project.sessions.length === 1 ? '' : 's'}</div>
      </div>`;
    row.addEventListener('click', () => openChat({ cwd: project.path, title: project.name }));

    const manage = document.createElement('button');
    manage.type = 'button';
    manage.className = 'icon-btn';
    manage.setAttribute('aria-label', `Manage ${project.name}`);
    manage.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M12 8a2 2 0 1 1 0-4 2 2 0 0 1 0 4m0 6a2 2 0 1 1 0-4' +
      ' 2 2 0 0 1 0 4m0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4"/></svg>';
    manage.addEventListener('click', () => openProjectSheet(project));

    wrap.append(row, manage);
    picker.appendChild(wrap);
  }
}

// --- cloning an existing GitHub repo ----------------------------------------
$('#form-clone').addEventListener('submit', (e) => {
  e.preventDefault();
  cloneRepo($('#input-clone').value.trim());
});

/**
 * Deliberately not wrapped in an AbortController, unlike the list fetch: a real
 * repository can take minutes to clone on a small instance, and a client-side
 * timeout would abandon a clone that is still running server-side, leaving a
 * half-finished directory nobody is watching. The server's own git timeout is
 * the bound.
 */
async function cloneRepo(repo) {
  if (!repo) return;
  const status = $('#clone-status');
  status.textContent = `Cloning ${repo}… a large repository can take a few minutes.`;

  try {
    const res = await api('/api/projects/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'clone failed');

    status.textContent = '';
    $('#input-clone').value = '';
    $('#repo-picker').innerHTML = '';
    await refreshList();
    renderProjectPicker();
    openChat({ cwd: data.project.path, title: data.project.name });
  } catch (err) {
    status.textContent = err.message;
  }
}

$('#btn-browse-repos').addEventListener('click', async () => {
  const picker = $('#repo-picker');
  picker.innerHTML = '<div class="empty">Loading your repositories…</div>';

  try {
    const res = await api('/api/github/repos');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'could not list repositories');
    if (!data.repos.length) {
      picker.innerHTML = '<div class="empty">No repositories visible to this workspace token.</div>';
      return;
    }

    picker.innerHTML = '';
    for (const repo of data.repos) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'row repo-row';
      const tags =
        (repo.private ? '<span class="repo-tag">private</span>' : '') +
        (repo.present ? '<span class="repo-tag">already here</span>' : '');
      row.innerHTML = `
        <div class="row-main">
          <div class="row-title">${escapeHtml(repo.slug)}${tags}</div>
          <div class="row-sub">${escapeHtml(repo.description || 'No description')}</div>
        </div>`;
      row.addEventListener('click', () => {
        // Cloning over an existing directory is refused server-side; saying so
        // here saves the round trip and explains the label.
        if (repo.present) {
          toast(`"${repo.name}" is already in the workspace.`);
          return;
        }
        $('#input-clone').value = repo.slug;
        cloneRepo(repo.slug);
      });
      picker.appendChild(row);
    }
  } catch (err) {
    picker.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
  }
});

// --- managing and removing a project ----------------------------------------
/**
 * Deleting a project deletes a directory tree, so the sheet's job is to show
 * what is in it *before* offering the button — and the server checks the same
 * things again for itself. Anything the client shows here is a courtesy; the
 * refusal that matters happens server-side.
 */
const projectSheet = $('#project-sheet');
let sheetProject = null;

function closeProjectSheet() {
  projectSheet.classList.add('hidden');
  sheetProject = null;
}
document
  .querySelectorAll('[data-close-project]')
  .forEach((el) => el.addEventListener('click', closeProjectSheet));

async function openProjectSheet(project) {
  sheetProject = project;
  $('#project-sheet-title').textContent = project.name;
  $('#project-sheet-body').textContent = 'Checking the repository…';
  const btn = $('#btn-project-remove');
  btn.classList.add('hidden');
  btn.disabled = false;
  projectSheet.classList.remove('hidden');

  try {
    const res = await api(`/api/project-status?name=${encodeURIComponent(project.name)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'could not read the project');
    // The sheet may have been closed, or opened on a different project, while
    // this was in flight — writing into it then would mislabel the facts.
    if (sheetProject?.name !== project.name) return;
    renderProjectFacts(data.status);
  } catch (err) {
    if (sheetProject?.name === project.name) $('#project-sheet-body').textContent = err.message;
  }
}

function renderProjectFacts(status) {
  const facts = [];
  const add = (label, value, atRisk = false) => facts.push({ label, value, atRisk });

  if (!status.isRepo) {
    add('Git', 'not a repository', true);
  } else {
    add('Branch', status.hasCommits ? status.branch || 'unknown' : 'no commits yet');
    add(
      'Remote',
      status.remote ? status.remote.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '') : 'none',
      !status.remote,
    );
    add('Uncommitted changes', status.dirty ? `${status.dirty} (will be committed)` : 'none');
    add('Unpushed commits', status.unpushed ? `${status.unpushed} (will be pushed)` : 'none');
    if (status.stashes) add('Stashes', `${status.stashes} — not pushed by anything`, true);
    if (status.ignored.length) {
      add('Not in git', status.ignored.join(', '), true);
    }
  }
  if (status.live.length) {
    const busy = status.live.filter((c) => c.busy).length;
    add('Open chats', busy ? `${status.live.length} (${busy} working)` : String(status.live.length), Boolean(busy));
  }
  add('Chat history', `${status.transcripts} kept after deleting`);

  $('#project-sheet-body').innerHTML =
    `<ul class="fact-list">${facts
      .map(
        (f) =>
          `<li class="${f.atRisk ? 'at-risk' : ''}"><span>${escapeHtml(f.label)}</span>` +
          `<span>${escapeHtml(f.value)}</span></li>`,
      )
      .join('')}</ul>` +
    '<p class="hint" style="margin-top:14px">Commits and pushes everything, checks the ' +
    'remote really has it, then deletes the folder from this machine. Chat history stays.</p>';

  const btn = $('#btn-project-remove');
  btn.textContent = 'Push & delete from this machine';
  btn.onclick = () => removeProjectFromMachine(false);
  btn.classList.remove('hidden');
}

async function removeProjectFromMachine(force) {
  const project = sheetProject;
  if (!project) return;
  const btn = $('#btn-project-remove');
  const body = $('#project-sheet-body');
  const previous = btn.textContent;

  btn.disabled = true;
  btn.textContent = force ? 'Deleting…' : 'Committing, pushing, verifying…';

  try {
    const res = await api('/api/projects/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: project.name, force }),
    });
    const data = await res.json();

    // 409 is a refusal, not a failure: the server found something that only
    // exists on this machine. Say what, and make overriding a separate,
    // deliberate second tap rather than a retry of the same button.
    if (res.status === 409) {
      body.innerHTML =
        `<p style="color:var(--accent);margin:0 0 12px">${escapeHtml(data.error)}</p>` +
        '<p class="hint" style="margin:0">Deleting now would lose that. Fix it from a chat in ' +
        'this project, or override — the folder goes away either way.</p>';
      btn.disabled = false;
      btn.textContent = 'Delete anyway, losing that work';
      btn.onclick = () => removeProjectFromMachine(true);
      return;
    }
    if (!res.ok) throw new Error(data.error || 'could not remove the project');

    closeProjectSheet();
    toast(
      force
        ? `Deleted "${project.name}" — forced, so check GitHub before relying on it.`
        : `Pushed and deleted "${project.name}".`,
      5000,
    );
    // The open chat may have been in the project that just went away.
    if (state.cwd === project.path) saveOpenChat(null);
    await refreshList();
    renderProjectPicker();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = previous;
    toast(err.message, 5000);
  }
}

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
  // Whatever was typed here and not sent before the page last went away. Safe to
  // reach the composer from here for the same reason `back()` can reach `voice`:
  // this only runs from a click or from boot(), long after the script is
  // evaluated.
  restoreDraft({ cwd, sessionId: state.sessionId });
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

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}

/*
 * Drafts survive the page going away, because the page going away is not this
 * app's decision. iOS discards a backgrounded tab and reloads it on return, the
 * editor surface reloads itself, and a phone browser can be killed for memory at
 * any time — and what was in the box was often several minutes of dictation or a
 * paragraph of code. None of that is recoverable afterwards, so it is written
 * down as it is typed.
 *
 * Scoped to the chat it was typed in, so a draft cannot reappear underneath a
 * different conversation, and dropped after a day so a forgotten one does not
 * ambush a chat months later.
 */
const DRAFT_KEY = 'claude-chat-draft';
const DRAFT_MAX_AGE = 24 * 60 * 60 * 1000;
let draftTimer = null;

function writeDraft() {
  clearTimeout(draftTimer);
  draftTimer = null;
  try {
    if (!input.value.trim()) {
      localStorage.removeItem(DRAFT_KEY);
      return;
    }
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      cwd: state.cwd,
      sessionId: state.sessionId,
      text: input.value,
      at: Date.now(),
    }));
  } catch {
    /* private mode: a draft is a safety net, not a reason to break the composer */
  }
}

// Debounced while typing — localStorage is synchronous and this is a phone — and
// flushed on the events that come immediately before the page is taken away.
function saveDraft({ now = false } = {}) {
  if (now) writeDraft();
  else if (!draftTimer) draftTimer = setTimeout(writeDraft, 400);
}

function restoreDraft({ cwd, sessionId }) {
  // Never overwrite something already in the box: back-then-into-another-chat
  // keeps the composer's contents, and that text is more current than a draft.
  if (input.value) return false;
  let draft = null;
  try {
    draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
  } catch {
    return false;
  }
  if (!draft?.text?.trim() || draft.cwd !== cwd) return false;
  if (Date.now() - (draft.at || 0) > DRAFT_MAX_AGE) return false;
  // A draft saved before the CLI had assigned a session id belongs to whichever
  // chat this directory opens next, so only a *known* mismatch is grounds to drop
  // it — otherwise the case this exists for (typed, never sent, page reloaded
  // before the first reply) is the one case it would miss.
  if (draft.sessionId && sessionId && draft.sessionId !== sessionId) return false;
  input.value = draft.text;
  autosize();
  toast('Restored the message you had not sent yet');
  return true;
}

input.addEventListener('input', () => {
  autosize();
  saveDraft();
});
// Both fire before an iOS app-switch or discard; `pagehide` also covers a
// reload, which is what the editor surface does to itself.
window.addEventListener('pagehide', () => saveDraft({ now: true }));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') saveDraft({ now: true });
});

input.addEventListener('keydown', (e) => {
  // Enter sends on desktop; Shift+Enter makes a newline. On phones the
  // on-screen keyboard's return key inserts a newline as usual.
  if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width: 760px)').matches) {
    e.preventDefault();
    sendMessage();
  }
});

// How long a send will wait for a dictation still being punctuated. Long enough
// for the pass to land (~1-2s), short enough that a tap never looks ignored.
const POLISH_WAIT_MS = 3000;
let sending = false;

async function sendMessage() {
  if (!input.value.trim() || sending) return;
  // Sending is an explicit end to dictation, so this is a normal stop: no alarm.
  if (voice.active) stopVoice();

  // A dictation still being punctuated is worth a moment: the point of that pass
  // is that what gets sent is readable, and someone who dictates a message taps
  // send the instant they stop talking. Capped, because a slow model must never
  // hold a message the user has already decided to send — and never fatal: the
  // raw transcript is in the box either way.
  if (voice.polishing) {
    sending = true;
    try {
      await Promise.race([
        voice.polishing,
        new Promise((resolve) => setTimeout(resolve, POLISH_WAIT_MS)),
      ]);
    } finally {
      sending = false;
    }
  }

  const text = input.value.trim();
  if (!text) return;
  hideDictationBar();
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
  autosize();
  // It is on its way to the server now, so the draft has done its job. Written
  // through immediately rather than debounced: a reload a moment later must not
  // put a sent message back in the box.
  saveDraft({ now: true });
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

/**
 * Which dictation engine to use.
 *
 * `stream` is the good one — audio cut at silence and transcribed phrase by
 * phrase on the box (see startStreamingDictation). It needs WebAudio and a
 * microphone, which is everything this app runs on, so the others are genuine
 * fallbacks rather than alternatives: `live` is the browser's own recognizer,
 * kept because it needs no server at all, and `record` transcribes only on stop.
 */
function pickDictationMode() {
  const hasAudio = Boolean(
    navigator.mediaDevices?.getUserMedia &&
    (window.AudioContext || window.webkitAudioContext),
  );
  if (hasAudio) return 'stream';
  return SpeechRecognition ? 'live' : 'record';
}

const voice = {
  mode: pickDictationMode(),
  active: false,
  recognition: null,
  recorder: null,
  chunks: [],
  stream: null,
  // Where the dictated text is being written, so interim results can be
  // rewritten in place as the recognizer revises them.
  anchor: 0,
  committed: '',
  startedAt: 0,
  // Set to true from the moment a start is requested until the recognizer or
  // recorder is actually running. `active` alone cannot guard the mic button:
  // starting is async (getUserMedia prompts), so a second tap in that window
  // used to open a second recorder feeding the same chunk list — which is heard
  // as the sentence being dictated twice.
  starting: false,
  // Set when dictation was taken away, so Resume continues from where it
  // stopped writing rather than from the caret. `input.selectionStart` cannot
  // answer this: it is always a number, never null, so the `??` fallback below
  // never fires, and an unfocused textarea happily reports 0 — which put resumed
  // text at the *start* of the box and pushed the earlier dictation behind it.
  // Deliberately a flag and not a position: the position is read when Resume is
  // tapped, which on the streaming path can be after further phrases have
  // landed, so a number banked at stop time would already be stale.
  resumeFromEnd: false,

  // --- streaming path (see startStreamingDictation) ---
  audioCtx: null,
  nodes: null,
  sampleRate: 16000,
  // Phrases captured but not yet transcribed, and whether the pump is running.
  queue: [],
  pumping: false,
  // The transcript so far: a concatenation of completed phrases. Unlike the
  // browser recognizer's output this is never revised, only appended to.
  finalText: '',
  // Cuts the phrase currently being captured. Set while the graph is live.
  cutPhrase: null,
  dropped: 0,
  // An interruption is announced only after the queue drains, so the banner
  // does not claim dictation ended while text is still arriving.
  pendingReason: null,
  // The cleanup pass over the finished dictation, while it is in flight. Kept on
  // `voice` rather than in a closure because sending has to wait for it: the
  // whole point is that the message goes out punctuated.
  polishing: null,
};

function setMicState(state) {
  micBtn.classList.toggle('recording', state === 'recording');
  micBtn.classList.toggle('working', state === 'working');
  $('#composer').classList.toggle('listening', state === 'recording');
}

// --- keeping the screen awake ------------------------------------------------
/**
 * The phone's display sleeps on its idle timer, and this app is used in long
 * stretches where nobody is touching the screen: dictating a paragraph, watching
 * a task run for two minutes, reading a long answer. When the display sleeps the
 * page is hidden, and hiding the page suspends the recognizer and freezes the
 * socket — so the idle timer is not a cosmetic annoyance, it ends whatever was in
 * flight. Dictation was the loudest symptom; it was never the only one.
 *
 * So the lock is held for as long as the app is open and in front, not just while
 * dictating. Three properties of the Screen Wake Lock API drive the shape of this:
 *
 *  - It needs a *visible* document. Requesting while hidden rejects.
 *  - The browser releases it automatically the moment the page is hidden, and
 *    never re-acquires it. Every return to the foreground must re-request.
 *  - The OS revokes it whenever it likes — battery saver, a low battery, policy —
 *    and there is no event that says "you may have it back". The only way to
 *    notice is to keep asking.
 *
 * Hence one `syncWakeLock()` that reconciles held against wanted, called from
 * every event that can change either, plus a slow timer for the revocation case.
 *
 * What no web API can do: keep the display on once the user leaves the app or
 * presses the power button. That is the OS's decision and the page is not
 * consulted. `alertDictationStopped()` exists for exactly that residue.
 */
const KEEP_AWAKE_KEY = 'claude-keep-awake';
// Checked on use rather than cached at load: it is one property lookup, and a
// cached answer is wrong in exactly the case that matters — a document where the
// API arrives late, which is also how the tests can reach this code at all.
const keepAwakeSupported = () => 'wakeLock' in navigator && Boolean(navigator.wakeLock);
// Deliberately its own localStorage key rather than a field in the settings blob:
// the editor overlay is the same origin and reads this too, so one switch covers
// both surfaces, and neither writer can clobber the other's keys.
let keepAwakeWanted = (() => {
  try {
    return localStorage.getItem(KEEP_AWAKE_KEY) !== '0';
  } catch {
    return true;
  }
})();

let wakeLock = null;
let wakeLockPending = false;
let wakeLockTicker = null;

function wakeLockHeld() {
  return Boolean(wakeLock);
}

/**
 * Dictation holds the screen even when the setting is off. Turning the setting
 * off means "don't burn my battery while I read", not "cut me off mid-sentence".
 */
function wantsScreenAwake() {
  return keepAwakeWanted || voice.active;
}

async function syncWakeLock() {
  if (!wantsScreenAwake() || document.visibilityState !== 'visible') {
    releaseWakeLock();
    return false;
  }
  if (wakeLock) return true;
  if (!keepAwakeSupported() || wakeLockPending) return false;

  wakeLockPending = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    // The await is not free: the page can be hidden, or the setting switched off,
    // between asking and being granted. Don't keep a lock nobody wants any more.
    if (!wantsScreenAwake() || document.visibilityState !== 'visible') {
      try { lock.release?.(); } catch { /* nothing to undo */ }
      return false;
    }
    wakeLock = lock;
    // Fires for the OS revoking it as well as for our own release. Drop the
    // handle either way, so the next sync re-requests instead of trusting a
    // dead one — and repaint, because the status bar promises the screen is held.
    lock.addEventListener?.('release', () => {
      if (wakeLock === lock) wakeLock = null;
      if (voice.active) renderListening();
    });
    if (voice.active) renderListening();
    return true;
  } catch {
    // Hidden, unsupported for this document, or refused by the OS. The periodic
    // sync will try again; a refusal now is not a refusal forever.
    return false;
  } finally {
    wakeLockPending = false;
  }
}

function releaseWakeLock() {
  const held = wakeLock;
  wakeLock = null;
  try {
    held?.release?.();
  } catch {
    /* already released */
  }
}

function setKeepAwake(on) {
  keepAwakeWanted = Boolean(on);
  try {
    localStorage.setItem(KEEP_AWAKE_KEY, keepAwakeWanted ? '1' : '0');
  } catch {
    /* private mode: the choice holds for this page's lifetime */
  }
  syncWakeLock();
}

/**
 * Re-request on everything that could plausibly restore eligibility. These are
 * cheap — `syncWakeLock` is a no-op when the lock is already held — and between
 * them they cover the cases a single hook misses: coming back to the foreground,
 * a bfcache restore, and an OS revocation that has since been lifted.
 */
function startKeepAwake() {
  document.addEventListener('visibilitychange', syncWakeLock);
  window.addEventListener('pageshow', syncWakeLock);
  window.addEventListener('focus', syncWakeLock);
  clearInterval(wakeLockTicker);
  wakeLockTicker = setInterval(syncWakeLock, 30_000);
  syncWakeLock();
}

/**
 * An AudioContext created during the mic tap — a user gesture — can still play
 * sound later without one. That is what lets the "dictation stopped" beep be
 * audible at the exact moment the user is not touching the phone.
 */
let alertCtx = null;
function primeAlertSound() {
  try {
    alertCtx = alertCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (alertCtx.state === 'suspended') alertCtx.resume();
  } catch {
    alertCtx = null;
  }
}

/** Beep and buzz: with the display off, these are the only channels left. */
function alertDictationStopped() {
  try {
    navigator.vibrate?.([140, 90, 140]);
  } catch {
    /* not supported; the beep and the banner still are */
  }
  if (!alertCtx || alertCtx.state !== 'running') return;
  try {
    const now = alertCtx.currentTime;
    const osc = alertCtx.createOscillator();
    const gain = alertCtx.createGain();
    osc.frequency.value = 660;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.3, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
    osc.connect(gain).connect(alertCtx.destination);
    osc.start(now);
    osc.stop(now + 0.45);
  } catch {
    /* audio is a nicety, not the notification of record */
  }
}

const dictationBar = $('#dictation-bar');
const dictationText = $('#dictation-text');
const dictationResume = $('#btn-dictation-resume');
const dictationDismiss = $('#btn-dictation-dismiss');
let listeningTicker = null;

function renderListening() {
  if (!voice.active) return;
  const secs = Math.max(0, Math.floor((Date.now() - voice.startedAt) / 1000));
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  // Phrases waiting on the transcriber. Shown because text arriving a beat after
  // the words are spoken is the one surprise of this dictation path, and a
  // visible backlog explains the delay instead of looking like a stall.
  const behind = voice.queue.length + (voice.pumping ? 1 : 0);
  const lag = behind ? ` · transcribing ${behind}` : '';
  // The elapsed clock is the liveness proof: a frozen number means a dead
  // recognizer, which is readable at a glance in a way a static label is not.
  dictationText.textContent = wakeLockHeld()
    ? `Listening… ${clock}${lag}`
    : `Listening… ${clock}${lag} · screen may sleep and cut this off`;
}

/**
 * Dictation has ended but its last phrases are still being transcribed. Held
 * separate from the stopped banner so the bar never claims dictation is over
 * while words are still landing in the box.
 */
function showDictationDraining(reason) {
  clearInterval(listeningTicker);
  dictationBar.className = `dictation-bar ${reason ? 'stopped' : 'listening'}`;
  dictationResume.classList.add('hidden');
  dictationDismiss.classList.add('hidden');
  dictationText.textContent = reason
    ? `Dictation stopped — ${reason}. Transcribing what was captured…`
    : 'Transcribing the last of it…';
}

function showListening() {
  dictationBar.className = 'dictation-bar listening';
  dictationResume.classList.add('hidden');
  dictationDismiss.classList.add('hidden');
  renderListening();
  clearInterval(listeningTicker);
  listeningTicker = setInterval(renderListening, 1000);
}

/** The banner the user finds when they pick the phone back up. */
function showDictationStopped(reason) {
  clearInterval(listeningTicker);
  dictationBar.className = 'dictation-bar stopped';
  dictationText.textContent = `Dictation stopped — ${reason}. What you said so far is kept.`;
  dictationResume.classList.remove('hidden');
  dictationDismiss.classList.remove('hidden');
}

function hideDictationBar() {
  clearInterval(listeningTicker);
  dictationBar.className = 'dictation-bar hidden';
  dictationResume.classList.add('hidden');
  dictationDismiss.classList.add('hidden');
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

/**
 * Where the next dictation should be written.
 *
 * Normally the caret, so dictation lands where you were typing. After an
 * interruption it is where that dictation stopped: the banner deliberately does
 * not focus the composer (the keyboard would cover it), so by the time Resume is
 * tapped the caret is not a trustworthy answer.
 */
function nextDictationAnchor() {
  const end = input.value.length;
  if (voice.resumeFromEnd) {
    voice.resumeFromEnd = false;
    return Math.min(voice.anchor + voice.committed.length, end);
  }
  return Math.min(input.selectionStart ?? end, end);
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

async function startLiveDictation() {
  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;   // this is what makes text appear while speaking
  rec.lang = navigator.language || 'en-US';

  voice.anchor = nextDictationAnchor();
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
  // Restart timestamps. A recognizer that ends the instant it starts will do so
  // forever, which reads as "dictation is on" while nothing is being heard, and
  // quietly drains the battery. Counting the restarts is how that is caught.
  let restarts = [];

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
      stopVoice({ reason: 'the microphone was blocked' });
      return;
    }
    // network / language-not-supported: use the server instead, this attempt on.
    toast('Live dictation unavailable — using server transcription.');
    voice.mode = 'record';
    stopVoice({ reason: `the recognizer failed (${event.error})` });
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
      const now = Date.now();
      restarts = [...restarts, now].filter((t) => now - t < 20_000);
      if (restarts.length > 10) {
        stopVoice({ reason: 'the recognizer would not stay running' });
        return;
      }
      try {
        rec.start();
      } catch {
        stopVoice({ reason: 'the recognizer would not restart' });
      }
    }
  };

  voice.recognition = rec;
  voice.active = true;
  voice.startedAt = Date.now();
  setMicState('recording');
  rec.start();
  // After start(), so a rejected lock does not stop dictation — it only changes
  // what the status bar promises about the screen. Usually already held, since
  // the app holds it whenever it is in front; this covers the setting being off.
  await syncWakeLock();
  if (voice.active) showListening();
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

  voice.anchor = nextDictationAnchor();
  voice.committed = '';

  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  const recorder = new MediaRecorder(voice.stream, mimeType ? { mimeType } : undefined);
  // Its own array, handed to `voice` rather than appended to a shared one: a
  // recorder that outlives its turn then fills a list nobody reads, instead of
  // interleaving a second copy of the same speech into the audio being uploaded.
  const chunks = [];
  voice.chunks = chunks;
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.onstop = transcribeRecording;
  recorder.start();

  voice.recorder = recorder;
  voice.active = true;
  voice.startedAt = Date.now();
  setMicState('recording');
  await syncWakeLock();
  if (voice.active) showListening();
}

/**
 * Stop dictating.
 *
 * `reason` is the difference between the user tapping the mic and dictation
 * being taken away from them. Without one this is a normal stop and the status
 * bar just disappears; with one, the stop gets announced — beep, buzz, and a
 * banner that stays put until it is acknowledged. Either way the dictated text
 * stays in the composer, because the recording is the only copy of it.
 */
function stopVoice({ reason = null } = {}) {
  const wasActive = voice.active;
  voice.active = false;
  // Reconcile rather than release outright: with "keep the screen awake" on, the
  // end of dictation is not a reason to let the display sleep.
  syncWakeLock();

  // Streaming: bank the phrase being spoken right now before dismantling the
  // audio graph, so the words up to an interruption are transcribed instead of
  // discarded — the same reason the recorder path stops by transcribing.
  if (voice.cutPhrase) {
    try {
      voice.cutPhrase();
    } catch {
      /* graph already gone */
    }
    teardownAudioGraph();
  }

  if (voice.recognition) {
    try {
      voice.recognition.stop();
    } catch {
      /* already stopped */
    }
    voice.recognition = null;
    // Don't pull focus on an unexpected stop: focusing the box raises the
    // keyboard, which on a phone can hide the banner explaining what happened.
    if (!reason) input.focus();
  }

  if (voice.recorder && voice.recorder.state !== 'inactive') {
    setMicState('working');
    // Stopping the recorder transcribes what it captured, so an interrupted
    // recording still yields the words spoken before the interruption.
    voice.recorder.stop();
  }

  // Phrases already captured are still being transcribed, so the mic stays in
  // its working state and the banner waits: saying "dictation stopped" while
  // words are still appearing would be its own kind of lie.
  const draining = voice.pumping || voice.queue.length > 0;
  setMicState(draining ? 'working' : 'idle');

  if (reason && wasActive) {
    // Resume should continue where this dictation stopped writing, because the
    // banner deliberately leaves the composer unfocused.
    voice.resumeFromEnd = true;
    alertDictationStopped();
    if (draining) {
      voice.pendingReason = reason;
      showDictationDraining(reason);
    } else {
      showDictationStopped(reason);
    }
  } else if (!reason) {
    voice.resumeFromEnd = false;
    if (draining) showDictationDraining(null);
    else hideDictationBar();
  }

  // Punctuate what was said, now that it is all here. Two cases are deliberately
  // not this one: phrases still in flight wait for `finishDictation`, so the pass
  // sees the whole message rather than everything up to the last sentence, and an
  // interrupted dictation is left alone because Resume continues it.
  if (wasActive && !reason && !draining) polishDictation();
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

    writeDictation(cleanTranscript(data.text || ''));
    input.focus();
    // This path has the whole recording in one transcript, so the cleanup pass
    // can start the moment it lands.
    polishDictation();
  } catch (err) {
    toast(err.message);
  } finally {
    // The cleanup pass, if one started, owns the mic state until it finishes.
    if (!voice.polishing) setMicState('idle');
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
    return wavFromSamples(resampled.getChannelData(0), targetRate);
  } finally {
    audioCtx.close();
  }
}

/**
 * 16-bit PCM mono WAV from raw samples.
 *
 * Shared by the recorder path (which decodes a container first) and the
 * streaming path (which already holds raw samples), so there is one WAV writer
 * to get right rather than two.
 */
function wavFromSamples(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);            // PCM header size
  view.setUint16(20, 1, true);             // format: PCM
  view.setUint16(22, 1, true);             // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);             // block align
  view.setUint16(34, 16, true);            // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

// --- streaming dictation: cut at silence, transcribe each phrase -------------
/**
 * The default dictation path, and the reason it exists.
 *
 * The browser's own recognizer (`SpeechRecognition`, still available below as a
 * fallback) ends its session on every natural pause and re-delivers phrases it
 * has already finalised. Keeping a running transcript therefore meant stitching
 * fragments together with a word-overlap heuristic, and every seam was a chance
 * to double or drop a word — which is what made dictation feel unreliable, and
 * what produced "let me let me" in real use. It also emits no punctuation.
 *
 * So do what a real dictation feature does: one decoder over the whole phrase.
 * Capture raw audio, watch its level, and cut only where the speaker paused.
 * Because every cut lands in silence, no word is ever split across two requests
 * and there are no seams to reconcile — the transcript is a concatenation of
 * independently-correct phrases rather than a reconstruction. Whisper also
 * punctuates and capitalises, which the browser recognizer never did.
 *
 * Cutting on silence rather than on a fixed timer is the whole trick. A 10s
 * timer would slice mid-word roughly whenever someone speaks in long sentences.
 */
const VAD = {
  // Speech/silence thresholds on frame RMS. Two levels, deliberately: rising
  // above `speech` starts a phrase, and only falling below `silence` ends one,
  // so a voice hovering at the boundary does not chop into fragments.
  speech: 0.012,
  silence: 0.006,
  // How much quiet ends a phrase. Long enough to sit through the pause between
  // words and a breath; short enough that text keeps up with the speaker.
  hangoverMs: 650,
  // Cut anyway past this, at the quietest point found, so one long unbroken
  // sentence still produces text instead of buffering to the end.
  maxPhraseMs: 14_000,
  // Below this, a "phrase" is a cough or a door. Whisper will happily invent
  // words for such things, so they are never sent.
  minPhraseMs: 320,
  frameMs: 32,
};

/** Append a transcribed phrase to the running text, spacing it sensibly. */
function joinPhrases(acc, phrase) {
  const next = phrase.trim();
  if (!next) return acc;
  if (!acc) return next;
  return `${acc.replace(/\s+$/, '')} ${next}`;
}

/**
 * Transcribe queued phrases one at a time.
 *
 * Single-flight on purpose. It bounds the load on a 2-vCPU box, and it makes
 * ordering free: phrases are appended in the order they were spoken because only
 * one request is ever outstanding. Transcription runs ~7x faster than realtime
 * here, so the queue drains while the next phrase is still being spoken.
 */
async function pumpDictationQueue() {
  if (voice.pumping) return;
  voice.pumping = true;
  try {
    while (voice.queue.length) {
      const samples = voice.queue.shift();
      renderListening();
      try {
        const form = new FormData();
        form.append('audio', wavFromSamples(samples, voice.sampleRate), 'phrase.wav');
        const res = await api('/api/transcribe', { method: 'POST', body: form });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'transcription failed');
        const phrase = cleanTranscript(data.text || '');
        if (phrase) {
          voice.finalText = joinPhrases(voice.finalText, phrase);
          writeDictation(voice.finalText);
        }
      } catch (err) {
        // A phrase the transcriber heard nothing in is not a failure: chunked
        // dictation sends it far more marginal audio than one long recording
        // does, and counting those would nag about every throat-clear.
        if (/no speech/i.test(err.message || '')) continue;
        // A real failure must not discard the rest of the dictation, and must
        // not be silent either — a gap in the text with no explanation is the
        // failure mode this whole feature exists to avoid.
        console.warn('phrase transcription failed:', err);
        voice.dropped += 1;
      }
      renderListening();
    }
  } finally {
    voice.pumping = false;
    if (!voice.active) finishDictation();
  }
}

/**
 * Whisper narrates non-speech in brackets ("[BLANK_AUDIO]", "(wind blowing)")
 * and, given near-silence, sometimes emits a stock phrase outright. Chunked
 * dictation hands it far more short and quiet segments than one long recording
 * does, so these have to be dropped here or they land in the message.
 */
function cleanTranscript(text) {
  const stripped = text
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return '';
  if (/^(you|thank you|thanks|bye|okay)[.!]?$/i.test(stripped)) return '';
  return stripped;
}

// --- making a finished dictation readable ------------------------------------
/**
 * What a consumer dictation app does that this did not.
 *
 * Everything above produces the right *words*. What it cannot produce is the
 * punctuation and the proper nouns, and those are most of what makes dictated
 * text feel finished. Neither engine here can: the browser recognizer emits no
 * punctuation at all, and whisper `base.en` sees one pause-delimited phrase at a
 * time — a few seconds of audio with no idea what the sentence or the subject
 * is. Measured against a real dictation of this app's own name: "compared to
 * ChatGPT and Gemini apps" came back as "compared to Georgia PT and Germany
 * apps", lowercase and unpunctuated throughout.
 *
 * Sentence boundaries and names need the whole utterance, so they are fixed once
 * the whole utterance exists — one bounded pass over the finished text (see
 * polish.js server-side). Three rules keep it from becoming a liability:
 *
 *  - It runs only after dictation has ended and the queue has drained, so the
 *    model sees the whole message and the user is not waiting mid-sentence.
 *  - It touches nothing if the composer changed underneath it. The request takes
 *    a second or two, and typing during that window is normal.
 *  - It never blocks or discards: the raw transcript is already in the box, and
 *    every failure path simply leaves it there.
 */
const POLISH_KEY = 'claude-polish-dictation';
// Its own localStorage key, like the wake lock, so the editor overlay — same
// origin, different surface — reads the one switch instead of a second copy.
let polishWanted = (() => {
  try {
    return localStorage.getItem(POLISH_KEY) !== '0';
  } catch {
    return true;
  }
})();

function setPolishDictation(on) {
  polishWanted = on;
  try {
    localStorage.setItem(POLISH_KEY, on ? '1' : '0');
  } catch {
    /* private mode: on for this session only */
  }
}

function showDictationPolishing() {
  clearInterval(listeningTicker);
  dictationBar.className = 'dictation-bar listening';
  dictationResume.classList.add('hidden');
  dictationDismiss.classList.add('hidden');
  dictationText.textContent = 'Punctuating what you said…';
}

/**
 * Start the cleanup pass, and publish it on `voice.polishing` so a send can wait
 * for it. Returns immediately; the promise is the only handle on it.
 */
function polishDictation() {
  const pass = runPolish();
  voice.polishing = pass;
  pass.finally(() => {
    if (voice.polishing === pass) voice.polishing = null;
  });
  return pass;
}

async function runPolish() {
  const raw = voice.committed;
  // Two words cannot be mispunctuated into anything worth a round trip.
  if (!polishWanted || raw.trim().split(/\s+/).filter(Boolean).length < 3) return;

  // The dictated span, and proof it is still the span we are about to rewrite.
  const end = voice.anchor + voice.committed.length;
  const before = input.value.slice(0, end);
  // An announced stop owns the status bar: it is the only thing telling the user
  // dictation was taken away, and it must survive this.
  const announced = dictationBar.classList.contains('stopped');

  if (!announced) showDictationPolishing();
  setMicState('working');
  try {
    const res = await api('/api/polish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: raw.trim() }),
    });
    const data = await res.json();
    // A new dictation now owns the composer, or the dictated words themselves
    // have been edited: either way the polished version is of something that is
    // no longer there. Only the span up to `end` is checked, so carrying on
    // typing after a dictation — the common case — still gets punctuated.
    if (voice.active || voice.starting) return;
    if (input.value.slice(0, end) !== before) return;
    if (res.ok && data.changed && data.text) {
      // Where the caret is relative to anything typed after the dictation. The
      // rewrite changes the length of the span in front of it, and leaving the
      // caret behind would drop the next keystroke mid-word.
      const caret = input.selectionStart ?? end;
      const tail = caret >= end ? caret - end : null;
      writeDictation(data.text);
      if (tail !== null) {
        const moved = voice.anchor + voice.committed.length + tail;
        input.setSelectionRange(moved, moved);
      }
      // Written through rather than debounced: this text arrived without anyone
      // touching the keyboard, so there may be no keystroke coming to save it.
      saveDraft({ now: true });
    }
  } catch (err) {
    // Includes the route being unreachable. The words are already in the box.
    console.warn('could not tidy up the dictation:', err);
  } finally {
    if (!voice.active && !voice.starting) {
      setMicState('idle');
      if (!announced) hideDictationBar();
    }
  }
}

/**
 * Decides where one spoken phrase ends and the next begins.
 *
 * Kept as a plain state machine, separate from the audio graph, because this is
 * the part that has to be right and the part that is impossible to eyeball: it
 * can be driven with synthetic frames in a test, which a ScriptProcessor
 * callback cannot. `push` takes a frame of samples, `flush` ends the phrase in
 * progress (used when dictation stops), and `onPhrase` receives each cut.
 *
 * Cuts land in silence, never on a timer, so no word is ever split across two
 * transcription requests — which is what removes the seams that the old
 * fragment-stitching had to guess at.
 */
function createPhraseCutter(sampleRate, onPhrase) {
  let frames = [];       // frames of the phrase being captured
  let samples = 0;
  let speaking = false;
  let quietMs = 0;
  let quietestRms = Infinity;
  let quietestAt = 0;    // frame index of the best place to cut, if forced
  const leadIn = 0.3 * sampleRate;

  function reset(rest) {
    frames = rest;
    samples = rest.reduce((n, f) => n + f.length, 0);
    speaking = false;
    quietMs = 0;
    quietestRms = Infinity;
    quietestAt = 0;
  }

  function cut(upTo) {
    const take = upTo === undefined ? frames : frames.slice(0, upTo);
    const rest = upTo === undefined ? [] : frames.slice(upTo);
    const total = take.reduce((n, f) => n + f.length, 0);
    const out = new Float32Array(total);
    let at = 0;
    for (const f of take) { out.set(f, at); at += f.length; }
    reset(rest);
    if (total) onPhrase(out);
  }

  return {
    push(frame) {
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
      const rms = Math.sqrt(sum / frame.length);
      const frameMs = (frame.length / sampleRate) * 1000;

      frames.push(frame);
      samples += frame.length;
      // Before speech starts, keep only a short run-up, so a phrase never opens
      // clipped on its first consonant but silence is not buffered forever.
      if (!speaking && samples > leadIn && rms < VAD.speech) {
        samples -= frames.shift().length;
      }

      if (rms >= VAD.speech) {
        speaking = true;
        quietMs = 0;
      } else if (speaking && rms < VAD.silence) {
        quietMs += frameMs;
        if (quietMs >= VAD.hangoverMs) {
          cut();
          return;
        }
      } else if (speaking) {
        quietMs = 0;
      }

      if (!speaking) return;
      if (rms < quietestRms) { quietestRms = rms; quietestAt = frames.length; }
      if ((samples / sampleRate) * 1000 >= VAD.maxPhraseMs) {
        // Forced cut for one long unbroken sentence: use the quietest frame seen
        // rather than the current one, which is very likely mid-word.
        cut(quietestAt > 4 ? quietestAt : undefined);
      }
    },
    // Only a phrase that actually contains speech is worth transcribing. The
    // buffer is rarely empty — a short run-up of silence is kept deliberately —
    // so `samples > 0` is not the question; `speaking` is.
    flush() {
      if (speaking) cut();
    },
  };
}

/** Hand a captured phrase to the transcriber, unless it was too short to be one. */
function enqueuePhrase(samples) {
  if (samples.length < (VAD.minPhraseMs / 1000) * voice.sampleRate) return;
  voice.queue.push(samples);
  pumpDictationQueue();
}

async function startStreamingDictation() {
  try {
    voice.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
  } catch (err) {
    toast(`Microphone blocked: ${err.message}`);
    return;
  }

  // Ask the context for 16 kHz directly, which is what Whisper wants: the
  // browser resamples on the way in and no conversion is needed per phrase.
  // Not every browser honours the hint, so the real rate is read back.
  let ctx;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  } catch {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

  voice.audioCtx = ctx;
  voice.sampleRate = ctx.sampleRate;
  voice.anchor = nextDictationAnchor();
  voice.committed = '';
  voice.finalText = '';
  voice.queue = [];
  voice.dropped = 0;

  const source = ctx.createMediaStreamSource(voice.stream);
  const frameSize = Math.max(256, 2 ** Math.round(Math.log2((VAD.frameMs / 1000) * ctx.sampleRate)));
  // ScriptProcessor is deprecated but is the only node available in every
  // browser this has to run in, and it is the *renderer* that is deprecated for
  // — reading levels off it is exactly what it is still good at.
  const node = ctx.createScriptProcessor(frameSize, 1, 1);
  const cutter = createPhraseCutter(voice.sampleRate, enqueuePhrase);

  node.onaudioprocess = (e) => {
    if (!voice.active) return;
    // Copy: the node reuses this buffer on the next callback.
    cutter.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };

  source.connect(node);
  // ScriptProcessor only runs while connected to the destination. A zero gain
  // keeps it running without playing the microphone back into the room.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination);

  voice.nodes = { source, node, mute };
  voice.cutPhrase = () => cutter.flush();

  voice.active = true;
  voice.startedAt = Date.now();
  setMicState('recording');
  await syncWakeLock();
  if (voice.active) showListening();
}

/** Tear down the audio graph. Safe to call twice. */
function teardownAudioGraph() {
  const nodes = voice.nodes;
  voice.nodes = null;
  voice.cutPhrase = null;
  try {
    if (nodes) {
      nodes.node.onaudioprocess = null;
      nodes.source.disconnect();
      nodes.node.disconnect();
      nodes.mute.disconnect();
    }
  } catch {
    /* already torn down */
  }
  voice.stream?.getTracks().forEach((t) => t.stop());
  voice.stream = null;
  const ctx = voice.audioCtx;
  voice.audioCtx = null;
  try {
    ctx?.close();
  } catch {
    /* already closed */
  }
}

/** Called once the queue has drained after a stop, to settle the UI. */
function finishDictation() {
  if (voice.active || voice.pumping) return;
  setMicState('idle');
  if (voice.dropped) {
    toast(`${voice.dropped} phrase${voice.dropped > 1 ? 's' : ''} could not be transcribed`);
    voice.dropped = 0;
  }
  if (voice.pendingReason) {
    const reason = voice.pendingReason;
    voice.pendingReason = null;
    showDictationStopped(reason);
    // No cleanup after an interruption: Resume continues this same dictation, and
    // repunctuating a sentence that is about to be continued mid-clause makes the
    // seam worse rather than better.
  } else {
    hideDictationBar();
    input.focus();
    polishDictation();
  }
}

/**
 * Begin dictating.
 *
 * Guarded against overlapping starts. Starting is asynchronous — the recording
 * path awaits `getUserMedia`, which can sit on a permission prompt — and
 * `voice.active` is only true once something is running, so a second tap in that
 * window used to start a second recorder. Both then captured the same speech
 * into the same upload, which came back transcribed twice.
 */
async function startVoice() {
  if (voice.active || voice.starting) return;
  voice.starting = true;
  hideDictationBar();
  // Must happen inside the tap: an AudioContext created from a user gesture is
  // the one that is still allowed to make a sound minutes later.
  primeAlertSound();
  try {
    if (voice.mode === 'stream') await startStreamingDictation();
    else if (voice.mode === 'live') await startLiveDictation();
    else await startRecordingDictation();
  } finally {
    voice.starting = false;
  }
}

micBtn.addEventListener('click', () => {
  if (voice.active) {
    stopVoice();
    return;
  }
  startVoice();
});

// Picks up where the interruption left off, appending at the caret, which is
// exactly where the previous session stopped writing.
dictationResume.addEventListener('click', startVoice);
// Dismissing the banner drops the interruption entirely, so the next dictation
// goes back to following the caret rather than resuming where that one stopped.
dictationDismiss.addEventListener('click', () => {
  voice.resumeFromEnd = false;
  hideDictationBar();
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

// Keeping the display on costs battery, and on a browser without the API it
// cannot be done at all. Both facts belong next to the switch rather than in a
// document nobody reads on a phone.
// Guarded, not assumed: a browser holding a stale index.html would otherwise
// throw here and take the whole script down with it, which looks like the app
// failing to boot rather than one missing checkbox. The lock itself does not
// depend on the UI existing.
const keepAwakeToggle = $('#opt-keep-awake');
const keepAwakeHint = $('#keep-awake-hint');
if (keepAwakeToggle) {
  keepAwakeToggle.checked = keepAwakeWanted;
  keepAwakeToggle.disabled = !keepAwakeSupported();
  keepAwakeToggle.addEventListener('change', (e) => {
    setKeepAwake(e.target.checked);
    toast(e.target.checked ? 'Screen will stay awake' : 'Screen may sleep when idle');
  });
}
if (keepAwakeHint) {
  keepAwakeHint.textContent = keepAwakeSupported()
    ? 'Stops the display sleeping mid-dictation or mid-task. Costs battery, and '
      + 'Android may drop it in battery saver. Also applies to the editor.'
    : 'This browser has no screen wake lock. Raise the screen timeout in Android '
      + 'Settings › Display, or turn on Developer options › Stay awake while charging.';
}

// Same guarded pattern, and the same reason for being its own switch rather than
// a settings-blob field: the editor overlay reads this key too.
const polishToggle = $('#opt-polish');
const polishHint = $('#polish-hint');
if (polishToggle) {
  polishToggle.checked = polishWanted;
  polishToggle.addEventListener('change', (e) => {
    setPolishDictation(e.target.checked);
    toast(e.target.checked ? 'Dictation will be punctuated' : 'Dictation left as transcribed');
  });
}
if (polishHint) {
  polishHint.textContent =
    'Adds punctuation and capitals and fixes misheard names once you stop talking, '
    + 'using Claude Haiku on Bedrock — a second or two, and a few tokens per '
    + 'dictation. Your words are never rewritten, and a failure leaves the '
    + 'transcript exactly as it was. Also applies to the editor.';
}

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
// The silent-dictation failure can't be reproduced from a desktop browser, so
// the test drives the interruption path directly instead.
window.__voiceForTest = {
  voice, stopVoice, startVoice, nextDictationAnchor,
  cleanTranscript, joinPhrases, enqueuePhrase, VAD, createPhraseCutter,
  // The cleanup pass and its switch: what has to be proved here is that it
  // rewrites the dictated span and nothing else, and that it gives up quietly
  // rather than pasting a stale sentence over something newly typed.
  polishDictation, setPolishDictation, sendMessage,
};
// The wake lock cannot be observed from a desktop browser either: whether the
// display sleeps is invisible to the page. The tests drive the reconciler.
// Losing a draft needs a page that goes away, which jsdom cannot do, so the test
// drives the save/restore pair directly instead.
// `state` comes along because which chat a draft belongs to is the half of this
// that can go wrong quietly.
window.__draftForTest = { saveDraft, restoreDraft, writeDraft, DRAFT_KEY, input, state };
window.__screenForTest = {
  syncWakeLock, setKeepAwake, wakeLockHeld, wantsScreenAwake,
  get wanted() { return keepAwakeWanted; },
};

// A device that wakes up may have been asleep for hours: iOS suspends timers
// and freezes sockets when the app is backgrounded, and the close event often
// never fires, so the client believes it is connected to a socket that is gone.
// On resume, verify the socket and rejoin if it died.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    // The page is going away: locked screen, app switch, another tab. Speech
    // recognition and MediaRecorder are both suspended here, so dictation is
    // over whether or not we admit it. Admitting it is the whole point — the
    // alternative is the mic button still glowing over a recognizer that has
    // been deaf for ten minutes.
    if (voice.active) stopVoice({ reason: 'the app went to the background' });
    return;
  }

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
  // Before anything else: the display should stop sleeping from the moment the
  // app is on screen, not from the moment a chat is open.
  startKeepAwake();

  const open = loadOpenChat();
  if (open?.cwd && open?.sessionId) {
    openChat({ cwd: open.cwd, title: open.title, resumeSessionId: open.sessionId });
    // Load the list behind the chat so going back is instant.
    refreshList();
    return;
  }
  refreshList();
})();
