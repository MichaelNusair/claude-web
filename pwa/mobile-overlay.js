/*
 * Mobile overlay for code-server: voice dictation + project switcher.
 *
 * Design constraint learned the hard way: do not touch the workbench's DOM or
 * CSS. VS Code positions its parts with absolute inline styles computed in JS,
 * so hiding or resizing them via CSS desynchronises the layout and paints a
 * blank gray screen. Everything here lives in its own fixed-position container
 * appended to <body>, above the workbench, and never restyles it.
 *
 * The Claude Code panel is a webview iframe with its own document, so its input
 * cannot be written to directly. (Desktop VS Code serves webviews from
 * vscode-cdn.net; code-server serves them from this origin under
 * /stable-<commit>/static/. Either way they are a separate window.) Dictated
 * text is therefore delivered the two ways that work from outside a webview:
 *   1. clipboard — one tap to paste, works everywhere
 *   2. synthetic keystrokes into whatever has focus, for same-origin inputs
 * Both are offered; the UI is explicit about which it used.
 */
(function () {
  'use strict';

  /*
   * Top-level document only.
   *
   * nginx injects this script into every text/html response code-server serves,
   * and the workbench serves its webview container from this same origin
   * (/stable-<commit>/static/out/vs/workbench/contrib/webview/browser/pre/).
   * So the Claude Code panel's iframe was getting the script too, and mounting a
   * second mic and a second project switcher a few pixels off the first pair.
   * The __claudeMobileOverlay flag below cannot catch that: the iframe is a
   * different window, with its own globals.
   *
   * Comparing window references never throws, even cross-origin — only reading
   * properties off a foreign window does. So this is safe in both the
   * same-origin webview code-server actually uses and the vscode-cdn.net one
   * desktop VS Code uses.
   */
  if (window.top !== window.self) return;

  if (window.__claudeMobileOverlay) return;
  window.__claudeMobileOverlay = true;

  // -------------------------------------------- survive a browser refresh
  /*
   * Keep the server-side extension host alive when this page goes away, so a
   * refresh or a device switch doesn't kill the Claude turn in flight.
   *
   * VS Code Web already holds a disconnected extension host for
   * VSCODE_RECONNECTION_GRACE_TIME. What defeated it: on unload the client
   * sends a Disconnect control frame, which means "deliberate, dispose now" —
   * the server logs "The client has disconnected gracefully" and tears the host
   * down about two seconds later, mid-request.
   *
   * The earlier attempt at this rewrote workbench.js to skip that send. It
   * black-screened the editor on mobile, twice, and was reverted. This does the
   * same job from outside: drop the one frame on its way out of the socket, and
   * leave VS Code's own code untouched. If this script fails to load or throws,
   * the editor is exactly stock — the failure mode is "the old bug is back",
   * not "a broken bundle no browser can render".
   *
   * Wire format (out/vs/base/parts/ipc, confirmed against this build): a
   * 13-byte header — type u8, id u32be, ack u32be, dataLength u32be — followed
   * by dataLength bytes. Type 5 is Disconnect and carries no payload. The
   * writer can coalesce several frames into one send(), so walk the buffer and
   * strip only complete zero-length type-5 frames; anything that doesn't parse
   * as a clean frame sequence is passed through untouched rather than guessed
   * at. Dropping a byte of real protocol traffic would break the session far
   * worse than the bug being fixed.
   */
  const DISCONNECT = 5;
  const HEADER = 13;

  function stripDisconnectFrames(buf) {
    let offset = 0;
    const keep = [];
    let stripped = false;

    while (offset < buf.length) {
      if (offset + HEADER > buf.length) return null; // truncated: not ours to edit
      const type = buf[offset];
      const dataLength =
        (buf[offset + 9] << 24) |
        (buf[offset + 10] << 16) |
        (buf[offset + 11] << 8) |
        buf[offset + 12];
      if (dataLength < 0) return null;
      const end = offset + HEADER + dataLength;
      if (end > buf.length) return null; // header disagrees with the buffer
      if (type === DISCONNECT && dataLength === 0) stripped = true;
      else keep.push(buf.subarray(offset, end));
      offset = end;
    }

    if (!stripped) return null; // nothing to do; send the original object
    const total = keep.reduce((n, f) => n + f.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const frame of keep) {
      out.set(frame, at);
      at += frame.length;
    }
    return out;
  }

  try {
    const nativeSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        // Only binary protocol frames are candidates; strings are not.
        if (data && typeof data !== 'string') {
          const view =
            data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : data.buffer instanceof ArrayBuffer
                ? new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength)
                : null;
          if (view && view.length >= HEADER) {
            const filtered = stripDisconnectFrames(view);
            if (filtered) {
              // Every frame was a Disconnect: send nothing at all.
              if (filtered.length === 0) return;
              return nativeSend.call(this, filtered);
            }
          }
        }
      } catch {
        // Never let this break a send; fall through to the original.
      }
      return nativeSend.call(this, data);
    };
  } catch {
    /* stock behaviour: refresh kills the turn, as before */
  }

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  // ---------------------------------------------------------------- styles
  // Scoped to our own ids/classes only. Nothing here selects .monaco-* or .part.
  const css = `
  /*
   * Docked to the LEFT edge, vertically centred — deliberately not the bottom
   * right, where Claude's own send/stop controls live. A floating button there
   * covered the stop button and made it impossible to interrupt the agent.
   * Also small and semi-transparent until touched, so it never hides content.
   */
  #cmo-fab {
    position: fixed; z-index: 2147483000;
    left: max(6px, env(safe-area-inset-left));
    top: 50%; transform: translateY(-50%);
    display: flex; flex-direction: column; gap: 8px;
    opacity: .45; transition: opacity .15s;
  }
  #cmo-fab:hover, #cmo-fab:focus-within, #cmo-fab.cmo-active { opacity: 1; }
  .cmo-btn {
    width: 40px; height: 40px; border-radius: 50%; border: none;
    display: grid; place-items: center; cursor: pointer;
    background: #d97757; color: #fff;
    box-shadow: 0 2px 8px rgba(0,0,0,.4);
    font-size: 17px; line-height: 1;
    -webkit-tap-highlight-color: transparent; touch-action: manipulation;
  }
  .cmo-btn.cmo-secondary { background: #3a3a38; font-size: 15px; }
  .cmo-btn:active { transform: scale(.93); }
  .cmo-btn.cmo-rec { background: #e05252; animation: cmo-pulse 1.4s infinite; }
  @keyframes cmo-pulse {
    0%,100% { box-shadow: 0 0 0 0 rgba(224,82,82,.55), 0 4px 14px rgba(0,0,0,.45) }
    50%     { box-shadow: 0 0 0 16px rgba(224,82,82,0), 0 4px 14px rgba(0,0,0,.45) }
  }
  /*
   * Speaking has to be visible on the bar, not only in the sheet: the sheet is
   * dismissed by tapping beside it, and the voice carries on afterwards — so this
   * button is the only Stop there is at that point. Same pulse as recording, in
   * the accent colour rather than the recording red.
   */
  .cmo-btn.cmo-speaking { background: #d97757; animation: cmo-speak-pulse 1.6s infinite; }
  @keyframes cmo-speak-pulse {
    0%,100% { box-shadow: 0 0 0 0 rgba(217,119,87,.55), 0 4px 14px rgba(0,0,0,.45) }
    50%     { box-shadow: 0 0 0 14px rgba(217,119,87,0), 0 4px 14px rgba(0,0,0,.45) }
  }

  #cmo-sheet {
    position: fixed; inset: 0; z-index: 2147483001;
    display: none; align-items: flex-end;
    background: rgba(0,0,0,.55);
  }
  #cmo-sheet.cmo-open { display: flex; }
  .cmo-panel {
    width: 100%; background: #1e1e1c; color: #f5f4ef;
    border-radius: 18px 18px 0 0;
    padding: 16px 16px calc(20px + env(safe-area-inset-bottom));
    font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    max-height: 82vh; overflow-y: auto;
    box-shadow: 0 -8px 30px rgba(0,0,0,.5);
  }
  .cmo-title { font-size: 13px; text-transform: uppercase; letter-spacing: .06em;
    color: #a3a099; margin: 0 0 10px; }
  #cmo-text {
    width: 100%; box-sizing: border-box; min-height: 108px;
    background: #272725; color: #f5f4ef;
    border: 1px solid #34342f; border-radius: 12px; padding: 12px;
    /* 16px minimum or iOS zooms the page and never zooms back. */
    font: 16px/1.5 inherit; resize: vertical;
  }
  .cmo-row { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .cmo-action {
    flex: 1 1 auto; min-width: 120px; padding: 13px 14px; border: none;
    border-radius: 12px; background: #d97757; color: #fff;
    font: 600 15px inherit; cursor: pointer;
  }
  .cmo-action.cmo-alt { background: #3a3a38; color: #f5f4ef; }
  .cmo-hint { color: #a3a099; font-size: 12.5px; margin: 10px 0 0; }
  .cmo-hint a { color: #d97757; }
  .cmo-status { color: #d97757; font-size: 13px; margin: 8px 0 0; min-height: 18px; }
  .cmo-item {
    display: block; width: 100%; text-align: left; padding: 14px 12px;
    background: none; border: none; border-bottom: 1px solid #34342f;
    color: #f5f4ef; font: 15px inherit; cursor: pointer;
  }
  .cmo-item:active { background: #272725; }
  .cmo-input {
    width: 100%; box-sizing: border-box; margin-bottom: 8px;
    background: #272725; color: #f5f4ef;
    border: 1px solid #34342f; border-radius: 10px; padding: 12px;
    /* 16px minimum or iOS zooms the page and never zooms back. */
    font: 16px/1.4 inherit;
  }
  .cmo-check {
    display: flex; align-items: center; gap: 9px;
    margin: 4px 0 2px; font-size: 14.5px; color: #d7d4cc;
  }
  .cmo-check input { width: 19px; height: 19px; accent-color: #d97757; }

  /*
   * Docked to the TOP, for the same reason the bar is docked to the left: the
   * bottom right is Claude's own send/stop control, and the left edge is the bar.
   * Centred and narrow, so it reads as a notification rather than as chrome, and
   * it is removed from the DOM when it has nothing to say.
   */
  #cmo-chip {
    position: fixed; z-index: 2147483000;
    top: max(6px, env(safe-area-inset-top));
    left: 50%; transform: translateX(-50%);
    max-width: min(92vw, 460px);
    display: flex; align-items: center; gap: 8px;
    padding: 9px 13px; border-radius: 999px; border: none;
    background: rgba(30,30,28,.94); color: #f5f4ef;
    font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    box-shadow: 0 2px 12px rgba(0,0,0,.45);
    cursor: pointer; text-align: left;
    -webkit-tap-highlight-color: transparent; touch-action: manipulation;
  }
  #cmo-chip.cmo-gone { opacity: 0; pointer-events: none; transition: opacity .4s; }
  .cmo-chip-text {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .cmo-dot {
    flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%;
    background: #6db26d;
  }
  .cmo-dot.cmo-busy { background: #d97757; animation: cmo-blink 1.2s infinite; }
  @keyframes cmo-blink { 0%,100% { opacity: 1 } 50% { opacity: .25 } }
  /* Whitespace preserved: it is Claude's message, and it was written with shape. */
  .cmo-said {
    margin: 10px 0 0; padding: 12px; border-radius: 12px;
    background: #272725; color: #f5f4ef;
    font: 14px/1.5 inherit; white-space: pre-wrap; overflow-wrap: anywhere;
    max-height: 46vh; overflow-y: auto;
  }
  /*
   * The other conversations in this project. Rows rather than a select, because
   * each one carries three things — what it is, what it is doing, and how long ago
   * — and because a thumb has to hit it on a phone.
   */
  .cmo-convos { margin: 6px 0 0; max-height: 34vh; overflow-y: auto; }
  .cmo-convo {
    width: 100%; display: grid; gap: 2px 8px;
    grid-template-columns: auto 1fr; align-items: baseline;
    margin: 6px 0 0; padding: 9px 11px; border: none; border-radius: 10px;
    background: #272725; color: #f5f4ef; text-align: left; cursor: pointer;
    font: 13px/1.4 inherit;
  }
  .cmo-convo.cmo-current { background: #34332f; box-shadow: inset 0 0 0 1px #d97757; }
  .cmo-convo-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cmo-convo-meta { grid-column: 2; color: #a8a49b; font-size: 12px; }
  .cmo-convo-back { grid-template-columns: 1fr; color: #a8a49b; }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ------------------------------------------------------------- scaffolding
  const fab = document.createElement('div');
  fab.id = 'cmo-fab';
  fab.innerHTML = `
    <button class="cmo-btn cmo-secondary" id="cmo-layout" aria-label="Fix the layout">&#10038;</button>
    <button class="cmo-btn cmo-secondary" id="cmo-projects" aria-label="Switch project">&#9707;</button>
    <button class="cmo-btn cmo-secondary" id="cmo-status" aria-label="Is Claude working?">&#9673;</button>
    <button class="cmo-btn cmo-secondary" id="cmo-terminal" aria-label="Terminal">&#10095;</button>
    <button class="cmo-btn" id="cmo-mic" aria-label="Dictate">&#127908;</button>`;
  document.body.appendChild(fab);

  /*
   * Held, not looked up by id. The dictation sheet has a `<p id="cmo-status">` of
   * its own, so `document.getElementById('cmo-status')` answers with whichever
   * comes first in document order — the bar, today, by luck of the append order.
   * This button is repainted while speech is playing, and picking the wrong
   * element for that would put a Stop control inside the dictation sheet.
   */
  const statusBtn = fab.querySelector('#cmo-status');

  // The chip is created here but only inserted when there is something to say;
  // an empty pill across the top of the editor is worse than no chip at all.
  const chip = document.createElement('button');
  chip.id = 'cmo-chip';
  chip.type = 'button';
  chip.innerHTML = '<span class="cmo-dot"></span><span class="cmo-chip-text"></span>';
  const chipDot = chip.querySelector('.cmo-dot');
  const chipText = chip.querySelector('.cmo-chip-text');

  const sheet = document.createElement('div');
  sheet.id = 'cmo-sheet';
  sheet.innerHTML = '<div class="cmo-panel" id="cmo-panel"></div>';
  document.body.appendChild(sheet);

  const panel = sheet.querySelector('#cmo-panel');
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) closeSheet();
  });

  /*
   * Which sheet is on screen, counted rather than named.
   *
   * Three buttons close the sheet a beat *after* they act, so their confirmation
   * ("Copied — paste into Claude") can be read before it disappears. That delay
   * outlives the sheet it belongs to: tap Copy and then open the status sheet
   * within the same second, and the pending close dismisses the sheet you just
   * opened. Every one of those buttons is on a bar that is always on screen, so
   * that second tap is not a strange thing to do.
   */
  let sheetGeneration = 0;

  function openSheet(html) {
    sheetGeneration += 1;
    panel.innerHTML = html;
    sheet.classList.add('cmo-open');
  }
  function closeSheet() {
    sheet.classList.remove('cmo-open');
    stopRecognition();
  }
  /** Close after `ms`, unless a different sheet has been opened by then. */
  function closeSheetLater(ms) {
    const generation = sheetGeneration;
    setTimeout(() => {
      if (generation === sheetGeneration) closeSheet();
    }, ms);
  }

  // ------------------------------------------------------------- dictation
  let recognition = null;
  // Split so a mid-dictation session restart can't re-append old phrases:
  // `committedText` holds finals from ended sessions, `liveText` the current one.
  let committedText = '';
  let liveText = '';

  /**
   * Append a phrase, dropping leading words that repeat the accumulated tail.
   *
   * Rebuilding from `event.results` stopped whole-transcript re-appends, but not
   * every duplicate: chunks carry no separator, so "sounds" then "sounds" glues
   * into "soundssounds", and a phrase re-delivered across a session boundary
   * isn't in the list we re-read. Comparing words against the tail catches both.
   *
   * Cost: a deliberate immediate repetition ("very very") collapses to one.
   * Worth it against duplication that made dictation unusable.
   */
  function appendPhrase(acc, phrase) {
    const head = acc.trim().split(/\s+/).filter(Boolean);
    const tail = phrase.trim().split(/\s+/).filter(Boolean);
    if (!tail.length) return head.join(' ');

    // Longest overlap first, so a multi-word repeat collapses in one step.
    for (let n = Math.min(head.length, tail.length); n > 0; n--) {
      const end = head.slice(head.length - n).join(' ').toLowerCase();
      const start = tail.slice(0, n).join(' ').toLowerCase();
      if (end === start) {
        tail.splice(0, n);
        break;
      }
    }
    return [...head, ...tail].join(' ');
  }

  function stopRecognition() {
    if (recognition) {
      try {
        recognition.onend = null;
        recognition.stop();
      } catch {
        /* already stopped */
      }
      recognition = null;
    }
    document.getElementById('cmo-mic')?.classList.remove('cmo-rec');
  }

  /*
   * Dictated text is the most expensive thing on this surface. The Claude panel is
   * a sandboxed iframe, so it cannot be typed into from out here — the words have
   * to sit in this textarea until they are copied across, and that is exactly when
   * the workbench is most likely to reload underneath them: its lifecycle service
   * reloads the window whenever the browser restores the page from the back/forward
   * cache, which on a phone means every time you switch apps and come back. A
   * paragraph of speech has no backup anywhere, so it is written down as it is
   * spoken.
   */
  const DICTATION_KEY = 'cmo-dictation-draft';
  const DICTATION_MAX_AGE = 60 * 60 * 1000;
  let dictationTimer = null;
  let pendingDictation = null;

  function writeDictation() {
    clearTimeout(dictationTimer);
    dictationTimer = null;
    if (pendingDictation === null) return;
    const text = pendingDictation;
    pendingDictation = null;
    try {
      if (text.trim()) {
        localStorage.setItem(DICTATION_KEY, JSON.stringify({ text, at: Date.now() }));
      } else {
        localStorage.removeItem(DICTATION_KEY);
      }
    } catch {
      /* private mode: the words are still on screen, which is where they were */
    }
  }

  // Debounced, because the recognizer rewrites the whole textarea on every interim
  // result — several times a second while someone is talking.
  function saveDictation(text) {
    pendingDictation = text;
    if (!dictationTimer) dictationTimer = setTimeout(writeDictation, 400);
  }

  function clearDictation() {
    clearTimeout(dictationTimer);
    dictationTimer = null;
    pendingDictation = null;
    try {
      localStorage.removeItem(DICTATION_KEY);
    } catch {
      /* nothing was stored either */
    }
  }

  function loadDictation() {
    try {
      const saved = JSON.parse(localStorage.getItem(DICTATION_KEY) || 'null');
      if (saved?.text && Date.now() - (saved.at || 0) < DICTATION_MAX_AGE) return saved.text;
    } catch {
      /* unreadable: treat as nothing saved */
    }
    return '';
  }

  /*
   * The same cleanup pass the chat composer runs, for the same reason: what comes
   * out of either recognizer has no punctuation, no capitals and mangled product
   * names, and here it is on its way to the clipboard rather than into a box you
   * can tidy up by hand. Server side is /api/polish (see chat-service/polish.js).
   *
   * The switch is the chat app's key, read on use rather than cached: one origin,
   * one setting, and the chat may have flipped it in another tab since this
   * workbench loaded.
   */
  const POLISH_KEY = 'claude-polish-dictation';
  const POLISH_TIMEOUT_MS = 6000;

  function polishWanted() {
    try {
      return localStorage.getItem(POLISH_KEY) !== '0';
    } catch {
      return true;
    }
  }

  /** The cleaned-up text, or '' if there is nothing better than what came in. */
  async function polishText(text) {
    if (!polishWanted() || text.split(/\s+/).filter(Boolean).length < 3) return '';
    try {
      const res = await fetch('/api/polish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        // The route answers with the raw text rather than an error when Bedrock is
        // slow, so this bound is only for a request that never arrives at all.
        signal: AbortSignal.timeout?.(POLISH_TIMEOUT_MS),
      });
      // Includes 401 — the chat service's session, not code-server's password.
      // Nothing to say about it here: the text is already copied.
      if (!res.ok) return '';
      const data = await res.json();
      return data.changed && data.text ? String(data.text) : '';
    } catch {
      return '';
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Needs a secure context, and can still be refused.
      return false;
    }
  }

  function openDictation() {
    // Restored into `committedText`, not just the textarea: that is what the
    // recognizer appends to, so dictation carries on from the recovered text
    // instead of overwriting it on the first result.
    committedText = loadDictation();
    liveText = '';
    openSheet(`
      <p class="cmo-title">Dictate</p>
      <textarea id="cmo-text" placeholder="${
        SpeechRecognition ? 'Listening… speak now' : 'Type or paste here'
      }"></textarea>
      <p class="cmo-status" id="cmo-status"></p>
      <div class="cmo-row">
        <button class="cmo-action" id="cmo-copy">Copy &amp; close</button>
        <button class="cmo-action cmo-alt" id="cmo-again">Restart mic</button>
        <button class="cmo-action cmo-alt" id="cmo-cancel">Cancel</button>
      </div>
      <p class="cmo-hint">Copy puts the text on the clipboard — long-press Claude's
      input and paste. The panel is a sandboxed iframe, so it can't be typed into
      from here.</p>`);

    const textarea = panel.querySelector('#cmo-text');
    const status = panel.querySelector('#cmo-status');
    textarea.value = committedText;
    if (committedText) status.textContent = 'Recovered what you dictated before.';
    textarea.focus();
    textarea.addEventListener('input', () => saveDictation(textarea.value));

    // Cancel is a decision to throw the text away. Dismissing the sheet by tapping
    // outside it is not, so that path keeps the draft — on a phone the two are one
    // stray tap apart.
    panel.querySelector('#cmo-cancel').addEventListener('click', () => {
      clearDictation();
      closeSheet();
    });
    panel.querySelector('#cmo-again').addEventListener('click', () => {
      stopRecognition();
      startDictation(textarea, status);
    });
    panel.querySelector('#cmo-copy').addEventListener('click', async () => {
      const raw = textarea.value.trim();
      if (!raw) return closeSheet();

      /*
       * Copy the raw text first, then punctuate and copy again.
       *
       * The order matters twice over. The copy is the handover — it is the only way
       * text leaves this sheet — so it must not wait on a network round trip that
       * can fail, and a clipboard write issued after an `await` is refused outright
       * on iOS. Doing it in the tap means the worst case is unpunctuated text on
       * the clipboard, which is what this sheet did before, rather than nothing.
       */
      if (!(await copyText(raw))) {
        // Selecting the text lets the user copy with the native control instead.
        textarea.select();
        status.textContent = 'Press Copy on the selection.';
        return;
      }
      status.textContent = 'Copied — paste into Claude.';

      const cleaned = await polishText(raw);
      if (cleaned && cleaned !== raw) {
        // Shown as well as copied: the user is about to paste it, and finding
        // something they did not see arrive in Claude's input is worse than a
        // second of delay.
        textarea.value = cleaned;
        if (await copyText(cleaned)) {
          status.textContent = 'Copied, punctuated — paste into Claude.';
        } else {
          // The raw text is on the clipboard and the better version is only on
          // screen, so this one is still the user's to copy — and still worth
          // keeping if the workbench reloads before they do.
          saveDictation(cleaned);
          writeDictation();
          textarea.select();
          status.textContent = 'Punctuated — press Copy on the selection.';
          return;
        }
      }
      // On the clipboard now, which outlives the page: the copy is the handover,
      // so keeping a second copy here would only resurface it next time.
      clearDictation();
      closeSheetLater(700);
    });

    startDictation(textarea, status);
  }

  function startDictation(textarea, status) {
    /*
     * A microphone is about to go live, so stop talking.
     *
     * Both dictation paths come through here — the recognizer and the whisper
     * recorder — which makes this the one place that has to know. Left playing,
     * the recognizer transcribes Claude's own reply into the composer and the
     * recorder uploads it to be transcribed; either way the user's next message
     * is Claude quoting itself.
     */
    stopSpeech();
    if (!SpeechRecognition) {
      status.textContent = 'Live dictation unavailable — recording instead.';
      recordAndTranscribe(textarea, status);
      return;
    }

    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true; // this is what makes words appear while speaking
    rec.lang = navigator.language || 'en-US';

    /*
     * Rebuild the text from `event.results` on every event rather than
     * accumulating.
     *
     * The old code did `finalText += chunk` from `event.resultIndex` onward.
     * That works on desktop, where recognition runs as one continuous session.
     * On mobile Safari the session ends on brief pauses and is restarted (see
     * onend below); each restart begins a fresh `results` list with
     * resultIndex back at 0, so every already-final phrase was appended again —
     * words showing up three or four times.
     *
     * `results` is authoritative for the current session, so read it whole and
     * keep finals from previous sessions in `committedText`, which only grows
     * when a session actually ends.
     */
    rec.onresult = (event) => {
      let sessionFinal = '';
      let interim = '';
      for (let i = 0; i < event.results.length; i++) {
        const chunk = event.results[i][0].transcript;
        if (event.results[i].isFinal) sessionFinal = appendPhrase(sessionFinal, chunk);
        else interim = appendPhrase(interim, chunk);
      }
      liveText = sessionFinal;
      const joined = appendPhrase(
        appendPhrase(committedText, sessionFinal),
        interim,
      );
      textarea.value = joined.replace(/\s+/g, ' ').trimStart();
      saveDictation(textarea.value);
    };

    rec.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        status.textContent = 'Microphone permission denied.';
        stopRecognition();
        return;
      }
      // network / language-not-supported: fall back to server transcription.
      status.textContent = 'Live dictation failed — recording instead.';
      stopRecognition();
      recordAndTranscribe(textarea, status);
    };

    // Mobile Safari ends the session on brief pauses; restart while active.
    // Commit what this session finalised *before* restarting, because the new
    // session's `results` list starts empty and would otherwise lose it.
    rec.onend = () => {
      if (recognition !== rec) return;
      if (liveText.trim()) {
        committedText = appendPhrase(committedText, liveText);
        liveText = '';
      }
      try {
        rec.start();
      } catch {
        stopRecognition();
      }
    };

    recognition = rec;
    document.getElementById('cmo-mic')?.classList.add('cmo-rec');
    status.textContent = 'Listening…';
    try {
      rec.start();
    } catch {
      status.textContent = 'Could not start the microphone.';
      stopRecognition();
    }
  }

  /** Fallback: record audio and transcribe on the server (whisper.cpp). */
  async function recordAndTranscribe(textarea, status) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      status.textContent = `Microphone blocked: ${err.message}`;
      return;
    }

    const chunks = [];
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);

    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      status.textContent = 'Transcribing…';
      try {
        const wav = await toWav(new Blob(chunks, { type: recorder.mimeType }));
        const form = new FormData();
        form.append('audio', wav, 'recording.wav');
        const res = await fetch('/api/transcribe', { method: 'POST', body: form });
        // Transcription lives behind the chat service's session, which is
        // separate from code-server's password. Say so plainly instead of
        // reporting a bare "authentication required" that looks like a bug.
        if (res.status === 401) {
          throw new Error('Sign in first — tap the project switcher.');
        }
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'transcription failed');
        textarea.value = (textarea.value ? textarea.value + ' ' : '') + data.text;
        status.textContent = 'Transcribed.';
      } catch (err) {
        status.textContent = err.message;
      }
    };

    recorder.start();
    status.textContent = 'Recording — tap the mic to stop.';
    const mic = document.getElementById('cmo-mic');
    mic?.classList.add('cmo-rec');
    const stop = () => {
      mic?.classList.remove('cmo-rec');
      if (recorder.state !== 'inactive') recorder.stop();
      mic?.removeEventListener('click', stop);
    };
    mic?.addEventListener('click', stop, { once: true });
  }

  /**
   * Browsers record webm/opus; the server's whisper.cpp decodes
   * WAV/MP3/FLAC/Vorbis but not Opus, and AL2023 ships no ffmpeg. The browser
   * already has an Opus decoder, so convert here. 16 kHz mono is also exactly
   * what Whisper wants, which shrinks the upload.
   */
  async function toWav(blob) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    try {
      const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
      const rate = 16000;
      const offline = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
        1, Math.ceil(decoded.duration * rate), rate,
      );
      const src = offline.createBufferSource();
      src.buffer = decoded;
      src.connect(offline.destination);
      src.start();
      const out = await offline.startRendering();
      const samples = out.getChannelData(0);

      const buf = new ArrayBuffer(44 + samples.length * 2);
      const view = new DataView(buf);
      const str = (off, s) => {
        for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
      };
      str(0, 'RIFF');
      view.setUint32(4, 36 + samples.length * 2, true);
      str(8, 'WAVE');
      str(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, rate, true);
      view.setUint32(28, rate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      str(36, 'data');
      view.setUint32(40, samples.length * 2, true);
      for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }
      return new Blob([buf], { type: 'audio/wav' });
    } finally {
      ctx.close();
    }
  }

  // --------------------------------------------------------- project switcher
  async function openProjects() {
    openSheet('<p class="cmo-title">Open project</p><p class="cmo-hint">Loading…</p>');
    let projects = [];
    try {
      const res = await fetch('/api/projects');
      // The editor and the chat API are gated separately — code-server checks its
      // own password, the API checks a session cookie. Signing into the editor
      // alone leaves this request unauthorized, and without this branch the 401
      // body falls through to `|| []` and renders as "No projects found", which
      // looks like an empty workspace rather than a missing login.
      if (res.status === 401) {
        const next = encodeURIComponent(location.pathname + location.search);
        openSheet(`
          <p class="cmo-title">Sign in to list projects</p>
          <p class="cmo-hint">The project list comes from the chat service, which
          needs its own sign-in. Same password as the editor — once only.</p>
          <div class="cmo-row">
            <button class="cmo-action" id="cmo-signin">Sign in</button>
            <button class="cmo-action cmo-alt" id="cmo-close-projects">Close</button>
          </div>`);
        panel.querySelector('#cmo-close-projects').addEventListener('click', closeSheet);
        panel.querySelector('#cmo-signin').addEventListener('click', () => {
          location.href = `/login?next=${next}`;
        });
        return;
      }
      projects = (await res.json()).projects || [];
    } catch {
      panel.innerHTML =
        '<p class="cmo-title">Open project</p><p class="cmo-hint">Could not reach the server.</p>';
      return;
    }

    // Which folder this window already has, so tapping it can do nothing instead
    // of reloading the workbench to arrive where it already is.
    let current = '';
    try {
      current = new URLSearchParams(location.search).get('folder') || '';
    } catch {
      /* no folder in the URL: an empty window, so nothing is "already open" */
    }

    const items = projects
      .map((p) => {
        const open = current !== '' && current === p.path;
        return (
          `<button class="cmo-item" data-path="${encodeURIComponent(p.path)}"` +
          `${open ? ' data-open="1"' : ''}>${p.name}${open ? ' — open' : ''}</button>`
        );
      })
      .join('');

    openSheet(`
      <p class="cmo-title">Open project</p>
      ${items || '<p class="cmo-hint">No projects found.</p>'}
      <div class="cmo-row">
        <button class="cmo-action" id="cmo-new-project">+ New project</button>
        <button class="cmo-action cmo-alt" id="cmo-close-projects">Close</button>
      </div>
      <p class="cmo-hint">Opens in this tab. Each project is a separate
      workspace, so Claude's session history follows the folder.</p>`);

    panel.querySelector('#cmo-close-projects').addEventListener('click', closeSheet);
    panel.querySelector('#cmo-new-project').addEventListener('click', openNewProject);
    panel.querySelectorAll('.cmo-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        // Already this folder. Navigating would reload the entire workbench, kill
        // the extension host and take an unsent message in the Claude panel with
        // it — to end up exactly here. The switcher is also the natural thing to
        // open when checking which project you are in, so this is a normal tap,
        // not a mistake to punish.
        if (btn.dataset.open) {
          closeSheet();
          return;
        }
        // ?folder= is code-server's own way to open a workspace, and code-server
        // is mounted at /editor/ — `/` is the chat. Navigating to `/?folder=...`
        // silently threw you into the chat while the editor kept whatever folder
        // it had, which reads as "the project switcher does nothing".
        location.href = `/editor/?folder=${btn.dataset.path}`;
      });
    });
  }

  /**
   * Create a project: folder + git repo + optional GitHub remote, then open it.
   *
   * The GitHub step involves network calls and can take a few seconds, so the
   * button reports progress and each step's outcome is shown individually — a
   * project that exists locally but failed to reach GitHub is a different
   * result from a fully wired one, and silently conflating them is how you end
   * up pushing to a remote that was never created.
   */
  function openNewProject() {
    openSheet(`
      <p class="cmo-title">New project</p>
      <input id="cmo-np-name" class="cmo-input" type="text" autocapitalize="none"
             autocorrect="off" spellcheck="false" placeholder="project-name">
      <input id="cmo-np-desc" class="cmo-input" type="text"
             placeholder="Description (optional)">
      <label class="cmo-check">
        <input type="checkbox" id="cmo-np-gh" checked>
        Create a GitHub repo and push
      </label>
      <label class="cmo-check">
        <input type="checkbox" id="cmo-np-private" checked>
        Private
      </label>
      <p class="cmo-status" id="cmo-np-status"></p>
      <div class="cmo-row">
        <button class="cmo-action" id="cmo-np-go">Create</button>
        <button class="cmo-action cmo-alt" id="cmo-np-back">Back</button>
      </div>
      <p class="cmo-hint">Creates /workspace/projects/&lt;name&gt;, runs git init
      with a first commit, then creates the remote with the workspace's GitHub
      token. Opens the project when it's ready.</p>`);

    const nameEl = panel.querySelector('#cmo-np-name');
    const status = panel.querySelector('#cmo-np-status');
    const go = panel.querySelector('#cmo-np-go');
    nameEl.focus();

    panel.querySelector('#cmo-np-back').addEventListener('click', openProjects);

    const create = async () => {
      const name = nameEl.value.trim();
      if (!name) {
        status.textContent = 'Give it a name.';
        return;
      }
      if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        status.textContent = 'Letters, numbers, dot, dash and underscore only.';
        return;
      }

      go.disabled = true;
      const wantsGithub = panel.querySelector('#cmo-np-gh').checked;
      status.textContent = wantsGithub ? 'Creating folder, git repo and remote…' : 'Creating…';

      try {
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            github: wantsGithub,
            private: panel.querySelector('#cmo-np-private').checked,
            description: panel.querySelector('#cmo-np-desc').value.trim(),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `server returned ${res.status}`);

        const steps = data.project.steps || [];
        const failed = steps.filter((s) => !s.ok);
        const repo = steps.find((s) => s.step === 'github' && s.ok);

        if (failed.length) {
          // Don't navigate away from a partial result — the message is the point.
          status.innerHTML =
            `Created <b>${escapeHtml(name)}</b>, but: ` +
            failed.map((s) => `${escapeHtml(s.step)} failed — ${escapeHtml(s.error || '')}`).join('; ');
          go.disabled = false;
          return;
        }

        status.textContent = repo?.url
          ? `Created and pushed to ${repo.url}. Opening…`
          : 'Created. Opening…';
        setTimeout(() => {
          location.href = `/editor/?folder=${encodeURIComponent(data.project.path)}`;
        }, 900);
      } catch (err) {
        status.textContent = err.message;
        go.disabled = false;
      }
    };

    go.addEventListener('click', create);
    nameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') create();
    });
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ------------------------------------------------- escaping a stuck layout
  /*
   * Claude opens files and diffs in the editor area. With tabs, the activity bar
   * and the status bar all hidden for phone use, nothing on screen closes one
   * again: the panel keeps whatever width is left over, and reloading brings the
   * file back. On a desktop you can at least drag the split to the edge — on a
   * phone the workspace is simply stuck, which is why this exists.
   *
   * The workbench's command service is not reachable from here. There is no
   * supported global for it, and this file must not reach into VS Code's
   * internals — rewriting the bundle black-screened the editor twice already
   * (see the disconnect-frame note above). So the commands are driven the one way
   * a page can drive them from outside: keybindings. The mobile extension binds
   * ctrl+alt+shift+F9 and F10, and these synthesise those chords. VS Code's
   * keybinding service listens for keydown on the window and does not check
   * `isTrusted`, so a dispatched event reaches it even while focus sits inside
   * the Claude webview's iframe.
   *
   * Nothing observable comes back, so success cannot be reported honestly from
   * out here. Hence three escalating options rather than one button that claims
   * to have worked: the command, the chrome so files can be closed by hand, and
   * a reload — which now recovers on its own, because the extension closes
   * restored file tabs at startup.
   */
  const KEY_BACK = { key: 'F9', code: 'F9', keyCode: 120 };
  const KEY_CHROME = { key: 'F10', code: 'F10', keyCode: 121 };
  const KEY_TERMINAL = { key: 'F11', code: 'F11', keyCode: 122 };

  function pressChord(spec) {
    const init = {
      key: spec.key,
      code: spec.code,
      keyCode: spec.keyCode,
      which: spec.keyCode,
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    // Dispatch from whatever holds focus so the event bubbles up through body and
    // document to the window, wherever the listener happens to be attached.
    const target = document.activeElement || document.body;
    for (const type of ['keydown', 'keyup']) {
      const event = new KeyboardEvent(type, init);
      // `keyCode` in the init dictionary is a legacy extension, and VS Code maps
      // keys from it. Where the browser ignores it, define it by hand rather
      // than dispatching an event the keybinding service will discard.
      if (!event.keyCode) {
        try {
          Object.defineProperty(event, 'keyCode', { get: () => spec.keyCode });
          Object.defineProperty(event, 'which', { get: () => spec.keyCode });
        } catch {
          /* nothing else to try; `code` may still be enough */
        }
      }
      target.dispatchEvent(event);
    }
  }

  // --------------------------------------------------- what reloaded the editor
  /*
   * A reload of the workbench is not a cosmetic event here: it restarts the
   * extension host and takes anything typed into the Claude panel and not sent
   * with it. Reports of "it refreshed a few times and deleted what I typed" cannot
   * be diagnosed from the instance, because the server side of every cause looks
   * identical — a new connection and a dead extension host — whether the page
   * navigated itself, the user pulled to refresh, or iOS discarded the tab to
   * reclaim memory.
   *
   * So each load writes down how it happened, and the Layout sheet shows the last
   * few. `navigation.type` is what separates the cases: `navigate` means something
   * assigned to `location` (a project switch), `reload` means the page or the OS
   * reloaded it, `back_forward` means history. The folder comes along because a
   * run of `navigate` entries with the *same* folder is a very different bug from
   * one where it changes.
   */
  const LOADS_KEY = 'claude-editor-loads';
  const LOADS_KEEP = 12;

  function loadHistory() {
    try {
      const list = JSON.parse(localStorage.getItem(LOADS_KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  function recordLoad(reason) {
    let how = reason || 'unknown';
    try {
      const nav = !reason
        && performance.getEntriesByType
        && performance.getEntriesByType('navigation')[0];
      if (nav && nav.type) how = String(nav.type);
    } catch {
      /* no navigation timing: the entry is still worth having for its timestamp */
    }
    let folder = '';
    try {
      folder = new URLSearchParams(location.search).get('folder') || '';
    } catch {
      /* empty window */
    }
    const list = loadHistory();
    list.push({ t: Date.now(), how, folder });
    try {
      localStorage.setItem(LOADS_KEY, JSON.stringify(list.slice(-LOADS_KEEP)));
    } catch {
      /* private mode: the history is diagnostic, never load-bearing */
    }
  }

  function loadSummary() {
    const list = loadHistory();
    if (!list.length) return '';
    const recent = list.filter((e) => Date.now() - e.t < 5 * 60 * 1000).length;
    const shown = list.slice(-5).map((e) => {
      const at = new Date(e.t).toTimeString().slice(0, 8);
      const where = e.folder ? ` ${e.folder.split('/').filter(Boolean).pop()}` : '';
      return `${at} ${e.how}${where}`;
    });
    return `${recent} load${recent === 1 ? '' : 's'} in the last five minutes. ` +
      shown.join(' · ');
  }

  function openLayout() {
    openSheet(`
      <p class="cmo-title">Layout</p>
      <div class="cmo-row">
        <button class="cmo-action" id="cmo-back">Back to Claude, full screen</button>
      </div>
      <div class="cmo-row">
        <button class="cmo-action cmo-alt" id="cmo-chrome">Show tabs &amp; bars</button>
        <button class="cmo-action cmo-alt" id="cmo-reload">Reload the editor</button>
      </div>
      <div class="cmo-row">
        <button class="cmo-action cmo-alt" id="cmo-layout-close">Close</button>
      </div>
      <p class="cmo-status" id="cmo-layout-status"></p>
      <p class="cmo-hint">The first button closes the files and diffs Claude
      opened and gives it the whole window back — the conversation keeps running,
      and unsaved files are left alone. If the layout is still wrong, show the
      tabs and close things by hand, or reload. Last resort, when even a reload
      comes back broken:
      <a href="/chat/reset.html?from=editor">reset this device</a>.</p>
      <p class="cmo-hint" id="cmo-loads"></p>`);

    const status = panel.querySelector('#cmo-layout-status');
    // Only shown once there is something to show, so the sheet stays a set of
    // buttons for the person who came here to fix their screen.
    const loads = loadSummary();
    if (loads) panel.querySelector('#cmo-loads').textContent = `This tab: ${loads}`;

    panel.querySelector('#cmo-layout-close').addEventListener('click', closeSheet);
    panel.querySelector('#cmo-reload').addEventListener('click', () => {
      status.textContent = 'Reloading…';
      location.reload();
    });
    panel.querySelector('#cmo-back').addEventListener('click', () => {
      pressChord(KEY_BACK);
      status.textContent = 'Asked the editor to close open files.';
      closeSheetLater(700);
    });
    panel.querySelector('#cmo-chrome').addEventListener('click', () => {
      pressChord(KEY_CHROME);
      status.textContent = 'Toggled tabs, activity bar and status bar.';
      closeSheetLater(700);
    });
  }

  // ------------------------------------------------------- keep the screen on
  /*
   * The editor has the same problem as the chat app: the display sleeps on its
   * idle timer while you are reading a diff or waiting on a task, and hiding the
   * page suspends dictation and freezes the workbench's socket.
   *
   * Same reconciler as chat-service/public/app.js, and deliberately the same
   * localStorage key — code-server and the chat are one origin behind nginx, so
   * the switch in the chat's Settings governs both. Duplicated rather than shared
   * because this file is injected raw into the workbench and imports nothing.
   *
   * The wake lock is released by the browser on every hide and never re-taken,
   * and the OS revokes it silently, so it has to be re-requested rather than
   * acquired once.
   */
  var wakeLock = null;
  var wakeLockPending = false;

  function keepAwakeWanted() {
    try {
      return localStorage.getItem('claude-keep-awake') !== '0';
    } catch (err) {
      return true;
    }
  }

  function syncWakeLock() {
    if (!keepAwakeWanted() || document.visibilityState !== 'visible') {
      var held = wakeLock;
      wakeLock = null;
      try { if (held) held.release(); } catch (err) { /* already gone */ }
      return;
    }
    if (wakeLock || wakeLockPending || !navigator.wakeLock) return;
    wakeLockPending = true;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLockPending = false;
      // The page may have been hidden, or the switch flipped, while we waited.
      if (!keepAwakeWanted() || document.visibilityState !== 'visible') {
        try { lock.release(); } catch (err) { /* nothing to undo */ }
        return;
      }
      wakeLock = lock;
      lock.addEventListener('release', function () {
        if (wakeLock === lock) wakeLock = null;
      });
    }).catch(function () {
      // Hidden, unsupported, or refused by the OS. The timer retries.
      wakeLockPending = false;
    });
  }

  document.addEventListener('visibilitychange', syncWakeLock);
  window.addEventListener('pageshow', syncWakeLock);
  window.addEventListener('focus', syncWakeLock);
  setInterval(syncWakeLock, 30000);
  syncWakeLock();

  // ------------------------------------------------- is Claude working, and what
  /*
   * The one thing you need to know before the history has finished loading.
   *
   * Opening a conversation on a second device means waiting while the Claude panel
   * re-reads and re-renders the entire transcript — measured at 1.75–3.97s inside
   * the extension host before the CLI is even launched, on transcripts up to 8.7MB,
   * and it renders oldest-first, so the newest message arrives last. That is the
   * message you need in order to reply, and it is the one you wait longest for.
   *
   * The panel is a proprietary webview, so none of that can be reordered from here.
   * What can be done is to answer the question from outside it, while it works:
   *
   *   Claude is working  ->  the answer has not been said yet. Wait; the history
   *                          is worth the wait, because the end of it is coming.
   *   Claude is idle     ->  it is your turn, and the last message is all you
   *                          need. Here it is, in tens of milliseconds.
   *
   * "Working" is not something a transcript can tell you — there is no turn-end
   * marker on disk — so it comes from claude-broker, which owns the process. See
   * chat-service/claude-status.js.
   */
  const STATUS_POLL_MS = 4000;
  // A tab left open for hours must not poll forever. Working turns are minutes,
  // not hours, and a stale chip is harmless once the answer is on screen anyway.
  const STATUS_POLL_LIMIT = 30 * 60 * 1000;
  // Long enough to read a line and decide, short enough not to sit on the editor.
  const CHIP_LINGER_MS = 30000;
  /*
   * A slow heartbeat, even when nothing is working.
   *
   * Switching conversations inside the panel is invisible from out here: it is one
   * webview rearranging itself, with no navigation, no visibility change, and
   * nothing to listen for. Without a heartbeat the answer from page load stands
   * until something else happens to ask — which is what "the status is stale after
   * I switch" actually was. A tail read is tens of milliseconds, so this is cheap
   * enough to run while the tab is watched and stopped the moment it is not.
   */
  const STATUS_HEARTBEAT_MS = 15000;

  let status = null;
  let statusPollTimer = null;
  let statusHeartbeat = null;
  let statusPollingSince = 0;
  let chipTimer = null;
  /*
   * A conversation the user picked out of the list, which then overrides the
   * guess. Null means "whichever one you think I am in" — see guessConversation in
   * chat-service/claude-status.js for how good that guess can be, and why the
   * answer always names what it chose.
   */
  let pinnedSession = null;

  function folder() {
    try {
      return new URLSearchParams(location.search).get('folder') || '';
    } catch {
      return ''; // an empty window: no conversation to report on
    }
  }

  /**
   * Ask the chat service. Every failure answers null, and null shows nothing:
   * a 401 (the editor and the chat API are gated separately, so signing into one
   * leaves the other unauthorized), no route on an older deployment, a dropped
   * network. None of those are worth a banner over someone's editor — the project
   * switcher is where a missing chat-service sign-in is explained.
   */
  async function fetchStatus() {
    const cwd = folder();
    if (!cwd) return null;
    const pin = pinnedSession ? `&sessionId=${encodeURIComponent(pinnedSession)}` : '';
    try {
      const res = await fetch(`/api/claude-status?cwd=${encodeURIComponent(cwd)}${pin}`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  function hideChip() {
    if (chipTimer) clearTimeout(chipTimer);
    chipTimer = null;
    chip.classList.add('cmo-gone');
    // Removed rather than left transparent: it sits over the editor's top edge,
    // and `pointer-events: none` is one CSS mistake away from swallowing taps.
    setTimeout(() => chip.remove(), 450);
  }

  /** How long ago, in words, for a list where exact times would be noise. */
  function sinceText(at) {
    if (!at) return '';
    const mins = Math.round((Date.now() - at) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
  }

  /**
   * A name for a conversation.
   *
   * Claude Code's own title where there is one — it is written into the transcript
   * as the conversation grows — and otherwise the opening of what was last said,
   * which is what people recognise a conversation by anyway.
   */
  function nameOf(c) {
    if (c?.title) return c.title;
    const said = c?.said || c?.last?.text || '';
    const line = said.replace(/\s+/g, ' ').trim();
    return line ? line.slice(0, 48) : 'Untitled conversation';
  }

  /** A single line: what it is doing, or the first of what it said. */
  function chipLine(s) {
    const line =
      s.state === 'working'
        ? 'Claude is working…'
        : s.last?.text
          ? s.last.text.replace(/\s+/g, ' ').trim()
          : s.state === 'unknown'
            ? 'Claude — tap for status'
            : 'Claude is waiting for you';
    // Name the conversation only when the project holds more than one, because
    // that is the only time it tells you anything — and it is exactly when an
    // answer about the wrong one is possible. See guessConversation.
    const many = (s.conversations?.length || 0) > 1;
    return many && s.title ? `${s.title} · ${line}` : line;
  }

  function showChip(s, { linger = true } = {}) {
    chipText.textContent = chipLine(s);
    chipDot.classList.toggle('cmo-busy', s.state === 'working');
    chip.classList.remove('cmo-gone');
    if (!chip.isConnected) document.body.appendChild(chip);
    if (chipTimer) clearTimeout(chipTimer);
    // A working chip stays: it is the reason to keep waiting, and it is replaced
    // by the finished one as soon as the turn ends.
    chipTimer = linger && s.state !== 'working' ? setTimeout(hideChip, CHIP_LINGER_MS) : null;
  }

  function stopStatusPoll() {
    if (statusPollTimer) clearTimeout(statusPollTimer);
    statusPollTimer = null;
  }

  /**
   * Ask, and decide whether the answer is worth putting on screen.
   *
   * `silent` is what makes a heartbeat tolerable: a repeat of what is already
   * known changes nothing, but two things still speak up. A turn finishing is the
   * moment the answer exists, and the conversation *changing* — someone switched
   * conversations in the panel, and this is the first sight of it out here — is the
   * moment the last message on screen stopped belonging to what is on screen.
   */
  async function refreshStatus({ silent = false } = {}) {
    const next = await fetchStatus();
    if (!next) return null;
    const prev = status;
    status = next;

    const switched = Boolean(prev?.sessionId && next.sessionId && prev.sessionId !== next.sessionId);
    const finished = prev?.state === 'working' && next.state !== 'working';
    // A visible chip is always kept current; an absent one is only brought back
    // for something new. Otherwise a dismissed chip would return every 15s.
    if (!silent || switched || finished || chip.isConnected) showChip(next);

    if (next.state === 'working') {
      if (!statusPollTimer) statusPollingSince = Date.now();
      stopStatusPoll();
      statusPollTimer = setTimeout(pollStatus, STATUS_POLL_MS);
    }
    return next;
  }

  /**
   * Poll fast while a turn is in flight, and only while the tab is visible.
   *
   * The transition from working to idle is why this is four seconds rather than
   * the heartbeat's fifteen — it is the moment the answer you were waiting for
   * exists, and the chip is rewritten when it happens.
   */
  async function pollStatus() {
    stopStatusPoll();
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - statusPollingSince > STATUS_POLL_LIMIT) return;
    await refreshStatus({ silent: true });
  }

  /**
   * Answer the question on arrival, unasked.
   *
   * Deliberately not behind a tap: the wait this exists for happens on page load,
   * and being told to tap something while the editor is busy loading is the same
   * wait with an extra step.
   */
  const checkStatus = () => refreshStatus();

  /** Notice a switch that this page has no way of being told about. */
  function startStatusHeartbeat() {
    if (statusHeartbeat) return;
    statusHeartbeat = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      // A working turn is already being polled, four times as often.
      if (statusPollTimer) return;
      refreshStatus({ silent: true });
    }, STATUS_HEARTBEAT_MS);
  }

  /** The whole of what Claude last said, for when one line was not enough. */
  function openStatus() {
    const s = status;
    if (!s) {
      openSheet(`
        <p class="cmo-title">Claude</p>
        <p class="cmo-hint">No status yet. The chat service answers this, and it has
        its own sign-in — open the project switcher if you have not signed in.</p>
        <div class="cmo-row"><button class="cmo-action cmo-alt" id="cmo-status-close">Close</button></div>`);
      panel.querySelector('#cmo-status-close').addEventListener('click', closeSheet);
      return;
    }

    const working = s.state === 'working';
    const when = s.last?.at ? new Date(s.last.at) : null;
    const ago = when ? Math.max(0, Math.round((Date.now() - when.getTime()) / 60000)) : null;
    const size = s.bytes ? `${(s.bytes / (1024 * 1024)).toFixed(1)} MB` : null;
    const said = s.last?.text || '';
    // No button when there is nothing to say or nothing to say it with, rather
    // than a disabled one: this sheet is answering a question, and an inert
    // control in it reads as something being broken.
    const canSpeak = Boolean(said) && speechAvailable();

    const others = Array.isArray(s.conversations) ? s.conversations : [];

    openSheet(`
      <p class="cmo-title">${working ? 'Claude is working' : 'Your turn'}</p>
      <p class="cmo-hint" id="cmo-status-name"></p>
      <p class="cmo-hint" id="cmo-status-detail"></p>
      <div class="cmo-said" id="cmo-status-said"></div>
      <div class="cmo-row">
        ${canSpeak ? `<button class="cmo-action" id="cmo-speak">${
          speaking ? 'Stop' : 'Read aloud'
        }</button>` : ''}
        <button class="cmo-action cmo-alt" id="cmo-status-refresh">Refresh</button>
        <button class="cmo-action cmo-alt" id="cmo-status-close">Close</button>
      </div>
      <p class="cmo-hint">${
        working
          ? 'The panel is still loading the history; the end of it has not been written yet.'
          : 'This is the last thing Claude said. The panel is still rendering the history above it.'
      }${size ? ` This conversation is ${size} on disk, which is what the panel is reading.` : ''}</p>
      ${others.length > 1 ? `
        <p class="cmo-hint" id="cmo-convo-head"></p>
        <div id="cmo-convos" class="cmo-convos"></div>` : ''}`);

    /*
     * Which conversation this is about, said out loud.
     *
     * Nothing outside the panel can see which conversation is on screen, so this
     * answer is a guess whenever it was not asked for by id. Naming it is what
     * makes a wrong guess correctable instead of merely stale — the list below is
     * the correction.
     */
    panel.querySelector('#cmo-status-name').textContent = [
      nameOf(s),
      pinnedSession ? 'following this one' : others.length > 1 ? 'best guess' : null,
    ]
      .filter(Boolean)
      .join(' · ');

    // textContent, not innerHTML: this is a message from a model, it routinely
    // contains code and angle brackets, and it is not markup.
    panel.querySelector('#cmo-status-said').textContent =
      s.last?.text || 'Nothing has been said in this conversation yet.';
    panel.querySelector('#cmo-status-detail').textContent = [
      ago === null ? null : ago === 0 ? 'just now' : `${ago} min ago`,
      // Where the verdict came from, because the two are not equally certain: the
      // broker knows, the transcript only shows the state it was left in.
      s.source === 'broker' ? 'live from the broker' : 'read from the transcript',
      // Not the same statement as "idle": no process means nothing can be working,
      // where no device merely means nobody is watching one that is.
      s.live === false ? 'nothing running it' : s.clients === 0 ? 'no device attached' : null,
    ]
      .filter(Boolean)
      .join(' · ');
    panel.querySelector('#cmo-status-close').addEventListener('click', closeSheet);

    // Ask again, in place. The heartbeat is fifteen seconds and someone reading
    // this sheet has a more specific question than that.
    panel.querySelector('#cmo-status-refresh').addEventListener('click', async () => {
      const button = panel.querySelector('#cmo-status-refresh');
      button.textContent = 'Refreshing…';
      await refreshStatus();
      openStatus();
    });

    /*
     * The other conversations in this project.
     *
     * This is the honest answer to "which conversation am I in", given that the
     * panel will not say: show them all, name each, and let a tap decide. Tapping
     * one pins it, so the chip and this sheet follow that conversation instead of
     * the guess — which is what someone who has just switched actually wants.
     */
    const list = panel.querySelector('#cmo-convos');
    if (list) {
      const busy = others.filter((c) => c.state === 'working').length;
      panel.querySelector('#cmo-convo-head').textContent =
        `${others.length} conversations here${busy ? `, ${busy} working` : ''} — tap one to follow it`;

      for (const c of others) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `cmo-convo${c.current ? ' cmo-current' : ''}`;
        const dot = document.createElement('span');
        dot.className = `cmo-dot${c.state === 'working' ? ' cmo-busy' : ''}`;
        const label = document.createElement('span');
        label.className = 'cmo-convo-label';
        // A title and a message are both model output. Never markup.
        label.textContent = nameOf(c);
        const meta = document.createElement('span');
        meta.className = 'cmo-convo-meta';
        meta.textContent = [
          c.state === 'working' ? 'working' : 'your turn',
          sinceText(c.at),
          c.live === false ? 'not running' : null,
        ]
          .filter(Boolean)
          .join(' · ');
        row.append(dot, label, meta);
        row.addEventListener('click', async () => {
          // Whatever is being read aloud belongs to the conversation being left,
          // and hearing it under a sheet describing a different one is worse than
          // silence. Same on the way back.
          stopSpeech();
          pinnedSession = c.sessionId;
          await refreshStatus();
          openStatus();
        });
        list.appendChild(row);
      }

      if (pinnedSession) {
        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'cmo-convo cmo-convo-back';
        back.textContent = 'Stop following — go back to the active one';
        back.addEventListener('click', async () => {
          stopSpeech();
          pinnedSession = null;
          await refreshStatus();
          openStatus();
        });
        list.appendChild(back);
      }
    }

    /*
     * Read aloud, and Stop.
     *
     * `speak` is called straight out of the tap with the text already in hand —
     * no await in front of it — because iOS refuses speech that did not start
     * inside a gesture. The sheet is left open afterwards rather than closed: the
     * voice outlives it either way, and dismissing it is how you get back to
     * watching the panel while it reads.
     */
    const speakBtn = panel.querySelector('#cmo-speak');
    if (speakBtn) {
      speakBtn.addEventListener('click', () => {
        if (speaking) {
          stopSpeech();
          return;
        }
        // Said first, when a turn is still running: otherwise the previous
        // message is heard as the answer to the thing still being worked on.
        const started = speak(said, working ? 'Still working. Last message:' : '');
        if (!started) {
          panel.querySelector('#cmo-status-detail').textContent =
            'Nothing was spoken — this browser has no speech, or the mic is live.';
        }
      });
    }
  }

  // ------------------------------------------------------- reading it aloud
  /*
   * Say the last message out loud, when asked to.
   *
   * The other half of the mic. Dictation carries a phone-shaped question into
   * Claude; this carries the answer back out, for the times you are holding the
   * phone rather than reading it — walking, driving, or waiting on a turn that
   * has been running for an hour. The final message of a turn is the one worth
   * hearing: it is where the summary of everything that just happened is.
   *
   * It is a button, deliberately, and not something that fires when a turn ends.
   * A turn can finish while you are mid-sentence with someone, in another app, or
   * twenty minutes after you stopped waiting for it — and a phone that starts
   * talking by itself in any of those is worse than one that stays quiet. So
   * nothing here has a timer or a subscription: it speaks when tapped.
   *
   * This cannot be done from the extension, and that is not a limitation of this
   * repo. The panel is a proprietary webview, and the extension host is a node
   * process with no audio device — nothing in either can make a sound. The
   * workbench page can, and it is also the one place that already has the text,
   * from /api/claude-status. So the overlay speaks, and the panel is untouched.
   *
   * Two constraints shape the rest, and both are ones the dictation sheet already
   * lives with:
   *
   *   iOS refuses speech that did not start inside a tap. So the first utterance
   *   is queued synchronously from the click handler, never after an `await` —
   *   exactly the rule the clipboard write follows. `openStatus` has already
   *   refreshed the status, so the text is in hand and nothing is fetched here.
   *
   *   Speaking while the recognizer is listening dictates Claude's own words back
   *   into the composer. So opening the dictation sheet stops the speech, and
   *   this never starts while dictation is running.
   */

  // Long enough for the summary a turn ends with; short enough that the wrong
  // message, or a wall of prose, is over in about a minute rather than five. What
  // is left is on screen, and the speech says so rather than just stopping.
  const SPEECH_CAP = 2400;
  /*
   * Utterances are queued one at a time, not all at once.
   *
   * Two reasons, and the second is the one that matters on this surface: iOS
   * speaks only the first of a long queue and drops the rest, and a short current
   * utterance is what makes Stop stop now instead of at the end of the message.
   */
  const SPEECH_CHUNK = 220;

  let speechChunks = [];
  let speaking = false;

  const speechAvailable = () =>
    typeof window.speechSynthesis !== 'undefined' &&
    typeof window.SpeechSynthesisUtterance === 'function';

  /**
   * Markdown as something worth listening to.
   *
   * A final message is written to be *read*: bold, bullets, backticks, file
   * paths, links, and a fenced diff in the middle of it. Spoken literally that is
   * "asterisk asterisk Done asterisk asterisk", every slash of every path read
   * out, and a minute of punctuation names. So the markup is removed rather than
   * pronounced, and the parts that are not prose at all — code blocks, URLs — are
   * replaced by the fact that they were there, because silently dropping them
   * would misrepresent the message.
   *
   * Deterministic and local, on purpose. A model would do this better, and
   * `polish.js` is right there — but it would put a network round trip and a bill
   * between the tap and the first word, and iOS only allows speech that starts
   * inside the tap. This is the one thing in the app that has to begin
   * immediately.
   */
  function speakable(markdown) {
    let text = String(markdown == null ? '' : markdown);

    // Code is not listenable and it is on screen anyway; say that it was there.
    // The unterminated case is a message that ended mid-block, which is a normal
    // thing to find in a transcript being read while it is still being written.
    text = text.replace(/```[\s\S]*?```/g, ' Code block. ');
    text = text.replace(/~~~[\s\S]*?~~~/g, ' Code block. ');
    text = text.replace(/```[\s\S]*$/g, ' Code block. ');

    // Images say nothing out loud. Links keep their label and lose their target:
    // the label is the sentence, the URL is unspeakable.
    text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
    text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    text = text.replace(/<(https?:\/\/[^>]*)>/g, ' link ');
    text = text.replace(/\bhttps?:\/\/\S+/g, ' link ');

    // Inline code is usually an identifier, a flag or a filename — all of them
    // words. It is the backticks that are not.
    text = text.replace(/`+([^`]*)`+/g, '$1');

    /*
     * Line-level markers, before the inline ones: a `*` opening a list item and a
     * `*` opening emphasis are told apart by the space after it, and only while
     * the line still begins where it began.
     *
     * The full stop is added here, on the lines that had a marker, rather than
     * later on every line. A heading or a bullet ends where it ends whatever
     * follows it, and this is the last point at which that is still known — after
     * the marker is gone, a bullet and the second line of a wrapped sentence look
     * identical, and giving both a full stop invents a sentence break in the
     * middle of the prose one.
     */
    text = text
      .split('\n')
      .map((line) => {
        const stripped = line
          .replace(/^\s{0,3}#{1,6}\s+/, '')
          .replace(/^\s{0,3}>\s?/, '')
          .replace(/^\s{0,3}([-*+]|\d{1,3}[.)])\s+/, '')
          .replace(/^\s*\[[ xX]\]\s*/, '')
          .replace(/^\s{0,3}([-*_])(\s*\1){2,}\s*$/, '')
          .trim();
        if (stripped === line.trim() || !stripped) return stripped;
        return /[.!?:;,]$/.test(stripped) ? stripped : `${stripped}.`;
      })
      .join('\n');

    // Tables read as prose only if the pipes become pauses; the separator row is
    // not a row at all. Terminated here for the same reason a bullet is: a row is
    // one item, and this is the last point at which it is recognisable as one.
    text = text.replace(/^\s*\|?[\s:|-]*\|[\s:|-]*$/gm, '');
    text = text.replace(/^\s*\|(.*)\|\s*$/gm, (_m, row) => {
      const cells = row.split('|').map((cell) => cell.trim()).filter(Boolean).join(', ');
      return cells && !/[.!?:;,]$/.test(cells) ? `${cells}.` : cells;
    });

    text = text.replace(/(\*\*|__|~~)/g, '');
    text = text.replace(/(^|[\s(])[*_]([^\s*_][^*_]*)[*_]($|[\s.,;:!?)])/g, '$1$2$3');

    /*
     * A path is a word, and the word is its last segment.
     *
     * Reading "slash workspace slash projects slash claude dash web slash chat
     * dash service slash auth dot js" is how a spoken summary becomes unusable,
     * and the file name is the part that identifies it anyway. Guarded so that
     * ordinary prose keeps its slashes: it takes either a second slash or a file
     * extension on the end to count as a path, which leaves "and/or", "24/7" and
     * "km/h" alone.
     */
    text = text.replace(
      /(^|[\s("'])(\.{0,2}\/?[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)+)/g,
      (match, pre, candidate) => {
        const looksLikePath =
          (candidate.match(/\//g) || []).length >= 2 || /\.[A-Za-z]{1,5}$/.test(candidate);
        if (!looksLikePath) return match;
        const segments = candidate.split('/').filter((part) => part && part !== '.' && part !== '..');
        return pre + (segments[segments.length - 1] || candidate);
      },
    );
    // `auth.js:42` and `auth.js:42-51` are line references, and they are read as
    // ones. Left as a colon they run the number into the next sentence.
    text = text.replace(
      /([A-Za-z0-9._-]+\.[A-Za-z]{1,5}):(\d+)(?:-(\d+))?/g,
      (_m, file, from, to) => `${file}, line ${from}${to ? ` to ${to}` : ''}`,
    );

    // Arrows, box drawing, dingbats, check marks and emoji — written as escapes
    // because this file is injected raw into a page whose charset we do not set.
    // Deliberately NOT the General Punctuation block (U+2000–U+206F): the dashes
    // and curly quotes in it are how a sentence is paced, and a synthesiser reads
    // them as the pauses they are.
    // U+2300–U+27BF already contains the box-drawing block, hence no range for it.
    text = text.replace(/[\u2190-\u21FF\u2300-\u27BF\u2B00-\u2BFF\uFE0F]/g, ' ');
    text = text.replace(/[\u{1F000}-\u{1FAFF}]/gu, ' ');

    /*
     * A blank line ends a sentence; a single newline does not.
     *
     * Which is exactly what those two mean in markdown, and it is also how they
     * sound. A synthesiser reads a bare newline as nothing at all, so something has
     * to supply the pauses — but supplying one at every newline breaks prose that
     * happens to be hard-wrapped, and a full stop in the middle of a sentence is
     * heard as a real one ("it now reads the mic button's. class instead of"). That
     * is worse than a missing pause, because it changes what the sentence says.
     *
     * The short lines this used to be for — headings, bullets, table rows — are
     * already terminated above, at the point where their marker was still there to
     * prove they were one. So they keep their pacing and nothing has to guess.
     */
    const paragraphs = [];
    let broken = false;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) {
        broken = true;
        continue;
      }
      const previous = paragraphs.length - 1;
      if (broken && previous >= 0 && !/[.!?:;,]$/.test(paragraphs[previous])) {
        paragraphs[previous] += '.';
      }
      paragraphs.push(line);
      broken = false;
    }
    // The last sentence too, or the voice ends on the rising note of an
    // unterminated line and sounds like it was cut off.
    const last = paragraphs.length - 1;
    if (last >= 0 && !/[.!?]$/.test(paragraphs[last])) {
      paragraphs[last] = paragraphs[last].replace(/[:;,]$/, '') + '.';
    }
    text = paragraphs.join(' ');

    text = text.replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
    // Collapse what the two passes above can leave behind: "word.." from a line
    // that ended in an abbreviation, and " . " from a line that was only markup.
    text = text.replace(/\.{2,}/g, '.').replace(/(?:\s\.)+/g, '.').trim();

    if (text.length <= SPEECH_CAP) return text;
    // Cut at the last sentence that fits, so it stops on a full stop rather than
    // in the middle of a word — and say that there is more, because a summary
    // that just stops sounds like the answer ended there.
    const head = text.slice(0, SPEECH_CAP);
    const lastStop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
    const kept = lastStop > SPEECH_CAP / 3 ? head.slice(0, lastStop + 1) : head;
    return `${kept.trim()} That is as far as I will read; the rest is on screen.`;
  }

  /**
   * Sentences, by scanning rather than by regex.
   *
   * A lookbehind (`/(?<=[.!?])\s+/`) is the obvious way to write this and the
   * wrong one here: it is a *parse* error on a browser that does not support it,
   * so the whole file fails to load and every button on this bar disappears —
   * the exact silent failure `overlay-test.js` exists for, except that the test
   * runs on node, where the syntax is fine, and would never see it.
   */
  function splitSentences(text) {
    const out = [];
    let start = 0;
    for (let i = 0; i < text.length; i += 1) {
      if ('.!?'.indexOf(text[i]) === -1) continue;
      // Take a run of terminators together ("Really?!"), and only break if
      // whitespace follows — "3.5" and "auth.js" are not sentence ends.
      let end = i;
      while (end + 1 < text.length && '.!?'.indexOf(text[end + 1]) !== -1) end += 1;
      if (end + 1 < text.length && !/\s/.test(text[end + 1])) {
        i = end;
        continue;
      }
      out.push(text.slice(start, end + 1));
      start = end + 1;
      i = end;
    }
    if (start < text.length) out.push(text.slice(start));
    return out;
  }

  /**
   * Split into utterance-sized pieces at sentence boundaries.
   *
   * Sentences first, and only then a hard split of any single sentence longer
   * than the limit — a code-heavy line can be one 900-character "sentence", and
   * it still has to be said.
   */
  function speechPieces(text) {
    const pieces = [];
    let current = '';

    const flush = () => {
      const trimmed = current.trim();
      if (trimmed) pieces.push(trimmed);
      current = '';
    };

    // Trimmed here, not by the scanner: a split leaves the space that followed the
    // full stop on the front of the next sentence, and joining those with another
    // space is a double space inside an utterance.
    for (const piece of splitSentences(text).map((s) => s.trim())) {
      if (!piece) continue;
      if (piece.length > SPEECH_CHUNK) {
        flush();
        for (const word of piece.split(' ')) {
          if (current.length + word.length + 1 > SPEECH_CHUNK) flush();
          current += (current ? ' ' : '') + word;
        }
        flush();
        continue;
      }
      if (current.length + piece.length + 1 > SPEECH_CHUNK) flush();
      current += (current ? ' ' : '') + piece;
    }
    flush();
    return pieces;
  }

  /** Reflect speech on the bar and in the sheet, wherever either happens to be. */
  function paintSpeech() {
    statusBtn.classList.toggle('cmo-speaking', speaking);
    // The glyph changes as well as the colour: on the bar this is the only Stop
    // once the sheet has been dismissed, and a pulse alone does not say so.
    statusBtn.innerHTML = speaking ? '&#9632;' : '&#9673;';
    statusBtn.setAttribute(
      'aria-label',
      speaking ? 'Stop reading aloud' : 'Is Claude working?',
    );
    const sheetBtn = panel.querySelector('#cmo-speak');
    if (sheetBtn) sheetBtn.textContent = speaking ? 'Stop' : 'Read aloud';
  }

  function stopSpeech() {
    speechChunks = [];
    if (speaking) speaking = false;
    if (speechAvailable()) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* a synthesiser that refuses to be cancelled is still one we forget */
      }
    }
    paintSpeech();
  }

  /** Say the next piece, and the one after it, until Stop or the end. */
  function sayNext() {
    if (!speechChunks.length) {
      speaking = false;
      paintSpeech();
      return;
    }
    const piece = speechChunks.shift();
    const utterance = new window.SpeechSynthesisUtterance(piece);
    // The same language the recognizer dictates in, so one setting governs both
    // directions of the conversation.
    utterance.lang = navigator.language || 'en-US';
    // Chaining on `end` is what keeps iOS speaking past the first piece. `error`
    // is chained too rather than aborting: one refused piece (a stray character,
    // an interrupted voice) must not silence the rest of the message.
    utterance.onend = () => {
      if (speaking) sayNext();
    };
    utterance.onerror = () => {
      if (speaking) sayNext();
    };
    try {
      window.speechSynthesis.speak(utterance);
    } catch {
      // Nothing will be spoken, so do not leave a Stop button on the bar.
      stopSpeech();
    }
  }

  /**
   * Start reading. Returns whether anything will actually be said, so the caller
   * can label its own button honestly.
   *
   * `lead` is spoken first and is plain speech, not markdown — it goes on *after*
   * the reduction rather than in front of the message, because the strips that
   * remove headings and bullets are anchored to the start of a line, and anything
   * put in front of the first line hides the marker on it.
   *
   * Must be called inside the tap: see the note at the top of this section.
   */
  function speak(markdown, lead = '') {
    stopSpeech();
    if (!speechAvailable()) return false;
    /*
     * Never over a live microphone. The recognizer would hear this and dictate
     * Claude's own words back into the composer, and the whisper path would
     * record them and send them to be transcribed.
     *
     * Asked of the mic button rather than of `recognition`, because that class is
     * the one thing both dictation paths maintain — the recognizer sets it, and so
     * does the recorder, which holds its state in a local nothing else can see.
     */
    if (document.getElementById('cmo-mic')?.classList.contains('cmo-rec')) return false;
    const body = speakable(markdown);
    // Asked of the message, not of the lead: a lead alone is this feature
    // announcing itself and saying nothing, which is worse than the button
    // reporting that there was nothing to read.
    if (!body) return false;
    speechChunks = speechPieces(lead ? `${lead} ${body}` : body);
    if (!speechChunks.length) return false;
    speaking = true;
    paintSpeech();
    sayNext();
    return true;
  }

  // -------------------------------------------------------------- wiring
  document.getElementById('cmo-mic').addEventListener('click', () => {
    if (recognition) {
      stopRecognition();
      return;
    }
    if (!sheet.classList.contains('cmo-open')) openDictation();
  });
  document.getElementById('cmo-projects').addEventListener('click', openProjects);
  document.getElementById('cmo-layout').addEventListener('click', openLayout);
  // The chip is the answer; the button is how you get it back after it has gone,
  // and how you ask again without reloading.
  statusBtn.addEventListener('click', async () => {
    /*
     * While it is reading, this button is Stop.
     *
     * The sheet is dismissed by tapping beside it and the voice carries on, so at
     * that point the bar holds the only control there is — and a phone talking
     * with no visible way to stop it is the worst outcome this feature has. It
     * looks like Stop too: see `paintSpeech`.
     */
    if (speaking) {
      stopSpeech();
      return;
    }
    // Refreshed before opening, because this button is also "ask again" — and a
    // minutes-old snapshot is exactly the wrong thing to answer that with.
    await checkStatus();
    openStatus();
  });
  chip.addEventListener('click', () => {
    openStatus();
    hideChip();
  });
  // Straight to the chord, no sheet: a terminal appearing is its own feedback, and
  // pressing it again is what puts Claude back. The extension decides which of
  // those two a press means, since only it can see what is in front.
  document.getElementById('cmo-terminal').addEventListener('click', () => {
    pressChord(KEY_TERMINAL);
  });

  // One line per workbench load, so a phone that reloads itself leaves a trail.
  recordLoad();
  /*
   * A page restored from the back/forward cache is not a load — but the workbench
   * makes it one: its lifecycle service calls location.reload() on
   * `pageshow.persisted`, because the sockets it was holding while suspended are
   * gone. On a phone that is a routine event (switch apps, swipe back, answer a
   * message), and it is invisible from the server, which sees only another dead
   * extension host. So it gets its own line: if this one ever shows up right
   * before a `reload`, the cause is the browser suspending the tab, and no amount
   * of settling the layout on our side will change it.
   */
  // The debounce above must not be what loses the last sentence.
  window.addEventListener('pagehide', writeDictation);
  /*
   * Stop reading when the page goes away, but NOT when it is merely hidden.
   *
   * The workbench reloads itself on this surface, routinely — every bfcache
   * restore — and speech that outlives its own document cannot be stopped by
   * anything, because the button that would stop it has been destroyed. iOS has
   * shipped exactly that bug more than once.
   *
   * Hiding the tab is deliberately not the same thing. Pressing Read aloud and
   * then locking the phone, or switching to something else while it talks, is a
   * reasonable thing to do — it is close to the point of the feature — and
   * cutting it off there would break the one case where hearing it beats reading
   * it. Unlike the recognizer, a synthesiser losing the foreground loses nothing:
   * it either keeps speaking or is resumed by the OS.
   */
  window.addEventListener('pagehide', stopSpeech);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') writeDictation();
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) recordLoad('bfcache-restore');
  });

  /*
   * Ask on arrival, and ask again whenever this tab comes back.
   *
   * Coming back to the tab is the other half of the same question: you left the
   * phone with Claude working, you return, and what you want to know before
   * anything renders is whether it finished. Polling stops while the tab is
   * hidden — a suspended phone tab must not hold a request open every four
   * seconds — so returning is also when polling has to be picked back up.
   */
  checkStatus();
  startStatusHeartbeat();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      stopStatusPoll();
      return;
    }
    statusPollingSince = Date.now();
    checkStatus();
  });
  // Returning to the window is the cheapest signal there is that something may
  // have changed in the panel while attention was elsewhere.
  window.addEventListener('focus', () => {
    if (document.visibilityState === 'visible') refreshStatus({ silent: true });
  });

  /*
   * Long-press either button to flip the bar to the other edge, and remember it.
   * A fixed overlay will eventually sit on top of something that matters, so
   * there has to be a way out without waiting on a redeploy.
   */
  const SIDE_KEY = 'cmo-side';
  function applySide(side) {
    if (side === 'right') {
      fab.style.left = 'auto';
      fab.style.right = 'max(6px, env(safe-area-inset-right))';
    } else {
      fab.style.right = 'auto';
      fab.style.left = 'max(6px, env(safe-area-inset-left))';
    }
  }
  applySide(localStorage.getItem(SIDE_KEY) || 'left');

  fab.querySelectorAll('.cmo-btn').forEach((btn) => {
    let timer = null;
    const begin = () => {
      timer = setTimeout(() => {
        const next = (localStorage.getItem(SIDE_KEY) || 'left') === 'left' ? 'right' : 'left';
        localStorage.setItem(SIDE_KEY, next);
        applySide(next);
        timer = null;
        btn.dataset.moved = '1'; // suppress the click that follows
      }, 550);
    };
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    btn.addEventListener('touchstart', begin, { passive: true });
    btn.addEventListener('touchend', cancel);
    btn.addEventListener('touchmove', cancel, { passive: true });
    btn.addEventListener('mousedown', begin);
    btn.addEventListener('mouseup', cancel);
    btn.addEventListener('mouseleave', cancel);
    btn.addEventListener(
      'click',
      (e) => {
        if (btn.dataset.moved) {
          delete btn.dataset.moved;
          e.stopImmediatePropagation();
          e.preventDefault();
        }
      },
      true,
    );
  });

  // Fade in while interacting so the buttons aren't ghostly when needed.
  fab.addEventListener('touchstart', () => fab.classList.add('cmo-active'), { passive: true });
  document.addEventListener('touchstart', (e) => {
    if (!fab.contains(e.target)) fab.classList.remove('cmo-active');
  }, { passive: true });
})();
