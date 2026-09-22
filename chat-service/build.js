/**
 * Which build this is, so the app can answer "am I looking at what I shipped".
 *
 * There is no staging here and deploys are frequent, so the question that comes
 * up after every one of them is whether the thing on the phone is the thing that
 * was just pushed. Until this file existed there was no way to ask it from inside
 * the app: `git log` on the box answers for the *checkout*, not for the payload
 * that is actually running — a deploy ships a tarball with no `.git` in it, and
 * `/opt/claude-web` can be several commits behind the tree an agent is looking at
 * in the editor. So the build has to be stamped at the moment it is packed, which
 * is what deploy.sh does: it writes `build.json` into the staged copy of this
 * directory, next to this file.
 *
 * Two fallbacks behind that, because a build that cannot name itself must still
 * answer:
 *
 *   1. **The stamp** — `build.json`, written by deploy.sh. The only source that
 *      can name a commit on a deployed box.
 *   2. **git** — for a checkout run directly (`npm start`, a test, this repo on a
 *      laptop). The stamp is not committed, so without this a development run
 *      would claim to be an unstamped build while the sha is right there.
 *   3. **Asset mtimes** — no commit, but a value that still *changes* when the
 *      payload changes, which is the half of the job that matters for telling a
 *      stale tab from a fresh one. This is what a box deployed before this file
 *      shipped falls back to.
 *
 * `source` says which of the three answered, and the UI shows it: "unstamped" is
 * a true and useful thing to read, and much better than a confident sha that came
 * from somewhere else.
 *
 * Nothing in here throws. It is asked for on every HTML request and by the
 * settings sheet, and a build identity is decoration — a page must never fail to
 * load because the app could not say which version of itself it is.
 */
import { readFile, stat } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
/** The repository, when this is a checkout. Absent from a deployed payload. */
const REPO = join(HERE, '..');

/**
 * Files whose mtime stands in for a build id when nothing stamped one.
 *
 * The same idea as `getAssetVersion` in server.js, and deliberately not shared
 * with it: that one exists to bust a browser cache for three files served to the
 * page, this one to identify a payload. They answer the same number today and
 * should be free to stop.
 */
const ASSETS = ['public/app.js', 'public/style.css', 'server.js'];

const defaultDeps = {
  readStamp: () => readFile(join(HERE, 'build.json'), 'utf8'),
  readVersion: () => readFile(join(REPO, 'package.json'), 'utf8'),
  isCheckout: () => stat(join(REPO, '.git')).then(() => true),
  git: (args) =>
    execFileAsync('git', ['-C', REPO, ...args], { timeout: 4000 }).then(({ stdout }) => stdout),
  mtimes: () =>
    Promise.all(
      ASSETS.map((f) =>
        stat(join(HERE, f))
          .then((s) => s.mtimeMs)
          .catch(() => 0),
      ),
    ),
};

/**
 * What a build id may contain.
 *
 * This value is interpolated into an HTML attribute (see applyBuildStamp) and
 * compared as a string by the client, so it is reduced to characters that cannot
 * end the attribute early. Same reasoning as NAME_PATTERN in manifest.js: what
 * arrives here is a file written on a deploy box, not a constant in this
 * repository, and a stamp with a quote in it must not be able to carry markup
 * into every page the app serves.
 */
const cleanId = (raw) => String(raw ?? '').replace(/[^A-Za-z0-9.+_-]/g, '').slice(0, 40);

/** Anything meant for a human, kept to one line and a sane length. */
const cleanText = (raw, max = 120) =>
  String(raw ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, max);

/** A count of milliseconds since the epoch, or null for "cannot say". */
const asTime = (raw) => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};

/**
 * The string the client compares against the one its page was stamped with.
 *
 * A commit when there is one, and `t<millis>` when there is not — prefixed
 * because an id is only ever compared, never parsed, and a bare number sitting
 * where a sha usually is reads like a truncated one.
 *
 * The `+` for a dirty tree is the honest part: `./deploy.sh --app-only` ships the
 * working tree, which on the shared box it is run from is very often not the
 * commit it claims to be. A sha with nothing to say about that would be a lie
 * that looks precise.
 */
function idFor({ commit, dirty, at }) {
  const base = cleanId(commit) || (at ? `t${at}` : '');
  if (!base) return '';
  return dirty ? `${base}+` : base;
}

/** The app's version, which is the root package.json's — not chat-service's. */
async function packageVersion(deps) {
  try {
    return cleanText(JSON.parse(await deps.readVersion()).version, 20);
  } catch {
    return '';
  }
}

