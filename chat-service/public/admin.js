/*
 * The operations page: what is running on this box, and how to stop one of it.
 *
 * Dependency-free and separate from app.js on purpose. This is the page you open
 * when the chat is misbehaving, so it must not share a bundle with the chat — a
 * load-time error in one would otherwise take the other with it, and this is the
 * surface you would be using to find out why.
 *
 * Everything it shows comes from GET /api/admin/overview. See chat-service/admin.js
 * for where the numbers come from and why the broker is inspected from outside.
 */

const $ = (sel) => document.querySelector(sel);

// A deliberate copy of app.js's helper rather than a shared module: these pages
// load as plain scripts, and any session can expire while this one is polling. The
// failure it prevents — a dashboard showing stale rows forever after the cookie
// died — is the same one, so the handling is the same.
let redirecting = false;
async function api(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401 && !redirecting) {
    redirecting = true;
    location.replace(`/login?next=${encodeURIComponent(location.pathname)}`);
    throw new Error('not signed in');
  }
  return res;
}

function toast(message, ms = 3600) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), ms);
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const mb = (kb) => (kb == null ? '—' : kb >= 1024 ? `${(kb / 1024).toFixed(kb >= 10240 ? 0 : 1)} GB` : `${Math.round(kb)} MB`);
const rss = (kb) => (kb == null ? '—' : `${Math.round(kb / 1024)} MB`);

function duration(seconds) {
  if (seconds == null) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

/** Rendered into the same `.row` shape the chat list uses, so it reads as one app. */
function row({ title, sub, badges = [], action = null }) {
  const el = document.createElement('div');
  el.className = 'row admin-row';
  el.innerHTML = `
    <div class="row-main">
      <div class="row-title">${escapeHtml(title)}</div>
      <div class="row-sub">${sub}</div>
    </div>
    <div class="row-badges">${badges.join('')}</div>`;
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'kill-btn';
    btn.textContent = action.label;
    btn.addEventListener('click', action.onClick);
    el.appendChild(btn);
  }
  return el;
}

const badge = (text, kind = '') => `<span class="pill ${kind}">${escapeHtml(text)}</span>`;

function empty(text) {
  const el = document.createElement('div');
  el.className = 'empty small';
  el.textContent = text;
  return el;
}

/**
 * Stop something.
 *
 * The two-step is the point, not friction to be smoothed away: the server refuses
 * anything that might hold a turn in flight and says why, and that reason becomes
 * the question. `force` is only ever sent as the answer to a refusal the user has
 * actually read.
 */
