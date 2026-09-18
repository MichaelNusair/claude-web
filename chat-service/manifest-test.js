/**
 * One manifest per project, because that is what a second window costs on Android.
 *
 * The platform fact this rests on: Chrome gives an installed web app exactly one
 * window on a phone, and no API opens a second. App *identity* is the only lever —
 * a manifest with an unfamiliar `id` is a distinct application even when served
 * from the same URL, and a distinct application on Android is a distinct icon with
 * its own task. So the whole feature is "the id differs per project", and if that
 * ever stops being true the symptom is silent: adding a second project to the home
 * screen quietly replaces the first icon instead of joining it.
 *
 * The other thing checked here is drift. The fields that are not project-specific
 * are written out in manifest.js rather than read from pwa/manifest.webmanifest,
 * because that file lives somewhere else at runtime. This test is what keeps the
 * duplicate honest.
 *
 * Run: node chat-service/manifest-test.js
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-test-'));
const PROJECTS = path.join(TMP, 'projects');
fs.mkdirSync(path.join(PROJECTS, 'demo'), { recursive: true });
fs.mkdirSync(path.join(PROJECTS, 'other'), { recursive: true });

// Read at import time by session-manager.js, which manifest.js validates through.
process.env.PROJECTS_ROOT = PROJECTS;

const { projectManifest, projectStartUrl, manifestForProject } = await import('./manifest.js');

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

section('A project is a distinct app, which is the entire point:');
const demo = await manifestForProject('demo');
const other = await manifestForProject('other');
ok(demo.id !== other.id, 'two projects share an id, so the second icon replaces the first');
ok(
  demo.id === `/editor/?folder=${encodeURIComponent(path.join(PROJECTS, 'demo'))}`,
  'the id is not the folder URL, so it is not stable across deploys',
);
ok(demo.start_url === demo.id, 'the icon opens somewhere other than the app it identifies');
ok(
  demo.start_url === projectStartUrl(path.join(PROJECTS, 'demo')),
  'the manifest and the switcher disagree about where a project opens',
);
ok(
  /^\/editor\/\?folder=/.test(demo.start_url),
  'a project window opens somewhere other than the editor — /?folder= lands in the chat',
);

section('What the icon says, and how far the window reaches:');
ok(demo.short_name === 'demo', 'the home-screen label is not the bare project name');
ok(/demo/.test(demo.name), 'the installer label does not name the project');
ok(demo.name !== other.name, 'two projects install under the same name');
ok(demo.scope === '/', 'the scope excludes /login, so a lapsed session opens a browser tab');
ok(demo.display === 'standalone', 'the project window is not standalone, so it is a tab');
ok(
  demo.orientation === undefined,
  'the project window is locked to an orientation — a workbench is used in both',
);
ok(
  demo.launch_handler === undefined,
  'launch_handler is pinned, which would stop a desktop opening a second window later',
);

section('The chat app is declared, so a phone can be asked what is installed:');
/*
 * getInstalledRelatedApps() only answers about applications the page's manifest
 * declares as related, and on Android the one question worth asking is which
 * installed app Chrome thinks an /editor/ URL belongs to — the chat app's scope is
 * the whole origin, so it is the first suspect when a project install is refused
 * as "already installed". Both members are load-bearing in opposite directions:
 * without the declaration the check can say nothing, and with
 * prefer_related_applications true the browser would offer that app instead of
 * installing this one.
 */
ok(
  demo.related_applications?.[0]?.platform === 'webapp',
  'the chat app is not declared as a related web app, so the editor’s install check ' +
    'can never name what Chrome thinks is already installed',
);
ok(
  demo.related_applications?.[0]?.url === '/chat/manifest.webmanifest',
  'the declared related app does not point at the chat manifest that index.html links',
);
ok(
  demo.prefer_related_applications === false,
  'prefer_related_applications is not explicitly false — true would make the browser ' +
    'offer the chat app instead of installing this project',
);

section('Everything shared with the chat app still agrees with it:');
const base = JSON.parse(fs.readFileSync(path.join(root, 'pwa', 'manifest.webmanifest'), 'utf8'));
ok(
  JSON.stringify(demo.icons) === JSON.stringify(base.icons),
  'the icons drifted from pwa/manifest.webmanifest — an install with no icon is not installable',
);
ok(demo.theme_color === base.theme_color, 'the theme colour drifted from the chat app');
ok(demo.background_color === base.background_color, 'the background colour drifted from the chat app');

section('A name that cannot be a directory cannot be a manifest:');
for (const bad of ['../etc', 'a/b', '.hidden', '', 'has space']) {
  let refused = false;
  try {
    await manifestForProject(bad);
  } catch {
    refused = true;
  }
  ok(refused, `"${bad}" was accepted as a project name`);
}

section('A manifest is only minted for a project that exists:');
let code = null;
try {
  await manifestForProject('never-created');
} catch (err) {
  code = err.code;
}
ok(
  code === 'ENOPROJECT',
  'a missing project did not report itself as missing, so the route cannot answer 404',
);

section('The builder needs no filesystem, so the route can be reasoned about:');
const pure = projectManifest({ project: 'p', path: '/workspace/projects/p' });
ok(pure.id === '/editor/?folder=%2Fworkspace%2Fprojects%2Fp', 'the path is not encoded into the id');

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
