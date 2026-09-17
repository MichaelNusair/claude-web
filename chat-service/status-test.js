/**
 * What a device is told when it opens a conversation, and where each part came from.
 *
 * This exists because the two halves of the answer have different failure modes and
 * only one of them is trustworthy. "Is Claude working" is knowledge held by
 * claude-broker, which owns the process; the transcript can only show the state a
 * conversation was *left* in, which reads as "working" forever once a process dies
 * mid-turn. Conflating those would put "Claude is working…" over the editor of a
 * conversation that will never answer.
 *
 * The reading itself is the other half: it must find the newest message without
 * reading the transcript, because reading the transcript is precisely what the
 * panel already does and precisely why there is a wait to fix.
 *
 * Run: node chat-service/status-test.js
 */
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
const PROJECTS = path.join(TMP, 'projects');
const CWD = path.join(PROJECTS, 'demo');
const CLAUDE_HOME = path.join(TMP, 'claude');
const SOCKET = path.join(TMP, 'broker.sock');
// The transcript directory name Claude Code derives from a path: separators and
// dots become dashes. Built the same way here rather than imported, so a change to
// that mangling shows up as a failure instead of agreeing with itself.
const PROJECT_DIR = path.join(CLAUDE_HOME, 'projects', CWD.replace(/[/.]/g, '-'));

fs.mkdirSync(CWD, { recursive: true });
fs.mkdirSync(PROJECT_DIR, { recursive: true });

// Read at import time by session-manager.js, so they have to be set before it
// loads — which is why this file imports dynamically below.
process.env.PROJECTS_ROOT = PROJECTS;
process.env.CLAUDE_HOME = CLAUDE_HOME;
process.env.CLAUDE_BROKER_SOCKET = SOCKET;

const { claudeStatus } = await import('./claude-status.js');

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

const SESSION = 'a1b2c3d4-0000-4000-8000-000000000000';
const TRANSCRIPT = path.join(PROJECT_DIR, `${SESSION}.jsonl`);

const assistant = (text, stop = 'end_turn') =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }] },
  });
const userText = (text) =>
  JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: text } });
const toolResult = (size) =>
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', content: 'x'.repeat(size) }] },
  });

const write = (...lines) => fs.writeFileSync(TRANSCRIPT, `${lines.join('\n')}\n`);

/*
 * A broker whose answer this test chooses.
 *
 * `brokerReply` is what it says; 'silent' accepts the connection and never answers,
 * which is the wedged-broker case — the one where a status request must give up on
 * its own rather than holding an HTTP response open.
 */
let brokerReply = null;
const broker = net.createServer((sock) => {
  sock.on('error', () => {});
  sock.on('data', () => {
    if (brokerReply === 'silent') return;
    sock.write(`${JSON.stringify(brokerReply)}\n`);
    sock.end();
  });
});
await new Promise((resolve) => broker.listen(SOCKET, resolve));

const liveSession = (over = {}) => ({
  ok: true,
  v: 1,
  sessions: [{ cwd: CWD, sessionId: SESSION, working: false, clients: 1, idleMs: 20, pid: 1, ...over }],
});

section('The last thing Claude said, out of the end of the transcript:');
/*
 * Most entries in a transcript are not messages, and several of the kinds that are
 * not get written *after* the last assistant reply — `last-prompt`, `mode`,
 * `atis-latch`, `ai-title`. On the real transcripts here they outnumber the actual
 * turns four to one. So "the last line" is the wrong thing to read, and reading it
 * would answer this with nothing at all.
 */
write(
  assistant('an earlier answer nobody asked to see'),
  userText('and then a question'),
  assistant('the answer you came back for'),
  JSON.stringify({ type: 'last-prompt', prompt: 'and then a question' }),
  JSON.stringify({ type: 'mode', mode: 'default' }),
  JSON.stringify({ type: 'atis-latch' }),
);
brokerReply = { ok: false, why: 'bad handshake' };
let status = await claudeStatus(CWD);
ok(status.last?.text === 'the answer you came back for',
  'it reads the newest message, past the bookkeeping entries written after it');
ok(status.sessionId === SESSION, 'and names the conversation it came from');
ok(status.bytes === fs.statSync(TRANSCRIPT).size, 'it reports the size that explains the wait');

