/**
 * Visitor analytics: PostHog, served and ingested through this site's own origin.
 *
 * Why the proxy rather than PostHog's paste-in snippet: requests to posthog.com
 * are on every blocker list, and a blocked request is not a degraded visit, it is
 * an invisible one. Everything here — the SDK, the events, the replay recorder,
 * the remote config — goes to a path on this domain that CloudFront forwards. The
 * path, the hosts and the CSP that permits it all live in
 * infra/landing-analytics.js, which is also what stamps the three values below
 * into this file at deploy time.
 *
 * Deliberately maximal, because this page has nothing to protect: no login, no
 * form, no user-supplied content, nothing on screen that is anybody's but the
 * author's. So: full session replay with no masking, autocapture, heatmaps, dead
 * clicks, rage clicks, web vitals, console logs, uncaught exceptions — plus the
 * six custom events that answer what the page actually exists to answer (did they
 * take the command, did they ask for the managed service, did they read the
 * security section, how far down did they get, where did they go instead). If a
 * form or a login ever appears here, revisit the masking options below before
 * shipping it.
 *
 * That last condition is why the managed signup is a disclosure and a mailto
 * rather than a field to type an address into: it is the one place on the page
 * where a form was the obvious thing to build. landing-test.js fails the build if
 * an input appears while the masking below is off, so this stays a decision and
 * does not quietly become a mistake.
 *
 * Progressive enhancement, like copy.js: the page must work with this file
 * blocked, stale or failing, so nothing here may throw into anything else and
 * nothing on the page may depend on it having run.
 */
