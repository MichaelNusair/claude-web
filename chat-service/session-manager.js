/**
 * Owns the long-lived `claude` processes.
 *
 * The key design point: one process per conversation, kept alive across
 * messages via --input-format stream-json. That's what makes the UX feel like
 * a chat app instead of a series of one-shot commands — context, cwd and
 * session id all persist, and a follow-up message costs no startup.
 */
import { spawn, execFile } from 'child_process';
import { readdir, readFile, stat, mkdir, realpath, writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { promisify } from 'util';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const execFileAsync = promisify(execFile);
const WORKSPACE_USER = process.env.WORKSPACE_USER || 'coder';

// Resolved on demand and cached: `gh` needs the token in its environment, and
// keeping it out of any file means nothing in the workspace can read it back.
let cachedGithubToken = null;
async function getGithubToken() {
  if (cachedGithubToken !== null) return cachedGithubToken;
  const arn = process.env.GITHUB_SECRET_ARN;
  if (!arn) {
    cachedGithubToken = '';
    return cachedGithubToken;
  }
  try {
    const client = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });
    const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
    cachedGithubToken = JSON.parse(res.SecretString || '{}').token || '';
  } catch {
    cachedGithubToken = '';
  }
  return cachedGithubToken;
}

const PROJECTS_ROOT = process.env.PROJECTS_ROOT || '/workspace/projects';
const CLAUDE_HOME = process.env.CLAUDE_HOME || '/workspace/claude';
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'us.anthropic.claude-opus-5';
const DEFAULT_PERMISSION_MODE = process.env.DEFAULT_PERMISSION_MODE || 'bypassPermissions';
const DEFAULT_EFFORT = process.env.DEFAULT_EFFORT || 'max';

// Claude Code stores transcripts under a path-mangled directory name:
// /workspace/projects/foo -> -workspace-projects-foo
//
// It mangles the *resolved* path, so any symlink in the path (on macOS, /tmp ->
// /private/tmp) changes the directory name. Resolve before mangling or the
// lookup silently finds nothing.
async function mangleCwd(cwd) {
  let resolved = cwd;
  try {
    resolved = await realpath(cwd);
  } catch {
    /* directory may not exist yet; fall back to the literal path */
  }
  return resolved.replace(/[/.]/g, '-');
}

/**
 * Not everything stored as a `user` turn was typed by the user. The CLI injects
 * skill loaders, interrupt markers, compaction preambles, command output and
 * system reminders through the same channel — rendering those as chat bubbles
 * shows people "messages they never sent".
 */
