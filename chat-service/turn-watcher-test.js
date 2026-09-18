/**
 * When a turn ending becomes a notification, and — mostly — when it does not.
 *
 * The failure everyone has met is not a missing notification, it is a phone that
 * buzzes for nothing: twice for one answer, once for something said an hour ago,
 * once per conversation the moment a service restarts, or for the message you are
 * already reading in the app. Each of those is a separate rule in turn-watcher.js
 * and each has a section here, because the only way to find out otherwise is to
 * carry the phone around for a day.
 *
 * Everything runs against real transcript files in a temporary CLAUDE_HOME, with
 * push and the session manager passed in as fakes. `scan()` is called directly, so
 * nothing here waits on the poll interval except the one check that the loop runs
 * at all.
 *
 * Run: node chat-service/turn-watcher-test.js
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-watcher-test-'));
const PROJECTS = path.join(TMP, 'projects');
const CLAUDE_HOME = path.join(TMP, 'claude');
const mangle = (p) => p.replace(/[/.]/g, '-');

// Two projects, plus a conversation whose cwd is not a project at all.
const DEMO = path.join(PROJECTS, 'demo');
const OTHER = path.join(PROJECTS, 'other');
const ELSEWHERE = path.join(TMP, 'somewhere-else');
const dirFor = (cwd) => path.join(CLAUDE_HOME, 'projects', mangle(cwd));
for (const cwd of [DEMO, OTHER, ELSEWHERE]) {
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(dirFor(cwd), { recursive: true });
}

// Read at import time by session-manager.js and push.js.
process.env.PROJECTS_ROOT = PROJECTS;
process.env.CLAUDE_HOME = CLAUDE_HOME;
process.env.CW_PUSH_DIR = path.join(TMP, 'push');

const { createTurnWatcher, preview } = await import('./turn-watcher.js');
const { topicFor } = await import('./push.js');

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

const assistant = (text, { stop = 'end_turn', at = new Date() } = {}) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(at).toISOString(),
    message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }] },
  });
const userText = (text) =>
  JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: text } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Write a transcript, and move its mtime on by a visible amount.
 *
 * The watcher skips a file whose mtime has not changed, which is the whole reason it
 * is cheap enough to run every five seconds. Two writes inside one filesystem tick —
 * about 10ms here — share an mtime, so the second would be invisible. That is an
 * artefact of a test that writes faster than anyone talks, not a bug: real turns are
 * seconds apart. Stamping each write rather than sleeping keeps it deterministic.
 */
let stamp = Date.now();
async function write(cwd, session, ...lines) {
  const file = path.join(dirFor(cwd), `${session}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  stamp += 20;
  fs.utimesSync(file, new Date(stamp), new Date(stamp));
}

/** A watcher wired to fakes: one subscribed device, and a notify that just records. */
function watcherWith({ live = [], devices = 1, notify } = {}) {
  const sent = [];
  const watcher = createTurnWatcher({
    liveSessions: () => live,
    subscriptions: async () => Array.from({ length: devices }, (_, i) => ({ endpoint: `https://push.example/${i}` })),
    notify: notify || (async (payload, opts) => { sent.push({ payload, opts }); }),
    log: () => {},
  });
  return { watcher, sent };
}

const S1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const S2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const S3 = 'cccccccc-0000-4000-8000-000000000003';

// --------------------------------------------------------------------------
section('A restart announces nothing:');
{
  await write(DEMO, S1, userText('do the thing'), assistant('The thing is done.'));
  const { watcher, sent } = watcherWith();

  const first = await watcher.scan();
  ok(sent.length === 0, 'the first scan notified, so every deploy buzzes once per conversation');
  ok(first.scanned > 0, 'the first scan read nothing, so it has not learned the current state');
  ok(watcher.stats().seeded, 'the watcher did not mark itself seeded');

  await watcher.scan();
  ok(sent.length === 0, 'a scan with nothing new notified anyway');
}