async function fromStamp(deps) {
  let raw;
  try {
    raw = JSON.parse(await deps.readStamp());
  } catch {
    // No stamp on a checkout, and malformed JSON means a deploy wrote something
    // this version cannot read. Both are the next fallback's problem.
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const commit = cleanId(raw.commit);
  const builtAt = asTime(raw.builtAt);
  const dirty = raw.dirty === true;
  const id = idFor({ commit, dirty, at: builtAt });
  // A stamp that identifies nothing is worse than no stamp: it would pin the id
  // to '' and defeat the comparison the client makes.
  if (!id) return null;
  return {
    id,
    version: cleanText(raw.version, 20),
    commit,
    commitAt: asTime(raw.commitAt),
    subject: cleanText(raw.subject),
    dirty,
    builtAt,
    source: 'stamp',
  };
}

async function fromGit(deps) {
  try {
    await deps.isCheckout();
  } catch {
    return null; // A deployed payload. Nothing to ask.
  }
  try {
    // One call, NUL-separated, because a commit subject can contain anything a
    // person can type and splitting it out of a formatted line would be a parser.
    // %h honours core.abbrev, which is what the rest of the repo prints.
    const [commit, at, subject] = (
      await deps.git(['log', '-1', '--format=%h%x00%ct%x00%s'])
    ).split('\0');
    const commitAt = asTime(Number(at) * 1000);
    let dirty = false;
    try {
      // -uno: an untracked scratch file is not a different build of the app, and
      // on the shared checkout on this box there is nearly always one.
      dirty = (await deps.git(['status', '--porcelain', '-uno'])).trim().length > 0;
    } catch {
      /* Left false: an unanswerable question, not a clean tree asserted. */
    }
    const id = idFor({ commit, dirty, at: commitAt });
    if (!id) return null;
    return {
      id,
      version: await packageVersion(deps),
      commit: cleanId(commit),
      commitAt,
      subject: cleanText(subject),
      dirty,
      // What is running was built now, in the sense that matters: there is no
      // packaging step behind a checkout being served directly.
      builtAt: commitAt,
      source: 'git',
    };
  } catch {
    return null;
  }
}

async function fromAssets(deps) {
  let newest = 0;
  try {
    newest = Math.max(0, ...(await deps.mtimes()));
  } catch {
    /* Falls through to the unidentifiable build below. */
  }
  const builtAt = asTime(Math.floor(newest));
  return {
    id: idFor({ commit: '', dirty: false, at: builtAt }),
    version: await packageVersion(deps),
    commit: '',
    commitAt: null,
    subject: '',
    dirty: false,
    builtAt,
    source: builtAt ? 'assets' : 'unknown',
  };
}

let cached = null;

/**
 * This build, resolved once per process.
 *
 * Cached because it cannot change while the process lives — a deploy replaces the
 * files and restarts the unit — and because the alternative is a `git` subprocess
 * per page load on a development checkout.
 *
 * Passing `deps` bypasses the cache, which is how build-test.js drives all three
 * sources without a deploy.
 */
export function buildInfo(deps = null) {
  if (deps) return resolve({ ...defaultDeps, ...deps });
  if (!cached) cached = resolve(defaultDeps);
  return cached;
}

async function resolve(deps) {
  return (await fromStamp(deps)) || (await fromGit(deps)) || (await fromAssets(deps));
}

/** Forget the resolved build. For tests, and for nothing else. */
export function resetBuild() {
  cached = null;
}

/**
 * Write the build id into an HTML shell, so the page knows which build it came
 * from.
 *
 * This is the whole mechanism behind "this tab is out of date". A running page
 * cannot otherwise tell: it has no memory of what the server looked like when it
 * loaded, so it would compare the server's build against the server's build and
 * always agree with itself. Stamped here rather than fetched by the client for
 * the same reason the deployment name is — the value has to be true of *this*
 * response, and a later request would answer for a server that may already have
 * been replaced.
 *
 * A shell with no `<meta name="build">` is returned untouched. build-test.js
 * asserts the tag is still in index.html, because losing it would silently turn
 * the staleness check off rather than break anything visibly.
 */
export function applyBuildStamp(html, id) {
  const value = cleanId(id);
  if (!value) return html;
  return html.replace(
    /(<meta name="build" content=")([^"]*)(")/i,
    (_, before, _content, after) => `${before}${value}${after}`,
  );
}
