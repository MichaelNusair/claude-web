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
 * So this hands out one manifest per project, differing in `id`, `start_url` and
 * the name on the icon. Same origin, same code, same login, same push
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
 * The URL a project's window opens on, and the identity Chrome files it under.
 *
 * `?folder=` is code-server's own way to open a workspace and the editor is
 * mounted at /editor/ — the same pair the project switcher navigates to, so an
 * installed icon lands exactly where tapping the project in the switcher does.
 *
 * The id is that same URL. It only has to be unique and same-origin — it is
 * never fetched — and the spec keeps query parameters when resolving it, which is
 * what makes one per folder possible without inventing a second naming scheme.
 */
export function projectStartUrl(path) {
  return `/editor/?folder=${encodeURIComponent(path)}`;
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
  const start = projectStartUrl(path);
  return {
    id: start,
    name: `${project} — Claude Code`,
    short_name: project,
    description: `Claude Code in ${project}, in a window of its own`,
    start_url: start,
    // Everything, not /editor/: signing in redirects to /login, and a scope that
    // excludes the login page turns the first launch after a lapsed session into
    // a browser tab — the exact failure this feature exists to avoid.
    scope: '/',
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
     * claims `/` — the whole origin, including every /editor/ URL here — so when
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