section('A turn that was killed says so, instead of claiming it finished:');
{
  /*
   * The bug this was written after, reported from a phone: "I get a 'Claude
   * finished' message". The turn had been killed, and Claude Code marks that by
   * writing an assistant entry reading "No response requested." with a terminal
   * stop_reason — so it read as a finished turn, and the body quoted the artifact
   * as though it were the answer.
   *
   * The second assertion is the one with a trap in it. Skipping the artifact means
   * the last thing really *said* is the message before it, which is usually one
   * already announced — so a watcher that decides "new" on the text alone would see
   * a repeat and stay silent, swallowing the one notification that matters: the turn
   * you are waiting on has stopped and will not resume by itself.
   */
  const { watcher, sent } = watcherWith();
  await write(DEMO, S3, userText('ship it'), assistant('Deployed. 144/144 checks passed.'));
  await watcher.scan(); // seed: this answer is already known and already announced

  await write(
    DEMO,
    S3,
    userText('ship it'),
    assistant('Deployed. 144/144 checks passed.'),
    assistant('No response requested.', { stop: 'stop_sequence' }),
  );
  await watcher.scan();

  ok(sent.length === 1, `${sent.length} notifications for a killed turn — a repeat digest swallowed it`);
  const { payload } = sent[0] || { payload: {} };
  ok(payload.title === 'Claude stopped · demo', `the title is ${JSON.stringify(payload.title)}`);
  ok(payload.cutOff === 'interrupted', 'the payload does not say why it stopped');
  ok(
    /needs a nudge/.test(payload.body || ''),
    `the body does not say what to do about it: ${JSON.stringify(payload.body)}`,
  );
  ok(
    !/No response requested/.test(payload.body || ''),
    'the harness artifact is read out as though Claude had said it',
  );
  ok(
    /Deployed\. 144/.test(payload.body || ''),
    'the body does not say what it was in the middle of, which is what makes it recognisable',
  );

  // And once, not once per poll: a lock screen that repeats itself is one people turn off.
  await watcher.scan();
  ok(sent.length === 1, 'the same cut-off turn notified twice');

  await write(
    DEMO,
    S3,
    userText('ship it'),
    assistant('Deployed. 144/144 checks passed.'),
    assistant('No response requested.', { stop: 'stop_sequence' }),
    userText('continue'),
  );
  await watcher.scan();
  ok(sent.length === 1, 'a cut-off turn that was picked up again notified again');
}

section('A finished turn, on a session this app is not driving:');
{
  const { watcher, sent } = watcherWith();
  await watcher.scan(); // seed
  await write(DEMO, S1, userText('and now?'), assistant('All three features are in, and the suite is green.'));
  await watcher.scan();

  ok(sent.length === 1, `${sent.length} notifications for one finished turn`);
  const { payload, opts } = sent[0] || { payload: {}, opts: {} };
  ok(payload.title === 'Claude finished · demo', `the title is ${JSON.stringify(payload.title)}`);
  ok(payload.body === 'All three features are in, and the suite is green.', `the body is ${JSON.stringify(payload.body)}`);
  ok(payload.sessionId === S1, 'the notification does not say which session it came from');
  ok(opts.topic === topicFor(`${mangle(DEMO)}|${S1}`), 'the Topic is not derived from the conversation');
  ok(payload.tag === `turn-${topicFor(`${mangle(DEMO)}|${S1}`)}`, 'the tag is not per conversation, so two answers stack up');

  // Same answer, transcript rewritten. Claude Code appends bookkeeping entries
  // after a turn ends, so this happens on its own within seconds of every reply.
  await write(DEMO, S1, userText('and now?'), assistant('All three features are in, and the suite is green.'), JSON.stringify({ type: 'ai-title', title: 'shipping three features' }));
  await watcher.scan();
  ok(sent.length === 1, 'the same message was announced twice');

  await write(DEMO, S1, userText('one more'), assistant('Done — pushed and deployed.'));
  await watcher.scan();
  ok(sent.length === 2, 'a genuinely new answer in the same conversation was not announced');
  ok(sent[1].payload.body === 'Done — pushed and deployed.', 'the second notification carries the wrong text');
}

