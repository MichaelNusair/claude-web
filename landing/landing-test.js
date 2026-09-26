/**
 * The landing page, checked where it fails without a symptom.
 *
 * Analytics is the reason this file exists. A broken tracker does not break a
 * page: the page loads, looks right, reads right, and reports nothing, and the
 * only evidence is a dashboard that is emptier than it should be — which looks
 * exactly like a page nobody visited. Nothing in a browser will tell you, and no
 * deploy will fail.
 *
 * Five ways that has to go wrong, and one check each:
 *
 *   - the page stops loading the script, or a new page never starts
 *   - the script and the CSP disagree, so every request is refused
 *   - the script and CloudFront disagree about the proxy path, so every request
 *     is a 404 against the marketing page
 *   - the copy button stops announcing copies the script is listening for
 *   - the signup stops announcing the one event this page exists to produce
 *
 * Two more sections check things that are not analytics but fail the same silent
 * way. The page runs session replay with masking off, which is only defensible
 * while there is nothing on it to type into — so an input appearing is a privacy
 * regression with no symptom, and is a failure here. And every host the page
 * points at is checked against an allowlist, because this is the one file in the
 * repository that is published to strangers: a private hostname reaching it would
 * look like an ordinary link.
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

/**
 * The page as a browser parses it.
 *
 * Comments are stripped for the markup checks below and *not* for the hostname
 * ones, which is the distinction that matters: a comment is published to anyone
 * who views source, so a private hostname in one still counts — but the sentence
 * in index.html explaining why there is no <form> is not a form.
 */
const markup = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

const index = read('index.html');
const notFound = read('404.html');
const analytics = read('analytics.js');
const copy = read('copy.js');
const signup = read('signup.js');

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
  ok(events.includes('triplec:copy'), 'it listens for a copied command');
  ok(events.includes('triplec:signup'), 'and for the managed signup, which is the page\'s only conversion');
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
  ok(exit && 'signup_intent' in exit.properties, 'and whether they asked for the managed service');

  // Fired by hand, because the stub has no <details> to open: what matters is that
  // the listener is wired to a capture of its own, under a name a funnel can use.
  env.documentListeners['triplec:signup'][0]({ detail: { plan: 'managed' }, target: null });
  const intent = env.sdk.captures.find((c) => c.event === 'managed_signup_intent');
  ok(Boolean(intent), 'opening the signup reports the intent as its own event');
  ok(intent && intent.properties.plan === 'managed', 'naming which plan was asked for');
  ok(
    intent && 'seconds' in intent.properties && 'sections_viewed' in intent.properties,
    'and how much of the page they had read before deciding',
  );
}

// ---------------------------------------------------------------------------
section('A section taller than the screen is still reported as read:');
// ---------------------------------------------------------------------------
// This is a regression test with a bill attached. The observer used to ask for
// `threshold: 0.5`, and a threshold is a fraction *of the section*, so a section
// taller than twice the viewport can never reach it. On a 390px phone the real
// page's `pricing` and `security` bands are ~1740px tall and peak at 48% — so
// between launch and 2026-09-26 no phone visitor ever reported reading either of
// the two bands the business cares most about, including one who scrolled the page
// end to end and clicked a link inside `security`. The funnel said nobody looked.
{
  const env = run(stamped);
  env.window.posthog = env.sdk;
  env.appended[0].onload();
  const { observers } = env;
  ok(observers.length === 1, 'one observer watches the bands');
  const options = (observers[0] && observers[0].options) || {};

  ok(!options.threshold, `it asks for no fraction of the section (threshold: ${options.threshold})`);
  ok(
    typeof options.rootMargin === 'string' && /^-\d+% 0px -\d+% 0px$/.test(options.rootMargin),
    `it narrows the viewport to a band instead (${options.rootMargin})`,
  );

  // The point of the band, stated as the thing that used to be false: height cannot
  // decide whether a section is reportable.
  const viewport = 844;
  for (const height of [200, viewport, viewport * 2 + 1, viewport * 10]) {
    ok(
      reportable(options, height, viewport),
      `a ${height}px section can be reported on an ${viewport}px screen`,
    );
  }
  ok(!reportable({ threshold: 0.5 }, viewport * 2 + 1, viewport), 'where the old threshold could not');
}

// ---------------------------------------------------------------------------
section('The copy button and the listener are two files with no shared code:');
// ---------------------------------------------------------------------------
ok(copy.includes("'triplec:copy'"), 'copy.js announces a copy');
ok(analytics.includes("'triplec:copy'"), 'analytics.js listens for the same name');
for (const key of ['command', 'method']) {
  ok(
    new RegExp(`${key}:`).test(copy) && analytics.includes(`detail.${key}`),
    `both halves agree the event carries "${key}"`,
  );
}