async function kill(kind, target, label) {
  const send = async (force) => {
    const res = await api('/api/admin/kill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, target, force }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  try {
    const first = await send(false);
    if (first.status === 200) {
      toast(`Stopped ${label}.`);
      refresh();
      return;
    }
    if (first.status !== 409) {
      toast(first.body.error || `Server returned ${first.status}`);
      return;
    }
    // The refusal, verbatim, as the question. It names what would be lost, which
    // is the only thing that makes the answer meaningful.
    if (!confirm(`${first.body.error}\n\nStop it anyway?`)) return;
    const forced = await send(true);
    if (forced.status === 200) {
      toast(`Stopped ${label}.`);
      refresh();
    } else {
      toast(forced.body.error || `Server returned ${forced.status}`);
    }
  } catch (err) {
    if (!redirecting) toast(err.message);
  }
}

async function reap() {
  try {
    const res = await api('/api/admin/reap', { method: 'POST' });
    const { stopped, freedKb } = await res.json();
    toast(stopped ? `Stopped ${stopped} probe${stopped === 1 ? '' : 's'}, freed ${rss(freedKb)}.` : 'No probes to stop.');
    refresh();
  } catch (err) {
    if (!redirecting) toast(err.message);
  }
}

function renderFindings(findings) {
  const host = $('#findings');
  host.innerHTML = '';
  for (const f of findings) {
    const el = document.createElement('div');
    el.className = `finding ${f.level}`;
    el.innerHTML =
      `<div class="finding-text">${escapeHtml(f.text)}</div>` +
      (f.detail ? `<div class="finding-detail">${escapeHtml(f.detail)}</div>` : '');
    if (f.action === 'reap') {
      const btn = document.createElement('button');
      btn.className = 'kill-btn';
      btn.textContent = 'Reap';
      btn.addEventListener('click', reap);
      el.appendChild(btn);
    }
    host.appendChild(el);
  }
}

function renderHost(host) {
  const el = $('#host');
  const memPct = host.memory.percent ?? 0;
  const diskPct = host.disk?.percent ?? 0;
  el.innerHTML = `
    <div class="card">
      <div class="card-label">Memory</div>
      <div class="card-value">${memPct}%</div>
      <div class="meter"><span style="width:${Math.min(memPct, 100)}%" class="${memPct >= 85 ? 'hot' : ''}"></span></div>
      <div class="card-note">${mb(host.memory.totalKb - host.memory.freeKb)} of ${mb(host.memory.totalKb)}</div>
    </div>
    <div class="card">
      <div class="card-label">Disk</div>
      <div class="card-value">${host.disk ? `${diskPct}%` : '—'}</div>
      <div class="meter"><span style="width:${Math.min(diskPct, 100)}%" class="${diskPct >= 85 ? 'hot' : ''}"></span></div>
      <div class="card-note">${host.disk ? `${mb(host.disk.usedKb)} of ${mb(host.disk.totalKb)}` : 'unknown'}</div>
    </div>
    <div class="card">
      <div class="card-label">Load</div>
      <div class="card-value">${host.load[0]}</div>
      <div class="card-note">1m · 5m ${host.load[1]} · 15m ${host.load[2]}</div>
    </div>
    <div class="card">
      <div class="card-label">Uptime</div>
      <div class="card-value">${duration(host.uptimeSeconds)}</div>
      <div class="card-note">${escapeHtml(host.hostname)}</div>
    </div>`;
}

function renderUnits(units) {
  const el = $('#units');
  el.innerHTML = units
    .map(
      (u) => `
      <div class="unit ${u.active ? '' : 'down'}">
        <span class="dot"></span>
        <span class="unit-name">${escapeHtml(u.name)}</span>
        <span class="unit-state">${escapeHtml(u.active ? u.sub || 'active' : u.state)}</span>
        <span class="unit-mem">${u.memoryBytes ? rss(u.memoryBytes / 1024) : ''}</span>
      </div>`,
    )
    .join('');
}

function renderChat(sessions) {
  const el = $('#surface-chat');
  el.innerHTML = '';
  if (!sessions.length) {
    el.appendChild(empty('No chat conversations running.'));
    return;
  }
  for (const s of sessions) {
    const badges = [];
    if (s.busy) badges.push(badge('working', 'hot'));
    if (!s.alive) badges.push(badge('process gone', 'warn'));
    el.appendChild(
      row({
        title: s.project || s.cwd,
        sub:
          `${escapeHtml(s.sessionId ? `${s.sessionId.slice(0, 8)}…` : 'starting')} · ` +
          `${rss(s.rssKb)} · ${duration(s.ageSeconds)} · ${escapeHtml(s.permissionMode)}`,
        badges,
        action: { label: 'Stop', onClick: () => kill('chat', s.id, `the ${s.project} chat`) },
      }),
    );
  }
}

function renderBroker(sessions) {
  const el = $('#surface-broker');
  el.innerHTML = '';
  if (!sessions.length) {
    el.appendChild(empty('No editor conversations running.'));
    return;
  }
  // Probes last: they are noise until you want to reap them, and a live
  // conversation is what you came here to look at.
  const sorted = [...sessions].sort((a, b) => Number(a.probe) - Number(b.probe));
  for (const s of sorted) {
    const badges = [];
    if (s.probe) badges.push(badge('idle probe', 'warn'));
    // Only the broker can say either of these, and only about a process it still
    // holds. Both are absent rather than false when it could not be asked.
    if (s.working) badges.push(badge('working', 'hot'));
    if (s.clients) badges.push(badge(`${s.clients} attached`));
    el.appendChild(
      row({
        title: s.project || s.cwd || `pid ${s.pid}`,
        sub:
          `${escapeHtml(s.sessionId ? `${s.sessionId.slice(0, 8)}…` : 'no session')} · ` +
          `pid ${s.pid} · ${rss(s.rssKb)} · ${duration(s.ageSeconds)}`,
        badges,
        action: {
          label: 'Stop',
          onClick: () => kill('broker', s.pid, s.probe ? 'the probe' : `the ${s.project} panel session`),
        },
      }),
    );
  }
}

function renderTmux(sessions) {
  const el = $('#surface-tmux');
  el.innerHTML = '';
  if (!sessions.length) {
    el.appendChild(empty('No tmux sessions.'));
    return;
  }
  for (const s of sessions) {
    const badges = [];
    if (s.attachedClients) badges.push(badge(`${s.attachedClients} attached`, 'hot'));
    if (s.hasClaude) badges.push(badge('claude'));
    if (s.serverInOwnUnit === false) badges.push(badge('wrong cgroup', 'warn'));
    el.appendChild(
      row({
        title: s.project || s.name,
        sub: `${rss(s.rssKb)} · ${s.createdAt ? duration((Date.now() - s.createdAt) / 1000) : '—'} old`,
        badges,
        // Only what `cc` started. Someone's own shell on this server is shown
        // because memory is memory, but the server refuses to kill it and there is
        // no reason to offer a button that cannot work.
        action: s.isClaudeSession
          ? { label: 'End', onClick: () => kill('tmux', s.name, `the ${s.project} session`) }
          : null,
      }),
    );
  }
}

let failures = 0;

async function refresh() {
  try {
    const res = await api('/api/admin/overview');
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    const data = await res.json();
    failures = 0;

    renderFindings(data.findings);
    renderHost(data.host);
    renderUnits(data.units);
    renderChat(data.surfaces.chat);
    renderBroker(data.surfaces.broker);
    renderTmux(data.surfaces.tmux);

    const total =
      data.surfaces.chat.length + data.surfaces.broker.length + data.surfaces.tmux.length;
    $('#admin-sub').textContent = `${total} session${total === 1 ? '' : 's'} · updated ${new Date(data.generatedAt).toLocaleTimeString()}`;
    $('#admin-footer').textContent =
      'Stopping a conversation here does not delete its transcript, so it can be '
      + 'resumed from the chat list afterwards. A deploy restarts claude-chat, which '
      + 'ends every chat conversation on this page — the editor and terminal '
      + 'surfaces survive it.';
  } catch (err) {
    if (redirecting) return;
    failures += 1;
    $('#admin-sub').textContent = `couldn't load — ${err.message}`;
    // One failed poll on a phone is a tunnel, not an outage. Say so quietly, and
    // only shout once it is clearly not coming back.
    if (failures === 3) toast("Can't reach the server.");
  }
}

$('#btn-refresh').addEventListener('click', refresh);

// Polled rather than pushed. The numbers here are cheap (one `ps`, one `df`, five
// `systemctl show`) but they are not free, so this only runs while the page is
// actually being looked at — a phone in a pocket with this tab open must not keep
// waking the box.
const POLL_MS = 5000;
let timer = null;
function startPolling() {
  stopPolling();
  timer = setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, POLL_MS);
}
function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    refresh();
    startPolling();
  } else {
    stopPolling();
  }
});

// Exposed for admin-test.js, which boots this file in jsdom for the same reason
// smoke-test.js boots app.js: a runtime error at load leaves a page that looks
// like the server is down, and this is the page you would be checking.
window.__adminForTest = { refresh, kill, reap, renderFindings, duration, rss };

refresh();
startPolling();