section('A turn that is still going says nothing:');
{
  const { watcher, sent } = watcherWith();
  await watcher.scan();

  await write(DEMO, S2, userText('go'), assistant('Let me look at the tests.', { stop: 'tool_use' }));
  await watcher.scan();
  ok(sent.length === 0, 'a turn that stopped to run a tool was announced as finished');

  await write(DEMO, S2, userText('go'), assistant('Let me look at the tests.', { stop: 'tool_use' }), userText('[tool result]'));
  await watcher.scan();
  ok(sent.length === 0, 'a tool result going back in was announced');

  await write(DEMO, S2, userText('go'), assistant('Let me look at the tests.', { stop: 'tool_use' }), userText('[tool result]'), assistant('Both suites pass.'));
  await watcher.scan();
  ok(sent.length === 1 && sent[0].payload.body === 'Both suites pass.', 'the turn ending after the tool was not announced');
}

section('The conversations this app drives are the app\'s business, not the lock screen\'s:');
{
  const live = [{ cwd: OTHER, sessionId: S3, busy: false }];
  const { watcher, sent } = watcherWith({ live });
  await watcher.scan();

  await write(OTHER, S3, userText('hello'), assistant('Hello — this one is in the chat app.'));
  await watcher.scan();
  ok(sent.length === 0, 'a conversation held in the chat app was pushed to the phone as well');

  // The process has exited, so it is no longer live — but its final message is
  // still on screen in the app that ran it.
  live.length = 0;
  await write(OTHER, S3, userText('hello'), assistant('Hello — this one is in the chat app.'), assistant('And a last word.'));
  await watcher.scan();
  ok(sent.length === 0, 'a chat conversation that has just exited was announced after the fact');

  // A different session in the same project is not the app's, and must still work.
  await write(OTHER, S1, userText('from the panel'), assistant('Panel answer.'));
  await watcher.scan();
  ok(sent.length === 1 && sent[0].payload.title === 'Claude finished · other', 'a panel session in a project the app is also using was suppressed');
}

section('Old news is not news:');
{
  const { watcher, sent } = watcherWith();
  await watcher.scan();

  await write(DEMO, S3, userText('yesterday'), assistant('This was said a while ago.', { at: Date.now() - 20 * 60 * 1000 }));
  await watcher.scan();
  ok(sent.length === 0, 'a message from twenty minutes ago woke the phone');

  // …and having been read once, it does not become news when it is read again.
  await write(DEMO, S3, userText('yesterday'), assistant('This was said a while ago.', { at: Date.now() - 20 * 60 * 1000 }), JSON.stringify({ type: 'mode', mode: 'default' }));
  await watcher.scan();
  ok(sent.length === 0, 'an old message was announced on a later pass');
}

section('With nothing subscribed, there is nothing to do:');
{
  const { watcher, sent } = watcherWith({ devices: 0 });
  const idle = await watcher.scan();
  ok(idle.scanned === 0, 'the disk was scanned with no device subscribed');
  ok(sent.length === 0, 'something was sent with no device subscribed');
  ok(!watcher.stats().seeded, 'the watcher considers itself seeded without having read anything');
}
{
  // A phone subscribes now. Whatever finished while nobody was listening stays
  // unannounced — the first scan after subscribing is a seed, not a backlog.
  let devices = 0;
  const sent = [];
  const watcher = createTurnWatcher({
    subscriptions: async () => Array.from({ length: devices }, () => ({ endpoint: 'https://push.example/1' })),
    notify: async (payload) => { sent.push(payload); },
    log: () => {},
  });
  await write(DEMO, S1, userText('while you were out'), assistant('Finished this an hour ago.'));
  await watcher.scan();
  devices = 1;
  await watcher.scan();
  ok(sent.length === 0, 'subscribing a phone replayed the conversations that finished before it');
  await write(DEMO, S1, userText('now'), assistant('And this one just now.'));
  await watcher.scan();
  ok(sent.length === 1 && sent[0].body === 'And this one just now.', 'the first turn after subscribing was not announced');
}