const SYNTHETIC_USER_PATTERNS = [
  /^\[Request interrupted/i,
  /^\[No response requested/i,
  /^Caveat: The messages below were generated/i,
  /^This session is being continued from a previous conversation/i,
  /^Base directory for this skill:/i,
  /^<(command-name|command-message|command-args|local-command|bash-input|bash-stdout|bash-stderr|system-reminder|user-prompt-submit-hook|session-start-hook|ide_selection|task-notification)/i,
  /^Your task is to create a detailed summary of the conversation/i,
  /^Please continue the conversation from where we left it off/i,
  /^\s*$/,
];

function isSyntheticUserText(text) {
  const trimmed = text.trim();
  return SYNTHETIC_USER_PATTERNS.some((re) => re.test(trimmed));
}

const PERMISSION_MODES = new Set([
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
  'manual',
]);

class Conversation extends EventEmitter {
  constructor({ id, cwd, model, permissionMode, effort, resumeSessionId }) {
    super();
    this.id = id;
    this.cwd = cwd;
    this.model = model || DEFAULT_MODEL;
    this.permissionMode = PERMISSION_MODES.has(permissionMode)
      ? permissionMode
      : DEFAULT_PERMISSION_MODE;
    this.effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)
      ? effort
      : DEFAULT_EFFORT;
    this.resumeSessionId = resumeSessionId || null;
    this.sessionId = resumeSessionId || null;
    this.proc = null;
    this.busy = false;
    this.buffer = '';
    // Replayed to a client that reconnects mid-conversation.
    this.history = [];
    // Events belonging to the turn in flight. The CLI's transcript is the
    // record of completed turns, but it lags for the turn happening right now,
    // so a device joining mid-task needs these to see the work in progress.
    this.currentTurn = [];
    // Assistant text streamed but not yet finalised, so a device that joins
    // mid-reply sees the half-written answer instead of a blank gap.
    this.partialText = '';
    this.lastActivity = Date.now();
    this.exited = false;
  }

  start() {
    const args = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--model', this.model,
      '--permission-mode', this.permissionMode,
      '--effort', this.effort,
    ];
    if (this.resumeSessionId) args.push('--resume', this.resumeSessionId);

    this.proc = spawn('claude', args, {
      cwd: this.cwd,
      env: {
        ...process.env,
        HOME: process.env.CODER_HOME || '/home/coder',
        CLAUDE_CODE_USE_BEDROCK: '1',
        ANTHROPIC_MODEL: this.model,
        TERM: 'dumb',
        // Prevent the CLI from thinking it's nested inside another agent.
        CLAUDECODE: '',
        CLAUDE_CODE_SESSION_ID: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.on('data', (chunk) => this.#onStdout(chunk));

    this.proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      // The CLI writes progress noise to stderr; only surface real errors.
      if (/error|fatal|exception/i.test(text)) {
        this.#emit({ type: 'error', message: text.slice(0, 500) });
      }
    });

    this.proc.on('exit', (code) => {
      this.exited = true;
      this.busy = false;
      this.#emit({ type: 'exit', code });
    });

    this.proc.on('error', (err) => {
      this.exited = true;
      this.busy = false;
      this.#emit({ type: 'error', message: `failed to start claude: ${err.message}` });
    });
  }

  #onStdout(chunk) {
    this.buffer += chunk.toString();
    const lines = this.buffer.split('\n');
    // Last element may be a partial line.
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue;
      }
      this.#translate(event);
    }
  }

  /**
   * Turn raw CLI events into the small vocabulary the UI needs. Doing this
   * server-side keeps the client simple and lets the wire format stay stable
   * if the CLI's event shapes change.
   */
  #translate(event) {
    this.lastActivity = Date.now();

    switch (event.type) {
      case 'system':
        if (event.subtype === 'init') {
          // A fresh session gets its id here. Register it under the manager's
          // durable key so another device can find this live process by
          // (cwd, sessionId) rather than by an id only one browser knows.
          const previous = this.sessionId;
          this.sessionId = event.session_id;
          if (previous !== event.session_id) this.emit('sessionId', this, previous);
          this.#emit({
            type: 'session',
            sessionId: event.session_id,
            model: event.model,
            cwd: event.cwd,
            permissionMode: event.permissionMode,
          });
        }
        return;

      case 'stream_event': {
        const inner = event.event;
        if (!inner) return;
        // Incremental assistant text — this is what makes replies appear live.
        if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
          this.partialText += inner.delta.text;
          this.#emit({ type: 'delta', text: inner.delta.text }, false);
        }
        if (inner.type === 'content_block_start' && inner.content_block?.type === 'thinking') {
          this.#emit({ type: 'thinking_start' }, false);
        }
        return;
      }

      case 'assistant': {
        for (const block of event.message?.content || []) {
          if (block.type === 'text' && block.text?.trim()) {
            this.#emit({ type: 'assistant_text', text: block.text });
          } else if (block.type === 'tool_use') {
            this.#emit({
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: block.input,
            });
          }
        }
        return;
      }

      case 'user': {
        // Tool results come back as synthetic user messages.
        for (const block of event.message?.content || []) {
          if (block.type === 'tool_result') {
            const content = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content);
            this.#emit({
              type: 'tool_result',
              toolUseId: block.tool_use_id,
              isError: Boolean(block.is_error),
              // Full payloads can be enormous; the UI only shows a preview.
              content: (content || '').slice(0, 4000),
            });
          }
        }
        return;
      }

      case 'result': {
        this.busy = false;
        // The turn is now in the on-disk transcript, so the live copy is no
        // longer needed to reconstruct it for a joining device.
        this.currentTurn = [];
        this.partialText = '';
        this.#emit({
          type: 'turn_complete',
          isError: Boolean(event.is_error),
          subtype: event.subtype,
          costUsd: event.total_cost_usd,
          durationMs: event.duration_ms,
          sessionId: event.session_id,
        });
        return;
      }

      default:
        return;
    }
  }

  #emit(msg, persist = true) {
    if (persist) {
      this.history.push(msg);
      // Bound memory on very long conversations.
      if (this.history.length > 2000) this.history.splice(0, 500);
      // Also accumulate into the in-flight turn, which a device joining
      // mid-task replays on top of the on-disk transcript.
      if (msg.type !== 'session') {
        this.currentTurn.push(msg);
        if (this.currentTurn.length > 400) this.currentTurn.splice(0, 100);
      }
    }
    this.emit('event', msg);
  }

  /**
   * Everything a device needs to render this conversation as it stands right
   * now: the finished turns come from the transcript, and these are the events
   * the transcript does not have yet.
   */
  liveTail() {
    return {
      events: this.currentTurn,
      partialText: this.partialText,
    };
  }

  send(text) {
    if (this.exited || !this.proc?.stdin.writable) {
      throw new Error('conversation is no longer running');
    }
    this.busy = true;
    this.lastActivity = Date.now();
    this.#emit({ type: 'user_message', text });
    this.proc.stdin.write(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      }) + '\n',
    );
  }

  interrupt() {
    if (this.proc && !this.exited) {
      // SIGINT maps to the CLI's own cancel handling.
      this.proc.kill('SIGINT');
      this.busy = false;
      this.#emit({ type: 'interrupted' });
    }
  }

  stop() {
    if (this.proc && !this.exited) this.proc.kill('SIGTERM');
  }
}

