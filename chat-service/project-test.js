/**
 * Tests for the project lifecycle: inspect, remove, clone.
 *
 * `removeProject` deletes a directory tree. Every check in it exists because
 * something can live only on this machine — uncommitted edits, commits no remote
 * has, a stash, a file git was told to ignore — and the cost of getting one of
 * those wrong is unrecoverable work. So the refusals are what this file tests
 * hardest: not just that a clean project is removed, but that a project with
 * something to lose is *not*, and that the directory is still there afterwards.
 *
 * Real git repositories in a temp directory, real pushes to a real bare repo. A
 * mock would pass while the argument order was wrong.
 *
 * Run: node chat-service/project-test.js
 */
import { execFile } from 'child_process';
import { mkdtemp, mkdir, writeFile, stat, rm, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const root = await mkdtemp(join(tmpdir(), 'claude-web-projects-'));
const remotes = await mkdtemp(join(tmpdir(), 'claude-web-remotes-'));

// session-manager reads these at import time, so they must be set first. A
// committer identity too: the module's own `git commit` inherits this process's
// environment, and a machine with no global git identity would otherwise fail
// the test for a reason that has nothing to do with the code.
process.env.PROJECTS_ROOT = root;
process.env.CLAUDE_HOME = join(root, '.claude');
process.env.GIT_AUTHOR_NAME = 'Test';
process.env.GIT_AUTHOR_EMAIL = 'test@example.com';
process.env.GIT_COMMITTER_NAME = 'Test';
process.env.GIT_COMMITTER_EMAIL = 'test@example.com';

const { SessionManager, parseGithubRepo, projectPathFor } = await import('./session-manager.js');

let passed = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const git = (cwd, ...args) =>
  execFileAsync('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

const exists = async (path) => Boolean(await stat(path).catch(() => null));

/** A bare repo to push to, so "pushed" means something a second process can see. */
async function makeRemote(name) {
  const path = join(remotes, `${name}.git`);
  await mkdir(path, { recursive: true });
  await git(path, 'init', '--bare', '-b', 'main');
  return path;
}

/** A project directory, optionally a repo, optionally wired to a remote. */
async function makeProject(name, { repo = true, remote = null, commit = true } = {}) {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'file.txt'), 'original\n');
  if (!repo) return path;
  await git(path, 'init', '-b', 'main');
  if (commit) {
    await git(path, 'add', '-A');
    await git(path, 'commit', '-m', 'first');
  }
  if (remote) {
    await git(path, 'remote', 'add', 'origin', remote);
    if (commit) await git(path, 'push', '-u', 'origin', 'main');
  }
  return path;
}

const manager = new SessionManager();

/** Removal that is expected to be refused, returned rather than thrown at us. */
async function attemptRemove(name, opts) {
  try {
    return { removed: await manager.removeProject(name, opts) };
  } catch (err) {
    return { error: err };
  }
}

console.log('\nNames that must never become paths:');
{
  for (const bad of ['../escape', 'a/b', '.hidden', '', 'x'.repeat(101), 'has space']) {
    let threw = false;
    try {
      projectPathFor(bad);
    } catch {
      threw = true;
    }
    check(`projectPathFor(${JSON.stringify(bad)}) rejected`, threw);
  }
  check('projectPathFor("ok-name_1.2") accepted', projectPathFor('ok-name_1.2').endsWith('ok-name_1.2'));
}

console.log('\nGitHub repo references:');
{
  const cases = [
    ['owner/repo', 'owner/repo'],
    ['https://github.com/owner/repo', 'owner/repo'],
    ['https://github.com/owner/repo.git', 'owner/repo'],
    ['http://www.github.com/owner/repo/', 'owner/repo'],
    ['git@github.com:owner/repo.git', 'owner/repo'],
    ['github.com/owner/repo', 'owner/repo'],
  ];
  for (const [input, slug] of cases) {
    let got = null;
    try {
      got = parseGithubRepo(input).slug;
    } catch (err) {
      got = err.message;
    }
    check(`${input} → ${slug}`, got === slug, `got ${got}`);
  }

  // Any host but github.com must be refused: the workspace's credential helper
  // answers with the PAT for whatever host git asks about, so accepting these
  // would turn this endpoint into a way to hand the token to a stranger.
  for (const bad of [
    'https://evil.example.com/owner/repo',
    'https://github.com.evil.example/owner/repo',
    'owner/repo/extra',
    'owner',
    'https://gitlab.com/owner/repo',
    '/etc/passwd',
    'owner/../../etc',
  ]) {
    let threw = false;
    try {
      parseGithubRepo(bad);
    } catch {
      threw = true;
    }
    check(`refuses ${bad}`, threw);
  }
}

