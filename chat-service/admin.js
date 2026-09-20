/**
 * What is actually running on this box, and how to stop one of it.
 *
 * Every hard-won note in AGENTS.md was found the same way: an SSM shell, `ps`,
 * and `journalctl`. Ten never-spoken-to probe processes at ~205 MB each, 2.0 GB of
 * 7.8 GB. Three `claude` processes against one project, two devices telling
 * different stories. A tmux server in the wrong cgroup, discovered only when a
 * deploy killed the work it was supposed to protect. None of those were visible
 * from any of the app's own surfaces, and all of them are visible from `ps`.
 *
 * So this file is that shell, on a phone. It is read-only apart from three
 * explicit kills, and it deliberately does not become a monitoring system: no
 * history, no storage, no alerting. It answers "what is running right now" and
 * "why does this box feel wrong", which are the two questions that have actually
 * come up.
 *
 * THE BROKER IS INSPECTED FROM THE OUTSIDE, ON PURPOSE. Adding a list/kill op to
 * `claude-broker/broker.js` would be the obvious way to enumerate its sessions,
 * and it would be the wrong one: the conversations are children of that process,
 * so a change to it only takes effect at a restart, and a restart ends every live
 * conversation — the exact failure the broker exists to prevent. Its children are
 * ordinary processes owned by the same user as this service, and their argv
 * already carries `--resume <session id>`, so `ps` answers the question for free
 * and today's broker needs no change at all. A SIGTERM to one of those children is
 * handled by the broker's own exit handler, which tells the attached pages and
 * unregisters the session. Keep it this way.
 *
 * Security: this adds no authority. Every route in front of it sits behind the
 * same gate as `/ws`, which already hands the caller a shell with
 * `bypassPermissions`. What it must never do is turn a caller-supplied string
 * into a signal for an arbitrary process, so a pid is only ever signalled after
 * being found in a freshly-read process table under a parent we expected.
 */
import { readFile, readlink } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';

const execFileAsync = promisify(execFile);

/** The units the deployment is made of. Order is the order they are shown in. */
const UNITS = ['claude-chat', 'code-server', 'claude-broker', 'claude-tmux', 'nginx'];

const DATA_MOUNT = process.env.PROJECTS_ROOT || '/workspace/projects';

/**
 * A refusal the UI can act on, rather than a crash. Same shape as the one
 * `session-manager.js` throws for a project removal, and for the same reason:
 * stopping a process that may hold a turn in flight is a question for the user,
 * and the honest answer has a reason attached.
 */
export class AdminBlocked extends Error {
  constructor(message, { target = null } = {}) {
    super(message);
    this.name = 'AdminBlocked';
    this.blocked = true;
    this.target = target;
  }
}

async function defaultRun(cmd, args, { timeout = 10_000 } = {}) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, out: (stdout || '').trim() };
  } catch (err) {
    return { ok: false, out: (err.stdout || '').toString().trim(), err: (err.stderr || err.message || '').toString() };
  }
}

const defaultDeps = {
  run: defaultRun,
  readProcFile: (path) => readFile(path, 'utf8'),
  readProcLink: (path) => readlink(path),
  sendSignal: (pid, signal) => process.kill(pid, signal),
  memory: () => ({ total: os.totalmem(), free: os.freemem() }),
  load: () => os.loadavg(),
  uptime: () => os.uptime(),
  now: () => Date.now(),
};

/**
 * One `ps` call for the whole box, rather than a walk of /proc per question.
 *
 * `args` goes last because it contains spaces; everything before it is a single
 * field. `etimes` is elapsed seconds, which avoids parsing a locale-formatted
 * start date only to subtract it from now again.
 */
async function processTable(deps) {
  const res = await deps.run('ps', ['-eo', 'pid=,ppid=,rss=,etimes=,args=']);
  if (!res.ok) return [];
  const rows = [];
  for (const line of res.out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 5) continue;
    const [pid, ppid, rss, etimes] = parts;
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      rssKb: Number(rss),
      ageSeconds: Number(etimes),
      args: parts.slice(4).join(' '),
    });
  }
  return rows.filter((r) => Number.isFinite(r.pid));
}

