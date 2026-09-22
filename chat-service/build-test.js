/**
 * "Am I running what I pushed" — the two ways this can answer it wrongly.
 *
 * A version line is not a feature anyone watches, which is exactly why it needs a
 * test: both of its failure modes are quiet and both are worse than having no
 * version line at all.
 *
 *  1. **A confident wrong answer.** The build must come from the payload that is
 *     running, never from somewhere that merely looks authoritative. So the
 *     resolution order is asserted directly: a stamp beats git, git beats mtimes,
 *     and a stamp that identifies nothing is refused rather than shown — a build
 *     id of `''` would make every tab agree it was current.
 *  2. **Staleness that cannot be seen.** The whole mechanism is one `<meta>` tag in
 *     the shell. If it is dropped from index.html, or the server stops filling it
 *     in, nothing breaks and nothing says so: the page compares the server's build
 *     with the server's build and always agrees. So the tag's presence is a test,
 *     and so is the client's behaviour when the two differ.
 *
 * The stamp is also the one input here that is written by a *deploy box*, not by
 * this repository, and it is interpolated into an HTML attribute on every page the
 * app serves. So it gets the same treatment PWA_NAME gets in manifest-test.js: a
 * hostile value goes in and the assertion is that nothing escapes the attribute.
 *
 * Run: node chat-service/build-test.js
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';
import { buildInfo, applyBuildStamp } from './build.js';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, 'public');

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks += 1;
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A world where none of the three sources answers, to be overridden one at a time. */
const nothing = {
  readStamp: () => Promise.reject(new Error('ENOENT')),
  readVersion: () => Promise.reject(new Error('ENOENT')),
  isCheckout: () => Promise.reject(new Error('ENOENT')),
  git: () => Promise.reject(new Error('not a repository')),
  mtimes: () => Promise.resolve([0, 0, 0]),
};

const stampOf = (obj) => ({ readStamp: () => Promise.resolve(JSON.stringify(obj)) });
const gitOf = (log, status = '') => ({
  isCheckout: () => Promise.resolve(true),
  git: (args) => Promise.resolve(args[0] === 'status' ? status : log),
});
const VERSION = { readVersion: () => Promise.resolve('{"version":"3.0.0"}') };

console.log('\nThe stamp a deploy writes:');
{
  const b = await buildInfo({
    ...nothing,
    ...stampOf({
      version: '3.0.0',
      commit: '33d370b',
      commitAt: 1790011700000,
      subject: 'Speak and listen on credit that runs out, not on a card',
      dirty: false,
      builtAt: 1790063935512,
    }),
  });
  check('names the commit that was packed', b.commit === '33d370b', JSON.stringify(b));
  check('the id is that commit', b.id === '33d370b');
  check('says where the answer came from', b.source === 'stamp');
  check('carries the version', b.version === '3.0.0');
  check('carries what the commit says', b.subject.startsWith('Speak and listen'));
  check('and when it was packed', b.builtAt === 1790063935512);
}

console.log('\nA payload that is not exactly its commit:');
{
  // `./deploy.sh --app-only` ships the working tree. On the shared checkout this
  // runs from, that tree is dirty more often than not, and a bare sha would be a
  // precise-looking lie about which code is on the box.
  const b = await buildInfo({ ...nothing, ...stampOf({ commit: 'abc1234', dirty: true, builtAt: 5 }) });
  check('the id is marked, so it cannot be mistaken for the commit', b.id === 'abc1234+');
  check('and the flag survives for the UI to explain', b.dirty === true);
}

