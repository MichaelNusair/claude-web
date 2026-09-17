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
// many processes exist.
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
    if (line.trim()) process.stdout.write(JSON.stringify({ type: 'echo', got: line }) + '\\n');
  }
});
process.stdin.on('end', () => process.exit(0));
setTimeout(() => process.exit(0), 15000).unref();
`,
  { mode: 0o755 },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const starts = () =>
  fs.existsSync(PIDFILE)
    ? fs.readFileSync(PIDFILE, 'utf8').trim().split('\n').filter(Boolean).length
    : 0;

const SESSION_ARGS = ['--input-format', 'stream-json', '--output-format', 'stream-json'];

/** A wrapper-shaped client: speaks the framing, collects decoded stdout. */
function connect({ resume }) {
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
          cwd: TMP,
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
 * Run the wrapper the way the extension does: real claude path as the first
 * argument, then the extension's own args. `holdMs` keeps stdin open, because the
 * extension holds it open for the life of the session and closing it immediately
 * would test a case that never happens.
 */
function runWrapper(args, env, { holdMs = 300 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, 'wrapper.js'), FAKE, ...args], {
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

async function main() {
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
