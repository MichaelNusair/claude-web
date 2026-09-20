#!/usr/bin/env node
/**
 * Analytics for the landing page — the one place its three halves agree.
 *
 * Recording a single visit needs three things to say the same word, and each of
 * them fails *silently* on its own:
 *
 *   1. `landing/analytics.js`        where the browser sends events
 *   2. `infra/lib/landing-stack.js`  the CloudFront behaviours that forward them,
 *                                    and the CSP that permits them at all
 *   3. `deploy-landing.sh`           which writes the project token into the page
 *
 * A mismatch does not produce a broken page. It produces a page that looks
 * perfect and records nothing, and nobody notices for weeks. So the path, the
 * hosts and the policy are defined here, imported by all three, and
 * `landing/landing-test.js` asserts the page still agrees with them.
 *
 * Run directly to stamp a staged copy of the script with the configured token:
 *
 *   node infra/landing-analytics.js dist/landing-site/analytics.js
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { loadConfig } from './config.js';

/**
 * The path on the landing distribution that CloudFront forwards to PostHog.
 *
 * Short and meaningless on purpose. Blocker lists match request paths by name —
 * `/analytics`, `/posthog`, `/track`, `/telemetry`, `/collect` are all in them —
 * and a blocked request is not a degraded visit, it is an invisible one. Serving
 * the SDK and swallowing the events on our own origin is the entire reason this
 * is more than a pasted snippet.
 */
export const PROXY_PATH = '/hq';

/**
 * PostHog's hostnames for a region. Two of them, and the split matters: assets
 * come with cache headers worth honouring, ingestion must never be cached.
 */
export function posthogOrigins(region) {
  const r = region === 'eu' ? 'eu' : 'us';
  return {
    /** Events, replay snapshots, feature flags. */
    api: `${r}.i.posthog.com`,
    /** array.js, the replay recorder, the toolbar, remote config. */
    assets: `${r}-assets.i.posthog.com`,
    /** Where a human reads the data. Never proxied — it is not part of the page. */
    app: `https://${r}.posthog.com`,
  };
}

/**
 * What `deploy-landing.sh` fills in, and what ships in git.
 *
 * The committed `landing/analytics.js` carries the placeholders and refuses to do
 * anything while it still holds them. That is what makes this repository
 * publishable: a fork that never configures a key ships a page that loads a
 * script which returns immediately, rather than one quietly reporting into
 * someone else's PostHog project.
 */
export const PLACEHOLDERS = {
  token: '__POSTHOG_PROJECT_TOKEN__',
  apiHost: '__POSTHOG_API_HOST__',
  uiHost: '__POSTHOG_UI_HOST__',
};

/** Is analytics configured at all? One answer, so nothing disagrees about it. */
export function analyticsEnabled(landing) {
  return Boolean(landing && landing.analytics && landing.analytics.posthogKey);
}

/**
 * Stamp the browser script with this deployment's token and hosts.
 *
 * Throws rather than returning the source untouched when a placeholder has gone
 * missing: renaming one in analytics.js would otherwise ship a page that tracks
 * nothing and deploys perfectly green.
 */
export function renderAnalytics(source, { posthogKey, region, domainName }) {
  const values = {
    token: posthogKey,
    // Absolute rather than a bare path: posthog-js parses this host in several
    // places (asset URLs, its own request bookkeeping), and an absolute URL is the
    // shape all of them expect.
    apiHost: `https://${domainName}${PROXY_PATH}`,
    uiHost: posthogOrigins(region).app,
  };

  let out = source;
  for (const [name, placeholder] of Object.entries(PLACEHOLDERS)) {
    if (!out.includes(placeholder)) {
      throw new Error(
        `landing/analytics.js no longer contains ${placeholder}, so the ${name} ` +
          'cannot be written into it. Either restore the placeholder or update ' +
          'PLACEHOLDERS in infra/landing-analytics.js — a page deployed without ' +
          'this substitution loads the script and records nothing.',
      );
    }
    out = out.split(placeholder).join(values[name]);
  }
  return out;
}

/**
 * The landing page's Content-Security-Policy.
 *
 * Without analytics this is as tight as a page gets: `default-src 'none'` and one
 * allowance per thing the page genuinely uses. With analytics it stays
 * first-party — every PostHog request travels through PROXY_PATH on this very
 * origin, so `'self'` already covers the SDK, the events, the replay recorder and
 * the remote config, and no third-party host appears here at all.
 *
 * Three deliberate relaxations, all of them so PostHog's own tooling works against
 * the real page:
 *
 *   - `worker-src blob: data:` — PostHog's documented baseline; replay compresses
 *     snapshots in a worker created from a blob URL.
 *   - `style-src 'unsafe-inline'` — the heatmap/toolbar overlay injects its own
 *     styles. A styling relaxation on a page with no login, no form and no
 *     user-supplied content; `script-src` stays strict, which is the one that
 *     would matter.
 *   - `frame-ancestors https://*.posthog.com` — so the heatmap view can frame the
 *     page. Heatmap *data* is captured either way; this is what makes it viewable.
 *     The stack drops `X-Frame-Options: DENY` to match, since that header has no
 *     allowlist form and would override the intent.
 */
export function landingCsp({ analytics = false } = {}) {
  const directives = {
    'default-src': ["'none'"],
    'img-src': ["'self'", 'data:'],
    'style-src': ["'self'"],
    'script-src': ["'self'"],
    'font-src': ["'self'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-ancestors': ["'none'"],
  };

  if (analytics) {
    directives['connect-src'] = ["'self'"];
    directives['worker-src'] = ["'self'", 'blob:', 'data:'];
    directives['style-src'] = ["'self'", "'unsafe-inline'"];
    // Wildcarded on PostHog's own advice: their app answers on more than one host
    // under posthog.com, and which one is not a stable fact.
    directives['frame-ancestors'] = ["'self'", 'https://*.posthog.com'];
  }

  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}

// --- CLI --------------------------------------------------------------------
// Only when run directly, so importing this from the stack or from a test never
// reads a config file and never touches the disk.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node infra/landing-analytics.js <path to staged analytics.js>');
    process.exit(2);
  }

  const config = loadConfig();
  if (!analyticsEnabled(config.landing)) {
    // Left holding its placeholders, which the script itself reads as "off".
    console.log('  analytics: none — landing.analytics.posthogKey is empty');
  } else {
    const { posthogKey, region } = config.landing.analytics;
    writeFileSync(
      target,
      renderAnalytics(readFileSync(target, 'utf8'), {
        posthogKey,
        region,
        domainName: config.landing.domainName,
      }),
    );
    console.log(
      `  analytics: PostHog ${posthogKey.slice(0, 12)}… (${region}) ` +
        `via https://${config.landing.domainName}${PROXY_PATH}`,
    );
  }
}
