/**
 * The operations surface, both halves, against a box that is having a bad day.
 *
 * The fake world below is not invented: it is every failure this project has
 * actually had, running at once — three probes the editor panel forgot, two
 * processes resuming one session id, and a tmux server in the wrong cgroup. The
 * dashboard exists to name those three things, so the test is that it does.
 *
 * The server half and the client half are wired together on purpose: the payload
 * the DOM is rendered from is the real output of `overview()`, JSON round-tripped.
 * A field renamed on one side fails on the other, which is the whole point of
 * having a test rather than two hopeful readings of the same shape.
 *
 * The assertions that matter most are the refusals. This module can signal
 * processes, so what it declines to do is its security boundary: a pid from the
 * client is only ever signalled after being re-found under the parent we expect.
 *
 * Run: node chat-service/admin-test.js
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';
import { createAdmin, parseClaudeArgs } from './admin.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.PROJECTS_ROOT || '/workspace/projects';
const GB = 1024 * 1024 * 1024;

const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

/** Ran and was refused, with the reason. Anything else is a bug in the refusal. */
async function refusal(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err.blocked ? err : Promise.reject(err);
  }
}

// --- the fake box -----------------------------------------------------------

const CHAT_PID = 800;
const CODE_SERVER_PID = 600;
const STRAY_CLAUDE_PID = 700;
const BROKER_PID = 900;
const TMUX_PID = 950;

const CLAUDE = '/home/coder/.local/bin/claude --print --input-format stream-json --output-format stream-json';

function makeState() {
  return {
    processes: [
      { pid: CODE_SERVER_PID, ppid: 1, rssKb: 180_000, ageSeconds: 90_000, args: 'node /usr/lib/code-server/out/node/entry.js' },
      // A claude that is not the broker's child. Nothing about its argv says so,
      // which is exactly why parentage is what the kill path checks.
      // Launched by the editor extension, so `--resume=<id>` is JOINED. The two
      // spellings on this box are not a style choice and the fixture must carry
      // both: the extension writes `--resume=<id>` (2.1.278), chat-service writes
      // `--resume <id>` (session-manager.js). A fixture that used only the spaced
      // form is why the parser shipped reading only the spaced form, which made
      // every conversation on the box read "no session" and quietly disabled the
      // fork finding this file is mostly about.
      { pid: STRAY_CLAUDE_PID, ppid: CODE_SERVER_PID, rssKb: 205_000, ageSeconds: 400, args: `${CLAUDE} --resume=other-session --permission-mode bypassPermissions`, cwd: `${ROOT}/demo` },
      { pid: CHAT_PID, ppid: 100, rssKb: 210_000, ageSeconds: 1200, args: `${CLAUDE} --resume dup-session --permission-mode bypassPermissions`, cwd: `${ROOT}/demo` },
      { pid: BROKER_PID, ppid: 1, rssKb: 40_000, ageSeconds: 90_000, args: 'node /opt/claude-broker/broker.js' },
      // The broker's own children: one live conversation resuming the same id the
      // chat is resuming — in the other spelling, which is how the fork really
      // looks — and three probes nobody has ever spoken to.
      { pid: 901, ppid: BROKER_PID, rssKb: 208_000, ageSeconds: 900, args: `${CLAUDE} --resume=dup-session --permission-mode bypassPermissions --model us.anthropic.claude-opus-5`, cwd: `${ROOT}/demo` },
      { pid: 902, ppid: BROKER_PID, rssKb: 205_000, ageSeconds: 880, args: `${CLAUDE} --permission-mode default`, cwd: `${ROOT}/demo` },
      { pid: 903, ppid: BROKER_PID, rssKb: 204_000, ageSeconds: 500, args: `${CLAUDE} --permission-mode default`, cwd: `${ROOT}/demo` },
      { pid: 904, ppid: BROKER_PID, rssKb: 203_000, ageSeconds: 60, args: `${CLAUDE} --permission-mode default`, cwd: `${ROOT}/other` },
      { pid: TMUX_PID, ppid: 1, rssKb: 9_000, ageSeconds: 80_000, args: 'tmux -L claude new-session -d' },
      { pid: 960, ppid: TMUX_PID, rssKb: 4_000, ageSeconds: 70_000, args: '-bash' },
      { pid: 961, ppid: 960, rssKb: 206_000, ageSeconds: 69_000, args: `${CLAUDE.replace(' --print --input-format stream-json --output-format stream-json', '')}`, cwd: `${ROOT}/demo` },
      { pid: 970, ppid: TMUX_PID, rssKb: 3_500, ageSeconds: 200, args: '-bash' },
    ],
    units: {
      'claude-chat': { active: true, sub: 'running', mainPid: 100, memoryBytes: 900 * 1024 * 1024 },
      'code-server': { active: true, sub: 'running', mainPid: CODE_SERVER_PID, memoryBytes: 400 * 1024 * 1024 },
      'claude-broker': { active: true, sub: 'running', mainPid: BROKER_PID, memoryBytes: 1200 * 1024 * 1024 },
      'claude-tmux': { active: true, sub: 'running', mainPid: TMUX_PID, memoryBytes: null },
      nginx: { active: true, sub: 'running', mainPid: 300, memoryBytes: 12 * 1024 * 1024 },
    },
    tmux: [
      { name: 'claude-demo', createdAt: 1_699_930_000_000, attached: 1, panePid: 960 },
      { name: 'work', createdAt: 1_699_999_000_000, attached: 0, panePid: 970 },
    ],
    // The failure that cost real work: the server is alive, but in code-server's
    // cgroup, so the next deploy takes its sessions with it.
    cgroup: '0::/system.slice/code-server.service\n',
    disk: { totalKb: 100_000_000, usedKb: 40_000_000 },
    mem: { total: 8 * GB, free: 0.8 * GB },
    signals: [],
    killedSessions: [],
    commands: [],
  };
}