/**
 * Pull the interesting flags out of a `claude` command line.
 *
 * The probe classification is the one that earns this function. The extension
 * starts two processes per page load and only ever speaks to one: the other is a
 * probe with `--permission-mode default` and no `--resume`, which it never writes
 * a byte to. Through the broker each of those became a resident process that
 * nothing could name — ten of them, 2.0 GB. From outside, argv is exactly what
 * tells them apart, and being able to name them is what makes them reapable.
 */
export function parseClaudeArgs(args) {
  const tokens = String(args || '').split(/\s+/);
  /*
   * Both spellings of every flag, because the choice is not ours to make and it
   * is not even consistent within one command line: extension 2.1.278 launches
   * `--resume=<id>` joined and `--permission-mode <mode>` spaced, in the same
   * argv. Reading only the spaced form meant `resume` was ALWAYS null, so every
   * conversation on the box read "no session" — and, far worse, the fork finding
   * below groups by this id and therefore silently matched nothing, on the one
   * page that exists to catch a fork. Measured before this fix: 9 live broker
   * children, 8 of them nameable from argv, 0 named.
   *
   * `claude-broker/wrapper` has read both spellings since it shipped; this is
   * the same rule, and the two must not disagree about what is being resumed.
   */
  const valueOf = (flag) => {
    const joined = tokens.find((t) => t.startsWith(`${flag}=`));
    if (joined !== undefined) return joined.slice(flag.length + 1) || null;
    const i = tokens.indexOf(flag);
    if (i < 0) return null;
    const next = tokens[i + 1];
    // A flag with no value: `--resume` alone means "pick one interactively",
    // which names no session. Taking the next token regardless turned that into
    // a session id of `--permission-mode`.
    return next !== undefined && !next.startsWith('-') ? next : null;
  };
  const isClaude = tokens.some((t) => t === 'claude' || t.endsWith('/claude'));
  const resume = valueOf('--resume');
  const permissionMode = valueOf('--permission-mode');
  return {
    isClaude,
    resume,
    permissionMode,
    model: valueOf('--model'),
    // No conversation to resume and the default permission mode: the panel's
    // probe. A real conversation either resumes an id or was started with this
    // deployment's own permission mode, which is never `default`.
    probe: isClaude && !resume && permissionMode === 'default',
  };
}

/** `systemctl show` for one unit. Read-only, and needs no privilege. */
async function unitState(deps, name) {
  const res = await deps.run('systemctl', [
    'show', name,
    '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID', '-p', 'MemoryCurrent',
  ]);
  const fields = {};
  for (const line of (res.out || '').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) fields[line.slice(0, eq)] = line.slice(eq + 1);
  }
  const memory = Number(fields.MemoryCurrent);
  return {
    name,
    active: fields.ActiveState === 'active',
    state: fields.ActiveState || 'unknown',
    sub: fields.SubState || '',
    mainPid: Number(fields.MainPID) || null,
    // systemd reports `[not set]` for a unit with no accounting, which is not 0.
    memoryBytes: Number.isFinite(memory) && memory > 0 ? memory : null,
  };
}