export class SessionManager {
  constructor() {
    this.conversations = new Map();
    // Live conversations keyed by `cwd|sessionId` — a name every device can
    // derive from the chat list, unlike the per-conversation UUID which only
    // the browser that created it ever knew. This is what makes picking a chat
    // up on another device attach to the running process instead of spawning a
    // second one against the same transcript.
    this.bySession = new Map();
    // Reap idle conversations so abandoned tabs don't pin processes forever.
    this.reaper = setInterval(() => this.#reap(), 60_000);
    this.reaper.unref?.();
  }

  static sessionKey(cwd, sessionId) {
    return `${cwd}|${sessionId}`;
  }

  #index(conv, previousSessionId) {
    if (previousSessionId) {
      this.bySession.delete(SessionManager.sessionKey(conv.cwd, previousSessionId));
    }
    if (conv.sessionId) {
      this.bySession.set(SessionManager.sessionKey(conv.cwd, conv.sessionId), conv);
    }
  }

  #forget(conv) {
    this.conversations.delete(conv.id);
    if (conv.sessionId) {
      const key = SessionManager.sessionKey(conv.cwd, conv.sessionId);
      if (this.bySession.get(key) === conv) this.bySession.delete(key);
    }
  }

  #reap() {
    const cutoff = Date.now() - 6 * 60 * 60 * 1000; // 6 hours idle
    for (const conv of [...this.conversations.values()]) {
      if (conv.exited || (!conv.busy && conv.lastActivity < cutoff)) {
        conv.stop();
        this.#forget(conv);
      }
    }
  }

  async listProjects() {
    await mkdir(PROJECTS_ROOT, { recursive: true });
    const entries = await readdir(PROJECTS_ROOT, { withFileTypes: true });
    const projects = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const cwd = join(PROJECTS_ROOT, entry.name);
      projects.push({
        name: entry.name,
        path: cwd,
        sessions: await this.listSessions(cwd),
      });
    }
    projects.sort((a, b) => {
      const at = a.sessions[0]?.mtime || 0;
      const bt = b.sessions[0]?.mtime || 0;
      return bt - at || a.name.localeCompare(b.name);
    });
    return projects;
  }

  /** Past conversations for a directory, newest first, with a title preview. */
  async listSessions(cwd) {
    const dir = join(CLAUDE_HOME, 'projects', await mangleCwd(cwd));
    let files;
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }

    const sessions = [];
    for (const file of files) {
      // `._*` are macOS AppleDouble metadata stubs, not real transcripts.
      if (!file.endsWith('.jsonl') || file.startsWith('._')) continue;
      const full = join(dir, file);
      try {
        const info = await stat(full);
        const sessionId = file.replace(/\.jsonl$/, '');
        const live = this.getBySession(cwd, sessionId);
        sessions.push({
          sessionId,
          mtime: info.mtimeMs,
          title: await this.#firstUserMessage(full),
          // Surfaced so the list can show a chat that is still working, and so
          // any device can tell it will be joining rather than restarting.
          live: Boolean(live),
          busy: Boolean(live?.busy),
        });
      } catch {
        /* transcript vanished mid-scan */
      }
    }
    sessions.sort((a, b) => b.mtime - a.mtime);
    return sessions.slice(0, 50);
  }

  /** Use the opening user message as the conversation title, like a chat app. */
  async #firstUserMessage(file) {
    try {
      const raw = await readFile(file, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry.type !== 'user') continue;
        const content = entry.message?.content;
        const text = typeof content === 'string'
          ? content
          : (content || []).find((b) => b.type === 'text')?.text;
        // A skill loader or resume preamble makes a useless title.
        if (text?.trim() && !isSyntheticUserText(text)) {
          const clean = text.replace(/\s+/g, ' ').trim();
          return clean.length > 70 ? `${clean.slice(0, 70)}…` : clean;
        }
      }
    } catch {
      /* unreadable transcript */
    }
    return 'Untitled conversation';
  }

  /** Read a stored transcript so a resumed chat shows its earlier messages. */
  async loadTranscript(cwd, sessionId) {
    // Both arguments come from the client, and both land in a filesystem path.
    // Reaching this requires a valid session, and a logged-in user already has a
    // shell here — so this is hygiene rather than a boundary, but an id shaped
    // like `../../../../secrets` should never have been turned into a path.
    if (!/^[A-Za-z0-9_-]+$/.test(String(sessionId))) {
      throw new Error('invalid session id');
    }
    if (!String(cwd).startsWith(PROJECTS_ROOT)) {
      throw new Error('cwd must be inside the projects root');
    }

    const file = join(CLAUDE_HOME, 'projects', await mangleCwd(cwd), `${sessionId}.jsonl`);
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return [];
    }

    const messages = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      const content = entry.message?.content;
      if (entry.type === 'user') {
        const text = typeof content === 'string'
          ? content
          : (content || []).find((b) => b.type === 'text')?.text;
        // Skip tool-result echoes; they aren't things the user typed.
        const isToolResult = Array.isArray(content) && content.some((b) => b.type === 'tool_result');
        if (text?.trim() && !isToolResult && !isSyntheticUserText(text)) {
          messages.push({ type: 'user_message', text });
        }
      } else if (entry.type === 'assistant') {
        for (const block of content || []) {
          if (block.type === 'text' && block.text?.trim()) {
            messages.push({ type: 'assistant_text', text: block.text });
          } else if (block.type === 'tool_use') {
            messages.push({
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: block.input,
            });
          }
        }
      }
    }
    return messages.slice(-400);
  }

  /**
   * Get the live conversation for a stored session, if one is still running.
   * This is the device-switching primitive: two browsers asking for the same
   * (cwd, sessionId) get the same process.
   */
  getBySession(cwd, sessionId) {
    const conv = this.bySession.get(SessionManager.sessionKey(cwd, sessionId));
    if (conv && conv.exited) {
      this.#forget(conv);
      return null;
    }
    return conv || null;
  }

  /**
   * Open a conversation. If the requested session already has a live process,
   * adopt it rather than starting a second `claude --resume` against the same
   * transcript — two processes sharing one transcript is what made a refresh or
   * a device switch land in an idle session waiting for a new command.
   */
  create({ cwd, model, permissionMode, effort, resumeSessionId }) {
    if (!cwd.startsWith(PROJECTS_ROOT)) {
      throw new Error('cwd must be inside the projects root');
    }

    if (resumeSessionId) {
      const existing = this.getBySession(cwd, resumeSessionId);
      if (existing) return existing;
    }

    const id = randomUUID();
    const conv = new Conversation({ id, cwd, model, permissionMode, effort, resumeSessionId });
    this.conversations.set(id, conv);
    // A resumed session is reachable by key immediately; a new one only once
    // the CLI reports its generated session id via `system/init`.
    this.#index(conv);
    conv.on('sessionId', (c, previous) => this.#index(c, previous));
    conv.start();
    return conv;
  }

  get(id) {
    return this.conversations.get(id);
  }

  /**
   * Create a project: a folder, a git repo, and optionally a GitHub remote.
   *
   * Everything runs as the workspace user so file ownership and git identity
   * match the rest of the tree. `gh` authenticates from the same Secrets Manager
   * token as the git credential helper, so no token is written to disk.
   *
   * Each step is reported back rather than silently skipped — a project that
   * exists locally but failed to reach GitHub is a materially different outcome
   * from a fully wired one, and the UI says which happened.
   */
  async createProject(name, { github = false, private: isPrivate = true, description = '' } = {}) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new Error('name may only contain letters, numbers, dot, dash and underscore');
    }
    if (name.startsWith('.') || name.length > 100) throw new Error('invalid project name');

    const path = join(PROJECTS_ROOT, name);
    try {
      await stat(path);
      throw new Error(`"${name}" already exists`);
    } catch (err) {
      if (!/already exists/.test(err.message) && err.code !== 'ENOENT') throw err;
      if (/already exists/.test(err.message)) throw err;
    }

    await mkdir(path, { recursive: true });
    const steps = [];

    // Seed a README so the first commit isn't empty (GitHub shows an empty repo
    // as unusable, and `gh repo create --push` needs a commit to push).
    await writeFile(
      join(path, 'README.md'),
      `# ${name}\n\n${description || 'Created from the Claude workspace.'}\n`,
      'utf8',
    );

    const run = async (cmd, args, opts = {}) => {
      const { stdout } = await execFileAsync(cmd, args, {
        cwd: path,
        timeout: 120_000,
        env: { ...process.env, ...(opts.env || {}) },
      });
      return (stdout || '').trim();
    };

    // This service already runs as the workspace user, so commands run directly.
    // Going through sudo both was unnecessary and failed outright: that account
    // is deliberately not in sudoers.
    const asUser = ([cmd, ...args], env) => run(cmd, args, { env });

    try {
      await asUser(['git', 'init', '-b', 'main']);
      await asUser(['git', 'add', '-A']);
      await asUser(['git', 'commit', '-m', 'Initial commit']);
      steps.push({ step: 'git init', ok: true });
    } catch (err) {
      steps.push({ step: 'git init', ok: false, error: err.message.slice(0, 200) });
      return { name, path, sessions: [], steps };
    }

    if (!github) return { name, path, sessions: [], steps };

    try {
      const token = await getGithubToken();
      if (!token) throw new Error('no GitHub token configured');
      const out = await asUser(
        [
          'gh', 'repo', 'create', name,
          isPrivate ? '--private' : '--public',
          '--source', '.', '--remote', 'origin', '--push',
          ...(description ? ['--description', description] : []),
        ],
        { GH_TOKEN: token, GITHUB_TOKEN: token },
      );
      const url = (out.match(/https:\/\/github\.com\/\S+/) || [])[0] || '';
      steps.push({ step: 'github', ok: true, url });
    } catch (err) {
      // The folder and local repo are already usable; surface the failure
      // instead of pretending the remote exists.
      steps.push({
        step: 'github',
        ok: false,
        error: (err.stderr || err.message || '').toString().slice(0, 300),
      });
    }

    return { name, path, sessions: [], steps };
  }
}

export { PROJECTS_ROOT, DEFAULT_MODEL };