console.log('\nA stamp is never trusted as far as the page:');
{
  const hostile = await buildInfo({
    ...nothing,
    ...stampOf({
      commit: '" onload="alert(1)',
      subject: 'a subject\nwith a second line',
      builtAt: 7,
    }),
  });
  check('the id keeps only id characters', /^[A-Za-z0-9.+_-]+$/.test(hostile.id), hostile.id);
  check('a human line stays one line', !/[\r\n]/.test(hostile.subject));

  // The reduced id may well still contain letters from an attempted injection —
  // `onloadalert1` here. That is fine and is the point: what it cannot contain is a
  // quote or an angle bracket, so it stays *content* rather than becoming markup.
  const html = applyBuildStamp('<meta name="build" content="">', hostile.id);
  check(
    'nothing escapes the attribute',
    html === `<meta name="build" content="${hostile.id}">` && !/["'<>=]/.test(hostile.id),
    html,
  );
  // The stamp goes through the same reduction on the way out, so a caller that
  // reached applyBuildStamp with a raw value cannot open the attribute either.
  const direct = applyBuildStamp('<meta name="build" content="">', '"><script>x</script>');
  check('nor when the raw value is stamped directly', !direct.includes('<script>'), direct);
}

console.log('\nWhen the stamp cannot be read, the next source answers:');
{
  const malformed = await buildInfo({
    ...nothing,
    ...VERSION,
    readStamp: () => Promise.resolve('{ this is not json'),
    ...gitOf('9f21ab3\u000017900117\u0000a commit from the checkout\n'),
  });
  check('malformed JSON falls through to git', malformed.source === 'git', JSON.stringify(malformed));
  check('and git names the commit', malformed.commit === '9f21ab3');
  check('with the subject intact', malformed.subject === 'a commit from the checkout');
  check('and the version from package.json', malformed.version === '3.0.0');

  const empty = await buildInfo({
    ...nothing,
    ...stampOf({ commit: '', builtAt: 0 }),
    ...gitOf('9f21ab3\u000017900117\u0000from git\n'),
  });
  check('a stamp that identifies nothing is refused, not shown', empty.source === 'git');

  const dirtyTree = await buildInfo({
    ...nothing,
    ...VERSION,
    ...gitOf('9f21ab3\u000017900117\u0000from git\n', ' M chat-service/server.js\n'),
  });
  check('a dirty checkout is marked too', dirtyTree.id === '9f21ab3+', dirtyTree.id);

  const unanswerable = await buildInfo({
    ...nothing,
    ...VERSION,
    isCheckout: () => Promise.resolve(true),
    git: (args) => (args[0] === 'status'
      ? Promise.reject(new Error('git died'))
      : Promise.resolve('9f21ab3\u000017900117\u0000from git\n')),
  });
  check('a failed status is not read as a clean tree', unanswerable.dirty === false);
  check('and does not lose the commit', unanswerable.id === '9f21ab3');
}

console.log('\nA box deployed before any of this existed:');
{
  // No stamp and no .git — which is every box running a payload shipped before
  // build.js. It cannot name a commit, and must still produce a value that
  // *changes* when the payload does, because that is what the tab comparison needs.
  const older = await buildInfo({ ...nothing, ...VERSION, mtimes: () => Promise.resolve([10, 4000, 30]) });
  check('falls back to the newest asset', older.id === 't4000', older.id);
  check('and says so rather than implying a commit', older.source === 'assets' && older.commit === '');

  const shipped = await buildInfo({ ...nothing, ...VERSION, mtimes: () => Promise.resolve([10, 9000, 30]) });
  check('a new payload is a new id', shipped.id !== older.id);
}

console.log('\nA build that cannot be identified at all:');
{
  const blind = await buildInfo({ ...nothing });
  check('has no id rather than a made-up one', blind.id === '', JSON.stringify(blind));
  check('and says it cannot say', blind.source === 'unknown');
  // The important consequence: with no id there is nothing to stamp, so the page
  // has nothing to compare and never claims to be out of date.
  const html = applyBuildStamp('<meta name="build" content="">', blind.id);
  check('so no page is stamped', html === '<meta name="build" content="">');
}

console.log('\nThe tag the whole mechanism rests on:');
{
  const shell = readFileSync(join(publicDir, 'index.html'), 'utf8');
  check('index.html still has <meta name="build">', /<meta name="build" content="">/.test(shell));
  const stamped = applyBuildStamp(shell, 'deadbee');
  check('the server can fill it in', stamped.includes('<meta name="build" content="deadbee">'));
  check('and changes nothing else', stamped.length === shell.length + 'deadbee'.length);

  const admin = readFileSync(join(publicDir, 'admin.html'), 'utf8');
  check('a shell without the tag is untouched', applyBuildStamp(admin, 'deadbee') === admin);
}

// --- the client -------------------------------------------------------------
/**
 * The tab that has been open since before a deploy.
 *
 * This is the state the feature exists for and the one no browser can be put into
 * on demand: the page was served by one build and the server is now another. Both
 * sides are faked at once — the shell is stamped, and /api/version answers with
 * something else — because what is being tested is the comparison between them.
 */
function bootClient({ pageBuild, serverBuild }) {
  const html = applyBuildStamp(readFileSync(join(publicDir, 'index.html'), 'utf8'), pageBuild);
  const js = readFileSync(join(publicDir, 'app.js'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://claude.example.com/chat/' });
  const w = dom.window;
  const asked = [];
  w.fetch = (url) => {
    asked.push(String(url));
    if (String(url).includes('/api/version')) {
      return serverBuild
        ? Promise.resolve({ ok: true, json: () => Promise.resolve(serverBuild) })
        : Promise.reject(new Error('offline'));
    }
    if (String(url).includes('/api/live')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ sessions: [] }) });
    }
    if (String(url).includes('/api/projects')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ projects: [] }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ models: [] }) });
  };
  w.WebSocket = function () {
    this.addEventListener = () => {};
    this.send = () => {};
    this.close = () => {};
    this.readyState = 0;
  };
  w.WebSocket.CONNECTING = 0;
  w.WebSocket.OPEN = 1;
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.eval(js);
  return { w, asked };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 60));

