#!/usr/bin/env node
//
// Boots the real broker against a fake `claude` and drives it over the real unix
// socket. Nothing is stubbed except the CLI itself, because the two things worth
// proving are exactly the two that a unit test with mocks would assume:
//
//   1. a second page JOINS the live process instead of starting a second one —
//      the whole point, and the bug that shipped;
//   2. the wrapper FAILS SAFE — no broker, or a refusal, still runs Claude.
//
// (2) matters more than (1). This sits in front of the user's only interface, so
// a broker that is down must degrade to today's behaviour rather than to a panel
// that will not open.
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER = path.join(HERE, 'wrapper');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-test-'));
const SOCKET = path.join(TMP, 'broker.sock');
const PIDFILE = path.join(TMP, 'starts.log');
const FAKE = path.join(TMP, 'fake-claude');

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}`);
  }
};
const section = (name) => console.log(`\n${name}`);

// A stand-in for the CLI: announces a session id like the real one does, echoes
// whatever is written to it, and records every start so the test can prove how
// many processes exist. `end-turn` makes it emit the `result` event that ends a
// turn in the real stream-json vocabulary, which is the only way the broker can
// tell "Claude is still working" from "your turn".
fs.writeFileSync(
  FAKE,
  `#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify(PIDFILE)}, process.pid + '\\n');
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'S1' }) + '\\n');
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString();
  const lines = buf.split('\\n');
  buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.trim() === 'end-turn') {
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success' }) + '\\n');
      continue;
    }
    // The same event, one byte per write, so the broker sees it split across
    // chunks. The real CLI does this whenever a flush lands mid-token.
    if (line.trim() === 'end-turn-slowly') {
      const event = JSON.stringify({ type: 'result', subtype: 'success' }) + '\\n';
      let i = 0;
      const tick = setInterval(() => {
        if (i >= event.length) { clearInterval(tick); return; }
        process.stdout.write(event[i]);
        i += 1;
      }, 2);
      continue;
    }
    process.stdout.write(JSON.stringify({ type: 'echo', got: line }) + '\\n');
  }
});
process.stdin.on('end', () => process.exit(0));
setTimeout(() => process.exit(0), 15000).unref();
`,
  { mode: 0o755 },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pids = () =>
  fs.existsSync(PIDFILE)
    ? fs.readFileSync(PIDFILE, 'utf8').trim().split('\n').filter(Boolean).map(Number)
    : [];
const starts = () => pids().length;
const lastPid = () => pids().at(-1);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const SESSION_ARGS = ['--input-format', 'stream-json', '--output-format', 'stream-json'];

/** A wrapper-shaped client: speaks the framing, collects decoded stdout. */
function connect({ resume, cwd = TMP }) {
  const sock = net.connect(SOCKET);
  const client = { sock, hello: null, out: '', frames: [] };
  let buffered = '';
  sock.on('data', (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split('\n');
    buffered = lines.pop() || '';
    for (const line of lines) {
      if (!line) continue;
      const frame = JSON.parse(line);
      if (!client.hello) {
        client.hello = frame;
        continue;
      }
      client.frames.push(frame);
      if (frame.s === 'out') client.out += Buffer.from(frame.d, 'base64').toString();
    }
  });
  return new Promise((resolve, reject) => {
    sock.on('error', reject);
    sock.on('connect', () => {
      sock.write(
        `${JSON.stringify({
          v: 1,
          cwd,
          claude: FAKE,
          args: SESSION_ARGS,
          resume,
          env: process.env,
        })}\n`,
      );
      resolve(client);
    });
  });
}

const send = (client, text) =>
  client.sock.write(
    `${JSON.stringify({ s: 'in', d: Buffer.from(text).toString('base64') })}\n`,
  );

/**
 * Ask the broker what it is running, the way chat-service/claude-status.js does.
 *
 * A reader, not a page: it must not attach to anything, must not start anything,
 * and must not be counted as a client — otherwise polling status would keep
 * conversations alive and the badge would be the thing preventing the reap.
 */
function status() {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCKET);
    let buffered = '';
    sock.on('error', reject);
    sock.on('connect', () => sock.write(`${JSON.stringify({ v: 1, op: 'status' })}\n`));
    sock.on('data', (chunk) => {
      buffered += chunk.toString();
      if (!buffered.includes('\n')) return;
      sock.destroy();
      try {
        resolve(JSON.parse(buffered.split('\n')[0]));
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Run the wrapper the way the extension does: EXEC THE FILE, letting its shebang
 * choose node, with the real claude path as the first argument and the extension's
 * own args after it.
 *
 * Spawning `node wrapper …` here instead would be a comfortable lie. That is what
 * this test used to do, and it is why a wrapper the extension could not launch at
 * all passed every check: the extension only runs the configured path under node
 * when the path looks like JavaScript, and in that branch it puts the real binary
 * BEFORE the script, so node parses the ELF and the wrapper never runs. See the
 * header of `wrapper`. Exec it exactly as the extension does, or this file proves
 * nothing about the panel.
 *
 * `holdMs` keeps stdin open, because the extension holds it open for the life of
 * the session and closing it immediately would test a case that never happens.
 */
function runWrapper(args, env, { holdMs = 300 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(WRAPPER, [FAKE, ...args], {
      cwd: TMP, // same cwd as the test's clients, so joining is possible at all
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    setTimeout(() => child.stdin.end(), holdMs);
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}

const isExecutable = (file) => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * How the extension launches the wrapper, checked before anything it does.
 *
 * These are trivial, static assertions about a filename, and they are here
 * because the panel has already been broken by exactly that: `wrapper.js` made
 * the extension run `node <real claude> wrapper.js`, node parsed the ELF, and the
 * only symptom was a SyntaxError where Claude should have been. Every behavioural
 * check below this passed throughout, because they spawned the wrapper themselves
 * instead of the way the extension does.
 */
function checkLaunchContract() {
  section('The extension can launch the wrapper:');
  // Reads are guarded rather than allowed to throw: the likeliest way to fail this
  // section is renaming the wrapper back, and an ENOENT stack trace would bury the
  // one line that says what to do about it.
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  ok(
    fs.existsSync(WRAPPER),
    'the wrapper is at claude-broker/wrapper — extensionless, as its header explains',
  );
  ok(
    !/\.(js|mjs|cjs|ts|tsx|jsx)$/.test(WRAPPER),
    'its path has no JS extension, so the extension execs it rather than running it under node',
  );
  ok(isExecutable(WRAPPER), 'it is executable, which being exec’d directly requires');
  ok(
    read(WRAPPER).startsWith('#!'),
    'and it opens with a shebang, which is what chooses node for it',
  );

  ok(
    /\bWRAPPER="\$HERE\/wrapper"/.test(read(path.join(HERE, 'install.sh'))),
    'install.sh points the editor setting at that exact file',
  );

  // Absent when this test runs from the deployed payload, which ships the broker
  // without deploy.sh.
  const deployPath = path.join(HERE, '..', 'deploy.sh');
  if (fs.existsSync(deployPath)) {
    ok(
      /claude-broker\/wrapper(?![.\w-])/.test(read(deployPath)),
      'deploy.sh puts it in the payload, so the box gets this file and not a stale one',
    );
  }
}

async function main() {
  checkLaunchContract();

  const broker = spawn(process.execPath, [path.join(HERE, 'broker.js')], {
    env: { ...process.env, CLAUDE_BROKER_SOCKET: SOCKET },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let brokerLog = '';
  broker.stdout.on('data', (d) => (brokerLog += d.toString()));
  broker.stderr.on('data', (d) => (brokerLog += d.toString()));

  for (let i = 0; i < 50 && !fs.existsSync(SOCKET); i += 1) await sleep(100);
  ok(fs.existsSync(SOCKET), 'broker is listening on its socket');

  section('One page starts a conversation:');
  const a = await connect({ resume: null });
  await sleep(600);
  ok(a.hello && a.hello.ok === true, 'the broker accepts it');
  ok(a.hello.joined === false, 'it is reported as a new conversation');
  ok(a.out.includes('"session_id":"S1"'), 'the page receives the CLI init event');
  ok(starts() === 1, 'exactly one claude was started');

  section('A second device joins the SAME live conversation:');
  const b = await connect({ resume: 'S1' });
  await sleep(600);
  ok(b.hello && b.hello.ok === true, 'the broker accepts it');
  ok(b.hello.joined === true, 'it is reported as a join, not a new conversation');
  ok(b.out.includes('"session_id":"S1"'), 'the joining page is replayed the stream so far');
  ok(starts() === 1, 'still exactly one claude — this is the fork that used to happen');

  section('Both devices drive the one process:');
  send(a, 'from-the-phone\n');
  await sleep(500);
  ok(a.out.includes('from-the-phone'), 'the sender sees the reply');
  ok(b.out.includes('from-the-phone'), 'the other device sees it too, live');
  send(b, 'from-the-laptop\n');
  await sleep(500);
  ok(a.out.includes('from-the-laptop'), 'input from either device reaches the same process');
  ok(starts() === 1, 'and it is still one process');

  section('Closing one page does not end the conversation:');
  b.sock.write(`${JSON.stringify({ s: 'detach' })}\n`);
  await sleep(400);
  send(a, 'still-here\n');
  await sleep(500);
  ok(a.out.includes('still-here'), 'the remaining device keeps working');
  ok(starts() === 1, 'no process was restarted');

  section('The wrapper fails safe:');
  const noBroker = await runWrapper(SESSION_ARGS, {
    CLAUDE_BROKER_SOCKET: path.join(TMP, 'nope.sock'),
  });
  ok(
    noBroker.out.includes('"session_id":"S1"'),
    'with no broker reachable it runs Claude directly',
  );
  ok(noBroker.code === 0, 'and exits cleanly');
  ok(starts() === 2, 'that fallback really was its own process');

  const oneShot = await runWrapper(['--version'], { CLAUDE_BROKER_SOCKET: SOCKET });
  ok(
    oneShot.out.includes('"session_id":"S1"'),
    'a one-shot invocation bypasses the broker rather than joining a conversation',
  );
  ok(starts() === 3, 'so it got its own process');

  const forked = await runWrapper([...SESSION_ARGS, '--fork-session'], {
    CLAUDE_BROKER_SOCKET: SOCKET,
  });
  ok(forked.out.includes('"session_id":"S1"'), '--fork-session is honoured, not merged');

  section('The wrapper goes through the broker when it can:');
  const startsBefore = starts();
  const viaBroker = await runWrapper([...SESSION_ARGS, '--resume=S1'], {
    CLAUDE_BROKER_SOCKET: SOCKET,
  });
  ok(
    viaBroker.out.includes('"session_id":"S1"'),
    'it joins the live conversation and is replayed it',
  );
  ok(starts() === startsBefore, 'joining started no new claude — the fork is gone');
  ok(viaBroker.code === 0, 'and the page leaving is not reported as a failure');
  await sleep(300);
  send(a, 'after-the-wrapper-left\n');
  await sleep(500);
  ok(
    a.out.includes('after-the-wrapper-left'),
    'the conversation survived that page closing',
  );

  section('It can say whether Claude is working, which nothing else can:');
  /*
   * The one fact about a conversation that is not on disk. A transcript records
   * what was said, not whether anything is still saying it — there is no turn-end
   * marker in the .jsonl at all — so a device that has just opened a conversation
   * cannot work out whether to wait for the history or simply reply. This process
   * holds the stream, so it is the only thing that knows.
   *
   * Session `a` above was written to and never answered with a `result`, which is
   * exactly what a turn in flight looks like.
   */
  const startsBeforeStatus = starts();
  const working = await status();
  const mine = (working.sessions || []).find((s) => s.cwd === TMP);
  ok(working.ok === true && Array.isArray(working.sessions), 'the broker answers a status request');
  ok(mine?.sessionId === 'S1', 'it names the conversation the way a device would ask for it');
  ok(mine?.working === true, 'a conversation that was sent a message and has not answered is working');
  ok(mine?.clients === 1, 'the page driving it is counted');
  ok(starts() === startsBeforeStatus, 'asking for status started no process');

  send(a, 'end-turn\n');
  await sleep(400);
  const idle = await status();
  const after = (idle.sessions || []).find((s) => s.cwd === TMP);
  ok(after?.working === false, 'and it is not working once the turn has ended');
  ok(after?.clients === 1, 'asking twice did not attach the reader as a page');
  // Nothing is claimed about `env`: it is the editor's whole environment, it only
  // reaches this daemon because the wrapper has to pass it through, and a status
  // reader has no business seeing it.
  ok(
    after && !('env' in after) && !('args' in after),
    'status does not hand out the environment the panel was launched with',
  );

  // A `result` arriving a byte at a time is invisible to any single chunk, and the
  // symptom of missing it is a badge stuck on "working" until the next turn ends —
  // which is precisely when nobody would think to look at this code.
  send(a, 'a-new-question\n');
  await sleep(300);
  ok(((await status()).sessions || []).find((s) => s.cwd === TMP)?.working === true,
    'a fresh message puts it back to working');
  send(a, 'end-turn-slowly\n');
  await sleep(900);
  const dribbled = ((await status()).sessions || []).find((s) => s.cwd === TMP);
  ok(dribbled?.working === false, 'a result split across chunks still ends the turn');

  section('A process nobody ever spoke to is not parked for twelve hours:');
  // The panel spawns TWO claudes per page load — a probe with no `--resume` that
  // it never writes to, then the real conversation — so this is per page load,
  // not per conversation. Ten of them were resident on the box at 205MB each.
  //
  // These use their own cwd because the fake CLI always announces the same id,
  // and re-keying a second session onto `TMP|S1` would displace the conversation
  // the section above is still using.
  const ALT = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-test-alt-'));
  const probe = await connect({ resume: null, cwd: ALT });
  await sleep(500);
  const probePid = lastPid();
  ok(probe.hello?.ok === true && alive(probePid), 'the probe runs while its page is open');
  // Destroyed rather than detached politely: a torn-down extension host is how
  // this actually happens.
  probe.sock.destroy();
  await sleep(800);
  ok(!alive(probePid), 'and is stopped when that page goes away, not held until IDLE_MS');

  const spoken = await connect({ resume: null, cwd: ALT });
  await sleep(500);
  const spokenPid = lastPid();
  send(spoken, 'a-real-first-message\n');
  await sleep(400);
  spoken.sock.destroy();
  await sleep(800);
  ok(
    alive(spokenPid),
    'but a conversation that was spoken to still outlives its last page — the point of all this',
  );
  fs.rmSync(ALT, { recursive: true, force: true });

  broker.kill('SIGTERM');
  await sleep(500);
  broker.kill('SIGKILL');

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) {
    console.log('\nbroker log:\n' + brokerLog);
    process.exit(1);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