// ---------------------------------------------------------------------------
section('The signup reports itself, and works without the script that reports it:');
// ---------------------------------------------------------------------------
ok(index.includes('src="/signup.js"'), 'index.html loads signup.js');
ok(signup.includes("'triplec:signup'"), 'signup.js announces the intent');
ok(analytics.includes("'triplec:signup'"), 'analytics.js listens for the same name');
ok(/detail: \{ plan:/.test(signup) && analytics.includes('detail.plan'), 'both halves agree it carries "plan"');
ok(/<details class="signup" data-signup="/.test(index), 'the panel is a native <details>, which the browser opens on its own');
ok(
  !/\bhidden\b/.test(index.slice(index.indexOf('class="signup"'), index.indexOf('</details>'))),
  'so the ways to reach us are not hidden behind JavaScript running',
);
ok(
  !/\.open\s*=|removeAttribute|classList/.test(signup),
  'and signup.js only reports: it never opens the panel, so a blocker cannot break the signup',
);
ok(/panel\.open/.test(signup), 'it reports on opening only, not on folding the panel back up');

// ---------------------------------------------------------------------------
section('Nothing on the page is private, which is what unmasked replay assumes:');
// ---------------------------------------------------------------------------
// analytics.js turns masking off and says in its own header that the day an input
// appears is the day to revisit it. This is that day arriving as a failed build
// rather than as a recording of somebody's email address.
for (const [name, html] of Object.entries({ 'index.html': index, '404.html': notFound })) {
  ok(
    !/<(input|textarea|select|form)\b/i.test(markup(html)),
    `${name} has no field or form for a visitor to type into`,
  );
}

// ---------------------------------------------------------------------------
section('The one published page points only where it means to:');
// ---------------------------------------------------------------------------
// This is the single artefact in the repository that strangers read, so a hostname
// belonging to somebody's private deployment would be an ordinary-looking link
// with nothing to flag it. Checked as an allowlist rather than a search for the
// hostnames to avoid, because naming those here would publish them too.
{
  const ALLOWED_HOSTS = ['triplec.host', 'github.com'];
  for (const [name, html] of Object.entries({ 'index.html': index, '404.html': notFound })) {
    const hosts = [...new Set([...html.matchAll(/https?:\/\/([^/"'\s>]+)/g)].map((m) => m[1]))];
    const strangers = hosts.filter((host) => !ALLOWED_HOSTS.includes(host));
    ok(strangers.length === 0, `${name} links only to ${ALLOWED_HOSTS.join(' and ')}${strangers.length ? ` — found ${strangers.join(', ')}` : ''}`);

    const mail = [...new Set([...html.matchAll(/mailto:([^"?]+)/g)].map((m) => m[1]))];
    const offBrand = mail.filter((address) => !address.endsWith('@triplec.host'));
    ok(offBrand.length === 0, `${name} shows no address off the brand's own domain${offBrand.length ? ` — found ${offBrand.join(', ')}` : ''}`);
  }

  // A rename that reached the buttons but not the clone command would hand a
  // visitor a URL that 404s, and the page would look entirely correct.
  const slugs = [...new Set([...index.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)/g)].map((m) => m[1].replace(/\.git$/, '')))];
  ok(slugs.length === 1, `every link and the clone command name one repository (${slugs.join(', ')})`);
  ok(index.includes(`data-copy="git clone https://github.com/${slugs[0]}.git"`), 'and that is the repository the copy button hands over');
  ok(index.includes('<meta property="og:url" content="https://triplec.host/">'), 'and a share of it resolves to the site itself');
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
  const observers = [];
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
    IntersectionObserver: function IntersectionObserver(callback, options) {
      observers.push({ callback, options });
      return { observe: (node) => observed.push(node), unobserve: () => {} };
    },
    posthog: undefined,
  };

  // eslint-disable-next-line no-new-func
  new Function('window', 'document', source)(window, document);

  return {
    window,
    document,
    sdk,
    appended,
    observed,
    observers,
    warnings,
    documentListeners,
    windowListeners,
  };
}

/**
 * Could a section of this height ever satisfy these observer options?
 *
 * The browser intersects the section with the root, shrunk or grown by `rootMargin`,
 * and compares the overlap against `threshold` as a fraction of the *section*. So the
 * best a section can do is cover the whole root: `root / height`, capped at 1. A
 * threshold above that is unreachable at any scroll position; a threshold of 0 needs
 * only a touch, which any section on the page will manage.
 */
function reportable(options, height, viewport) {
  const margins = String(options.rootMargin || '0px 0px 0px 0px').split(/\s+/);
  const edge = (value) => (/%$/.test(value) ? (parseFloat(value) / 100) * viewport : parseFloat(value) || 0);
  const root = viewport + edge(margins[0]) + edge(margins[2] === undefined ? margins[0] : margins[2]);
  if (root <= 0) return false;
  const threshold = options.threshold || 0;
  return threshold === 0 ? true : Math.min(1, root / height) >= threshold;
}

function fakeSection(name) {
  return { getAttribute: (attribute) => (attribute === 'data-section' ? name : null) };
}