function makeDeps(state) {
  return {
    run: async (cmd, args) => {
      state.commands.push([cmd, ...args].join(' '));
      if (cmd === 'ps') {
        return {
          ok: true,
          out: state.processes
            .map((p) => `${p.pid} ${p.ppid} ${p.rssKb} ${p.ageSeconds} ${p.args}`)
            .join('\n'),
        };
      }
      if (cmd === 'systemctl') {
        const u = state.units[args[1]];
        if (!u) return { ok: false, out: '' };
        return {
          ok: true,
          out: [
            `ActiveState=${u.active ? 'active' : 'inactive'}`,
            `SubState=${u.sub}`,
            `MainPID=${u.mainPid || 0}`,
            // systemd really does print this for a unit with no accounting.
            `MemoryCurrent=${u.memoryBytes ?? '[not set]'}`,
          ].join('\n'),
        };
      }
      if (cmd === 'tmux' && args[0] === 'list-sessions') {
        if (!state.tmux.length) return { ok: false, out: '', err: 'no server running' };
        return {
          ok: true,
          out: state.tmux
            .map((s) => `${s.name}\t${Math.round(s.createdAt / 1000)}\t${s.attached}\t${s.panePid}`)
            .join('\n'),
        };
      }
      if (cmd === 'tmux' && args[0] === 'kill-session') {
        state.killedSessions.push(args[2]);
        return { ok: true, out: '' };
      }
      if (cmd === 'df') {
        return {
          ok: true,
          out: `Filesystem 1024-blocks Used Available Capacity Mounted on\n`
            + `/dev/nvme1n1 ${state.disk.totalKb} ${state.disk.usedKb} 55000000 41% ${args[1]}`,
        };
      }
      return { ok: false, out: '' };
    },
    readProcFile: async (path) => {
      if (path === `/proc/${TMUX_PID}/cgroup`) return state.cgroup;
      throw new Error('ENOENT');
    },
    readProcLink: async (path) => {
      const proc = state.processes.find((p) => p.pid === Number(path.split('/')[2]));
      if (!proc?.cwd) throw new Error('ENOENT');
      return proc.cwd;
    },
    sendSignal: (pid, signal) => state.signals.push({ pid, signal }),
    memory: () => state.mem,
    load: () => [0.42, 0.31, 0.25],
    uptime: () => 30 * 3600,
    now: () => 1_700_000_000_000,
  };
}

function makeManager(conversations) {
  return {
    inventory: () => conversations.map((c) => ({ ...c })),
    stopConversation: (id) => {
      const i = conversations.findIndex((c) => c.id === id);
      if (i < 0) return null;
      const [conv] = conversations.splice(i, 1);
      return { id: conv.id, cwd: conv.cwd, sessionId: conv.sessionId, wasBusy: conv.busy };
    },
  };
}