(function (window, document) {
  'use strict';

  // Written by deploy-landing.sh from triplec.config.json (landing.analytics).
  // Left as placeholders in git — and in any fork that never configures a key —
  // in which case this file returns below and does nothing at all.
  var TOKEN = '__POSTHOG_PROJECT_TOKEN__';
  var API_HOST = '__POSTHOG_API_HOST__';
  var UI_HOST = '__POSTHOG_UI_HOST__';

  if (TOKEN.indexOf('phc_') !== 0) return;

  /** Scroll milestones, reported once each. */
  var DEPTHS = [25, 50, 75, 100];
  /** How long a section must hold half the viewport before it counts as read. */
  var DWELL_MS = 1000;

  var state = {
    openedAt: Date.now(),
    visibleMs: 0,
    visibleSince: document.visibilityState === 'hidden' ? 0 : Date.now(),
    maxScroll: 0,
    sections: [],
    copied: false,
    signup: false,
    exited: false,
  };

  // The SDK, from our own origin. Loaded here rather than by PostHog's inline
  // snippet because the CSP allows no inline script, and because with no stub to
  // queue calls into there is one ordering to reason about: it is loaded, then it
  // is initialised, then it is wired.
  var script = document.createElement('script');
  script.src = API_HOST + '/static/array.js';
  script.async = true;
  script.onload = start;
  document.head.appendChild(script);

  function start() {
    var posthog = window.posthog;
    if (!posthog || typeof posthog.init !== 'function') return;

    try {
      var ph =
        posthog.init(TOKEN, {
          api_host: API_HOST,
          // The real app, so replay links and the heatmap toolbar point somewhere
          // a human can log in to. Never proxied.
          ui_host: UI_HOST,

          // Left unset on purpose. Each dated default flips a bundle of
          // behaviours at once, and among them is strictMinimumDuration, which
          // *discards* short recordings — exactly the two-second bounces this page
          // most needs to see. Opt into them individually if ever wanted.
          defaults: 'unset',

          // A person record for anonymous visitors too, not just identified ones.
          // Nobody ever logs in here, so 'identified_only' would mean no person
          // properties, no returning-visitor view and no unique-visitor counts.
          person_profiles: 'always',

          autocapture: {
            // The page's entire call to action is a command to copy, so what gets
            // selected and lifted off it is a primary signal rather than a curio.
            capture_copied_text: true,
          },
          capture_pageview: true,
          capture_pageleave: true,
          capture_dead_clicks: true,
          capture_heatmaps: true,
          // Navigation timing and web vitals: a marketing page that loads slowly
          // on a phone is the most likely reason a visit ends early.
          capture_performance: true,
          capture_exceptions: true,
          rageclick: true,

          // --- Session replay --------------------------------------------------
          disable_session_recording: false,
          enable_recording_console_log: true,
          session_recording: {
            // Nothing on this page is private, and a replay of masked blocks is
            // not worth watching. There is no input on the page at all; the day
            // one appears, this is the line to change.
            maskAllInputs: false,
            maskTextSelector: undefined,
          },
        }) || posthog;

      // On every event from this visitor, so segmenting never needs a join.
      ph.register({
        prefers_dark: matches('(prefers-color-scheme: dark)'),
        coarse_pointer: matches('(pointer: coarse)'),
        standalone_display: matches('(display-mode: standalone)'),
      });

      wire(ph);
    } catch (err) {
      // An analytics failure is not a page failure. Swallow it, but leave it in
      // the console so it is findable when the numbers look wrong.
      if (window.console) window.console.warn('analytics: ' + err);
    }
  }

  /** Media query test that survives a browser without matchMedia. */
  function matches(query) {
    if (!window.matchMedia) return null;
    try {
      return window.matchMedia(query).matches;
    } catch (err) {
      return null;
    }
  }

  function wire(ph) {
    // --- What they took away ---------------------------------------------------
    // copy.js dispatches this on every copy, successful or fallen back to a
    // selection. Autocapture already records the click; this records *which*
    // command and whether the clipboard actually took it.
    document.addEventListener('triplec:copy', function (event) {
      var detail = event.detail || {};
      state.copied = true;
      ph.capture('command_copied', {
        command: detail.command,
        method: detail.method,
        section: sectionOf(event.target),
      });
    });

    // --- Who said yes ----------------------------------------------------------
    // The one conversion on the page. signup.js dispatches this when the managed
    // panel is opened, which is the click that means "bill me" — so it is captured
    // under a name of its own rather than left to autocapture, where it would be an
    // anonymous <summary> among every other click.
    //
    // `seconds` is on it because the interesting question is not how many people
    // clicked but whether they clicked before or after reading the part that says
    // nobody is being charged yet.
    document.addEventListener('triplec:signup', function (event) {
      var detail = event.detail || {};
      state.signup = true;
      ph.capture('managed_signup_intent', {
        plan: detail.plan,
        section: sectionOf(event.target),
        seconds: secondsVisible(),
        sections_viewed: state.sections.slice(),
        max_scroll_percent: state.maxScroll,
      });
    });

    // --- Where they went instead ----------------------------------------------
    // Every link off this origin, named by destination rather than by DOM path, so
    // a funnel can be built on it without reading selectors.
    document.addEventListener(
      'click',
      function (event) {
        var link = closestLink(event.target);
        if (!link) return;
        var href = link.getAttribute('href') || '';
        if (href.indexOf('http') !== 0) return;
        var url = parse(href);
        if (!url || url.host === window.location.host) return;
        ph.capture('outbound_click', {
          href: href,
          host: url.host,
          path: url.pathname,
          text: (link.textContent || '').trim().slice(0, 80),
          section: sectionOf(link),
        });
      },
      true,
    );

    // --- How far down they got -------------------------------------------------
    var reported = {};
    window.addEventListener(
      'scroll',
      function () {
        var percent = scrollPercent();
        if (percent > state.maxScroll) state.maxScroll = percent;
        for (var i = 0; i < DEPTHS.length; i += 1) {
          var depth = DEPTHS[i];
          if (percent >= depth && !reported[depth]) {
            reported[depth] = true;
            ph.capture('scroll_depth', { percent: depth, seconds: secondsVisible() });
          }
        }
      },
      { passive: true },
    );

    // --- Which parts they actually read ---------------------------------------
    // Half the section in view for a second, rather than a pixel of it in view for
    // an instant: scrolling past something is not reading it.
    if (window.IntersectionObserver) {
      var timers = {};
      var observer = new window.IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            var name = entry.target.getAttribute('data-section');
            if (!name) return;
            if (!entry.isIntersecting) {
              clearTimeout(timers[name]);
              return;
            }
            timers[name] = setTimeout(function () {
              observer.unobserve(entry.target);
              state.sections.push(name);
              ph.capture('section_viewed', { section: name, seconds: secondsVisible() });
            }, DWELL_MS);
          });
        },
        { threshold: 0.5 },
      );
      Array.prototype.forEach.call(document.querySelectorAll('[data-section]'), function (section) {
        observer.observe(section);
      });
    }

    // --- How the visit ended ---------------------------------------------------
    // $pageleave already records that they left; this records what they had done
    // by then, in one event that a single insight can read.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        if (state.visibleSince) state.visibleMs += Date.now() - state.visibleSince;
        state.visibleSince = 0;
        exit(ph);
      } else if (!state.visibleSince) {
        state.visibleSince = Date.now();
      }
    });
    window.addEventListener('pagehide', function () {
      exit(ph);
    });
  }

  function exit(ph) {
    if (state.exited) return;
    state.exited = true;
    ph.capture(
      'page_exit',
      {
        visible_seconds: secondsVisible(),
        open_seconds: Math.round((Date.now() - state.openedAt) / 1000),
        max_scroll_percent: state.maxScroll,
        sections_viewed: state.sections.slice(),
        sections_viewed_count: state.sections.length,
        copied_command: state.copied,
        signup_intent: state.signup,
      },
      // The page is going away; a normal XHR would be cancelled with it.
      { transport: 'sendBeacon' },
    );
  }

  function secondsVisible() {
    var live = state.visibleSince ? Date.now() - state.visibleSince : 0;
    return Math.round((state.visibleMs + live) / 1000);
  }

  /** How far through the document the bottom of the viewport has reached. */
  function scrollPercent() {
    var doc = document.documentElement || {};
    var height = (doc.scrollHeight || 0) - (window.innerHeight || 0);
    if (height <= 0) return 100;
    var percent = Math.round(((window.pageYOffset || 0) / height) * 100);
    return Math.max(0, Math.min(100, percent));
  }

  /** The nearest enclosing <a>, since a click usually lands on a child of one. */
  function closestLink(node) {
    while (node && node !== document) {
      if (node.tagName === 'A') return node;
      node = node.parentNode;
    }
    return null;
  }

  /** Which part of the page an element sits in, by the nearest data-section. */
  function sectionOf(node) {
    while (node && node !== document) {
      if (node.getAttribute) {
        var name = node.getAttribute('data-section');
        if (name) return name;
      }
      node = node.parentNode;
    }
    return null;
  }

  function parse(href) {
    try {
      return new URL(href, window.location.href);
    } catch (err) {
      return null;
    }
  }
})(window, document);
