/**
 * The landing page, checked where it fails without a symptom.
 *
 * Analytics is the reason this file exists. A broken tracker does not break a
 * page: the page loads, looks right, reads right, and reports nothing, and the
 * only evidence is a dashboard that is emptier than it should be — which looks
 * exactly like a page nobody visited. Nothing in a browser will tell you, and no
 * deploy will fail.
 *
 * Four ways that has to go wrong, and one check each:
 *
 *   - the page stops loading the script, or a new page never starts
 *   - the script and the CSP disagree, so every request is refused
 *   - the script and CloudFront disagree about the proxy path, so every request
 *     is a 404 against the marketing page
 *   - the copy button stops announcing copies the script is listening for
 *
 * It runs the real analytics.js — twice, once holding its committed placeholders
 * and once stamped the way a deploy stamps it — in a hand-built stub of the four
 * browser objects it touches. No jsdom: this directory has no node_modules and
 * should not grow one for a file with no dependencies.
 *
 * Run: node landing/landing-test.js
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  PLACEHOLDERS,
  PROXY_PATH,
  landingCsp,
  posthogOrigins,
  renderAnalytics,
} from '../infra/landing-analytics.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(path.join(here, name), 'utf8');

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

const index = read('index.html');
const notFound = read('404.html');
const analytics = read('analytics.js');
const copy = read('copy.js');

// ---------------------------------------------------------------------------
section('Every page the site serves reports itself:');
// ---------------------------------------------------------------------------
ok(index.includes('src="/analytics.js"'), 'index.html loads analytics.js');
ok(notFound.includes('src="/analytics.js"'), '404.html loads it too — a bad link is worth knowing about');

const sections = [...index.matchAll(/data-section="([^"]+)"/g)].map((m) => m[1]);
ok(sections.length >= 5, `index.html names its bands for analytics (${sections.join(', ')})`);
ok(new Set(sections).size === sections.length, 'no two bands share a name, which would merge them in the data');
ok(/data-section="404"/.test(notFound), '404.html names itself as well');

// ---------------------------------------------------------------------------
section('Nothing is tracked until a deployment asks for it:');
// ---------------------------------------------------------------------------
{
  const env = run(analytics);
  ok(env.appended.length === 0, 'the committed script loads no SDK while it holds its placeholders');
  ok(env.warnings.length === 0, 'and says nothing about it: a fork that wants no analytics has no problem');
  ok(
    Object.values(PLACEHOLDERS).every((placeholder) => analytics.includes(placeholder)),
    'every placeholder the deploy substitutes is still in the file',
  );
}

// ---------------------------------------------------------------------------
section('A deployed script tracks a visit as completely as the SDK allows:');
// ---------------------------------------------------------------------------
const stamped = renderAnalytics(analytics, {
  posthogKey: 'phc_testtesttesttesttesttesttest',
  region: 'eu',
  domainName: 'landing.example.com',
});
{
  const env = run(stamped);
  const loaded = env.appended[0];
  ok(env.appended.length === 1, 'it loads the SDK');
  ok(
    loaded && loaded.src === `https://landing.example.com${PROXY_PATH}/static/array.js`,
    'from this site\'s own origin, under the path CloudFront proxies',
  );
  ok(loaded && loaded.async === true, 'without blocking the page on it');

  // The SDK arrives and initialises.
  env.window.posthog = env.sdk;
  loaded.onload();
  const init = env.sdk.calls[0];

  ok(init && init.token === 'phc_testtesttesttesttesttesttest', 'with the configured project key');
  const options = (init && init.options) || {};
  ok(options.api_host === `https://landing.example.com${PROXY_PATH}`, 'events go to the proxy, not to posthog.com');
  ok(options.ui_host === posthogOrigins('eu').app, 'links back to the app point at the right cloud');
  ok(options.person_profiles === 'always', 'anonymous visitors get a person record, so visitors can be counted');
  ok(options.capture_pageview === true && options.capture_pageleave === true, 'pageviews and exits');
  ok(options.capture_dead_clicks === true && options.rageclick === true, 'dead clicks and rage clicks');
  ok(options.capture_heatmaps === true, 'heatmaps');
  ok(options.capture_performance === true, 'load performance and web vitals');
  ok(options.capture_exceptions === true, 'uncaught exceptions on the page');
  ok(options.autocapture && options.autocapture.capture_copied_text === true, 'text lifted off the page');
  ok(options.disable_session_recording === false, 'session replay is on');
  ok(
    options.session_recording && options.session_recording.maskAllInputs === false,
    'and unmasked, which is only acceptable because nothing here is private',
  );
  ok(options.defaults === 'unset', 'no dated default flag, which would start discarding short recordings');
  ok(env.sdk.registered.length === 1, 'and every event carries this visitor\'s display traits');

  const events = Object.keys(env.documentListeners).concat(Object.keys(env.windowListeners));
  ok(events.includes('claude-web:copy'), 'it listens for a copied command');
  ok(events.includes('click'), 'for clicks off the site');
  ok(events.includes('scroll'), 'for how far down the page they got');
  ok(events.includes('visibilitychange') && events.includes('pagehide'), 'and for the visit ending');
  ok(env.observed.length === 2, 'each band is watched for whether it was actually read');

  // The exit event is the one that must survive the page going away.
  env.windowListeners.pagehide[0]();
  const exit = env.sdk.captures.find((c) => c.event === 'page_exit');
  ok(Boolean(exit), 'leaving the page reports what the visit amounted to');
  ok(exit && exit.options && exit.options.transport === 'sendBeacon', 'by beacon, or it would be cancelled with the page');
  ok(
    exit && 'max_scroll_percent' in exit.properties && 'copied_command' in exit.properties,
    'including how far they read and whether they took the command',
  );
}

// ---------------------------------------------------------------------------
section('The copy button and the listener are two files with no shared code:');
// ---------------------------------------------------------------------------
ok(copy.includes("'claude-web:copy'"), 'copy.js announces a copy');
ok(analytics.includes("'claude-web:copy'"), 'analytics.js listens for the same name');
for (const key of ['command', 'method']) {
  ok(
    new RegExp(`${key}:`).test(copy) && analytics.includes(`detail.${key}`),
    `both halves agree the event carries "${key}"`,
  );
}

// ---------------------------------------------------------------------------
section('The policy permits exactly what the page does:');
// ---------------------------------------------------------------------------
{
  const strict = landingCsp({});
  ok(strict.includes("default-src 'none'"), 'with no analytics the page still allows nothing by default');
  ok(!strict.includes('connect-src'), 'and cannot talk to anything at all');
  ok(strict.includes("frame-ancestors 'none'"), 'and cannot be framed');

  const open = landingCsp({ analytics: true });
  ok(open.includes("connect-src 'self'"), 'with analytics it may send events to its own origin');
  ok(open.includes("script-src 'self'"), 'and load the SDK from it');
  ok(/worker-src [^;]*blob:/.test(open), 'and start the replay compression worker');
  ok(!open.includes('posthog.com/'), 'no third-party origin is permitted: everything is proxied');
  ok(!/script-src[^;]*unsafe-eval/.test(open), 'script-src stays strict — no eval, no inline');
  ok(open.includes('https://*.posthog.com'), 'heatmaps may frame the page, which is all that relaxes');
}

// ---------------------------------------------------------------------------
section('One definition of the proxy path, shared by the page and CloudFront:');
// ---------------------------------------------------------------------------
{
  const stack = readFileSync(path.join(here, '..', 'infra', 'lib', 'landing-stack.js'), 'utf8');
  ok(stack.includes('PROXY_PATH'), 'the stack takes the path from infra/landing-analytics.js');
  ok(!stack.includes(`'${PROXY_PATH}`), 'and hardcodes no second copy of it');
  ok(stack.includes('landingCsp('), 'and takes the policy from there too');
  ok(
    !/https?:\/\/[a-z.-]*posthog\.com/.test(analytics),
    'the page hardcodes no PostHog URL: both hosts arrive with the token',
  );
  ok(stamped.includes(PROXY_PATH), 'the stamped page uses the shared path');

  // The deploy fetches the tracker to prove the proxy answers. A path written out
  // by hand there would keep passing after the shared one moved, which is the
  // failure this whole section exists to prevent.
  const deploy = readFileSync(path.join(here, '..', 'deploy-landing.sh'), 'utf8');
  ok(deploy.includes('CFG_LANDING_PH_PATH'), 'the deploy checks the proxy at the exported path');
  ok(!deploy.includes(PROXY_PATH), 'and hardcodes no copy of the path either');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

/**
 * Run analytics.js against a stub of the browser.
 *
 * The script is written to take `window` and `document` as arguments precisely so
 * this is possible without a DOM library: everything it touches goes through one
 * of the two, so a stub is small and the test drives the SDK's arrival itself.
 */