const conversation = (over = {}) => ({
  id: 'c1',
  cwd: `${ROOT}/demo`,
  project: 'demo',
  sessionId: 'dup-session',
  model: 'us.anthropic.claude-opus-5',
  permissionMode: 'bypassPermissions',
  effort: 'high',
  busy: false,
  exited: false,
  pid: CHAT_PID,
  lastActivity: 1_699_999_999_000,
  events: 42,
  ...over,
});

// --- 1. Reading a command line ----------------------------------------------

console.log('\nTells a probe from a conversation:');
{
  const probe = parseClaudeArgs(`${CLAUDE} --permission-mode default`);
  check('no --resume and default mode → probe', probe.probe && probe.isClaude);

  const live = parseClaudeArgs(`${CLAUDE} --resume abc --permission-mode bypassPermissions --model m`);
  check('a resumed conversation is not a probe', live.isClaude && !live.probe);
  check('reads the session id', live.resume === 'abc', live.resume);
  check('reads the model', live.model === 'm', live.model);

  // The dangerous near-miss: a real conversation whose caller left the default
  // permission mode. It has a transcript, so it must never be reapable.
  const resumedDefault = parseClaudeArgs(`${CLAUDE} --resume abc --permission-mode default`);
  check('a resumed conversation in default mode is not a probe', !resumedDefault.probe);

  /*
   * The spelling the editor actually uses, which this could not read at all.
   *
   * Real argv from the box, extension 2.1.278: `--resume=<id>` joined, and
   * `--permission-mode <mode>` spaced, in one command line. `indexOf('--resume')`
   * therefore found nothing, so every one of nine live conversations was reported
   * as "no session" — and the fork finding, which groups by this id and skips a
   * null, silently matched nothing on the page whose job is catching a fork.
   */
  const joined = parseClaudeArgs(
    `${CLAUDE} --permission-prompt-tool stdio --resume=3b86a39a-71de-42e1-b7fe-c2ebcb863a5d`
      + ' --setting-sources=user,project,local --permission-mode bypassPermissions --enable-auth-status',
  );
  check('reads a joined --resume=<id>', joined.resume === '3b86a39a-71de-42e1-b7fe-c2ebcb863a5d', joined.resume);
  check('and the spaced flags beside it', joined.permissionMode === 'bypassPermissions', joined.permissionMode);
  check('a conversation the editor resumed is not a probe', !joined.probe);

  // `--resume` with nothing after it means "pick one interactively" — the wrapper
  // has always read it that way. Taking the next token regardless made the session
  // id `--permission-mode`, which would then group two unrelated processes into a
  // fork that does not exist.
  const interactive = parseClaudeArgs(`${CLAUDE} --resume --permission-mode default`);
  check('a valueless --resume names no session', interactive.resume === null, interactive.resume);
  check('and is still a probe, as the panel’s own is', interactive.probe);

  check('the node server is not a claude', !parseClaudeArgs('node /opt/chat-service/server.js').isClaude);
  // Near-miss names are how the wrapper trap bit once already; matching is on the
  // whole token or a path ending in /claude, never a prefix.
  check('a name that merely starts with claude is not a claude', !parseClaudeArgs('claudette --print').isClaude);
  check('an absolute path to claude is a claude', parseClaudeArgs('/home/coder/.local/bin/claude -p hi').isClaude);
  check('empty argv is not a claude', !parseClaudeArgs('').isClaude);
}

// --- 2. The overview --------------------------------------------------------

