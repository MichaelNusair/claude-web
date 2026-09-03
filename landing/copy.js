/**
 * Click-to-copy for the install command. The only script on the page.
 *
 * Progressive enhancement: without it the command is still fully visible and
 * selectable, so the page never depends on this running.
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