section('Which state the conversation was left in, when the broker cannot say:');
ok(status.source === 'transcript' && status.state === 'idle',
  'a finished turn (stop_reason end_turn) is your turn');

write(assistant('let me look', 'tool_use'));
status = await claudeStatus(CWD);
ok(status.state === 'working', 'a turn that stopped to run a tool is still working');

write(assistant('done'), userText('a follow-up with no reply yet'));
status = await claudeStatus(CWD);
ok(status.state === 'working', 'a question with no answer under it is working');
ok(status.last?.text === 'done', 'and the last thing said is still reported, not the question');

section('A big tool result does not hide the message behind it:');
/*
 * One 400KB tool result pushes the last real reply outside any small window. The
 * read widens rather than answering "nothing to show" about a conversation that
 * plainly has something to show — and it is still bounded, because reading the
 * whole file is the thing this exists to avoid.
 */
write(assistant('the answer, buried'), toolResult(400 * 1024));
status = await claudeStatus(CWD);
ok(status.last?.text === 'the answer, buried',
  'it widens the read when the first window holds no message');
ok(status.state === 'working', 'and the trailing tool result still reads as working');

section('It does not read the transcript, which is the entire point:');
/*
 * The panel takes 1.75–3.97s to reload a large conversation; this has to answer in
 * a fraction of that or it is just a second copy of the same wait. Timed rather
 * than asserted structurally because the property that matters is the wall clock —
 * the bound is loose enough to survive a busy box and still an order of magnitude
 * under a full read and parse of this file.
 */
const filler = `${toolResult(64 * 1024)}\n`;
fs.writeFileSync(TRANSCRIPT, `${assistant('buried under twelve megabytes')}\n`);
for (let i = 0; i < 190; i += 1) fs.appendFileSync(TRANSCRIPT, filler);
fs.appendFileSync(TRANSCRIPT, `${assistant('the newest thing said')}\n`);
const size = fs.statSync(TRANSCRIPT).size;
const started = Date.now();
status = await claudeStatus(CWD);
const took = Date.now() - started;
ok(status.last?.text === 'the newest thing said', `it answers correctly on ${(size / 1048576).toFixed(1)}MB`);
ok(took < 1500, `and answers in ${took}ms, not in the seconds a full read would take`);

section('A broker answer beats the transcript, in both directions:');
write(assistant('done'), userText('a follow-up with no reply yet'));
brokerReply = liveSession({ working: true });
status = await claudeStatus(CWD);
ok(status.state === 'working' && status.source === 'broker',
  'a live turn is reported from the broker, which is the only thing that knows');
ok(status.clients === 1, 'along with how many pages are driving it');

brokerReply = liveSession({ working: false });
status = await claudeStatus(CWD);
ok(status.state === 'idle' && status.source === 'broker',
  'a live process between turns is your turn, whatever the transcript looks like');

/*
 * The case the whole feature turns on. The transcript ends mid-turn — a question
 * with no answer under it — but the broker holds no session for this directory, so
 * there is no process that could ever finish it. That is a definite "your turn",
 * and inferring "working" from the file would leave the chip lying indefinitely.
 */
brokerReply = { ok: true, v: 1, sessions: [] };
status = await claudeStatus(CWD);
ok(status.state === 'idle' && status.source === 'broker',
  'no live process means your turn, even where the transcript stops mid-turn');
ok(status.clients === null, 'with nothing claimed about pages that do not exist');

/*
 * A session with no id has never been spoken to: the panel starts one such probe
 * per page load and never writes to it. Treating one as the conversation would
 * report a directory as idle while the real conversation beside it was working.
 */
brokerReply = {
  ok: true,
  v: 1,
  sessions: [
    { cwd: CWD, sessionId: null, working: false, clients: 1, idleMs: 5, pid: 2 },
    { cwd: CWD, sessionId: SESSION, working: true, clients: 1, idleMs: 50, pid: 3 },
  ],
};
status = await claudeStatus(CWD);
ok(status.state === 'working' && status.sessionId === SESSION,
  'the panel’s never-spoken-to probe is not mistaken for the conversation');