console.log('\nSees what is on the box:');
const state = makeState();
const conversations = [conversation(), conversation({ id: 'c2', project: 'gone', sessionId: 'lonely', pid: 99_999, busy: true })];
const admin = createAdmin({ manager: makeManager(conversations), deps: makeDeps(state) });
const overview = await admin.overview();
{
  check('lists all five units', overview.units.length === 5, String(overview.units.length));
  check('reads unit memory', overview.units[0].memoryBytes === 900 * 1024 * 1024);
  check('[not set] memory is null, not zero', overview.units[3].memoryBytes === null);

  check('one ps for the whole page', state.commands.filter((c) => c.startsWith('ps ')).length === 1,
    state.commands.filter((c) => c.startsWith('ps ')).join(' | '));

  const { chat, broker, tmux } = overview.surfaces;
  check('finds the broker conversations', broker.length === 4, String(broker.length));
  check('three of them are probes', broker.filter((s) => s.probe).length === 3);
  // Parentage, not argv: the identical claude under code-server is not the
  // broker's and must not appear on the broker's list.
  check('a claude under another parent is not listed as the broker\'s',
    !broker.some((s) => s.pid === STRAY_CLAUDE_PID));
  check('names the project from /proc/<pid>/cwd', broker[0].project === 'demo', String(broker[0].project));
  check('reports the conversation\'s memory', broker[0].rssKb === 208_000);

  check('lists the chat\'s own conversations', chat.length === 2);
  check('costs the live one from the process table', chat[0].rssKb === 210_000 && chat[0].alive);
  // What "the chat says session ended" looks like from this side.
  check('a conversation whose process has gone reads as not alive', chat[1].alive === false);

  check('lists both tmux sessions', tmux.length === 2);
  const demo = tmux.find((s) => s.name === 'claude-demo');
  check('sums the pane tree, not just the shell', demo.rssKb === 4_000 + 206_000, String(demo.rssKb));
  check('sees the claude inside the pane', demo.hasClaude);
  check('counts attached clients', demo.attachedClients === 1);
  check('someone\'s own shell is shown but not claimed', tmux.find((s) => s.name === 'work').isClaudeSession === false);
  check('reports the tmux server\'s cgroup', demo.serverInOwnUnit === false);

  check('reads memory pressure', overview.host.memory.percent === 90, String(overview.host.memory.percent));
  check('reads disk', overview.host.disk.percent === 40, String(overview.host.disk?.percent));
}

console.log('\nSays what is wrong:');
{
  const texts = overview.findings.map((f) => f.text).join('\n');
  const find = (needle) => overview.findings.find((f) => f.text.includes(needle));

  const fork = find('resuming session');
  check('names the fork', Boolean(fork) && fork.level === 'error', texts);
  check('the fork says what it costs', fork?.detail?.includes('one transcript'));

  const probes = find('idle probe');
  check('names the probes', Boolean(probes), texts);
  check('adds up what they hold', probes?.text.includes('598 MB'), probes?.text);
  check('offers to reap them', probes?.action === 'reap');
  check('more than two probes is a warning, not a note', probes?.level === 'warn');

  const cgroup = find('claude-tmux.service');
  check('names the wrong cgroup', Boolean(cgroup) && cgroup.level === 'error', texts);
  check('says a deploy will kill those sessions', cgroup?.detail?.includes('deploy'));

  const mem = find('memory is 90%');
  check('names memory pressure', Boolean(mem) && mem.level === 'warn', texts);
  check('says what to try first', mem?.detail?.includes('reaping probes'));

  check('a healthy disk is not a finding', !overview.findings.some((f) => f.text.includes('full')));
}

console.log('\nSays what is down, and what that silently costs:');
{
  const down = makeState();
  down.units['claude-broker'] = { active: false, sub: 'dead', mainPid: 0, memoryBytes: null };
  down.units['claude-tmux'] = { active: false, sub: 'dead', mainPid: 0, memoryBytes: null };
  const quiet = createAdmin({ manager: makeManager([]), deps: makeDeps(down) });
  const view = await quiet.overview();
  const detail = (name) => view.findings.find((f) => f.text.startsWith(name))?.detail || '';

  check('a down broker is an error', view.findings.some((f) => f.text.startsWith('claude-broker') && f.level === 'error'));
  // The broker being down looks like nothing until two devices disagree, so the
  // finding has to say what it means rather than just that a dot is off.
  check('says the panel falls back to a fork per page', detail('claude-broker').includes('per page load'));
  check('says a deploy will kill the next cc\'s sessions', detail('claude-tmux').includes('deploy'));
  check('with the broker down there are no broker sessions', view.surfaces.broker.length === 0);
}

// --- 3. The refusals --------------------------------------------------------