console.log('\nThe settings sheet, on a tab that is current:');
{
  const { w, asked } = bootClient({
    pageBuild: '33d370b',
    serverBuild: { id: '33d370b', version: '3.0.0', commit: '33d370b', commitAt: Date.now(), subject: 'the commit on the box', dirty: false, builtAt: Date.now() - 3600_000, source: 'stamp' },
  });
  check('nothing is asked before the sheet is opened', !asked.some((u) => u.includes('/api/version')));

  w.document.querySelector('#btn-settings').click();
  await settled();
  const line = w.document.querySelector('#build-line').textContent;
  check('asked which build is running', asked.some((u) => u.includes('/api/version')));
  check('shows the version', line.includes('v3.0.0'), line);
  check('and the commit', line.includes('33d370b'), line);
  check('and when it was deployed', /deployed .+ ago/.test(line), line);
  check('says what that build contains', w.document.querySelector('#build-note').textContent.includes('the commit on the box'));
  check(
    'and offers no reload, because there is nothing to get',
    w.document.querySelector('#btn-build-reload').classList.contains('hidden'),
  );
  check('nor marks the line', !w.document.querySelector('#build-line').classList.contains('stale'));
}

console.log('\nThe settings sheet, on a tab left open through a deploy:');
{
  const { w } = bootClient({
    pageBuild: '33d370b',
    serverBuild: { id: '9f21ab3', version: '3.0.0', commit: '9f21ab3', commitAt: Date.now(), subject: 'what was just deployed', dirty: false, builtAt: Date.now() - 120_000, source: 'stamp' },
  });
  w.document.querySelector('#btn-settings').click();
  await settled();
  const line = w.document.querySelector('#build-line').textContent;
  check('names the build on the box', line.includes('9f21ab3'), line);
  check('and the older one this tab is running', line.includes('33d370b'), line);
  check('marks the line', w.document.querySelector('#build-line').classList.contains('stale'));
  check(
    'and offers the reload that fixes it',
    !w.document.querySelector('#btn-build-reload').classList.contains('hidden'),
  );
}

console.log('\nA tab that cannot be compared says so, instead of guessing:');
{
  // An unstamped page — a server too old to fill the tag in, or a shell opened
  // from disk. Claiming "out of date" here would send somebody reloading a page
  // that is already current, forever.
  const { w } = bootClient({
    pageBuild: '',
    serverBuild: { id: '9f21ab3', version: '3.0.0', commit: '9f21ab3', commitAt: null, subject: '', dirty: false, builtAt: Date.now(), source: 'stamp' },
  });
  w.document.querySelector('#btn-settings').click();
  await settled();
  check('still shows what the server is running', w.document.querySelector('#build-line').textContent.includes('9f21ab3'));
  check(
    'but claims nothing about this tab',
    w.document.querySelector('#btn-build-reload').classList.contains('hidden'),
  );
}

console.log('\nAn unstamped build, and a server that cannot be reached:');
{
  const { w } = bootClient({
    pageBuild: 't4000',
    serverBuild: { id: 't4000', version: '3.0.0', commit: '', commitAt: null, subject: '', dirty: false, builtAt: 4000, source: 'assets' },
  });
  w.document.querySelector('#btn-settings').click();
  await settled();
  const line = w.document.querySelector('#build-line').textContent;
  check('does not print an empty commit', !line.includes('· ·') && line.includes('unstamped'), line);

  const offline = bootClient({ pageBuild: '33d370b', serverBuild: null });
  offline.w.document.querySelector('#btn-settings').click();
  await settled();
  const text = offline.w.document.querySelector('#build-line').textContent;
  check('a failed ask still says what this tab is', text.includes('33d370b'), text);
  check(
    'and does not offer a reload it cannot justify',
    offline.w.document.querySelector('#btn-build-reload').classList.contains('hidden'),
  );
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
// Explicit, as in overlay-test.js: closing the windows stops the client's own
// timers but jsdom keeps enough of itself alive that node does not fall off the
// end, and a suite that hangs green is indistinguishable from one that hangs red.
process.exit(0);