section('Which conversation the answer is about, when a project holds several:');
/*
 * The staleness that prompted all of this. A project on this box has four live
 * conversations in it; the first version of this file answered per *project* —
 * least-idle live session wins — and never said which conversation it meant. So
 * switching conversations inside the panel left a badge confidently describing a
 * different one, and there was no way to tell from the outside.
 *
 * Which conversation is on screen is not knowable from out here: the panel is a
 * vendor webview that reports nothing about itself and fires no navigation when
 * you switch. What is knowable is that a page driving a conversation holds a
 * broker client for it, and that among attached conversations the one spoken to
 * most recently is the one being used. That is a guess, so the answer carries the
 * name of what it chose and a list of the alternatives — a wrong guess is then
 * visibly wrong instead of silently stale.
 */
const OTHER = 'b2c3d4e5-1111-4000-8000-000000000000';
const OTHER_FILE = path.join(PROJECT_DIR, `${OTHER}.jsonl`);
const title = (text) => JSON.stringify({ type: 'ai-title', title: text });
const writeConvo = (file, ...lines) => fs.writeFileSync(file, `${lines.join('\n')}\n`);
const older = (file) => {
  const when = new Date(Date.now() - 60 * 1000);
  fs.utimesSync(file, when, when);
};

writeConvo(TRANSCRIPT, title('The one on screen'), assistant('what this conversation last said'));
writeConvo(OTHER_FILE, title('The other one'), assistant('what the other one last said'));
// The conversation being asked about is deliberately the OLDER file, so that an
// answer which merely takes the newest transcript fails here.
older(TRANSCRIPT);

const twoLive = (mine = {}, other = {}) => ({
  ok: true,
  v: 1,
  sessions: [
    { cwd: CWD, sessionId: SESSION, working: false, clients: 1, idleMs: 400, spokeMs: 900, pid: 3, ...mine },
    { cwd: CWD, sessionId: OTHER, working: false, clients: 0, idleMs: 5, spokeMs: 50, pid: 4, ...other },
  ],
});

brokerReply = twoLive();
status = await claudeStatus(CWD);
ok(status.sessionId === SESSION,
  'the conversation a page is attached to is the one described, not the busiest stream');
ok(status.title === 'The one on screen',
  'and it is named, so an answer about the wrong conversation can be recognised as one');
ok(status.last?.text === 'what this conversation last said', 'the message comes from that conversation');
ok(status.conversations?.length === 2, 'the others in the project are listed alongside it');
const listed = (id) => status.conversations.find((c) => c.sessionId === id);
ok(listed(SESSION)?.current === true && listed(OTHER)?.current === false,
  'exactly one of them is marked as the one the answer is about');
ok(listed(OTHER)?.title === 'The other one' && listed(OTHER)?.said === 'what the other one last said',
  'each is described well enough to pick out of a list');
ok(listed(OTHER)?.live === true && listed(OTHER)?.clients === 0,
  'including a conversation still running with nobody watching it — the case this service exists for');

status = await claudeStatus(CWD, { sessionId: OTHER });
ok(status.sessionId === OTHER && status.title === 'The other one',
  'a device that knows which conversation it is in overrides the guess');
ok(status.last?.text === 'what the other one last said', 'and is answered about that one');
ok(status.conversations?.find((c) => c.sessionId === OTHER)?.current === true,
  'the list follows the choice rather than the guess');

// Both attached: the tie-break. `idleMs` is when the stream last produced a byte,
// which resuming a conversation does with nobody typing, so it identifies the
// conversation being *read back*. `spokeMs` is when someone last said something.
brokerReply = twoLive({ spokeMs: 30 * 1000, idleMs: 20 }, { clients: 1, spokeMs: 400, idleMs: 9000 });
status = await claudeStatus(CWD);
ok(status.sessionId === OTHER,
  'among attached conversations the most recently spoken to wins, not the noisiest');

brokerReply = twoLive({ clients: 0, spokeMs: 30 * 1000 }, { clients: 0, working: true });
status = await claudeStatus(CWD);
ok(status.sessionId === OTHER && status.state === 'working',
  'with nothing attached it falls back to the newest transcript, which is the one being written to');

section('A latched "working" is overruled by the transcript, but only on a quiet stream:');
/*
 * Two reasons this is not redundant. A broker predating the input-side turn
 * detection latches `working` on for the life of the process — 11 of 13 sessions
 * on the box, measured — and restarting it ends every live conversation, so the
 * client half has to be deployable on its own. And even a correct broker can only
 * ever *miss* a `result`, never invent one, so the failure mode is always a badge
 * stuck on "working".
 *
 * A turn in flight is not silent: deltas arrive, tools announce themselves. So a
 * stream that has said nothing for OVERRIDE_QUIET_MS, whose transcript ends with a
 * finished turn, is not working.
 */
