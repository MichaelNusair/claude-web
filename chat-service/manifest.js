/**
 * A web app manifest per project, so a project can be its own window.
 *
 * The problem it solves is an Android one. Chrome gives an installed web app
 * exactly one window — its own documentation says so, in the course of explaining
 * why `launch_handler` defaults differ by platform: "mobile devices only support
 * single clients", while "desktop devices support multiple windows". So on a
 * laptop you can have a window per project and on a phone you cannot, and no
 * amount of JavaScript changes that: there is no API that opens a second window
 * of an installed app.
 *
 * What there *is* is app identity. Per the manifest spec, a manifest whose `id`
 * does not match an installed app "is a description of a distinct application,
 * even if it is served from the same URL as another application" — and a distinct
 * application on Android is a distinct home-screen icon with a task of its own in
 * the recents switcher. Which is the thing that was actually wanted: another
 * window, that looks like another app on the home screen.
 *
 * Identity alone turned out not to be enough, though, and the missing half is
 * `scope`: it is a *path prefix*, matched without the query string, so a set of
 * projects that differ only in `?folder=` are one app to Android whatever their ids
 * say — see projectWindowPath below, which is why /p/<name>/ exists.
 *
 * So this hands out one manifest per project, differing in `id`, `start_url`, `scope`
 * and the name on the icon. Same origin, same code, same login, same push
 * subscription — one install per project, once.
 *
 * Everything not project-specific is duplicated from pwa/manifest.webmanifest
 * rather than read out of it, because that file is not in this directory at
 * runtime (deploy.sh copies it into public/) and reaching for it through two
 * different relative paths is worse than one assertion. manifest-test.js compares
 * the two and fails if they drift.
 */
import { stat } from 'fs/promises';
import { projectPathFor } from './session-manager.js';

/** Where the icons live, as the served manifest sees them: nginx puts the chat's assets under /chat/. */
const ICONS = [
  { src: '/chat/pwa-icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/chat/pwa-icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/chat/pwa-icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];

const THEME_COLOR = '#141413';

/**
 * The path a project's window lives under, which is the whole reason it can be its
 * own app.
 *
 * This segment carries no information — `?folder=` below already names the folder,
 * and nginx forwards the query to code-server without reading it — so it looks
 * redundant and is not. **A manifest's scope is a path prefix, and scope matching
 * ignores the query string.** While every project's start_url was
 * `/editor/?folder=<path>`, every project manifest described an app with the same
 * scope as every other one *and* the same scope as the chat app, so Android had a
 * single installed web app claiming the whole origin and refused every install after
 * the first as "already installed". A differing `id` does not rescue that: on Android
 * the installed WebAPK claims URLs by scope.
 *
 * So a window per project needs a path per project. Hence /p/<name>/, whose only job
 * is to be a scope that nothing else covers. The route is in
 * infra/userdata/bootstrap.sh, which means this cannot be changed by --app-only.
 */
export function projectWindowPath(project) {
  return `/p/${encodeURIComponent(project)}/`;
}

/**
 * The URL a project's window opens on.
 *
 * `?folder=` is code-server's own way to open a workspace, and it stays in the
 * browser's URL rather than being swallowed by the route, because the overlay reads
 * it to know which project it is in — `folder()` in pwa/mobile-overlay.js. nginx
 * forwards the query to code-server unchanged, so the path segment and the query are
 * two views of one fact and this function is what keeps them agreeing.
 */
export function projectStartUrl(project, path) {
  return `${projectWindowPath(project)}?folder=${encodeURIComponent(path)}`;
}

/**
 * The manifest for one project.
 *
 * `short_name` is what Android writes under the icon, so it is the bare project
 * name; `name` is the longer label used in the installer and app info, and says
 * what the thing is.
 *
 * Two deliberate omissions:
 *   - `orientation`. The chat app asks for portrait; a workbench is used in both,
 *     and locking the editor to portrait would make a phone in landscape worse
 *     than the browser it replaced.
 *   - `launch_handler`. The default lets a desktop browser open a second window
 *     of the same project, which is wanted later — pinning `focus-existing` here
 *     would be building the ceiling before the room.
 */
export function projectManifest({ project, path }) {
  const home = projectWindowPath(project);
  return {
    // The path, not the start_url: an id is app identity, and identity should not
    // change if the folder a project lives in ever moves.
    id: home,
    name: `${project} — Claude Code`,
    short_name: project,
    description: `Claude Code in ${project}, in a window of its own`,
    start_url: projectStartUrl(project, path),
    /*
     * The one field this whole feature turns on. See projectWindowPath: scope is a
     * path prefix compared without the query string, so this must be per-project or
     * every project is the same app to Android and only the first one installs.
     *
     * The cost, accepted deliberately: /login is outside this scope, so the first
     * launch after a lapsed session leaves the app's own window and shows Chrome's
     * toolbar until the redirect back. A scope wide enough to include the login page
     * is a scope wide enough to collide, and a login that looks like a browser beats
     * a project that cannot be installed at all.
     */
    scope: home,
    display: 'standalone',
    background_color: THEME_COLOR,
    theme_color: THEME_COLOR,
    icons: ICONS,
    /*
     * The chat app, declared as a relation so a phone can be asked about it.
     *
     * `navigator.getInstalledRelatedApps()` only answers about applications the
     * current page's manifest declares, and this is the one question worth asking on
     * Android: which installed app does Chrome think this page belongs to? Chrome
     * matches an installed web app to a URL by *scope*, and the chat app's manifest
     * claims `/` — the whole origin, including every /p/<name>/ URL here — so when
     * Chrome refuses a project install as "already installed", the chat icon is the
     * first suspect, and this is what lets the editor's install check name it
     * instead of guessing. See explainInstall in pwa/mobile-overlay.js.
     *
     * `prefer_related_applications` is stated rather than left to its default,
     * because it is the one member that would turn this diagnostic into a
     * regression: true tells the browser to offer the related app instead of
     * installing this one.
     */
    related_applications: [{ platform: 'webapp', url: '/chat/manifest.webmanifest' }],
    prefer_related_applications: false,
  };
}

/**
 * Resolve a project name to a manifest, or throw.
 *
 * `projectPathFor` is the same validator the rest of the service uses, so a name
 * that cannot be a directory cannot be a manifest either. The existence check is
 * what stops this from being an oracle for arbitrary names: a manifest is only
 * minted for a project that is really there.
 */
export async function manifestForProject(project) {
  const path = projectPathFor(project); // throws on a name that is not a name
  const info = await stat(path).catch(() => null);
  if (!info?.isDirectory()) {
    const err = new Error('no such project');
    err.code = 'ENOPROJECT';
    throw err;
  }
  return projectManifest({ project, path });
}
