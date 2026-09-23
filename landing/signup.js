/**
 * Reports that someone said yes to the managed service.
 *
 * It does not open the panel. That is a native <details> in index.html, which the
 * browser handles on its own — so this file is pure enhancement, exactly like
 * copy.js: blocked, stale or failing, the signup still works and the ways to reach
 * us are still reachable. A disclosure that needed JavaScript to disclose would
 * hide the contact details from precisely the audience most likely to be running a
 * blocker.
 *
 * Announced as a `triplec:signup` DOM event, which analytics.js listens for. An
 * event rather than a call, so neither file imports the other and either can be
 * absent — nothing here checks whether anyone is listening.
 */
(function () {
  document.querySelectorAll('details[data-signup]').forEach(function (panel) {
    // Once per visit, on opening only. `toggle` also fires on close, and a
    // visitor who folds the panel back up has not changed their mind about
    // anything — counting that would make the number mean "fiddled with it".
    var announced = false;

    panel.addEventListener('toggle', function () {
      if (!panel.open || announced) return;
      announced = true;
      if (typeof window.CustomEvent !== 'function') return;
      panel.dispatchEvent(
        new CustomEvent('triplec:signup', {
          bubbles: true,
          detail: { plan: panel.dataset.signup || '' },
        }),
      );
    });
  });
})();