section('Every project, named the way a person names it:');
{
  const { watcher, sent } = watcherWith();
  await watcher.scan();

  await write(DEMO, S1, assistant('From demo.'));
  await write(OTHER, S2, assistant('From other.'));
  await write(ELSEWHERE, S3, assistant('From somewhere that is not a project.'));
  await watcher.scan();

  const titles = sent.map((s) => s.payload.title).sort();
  ok(sent.length === 3, `${sent.length} of three projects were announced`);
  ok(titles.includes('Claude finished · demo') && titles.includes('Claude finished · other'), `titles were ${titles.join(', ')}`);
  ok(
    titles.some((t) => t.includes(mangle(ELSEWHERE))),
    'a conversation outside the projects tree was given no name at all',
  );
  const topics = new Set(sent.map((s) => s.opts.topic));
  ok(topics.size === 3, 'two conversations share a Topic, so one notification replaces another');
}

section('One push service failing does not lose the rest:');
{
  let calls = 0;
  const { watcher } = watcherWith({
    notify: async () => {
      calls += 1;
      throw new Error('push service is down');
    },
  });
  await watcher.scan();
  await write(DEMO, S1, assistant('One.'));
  await write(OTHER, S2, assistant('Two.'));
  const result = await watcher.scan();
  ok(calls === 2, `notify was called ${calls} times; a throw stopped the loop`);
  ok(result.sent.length === 0, 'a failed send was reported as sent');
}

section('A missing CLAUDE_HOME is survivable, because it happens on a fresh box:');
{
  const sent = [];
  const watcher = createTurnWatcher({
    subscriptions: async () => [{ endpoint: 'https://push.example/1' }],
    notify: async (p) => { sent.push(p); },
    log: () => {},
  });
  const home = path.join(CLAUDE_HOME, 'projects');
  const moved = `${home}-away`;
  fs.renameSync(home, moved);
  const result = await watcher.scan();
  ok(result.scanned === 0 && sent.length === 0, 'a missing transcript directory was not survived');
  fs.renameSync(moved, home);
  ok((await watcher.scan()).scanned > 0, 'the watcher did not recover once the directory came back');
}

section('The loop runs on its own:');
{
  const sent = [];
  const watcher = createTurnWatcher({
    subscriptions: async () => [{ endpoint: 'https://push.example/1' }],
    notify: async (p) => { sent.push(p); },
    pollMs: 15,
    log: () => {},
  });
  watcher.start();
  await sleep(60);
  await write(DEMO, S2, assistant('Said this while the timer was running.'));
  for (let i = 0; i < 40 && !sent.length; i += 1) await sleep(25);
  await watcher.stop();
  ok(sent.length === 1, `the polling loop sent ${sent.length} notifications for one new message`);

  const before = sent.length;
  await write(DEMO, S2, assistant('And this after it was stopped.'));
  await sleep(80);
  ok(sent.length === before, 'the watcher kept polling after stop()');
}

// --------------------------------------------------------------------------
section('The preview, which is all a lock screen shows:');
{
  ok(preview('Short and done.') === 'Short and done.', 'a short message was altered');
  ok(preview('two\n\nlines   here') === 'two lines here', 'newlines and runs of spaces are not collapsed');
  ok(preview('  padded  ') === 'padded', 'the preview is not trimmed');
  const long = `${'word '.repeat(60)}end`;
  const cut = preview(long);
  ok(cut.length <= 151, `the preview is ${cut.length} characters, which a lock screen truncates mid-word anyway`);
  ok(cut.endsWith('…'), 'a truncated preview does not say it was truncated');
  ok(!/ …$/.test(cut), 'the ellipsis is hung off a trailing space');
  ok(preview('here is code:\n```js\nconst x = 1;\n```\nand after') === 'here is code: and after', 'a code fence is read out into the preview');
  ok(preview(null) === '' && preview(undefined) === '', 'a missing message throws instead of previewing as empty');
  ok(preview('abcdef', 3) === 'abc…', 'a short limit is not honoured');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