/** Where a process's working directory is, or null when it has gone away. */
async function cwdOf(deps, pid) {
  try {
    return await deps.readProcLink(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

const projectOf = (cwd) =>
  cwd && cwd.startsWith(`${DATA_MOUNT}/`) ? cwd.slice(DATA_MOUNT.length + 1) : cwd || null;

/**
 * The editor panel's conversations: children of the broker, one per conversation,
 * named by the `--resume` id in their own argv.
 */
async function brokerSessions(deps, table, brokerPid) {
  if (!brokerPid) return [];
  const out = [];
  for (const proc of table) {
    if (proc.ppid !== brokerPid) continue;
    const parsed = parseClaudeArgs(proc.args);
    if (!parsed.isClaude) continue;
    const cwd = await cwdOf(deps, proc.pid);
    out.push({
      kind: 'broker',
      pid: proc.pid,
      sessionId: parsed.resume,
      cwd,
      project: projectOf(cwd),
      model: parsed.model,
      permissionMode: parsed.permissionMode,
      probe: parsed.probe,
      rssKb: proc.rssKb,
      ageSeconds: proc.ageSeconds,
    });
  }
  return out;
}

/**
 * The tmux surface. `cc` names its sessions `claude-<project>`, and anything else
 * on this server is someone's own shell — shown, because a stray session holding
 * memory is exactly the sort of thing this page is for, but never offered as a
 * Claude session.
 */
async function tmuxSessions(deps, table, tmuxServerPid) {
  const res = await deps.run('tmux', [
    'list-sessions', '-F', '#{session_name}\t#{session_created}\t#{session_attached}\t#{pane_pid}',
  ]);
  // A server with no sessions exits non-zero with "no server running"; that is an
  // answer, not a failure.
  if (!res.ok) return [];

  const byPid = new Map(table.map((p) => [p.pid, p]));
  const sessions = [];
  for (const line of res.out.split('\n')) {
    if (!line.trim()) continue;
    const [name, created, attached, panePid] = line.split('\t');
    const pid = Number(panePid);
    // Everything the pane forked, so the reported memory is the shell *and* the
    // Claude inside it rather than the shell alone.
    const tree = [byPid.get(pid), ...table.filter((p) => p.ppid === pid)].filter(Boolean);
    sessions.push({
      kind: 'tmux',
      name,
      project: name.startsWith('claude-') ? name.slice('claude-'.length) : null,
      isClaudeSession: name.startsWith('claude-'),
      attachedClients: Number(attached) || 0,
      createdAt: Number(created) * 1000 || null,
      pid: Number.isFinite(pid) ? pid : null,
      rssKb: tree.reduce((sum, p) => sum + p.rssKb, 0),
      hasClaude: tree.some((p) => parseClaudeArgs(p.args).isClaude),
    });
  }
  // The durability of every one of these depends on the server's cgroup, so it is
  // reported alongside them rather than left to be discovered by a deploy.
  const cgroup = tmuxServerPid ? await readCgroup(deps, tmuxServerPid) : null;
  for (const session of sessions) session.serverInOwnUnit = cgroup === null ? null : cgroup.includes('claude-tmux');
  return sessions;
}

async function readCgroup(deps, pid) {
  try {
    return await deps.readProcFile(`/proc/${pid}/cgroup`);
  } catch {
    return null;
  }
}

async function diskUsage(deps, path) {
  const res = await deps.run('df', ['-kP', path]);
  if (!res.ok) return null;
  const line = res.out.split('\n').slice(1)[0];
  if (!line) return null;
  const parts = line.trim().split(/\s+/);
  const totalKb = Number(parts[1]);
  const usedKb = Number(parts[2]);
  if (!Number.isFinite(totalKb) || !Number.isFinite(usedKb)) return null;
  return { path, totalKb, usedKb, percent: totalKb ? Math.round((usedKb / totalKb) * 100) : null };
}

/**
 * The findings. This is the part worth having: each one is a failure this project
 * has already had, phrased as the thing you would want to be told.
 */
function findings({ units, chat, broker, tmux, memory, disk }) {
  const out = [];
  const unit = (name) => units.find((u) => u.name === name);

  for (const name of UNITS) {
    const u = unit(name);
    if (u && !u.active) {
      out.push({
        level: 'error',
        text: `${name} is ${u.state}${u.sub ? ` (${u.sub})` : ''}`,
        // The broker being down is not a visible failure — it is a silent
        // regression to one Claude per browser page, which is why it is called out
        // rather than left to be inferred from a dot.
        detail: name === 'claude-broker'
          ? 'the editor panel forks a separate Claude per page load while this is down'
          : name === 'claude-tmux'
            ? 'the next `cc` will start a tmux server inside code-server, and a deploy will kill its sessions'
            : null,
      });
    }
  }

  // The fork. Two processes resuming one session id, both appending to one
  // transcript — what the user sees is two devices telling different stories, and
  // until now the only way to find it was to count processes by hand on the box.
  const byResume = new Map();
  for (const proc of [...broker, ...chat]) {
    if (!proc.sessionId) continue;
    const list = byResume.get(proc.sessionId) || [];
    list.push(proc);
    byResume.set(proc.sessionId, list);
  }
  for (const [sessionId, procs] of byResume) {
    if (procs.length < 2) continue;
    out.push({
      level: 'error',
      text: `${procs.length} processes are resuming session ${sessionId.slice(0, 8)}…`,
      detail: 'they append to one transcript and will diverge; stop all but the one you are using',
    });
  }

  const probes = broker.filter((s) => s.probe);
  if (probes.length) {
    const mb = Math.round(probes.reduce((sum, p) => sum + p.rssKb, 0) / 1024);
    out.push({
      level: probes.length > 2 ? 'warn' : 'info',
      text: `${probes.length} idle probe${probes.length === 1 ? '' : 's'} holding ${mb} MB`,
      detail: 'the editor panel starts one per page load and never speaks to it; safe to reap',
      action: 'reap',
    });
  }

  const strayTmux = tmux.find((s) => s.serverInOwnUnit === false);
  if (strayTmux) {
    out.push({
      level: 'error',
      text: 'the tmux server is not claude-tmux.service',
      detail: 'its sessions are in code-server\'s cgroup, so the next deploy will kill them',
    });
  }

  if (memory.percent >= 85) {
    out.push({
      level: memory.percent >= 93 ? 'error' : 'warn',
      text: `memory is ${memory.percent}% used`,
      detail: 'each Claude holds ~200 MB; reaping probes is the cheapest thing to try first',
    });
  }
  if (disk && disk.percent >= 85) {
    out.push({ level: disk.percent >= 93 ? 'error' : 'warn', text: `${disk.path} is ${disk.percent}% full` });
  }

  return out;
}

export function createAdmin({ manager, deps: overrides = {} } = {}) {
  const deps = { ...defaultDeps, ...overrides };

  /** Everything the dashboard shows, in one round trip. */
  async function overview() {
    const [table, units] = await Promise.all([
      processTable(deps),
      Promise.all(UNITS.map((name) => unitState(deps, name))),
    ]);
    const brokerUnit = units.find((u) => u.name === 'claude-broker');
    const tmuxUnit = units.find((u) => u.name === 'claude-tmux');

    const byPid = new Map(table.map((p) => [p.pid, p]));
    // The chat's own conversations come from memory — this service owns them — and
    // are enriched from the table, because how much a conversation costs is a
    // question only the OS can answer.
    const chat = (manager?.inventory() || []).map((conv) => {
      const proc = conv.pid ? byPid.get(conv.pid) : null;
      return {
        kind: 'chat',
        ...conv,
        rssKb: proc?.rssKb ?? null,
        ageSeconds: proc?.ageSeconds ?? null,
        // A conversation whose process has gone is a row worth seeing: it is what
        // "the chat says session ended" looks like from this side.
        alive: Boolean(proc),
      };
    });

    const [broker, tmux, disk] = await Promise.all([
      brokerSessions(deps, table, brokerUnit?.mainPid || null),
      tmuxSessions(deps, table, tmuxUnit?.mainPid || null),
      diskUsage(deps, DATA_MOUNT),
    ]);

    const mem = deps.memory();
    const memory = {
      totalKb: Math.round(mem.total / 1024),
      freeKb: Math.round(mem.free / 1024),
      percent: mem.total ? Math.round(((mem.total - mem.free) / mem.total) * 100) : null,
    };

    return {
      generatedAt: deps.now(),
      host: {
        hostname: os.hostname(),
        uptimeSeconds: Math.round(deps.uptime()),
        load: deps.load().map((n) => Math.round(n * 100) / 100),
        memory,
        disk,
      },
      units,
      surfaces: { chat, broker, tmux },
      findings: findings({ units, chat, broker, tmux, memory, disk }),
    };
  }

  /**
   * Stop one thing.
   *
   * The refusals are the design. Everything here may hold a turn in flight, and a
   * killed turn is not recoverable — so anything that could be live comes back as
   * a refusal carrying the reason, and `force` is the answer to that specific
   * question rather than a flag the client sets by habit. Only a probe, which by
   * definition has never been spoken to, goes on one tap.
   */
  async function kill({ kind, target, force = false } = {}) {
    if (kind === 'chat') {
      const conv = (manager?.inventory() || []).find((c) => c.id === target);
      if (!conv) throw new AdminBlocked('that conversation is no longer running', { target });
      if (conv.busy && !force) {
        throw new AdminBlocked(
          'that chat is working right now — stopping it loses the turn in flight',
          { target },
        );
      }
      const stopped = manager.stopConversation(target);
      return { stopped: Boolean(stopped), kind, target, wasBusy: Boolean(stopped?.wasBusy) };
    }

    if (kind === 'broker') {
      const pid = Number(target);
      if (!Number.isInteger(pid) || pid <= 1) throw new AdminBlocked('not a pid', { target });
      // Re-read the table and re-check the parent. A pid from the client is a
      // number, and the process wearing it now may not be the one the page was
      // looking at when it rendered — so membership is proved again here, against
      // the broker we expect, immediately before the signal.
      const [table, unit] = await Promise.all([processTable(deps), unitState(deps, 'claude-broker')]);
      const proc = table.find((p) => p.pid === pid);
      if (!proc) throw new AdminBlocked('that process has already gone', { target });
      if (!unit.mainPid || proc.ppid !== unit.mainPid) {
        throw new AdminBlocked('that pid is not a broker conversation', { target });
      }
      const parsed = parseClaudeArgs(proc.args);
      if (!parsed.isClaude) throw new AdminBlocked('that pid is not a claude process', { target });
      if (!parsed.probe && !force) {
        throw new AdminBlocked(
          'that is a live conversation — a device may be mid-turn in it',
          { target },
        );
      }
      deps.sendSignal(pid, 'SIGTERM');
      return { stopped: true, kind, target: pid, wasProbe: parsed.probe };
    }

    if (kind === 'tmux') {
      const name = String(target || '');
      // Goes to `tmux kill-session -t`, so it is validated rather than trusted:
      // tmux target syntax has its own sigils, and a name is not a place to find
      // out which ones.
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new AdminBlocked('not a session name', { target });
      if (!name.startsWith('claude-')) {
        throw new AdminBlocked('only sessions started by `cc` can be stopped here', { target });
      }
      if (!force) {
        throw new AdminBlocked(
          'a tmux session holds a real terminal and its scrollback — ending it cannot be undone',
          { target },
        );
      }
      const res = await deps.run('tmux', ['kill-session', '-t', name]);
      if (!res.ok) throw new AdminBlocked(`tmux refused: ${(res.err || '').slice(0, 200)}`, { target });
      return { stopped: true, kind, target: name };
    }

    throw new AdminBlocked(`unknown target kind "${kind}"`, { target });
  }

  /**
   * Stop every probe the broker is holding.
   *
   * The one-tap answer to the 2.0 GB story. Safe because a probe has never been
   * written to — no conversation, no transcript, nothing in flight — and because
   * the classification comes from argv rather than from a guess about age or size.
   */
  async function reap() {
    const [table, unit] = await Promise.all([processTable(deps), unitState(deps, 'claude-broker')]);
    if (!unit.mainPid) return { stopped: 0, freedKb: 0 };
    let stopped = 0;
    let freedKb = 0;
    for (const proc of table) {
      if (proc.ppid !== unit.mainPid) continue;
      if (!parseClaudeArgs(proc.args).probe) continue;
      try {
        deps.sendSignal(proc.pid, 'SIGTERM');
        stopped += 1;
        freedKb += proc.rssKb;
      } catch {
        /* it exited between the table and the signal, which is the outcome anyway */
      }
    }
    return { stopped, freedKb };
  }

  return { overview, kill, reap };
}