console.log('\nRefuses to stop a chat that is mid-turn:');
{
  const busy = makeState();
  const convs = [conversation({ busy: true })];
  const a = createAdmin({ manager: makeManager(convs), deps: makeDeps(busy) });

  const blocked = await refusal(a.kill({ kind: 'chat', target: 'c1' }));
  check('a busy chat is refused', Boolean(blocked), 'it was stopped without asking');
  check('the refusal says what would be lost', blocked?.message.includes('turn in flight'), blocked?.message);
  check('and the conversation is still running', convs.length === 1);

  const forced = await a.kill({ kind: 'chat', target: 'c1', force: true });
  check('force stops it', forced.stopped && forced.wasBusy);
  check('and it is gone from the manager', convs.length === 0);

  const missing = await refusal(a.kill({ kind: 'chat', target: 'c1' }));
  check('stopping it twice is refused, not a crash', missing?.message.includes('no longer running'));
}

console.log('\nOnly signals a pid it has just re-found under the broker:');
{
  const s = makeState();
  const a = createAdmin({ manager: makeManager([conversation()]), deps: makeDeps(s) });

  // The one that matters: an identical claude, same user, same argv, different
  // parent. If parentage were not re-checked this would be a remote kill of any
  // process on the box.
  const stray = await refusal(a.kill({ kind: 'broker', target: STRAY_CLAUDE_PID }));
  check('a claude that is not the broker\'s child is refused', Boolean(stray), 'it signalled a stranger');
  check('the refusal says why', stray?.message.includes('not a broker conversation'), stray?.message);

  check('init is not a target', Boolean(await refusal(a.kill({ kind: 'broker', target: 1 }))));
  check('a pid that is not a number is not a target', Boolean(await refusal(a.kill({ kind: 'broker', target: 'all' }))));
  check('a pid that has gone is refused, not a crash',
    (await refusal(a.kill({ kind: 'broker', target: 123_456 })))?.message.includes('already gone'));
  check('the broker itself is not one of its conversations',
    Boolean(await refusal(a.kill({ kind: 'broker', target: BROKER_PID }))));
  check('nothing was signalled by any of that', s.signals.length === 0, JSON.stringify(s.signals));

  const live = await refusal(a.kill({ kind: 'broker', target: 901 }));
  check('a live panel conversation needs force', Boolean(live), 'it stopped a live conversation on one tap');
  check('the refusal names the risk', live?.message.includes('mid-turn'), live?.message);
  check('still nothing signalled', s.signals.length === 0);

  await a.kill({ kind: 'broker', target: 901, force: true });
  check('force stops it', s.signals.length === 1 && s.signals[0].pid === 901);
  check('with SIGTERM, so the broker\'s own exit handler tells the pages',
    s.signals[0].signal === 'SIGTERM', s.signals[0].signal);

  // A probe has never been spoken to, so it is the one thing that goes on one tap.
  const probe = await a.kill({ kind: 'broker', target: 902 });
  check('a probe stops without a question', probe.stopped && probe.wasProbe);
}

console.log('\nTreats a tmux session as unrecoverable, because it is:');
{
  const s = makeState();
  const a = createAdmin({ manager: makeManager([]), deps: makeDeps(s) });

  // This string reaches `tmux kill-session -t`. tmux target syntax has its own
  // sigils, and a caller-supplied name is not the place to find out which.
  for (const name of ['claude-demo; rm -rf /', 'claude-$(id)', '=claude-demo', 'claude demo', '../claude-demo']) {
    check(`refuses the name ${JSON.stringify(name)}`,
      (await refusal(a.kill({ kind: 'tmux', target: name, force: true })))?.message.includes('not a session name'));
  }
  check('refuses someone else\'s shell',
    (await refusal(a.kill({ kind: 'tmux', target: 'work', force: true })))?.message.includes('started by `cc`'));

  const unforced = await refusal(a.kill({ kind: 'tmux', target: 'claude-demo' }));
  check('a claude session still needs force', Boolean(unforced));
  check('because scrollback cannot come back', unforced?.message.includes('cannot be undone'));
  check('nothing was killed by any of that', s.killedSessions.length === 0, s.killedSessions.join(','));

  await a.kill({ kind: 'tmux', target: 'claude-demo', force: true });
  check('force ends it', s.killedSessions.join(',') === 'claude-demo', s.killedSessions.join(','));

  check('an unknown kind is refused', Boolean(await refusal(a.kill({ kind: 'everything', target: '*', force: true }))));
}