writeConvo(TRANSCRIPT, title('The one on screen'), assistant('the finished answer'));
brokerReply = twoLive({ working: true, idleMs: 60 * 1000, spokeMs: 120 * 1000 });
status = await claudeStatus(CWD);
ok(status.state === 'idle' && status.source === 'transcript',
  'a "working" stream that has been silent for a minute, over a finished turn, is your turn');
ok(status.conversations?.find((c) => c.sessionId === SESSION)?.state === 'idle',
  'and the list says the same thing about it, rather than contradicting the answer above');

brokerReply = twoLive({ working: true, idleMs: 200, spokeMs: 120 * 1000 });
status = await claudeStatus(CWD);
ok(status.state === 'working' && status.source === 'broker',
  'a stream that is still producing output is working, whatever the transcript shows');

brokerReply = twoLive({ working: true, idleMs: 60 * 1000, spokeMs: 500 });
status = await claudeStatus(CWD);
ok(status.state === 'working',
  'and so is a message sent a moment ago that has not reached the disk yet');

writeConvo(TRANSCRIPT, title('The one on screen'), assistant('done'), userText('a follow-up with no reply yet'));
brokerReply = twoLive({ working: true, idleMs: 60 * 1000, spokeMs: 120 * 1000 });
status = await claudeStatus(CWD);
ok(status.state === 'working',
  'a transcript that itself ends mid-turn overrules nothing — both sources agree');

section('One project is never answered with another project’s conversation:');
/*
 * The case the user had not tried yet. Sessions are matched on cwd, and this is
 * the check that says so: a conversation working hard in a different project must
 * not leak into this answer, in either direction.
 */
const CWD2 = path.join(PROJECTS, 'elsewhere');
const PROJECT_DIR2 = path.join(CLAUDE_HOME, 'projects', CWD2.replace(/[/.]/g, '-'));
const ELSEWHERE = 'c3d4e5f6-2222-4000-8000-000000000000';
fs.mkdirSync(CWD2, { recursive: true });
fs.mkdirSync(PROJECT_DIR2, { recursive: true });
writeConvo(
  path.join(PROJECT_DIR2, `${ELSEWHERE}.jsonl`),
  title('A different project'),
  assistant('what the other project last said'),
);

brokerReply = {
  ok: true,
  v: 1,
  sessions: [
    { cwd: CWD, sessionId: SESSION, working: false, clients: 1, idleMs: 400, spokeMs: 900, pid: 3 },
    { cwd: CWD2, sessionId: ELSEWHERE, working: true, clients: 1, idleMs: 10, spokeMs: 10, pid: 5 },
  ],
};
status = await claudeStatus(CWD);
ok(status.sessionId === SESSION && status.state === 'idle',
  'a busy conversation in another project does not make this one look busy');
ok(!status.conversations.some((c) => c.sessionId === ELSEWHERE),
  'nor does it appear in this project’s list');
status = await claudeStatus(CWD2);
ok(status.sessionId === ELSEWHERE && status.state === 'working' && status.title === 'A different project',
  'and that project is answered about its own conversation');
ok(status.conversations.length === 1, 'with only its own conversations listed');

section('Every way of not knowing falls back rather than guessing:');
brokerReply = 'silent';
const slowStart = Date.now();
status = await claudeStatus(CWD);
ok(status.source === 'transcript' && Date.now() - slowStart < 1200,
  'a broker that accepts the connection and says nothing is given up on, not waited for');

await new Promise((resolve) => broker.close(resolve));
try {
  fs.unlinkSync(SOCKET);
} catch {
  /* already gone */
}
status = await claudeStatus(CWD);
ok(status.source === 'transcript', 'no broker at all falls back to the transcript');
ok(status.state === 'working',
  'and reports what the file shows rather than claiming a conversation is idle');

section('A cwd from a browser cannot name a path outside the projects root:');
let refused = false;
try {
  await claudeStatus('/etc');
} catch {
  refused = true;
}
ok(refused, 'a cwd outside the projects root is refused');

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
