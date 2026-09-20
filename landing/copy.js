/**
 * Click-to-copy for the install command.
 *
 * Progressive enhancement: without it the command is still fully visible and
 * selectable, so the page never depends on this running.
 *
 * Announces each copy as a `claude-web:copy` DOM event, which analytics.js
 * listens for. A DOM event rather than a call, so neither file imports the other
 * and either can be absent: nothing here checks whether anyone is listening.
 */
(function () {
  var RESET_MS = 1600;

  document.querySelectorAll('.copy').forEach(function (button) {
    var hint = button.querySelector('.copy-hint');
    var original = hint ? hint.textContent : '';
    var timer;

    button.addEventListener('click', function () {
      var text = button.dataset.copy || '';

      var done = function (ok) {
        announce(button, text, ok ? 'clipboard' : 'selection');
        if (!hint) return;
        hint.textContent = ok ? 'Copied' : 'Press ⌘C';
        button.classList.toggle('copied', ok);
        clearTimeout(timer);
        timer = setTimeout(function () {
          hint.textContent = original;
          button.classList.remove('copied');
        }, RESET_MS);
      };

      // The async clipboard API needs a secure context and a permission that can
      // be refused, so fall back to selecting the text for the user to copy.
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { selectFallback(button); done(false); });
      } else {
        selectFallback(button);
        done(false);
      }
    });
  });

  /**
   * Tell whoever is listening what was copied and how. Dispatched from the button
   * so a listener can tell which one it was, and wrapped because an old browser
   * without CustomEvent must still copy.
   */
  function announce(button, command, method) {
    if (typeof window.CustomEvent !== 'function') return;
    button.dispatchEvent(
      new CustomEvent('claude-web:copy', {
        bubbles: true,
        detail: { command: command, method: method },
      }),
    );
  }

  /** Select the command so ⌘C / Ctrl+C works even when the clipboard is denied. */
  function selectFallback(button) {
    var code = button.querySelector('code');
    if (!code || !window.getSelection) return;
    var range = document.createRange();
    range.selectNodeContents(code);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
})();