console.log('\nReports what a project still holds:');
{
  const remote = await makeRemote('reported');
  const path = await makeProject('reported', { remote });
  await writeFile(join(path, 'file.txt'), 'edited\n');
  await writeFile(join(path, '.gitignore'), 'secrets.env\n');
  await writeFile(join(path, 'secrets.env'), 'TOKEN=1\n');
  await git(path, 'add', '.gitignore');
  await git(path, 'commit', '-m', 'ignore secrets');

  const status = await manager.projectStatus('reported');
  check('sees a git repository', status.isRepo === true);
  check('reports the branch', status.branch === 'main', `got ${status.branch}`);
  check('reports the remote', status.remote === remote, `got ${status.remote}`);
  check('counts uncommitted changes', status.dirty === 1, `got ${status.dirty}`);
  check('counts unpushed commits', status.unpushed === 1, `got ${status.unpushed}`);
  check(
    'lists files git ignores, which no push can save',
    status.ignored.includes('secrets.env'),
    `got ${JSON.stringify(status.ignored)}`,
  );
  check('reports no stashes', status.stashes === 0);
  check('names a missing project rather than inventing one', await manager
    .projectStatus('does-not-exist')
    .then(() => false, (err) => /no project named/.test(err.message)));
}

console.log('\nCalls a conversation what the CLI calls it:');
{
  // Real transcript lines, in the CLI's own spelling. The list used to be titled
  // by the opening user message, which on a resumed or long conversation is
  // whatever happened to be said first — "Now wire it into server.js:" — while
  // the CLI has been writing a name for the conversation all along and showing
  // it in the editor and the terminal.
  const path = await makeProject('named', { repo: false });
  const dir = join(process.env.CLAUDE_HOME, 'projects', (await realpath(path)).replace(/[/.]/g, '-'));
  await mkdir(dir, { recursive: true });

  const user = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
  const aiTitle = (aiTitle) => JSON.stringify({ type: 'ai-title', aiTitle, sessionId: 'x' });
  const write = (id, ...lines) => writeFile(join(dir, `${id}.jsonl`), `${lines.join('\n')}\n`);

  await write('11111111-1111-1111-1111-111111111111',
    user('Now wire it into server.js:'),
    aiTitle('Empty and lingering sessions'),
    user('Done. Committed, pushed, deployed'),
    // Regenerated as the conversation moves on; the current subject is the useful
    // one, so the last one wins.
    aiTitle('Naming conversations in the list'));
  await write('22222222-2222-2222-2222-222222222222',
    user('<command-name>/loop</command-name>'),
    user('the first thing actually typed'));
  await write('33333333-3333-3333-3333-333333333333',
    user('a conversation too young to have been named'));
  await write('44444444-4444-4444-4444-444444444444', '{"type":"ai-title"', user('a torn tail'));
  await write('55555555-5555-5555-5555-555555555555', '');

  const byId = new Map((await manager.listSessions(path)).map((s) => [s.sessionId.slice(0, 1), s.title]));
  check('uses the name the CLI gave the conversation',
    byId.get('1') === 'Naming conversations in the list', byId.get('1'));
  check('an unnamed conversation still falls back to its opening message',
    byId.get('2') === 'the first thing actually typed', byId.get('2'));
  check('and a skill loader is not that message', byId.get('3') === 'a conversation too young to have been named', byId.get('3'));
  // Transcripts are appended to while this reads them, so a half-written last
  // line has to cost the name, not the row.
  check('a torn line is skipped, not fatal', byId.get('4') === 'a torn tail', byId.get('4'));
  check('an empty transcript is still listed', byId.get('5') === 'Untitled conversation', byId.get('5'));
}