function run(source) {
  const appended = [];
  const observed = [];
  const warnings = [];
  const documentListeners = {};
  const windowListeners = {};
  const recordInto = (map) => (type, handler) => {
    (map[type] = map[type] || []).push(handler);
  };

  const sdk = {
    calls: [],
    captures: [],
    registered: [],
    init(token, options) {
      this.calls.push({ token, options });
      return {
        register: (properties) => sdk.registered.push(properties),
        capture: (event, properties, options) => sdk.captures.push({ event, properties, options }),
      };
    },
  };

  const document = {
    visibilityState: 'visible',
    documentElement: { scrollHeight: 4000 },
    head: { appendChild: (element) => appended.push(element) },
    createElement: () => ({}),
    addEventListener: recordInto(documentListeners),
    // Two bands, the way the real page has several.
    querySelectorAll: () => [fakeSection('hero'), fakeSection('security')],
  };

  const window = {
    document,
    sdk,
    innerHeight: 800,
    pageYOffset: 0,
    location: { href: 'https://landing.example.com/', host: 'landing.example.com' },
    matchMedia: () => ({ matches: false }),
    addEventListener: recordInto(windowListeners),
    console: { warn: (message) => warnings.push(message) },
    CustomEvent: function CustomEvent() {},
    IntersectionObserver: function IntersectionObserver() {
      return { observe: (node) => observed.push(node), unobserve: () => {} };
    },
    posthog: undefined,
  };

  // eslint-disable-next-line no-new-func
  new Function('window', 'document', source)(window, document);

  return { window, document, sdk, appended, observed, warnings, documentListeners, windowListeners };
}

function fakeSection(name) {
  return { getAttribute: (attribute) => (attribute === 'data-section' ? name : null) };
}