console.log('\nReaps only what has never been spoken to:');
{
  const s = makeState();
  const a = createAdmin({ manager: makeManager([conversation()]), deps: makeDeps(s) });
  const result = await a.reap();

  check('stops every probe', result.stopped === 3, String(result.stopped));
  check('reports what it freed', result.freedKb === 205_000 + 204_000 + 203_000, String(result.freedKb));
  const pids = s.signals.map((x) => x.pid).sort().join(',');
  check('and only the probes', pids === '902,903,904', pids);
  check('the live conversation survives', !s.signals.some((x) => x.pid === 901));
  check('so does a claude that is not the broker\'s', !s.signals.some((x) => x.pid === STRAY_CLAUDE_PID));

  const down = makeState();
  down.units['claude-broker'] = { active: false, sub: 'dead', mainPid: 0, memoryBytes: null };
  const quiet = createAdmin({ manager: makeManager([]), deps: makeDeps(down) });
  check('with no broker there is nothing to reap', (await quiet.reap()).stopped === 0);
  check('and nothing was signalled', down.signals.length === 0);
}

// --- 4. The page ------------------------------------------------------------
//
// Booted in jsdom for the same reason smoke-test.js boots app.js: a runtime error
// at load leaves a page that looks like the server is down, and this is the page
// you would be opening to find out whether it is.

console.log('\nThe page renders that box:');
const dom = new JSDOM(readFileSync(join(here, 'public/admin.html'), 'utf8'), {
  runScripts: 'outside-only',
  url: 'https://claude.example.com/chat/admin',
});
const w = dom.window;

// The real overview, over the wire it would actually cross.
const payload = JSON.parse(JSON.stringify(overview));
const posts = [];
let killReplies = [];
w.fetch = (url, options = {}) => {
  const path = String(url);
  if (path.includes('/api/admin/overview')) {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
  }
  if (path.includes('/api/admin/kill')) {
    posts.push({ path, body: JSON.parse(options.body || '{}') });
    const reply = killReplies.shift() || { status: 200, body: { stopped: true } };
    return Promise.resolve({ ok: reply.status === 200, status: reply.status, json: () => Promise.resolve(reply.body) });
  }
  if (path.includes('/api/admin/reap')) {
    posts.push({ path, body: null });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ stopped: 3, freedKb: 612_000 }) });
  }
  return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
};

let confirmAnswer = false;
const confirmed = [];
w.confirm = (message) => {
  confirmed.push(message);
  return confirmAnswer;
};