console.log('\nRefuses to delete work that exists nowhere else:');
{
  await makeProject('not-a-repo', { repo: false });
  const plain = await attemptRemove('not-a-repo');
  check('a plain directory is not removed', Boolean(plain.error?.blocked));
  check('says why: nothing to push to', /not a git repositor/.test(plain.error?.message || ''));
  check('the directory is still there', await exists(join(root, 'not-a-repo')));

  await makeProject('no-remote', { remote: null });
  const orphan = await attemptRemove('no-remote');
  check('a repo with no remote is not removed', Boolean(orphan.error?.blocked));
  check('says why: no remote', /no git remote/.test(orphan.error?.message || ''));
  check('its files are still there', await exists(join(root, 'no-remote', 'file.txt')));

  const stashRemote = await makeRemote('stashed');
  const stashPath = await makeProject('stashed', { remote: stashRemote });
  await writeFile(join(stashPath, 'file.txt'), 'work in progress\n');
  await git(stashPath, 'stash', 'push', '-m', 'wip');
  const stashed = await attemptRemove('stashed');
  check('a repo with a stash is not removed', Boolean(stashed.error?.blocked));
  check('says why: the stash', /stash/.test(stashed.error?.message || ''));
  check('the stashed repo survives', await exists(join(root, 'stashed')));

  // A remote that cannot be reached: the push fails, so the commits are still
  // only here, and that must stop the delete rather than being logged and ignored.
  const brokenPath = await makeProject('broken-remote', { remote: null });
  await git(brokenPath, 'remote', 'add', 'origin', join(remotes, 'does-not-exist.git'));
  const broken = await attemptRemove('broken-remote');
  check('an unreachable remote stops the delete', Boolean(broken.error?.blocked));
  check(
    'says why: the commits are still only here',
    /only on this machine|verify the push/.test(broken.error?.message || ''),
    broken.error?.message,
  );
  check('the unpushed repo survives', await exists(join(root, 'broken-remote')));
}

console.log('\nCommits, pushes, verifies, then deletes:');
{
  const remote = await makeRemote('done');
  const path = await makeProject('done', { remote });

  // A side branch nobody pushed: the delete must take this with it, not orphan
  // it. Committed before the loose edits below, so those stay on main where the
  // "did the working tree survive" assertions can look for them.
  await git(path, 'checkout', '-b', 'side');
  await writeFile(join(path, 'side.txt'), 'side work\n');
  await git(path, 'add', 'side.txt');
  await git(path, 'commit', '-m', 'side work');
  await git(path, 'checkout', 'main');

  await writeFile(join(path, 'file.txt'), 'final edit\n');
  await writeFile(join(path, 'new.txt'), 'added late\n');

  const result = await manager.removeProject('done');
  check('reports removal', result.removed === true);
  check('the directory is gone', !(await exists(path)));
  check('it was not a forced removal', result.forced === false);
  check(
    'the verify step ran',
    result.steps.some((s) => s.step === 'verify' && s.ok),
    JSON.stringify(result.steps),
  );

  // The remote is the only copy now, so ask it what it actually has.
  const { stdout: files } = await git(remote, 'ls-tree', '-r', '--name-only', 'main');
  check('the late edit reached the remote', files.includes('new.txt'), files);
  const { stdout: content } = await git(remote, 'show', 'main:file.txt');
  check('the uncommitted change reached the remote', content.trim() === 'final edit');
  const { stdout: branches } = await git(remote, 'branch', '--format=%(refname:short)');
  check(
    'the side branch reached the remote too',
    branches.split('\n').map((b) => b.trim()).includes('side'),
    branches,
  );
}

console.log('\nForce is an override, not a shortcut:');
{
  await makeProject('forced', { repo: false });
  const result = await manager.removeProject('forced', { force: true });
  check('force removes a directory that has no remote', result.removed === true);
  check('the directory is gone', !(await exists(join(root, 'forced'))));
  check('the result says it was forced', result.forced === true);
}

console.log('\nCloning refuses what it should before touching the network:');
{
  await makeProject('taken', { repo: false });
  const clash = await manager
    .cloneProject({ repo: 'someone/taken' })
    .then(() => null, (err) => err.message);
  check('will not clone over an existing project', /already exists/.test(clash || ''), clash);

  const offsite = await manager
    .cloneProject({ repo: 'https://evil.example.com/a/b' })
    .then(() => null, (err) => err.message);
  check('will not clone from another host', /owner\/repo/.test(offsite || ''), offsite);

  const named = await manager
    .cloneProject({ repo: 'someone/thing', name: '../escape' })
    .then(() => null, (err) => err.message);
  check('will not clone to a name outside the projects root', Boolean(named), named);
}

await rm(root, { recursive: true, force: true });
await rm(remotes, { recursive: true, force: true });

if (failures.length) {
  console.error(`\nFAIL: ${failures.length} of ${passed + failures.length} checks failed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\n${passed}/${passed} checks passed`);