try {
  w.eval(readFileSync(join(here, 'public/admin.js'), 'utf8'));
} catch (err) {
  console.error(`FAIL: admin.js threw on load — ${err.constructor.name}: ${err.message}`);
  console.error(err.stack?.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}
await new Promise((resolve) => setTimeout(resolve, 50));

const $ = (sel) => w.document.querySelector(sel);
{
  check('the header stops saying loading', !$('#admin-sub').textContent.includes('loading'), $('#admin-sub').textContent);
  check('it counts the sessions', $('#admin-sub').textContent.startsWith('8 sessions'), $('#admin-sub').textContent);

  const findings = $('#findings');
  check('every finding is shown', findings.querySelectorAll('.finding').length === overview.findings.length);
  check('errors are marked as errors', findings.querySelectorAll('.finding.error').length === 2);
  check('the probes finding has its reap button', findings.querySelectorAll('.kill-btn').length === 1);

  check('four host cards', $('#host').querySelectorAll('.card').length === 4);
  check('memory is on one of them', $('#host').innerHTML.includes('90%'));
  check('a hot meter reads hot', $('#host').innerHTML.includes('class="hot"'));

  check('five service rows', $('#units').querySelectorAll('.unit').length === 5);
  check('all up, so none marked down', $('#units').querySelectorAll('.unit.down').length === 0);

  check('the chat conversations are listed', $('#surface-chat').querySelectorAll('.row').length === 2);
  check('a working chat says so', $('#surface-chat').innerHTML.includes('working'));
  check('a dead process says so', $('#surface-chat').innerHTML.includes('process gone'));

  const brokerRows = [...$('#surface-broker').querySelectorAll('.row')];
  check('the panel conversations are listed', brokerRows.length === 4);
  // The one you came to look at is the one you can see without scrolling.
  check('the live conversation sorts above the probes', !brokerRows[0].innerHTML.includes('idle probe'));
  check('probes are labelled', $('#surface-broker').querySelectorAll('.pill.warn').length === 3);

  check('the tmux sessions are listed', $('#surface-tmux').querySelectorAll('.row').length === 2);
  // No button is better than a button whose only outcome is a refusal.
  check('only the cc session offers to end', $('#surface-tmux').querySelectorAll('.kill-btn').length === 1);
  check('the wrong cgroup is called out on the row too', $('#surface-tmux').innerHTML.includes('wrong cgroup'));

  check('the footer says a deploy ends every chat here', $('#admin-footer').textContent.includes('deploy'));
  check('and that transcripts survive being stopped', $('#admin-footer').textContent.includes('transcript'));
}

console.log('\nThe page asks before forcing anything:');
{
  const kill = w.__adminForTest.kill;

  posts.length = 0;
  confirmed.length = 0;
  confirmAnswer = false;
  killReplies = [{ status: 409, body: { error: 'that chat is working right now — stopping it loses the turn in flight', canForce: true } }];
  await kill('chat', 'c1', 'the demo chat');
  check('the first attempt never sends force', posts[0]?.body.force === false, JSON.stringify(posts[0]?.body));
  // The server's reason, verbatim, as the question. Rewriting it here would be a
  // second copy of the rules, drifting from the ones actually enforced.
  check('the server\'s refusal is the question', confirmed[0]?.includes('loses the turn in flight'), confirmed[0]);
  check('answering no sends nothing more', posts.length === 1, `${posts.length} posts`);

  posts.length = 0;
  confirmed.length = 0;
  confirmAnswer = true;
  killReplies = [
    { status: 409, body: { error: 'a tmux session holds a real terminal and its scrollback — ending it cannot be undone' } },
    { status: 200, body: { stopped: true } },
  ];
  await kill('tmux', 'claude-demo', 'the demo session');
  check('answering yes retries', posts.length === 2, `${posts.length} posts`);
  check('and only then with force', posts[1]?.body.force === true, JSON.stringify(posts[1]?.body));
  check('the target does not change between the two', posts[0].body.target === posts[1].body.target);

  posts.length = 0;
  confirmed.length = 0;
  killReplies = [{ status: 500, body: { error: 'something else broke' } }];
  await kill('chat', 'c1', 'the demo chat');
  check('a non-409 failure is not turned into a force prompt', confirmed.length === 0 && posts.length === 1);
  check('and is reported', $('#toast').textContent.includes('something else broke'), $('#toast').textContent);

  posts.length = 0;
  await w.__adminForTest.reap();
  check('reaping asks nothing, because a probe holds nothing', posts.length === 1 && posts[0].path.includes('/reap'));
  check('and says what it freed', $('#toast').textContent.includes('3 probes'), $('#toast').textContent);
}

console.log('\nDoes not hand a project name to the DOM as HTML:');
{
  // cwd comes from /proc, but a project name comes from a directory a user made,
  // and this page renders one into a row title. `git clone` will happily create
  // `<img src=x onerror=...>` as a directory name.
  const nasty = JSON.parse(JSON.stringify(payload));
  nasty.surfaces.chat = [{ ...conversation({ project: '<img src=x onerror=alert(1)>' }), kind: 'chat', rssKb: 1000, ageSeconds: 5, alive: true }];
  nasty.surfaces.broker = [];
  nasty.surfaces.tmux = [];
  nasty.findings = [{ level: 'warn', text: '<b>not bold</b>', detail: '<i>nor italic</i>' }];
  w.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(nasty) });
  await w.__adminForTest.refresh();

  check('a project name is escaped in a row', !$('#surface-chat').innerHTML.includes('<img'), $('#surface-chat').innerHTML);
  check('and the text still reads correctly', $('#surface-chat').textContent.includes('<img src=x'));
  check('a finding is escaped too', !$('#findings').innerHTML.includes('<b>'));
}

dom.window.close();

if (failures.length) {
  console.error(`\nFAIL: ${failures.length} check(s) failed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  '\nPASS: the dashboard names a fork, three idle probes and a tmux server in the '
  + 'wrong cgroup; refuses to stop anything mid-turn, to signal a pid it has not '
  + 're-found under the broker, or to pass a session name to tmux unvalidated; '
  + 'reaps only probes; and the page renders it without trusting a project name.',
);
