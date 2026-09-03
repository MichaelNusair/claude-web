/*
 * Mobile overlay for code-server: voice dictation + project switcher.
 *
 * Design constraint learned the hard way: do not touch the workbench's DOM or
 * CSS. VS Code positions its parts with absolute inline styles computed in JS,
 * so hiding or resizing them via CSS desynchronises the layout and paints a
 * blank gray screen. Everything here lives in its own fixed-position container
 * appended to <body>, above the workbench, and never restyles it.
 *
 * The Claude Code panel is a cross-origin iframe (webviews are served from
 * vscode-cdn.net), so its input cannot be written to directly. Dictated text is
 * therefore delivered the two ways that do work from outside a webview:
 *   1. clipboard — one tap to paste, works everywhere
 *   2. synthetic keystrokes into whatever has focus, for same-origin inputs
 * Both are offered; the UI is explicit about which it used.
 */
(function () {
  'use strict';

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
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ------------------------------------------------------------- scaffolding
  const fab = document.createElement('div');
  fab.id = 'cmo-fab';
  fab.innerHTML = `
    <button class="cmo-btn cmo-secondary" id="cmo-projects" aria-label="Switch project">&#9707;</button>
    <button class="cmo-btn" id="cmo-mic" aria-label="Dictate">&#127908;</button>`;
  document.body.appendChild(fab);

  const sheet = document.createElement('div');
  sheet.id = 'cmo-sheet';
  sheet.innerHTML = '<div class="cmo-panel" id="cmo-panel"></div>';
  document.body.appendChild(sheet);

  const panel = sheet.querySelector('#cmo-panel');
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) closeSheet();
  });

  function openSheet(html) {
    panel.innerHTML = html;
    sheet.classList.add('cmo-open');
  }
  function closeSheet() {
    sheet.classList.remove('cmo-open');
    stopRecognition();
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

  function openDictation() {
    committedText = '';
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
    textarea.focus();

    panel.querySelector('#cmo-cancel').addEventListener('click', closeSheet);
    panel.querySelector('#cmo-again').addEventListener('click', () => {
      stopRecognition();
      startDictation(textarea, status);
    });
    panel.querySelector('#cmo-copy').addEventListener('click', async () => {
      const text = textarea.value.trim();
      if (!text) return closeSheet();
      try {
        await navigator.clipboard.writeText(text);
        status.textContent = 'Copied — paste into Claude.';
      } catch {
        // Clipboard API needs a secure context and can still be refused;
        // selecting the text lets the user copy with the native control.
        textarea.select();
        status.textContent = 'Press Copy on the selection.';
        return;
      }
      setTimeout(closeSheet, 700);
    });

    startDictation(textarea, status);
  }

  function startDictation(textarea, status) {
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
      projects = (await res.json()).projects || [];
    } catch {
      panel.innerHTML =
        '<p class="cmo-title">Open project</p><p class="cmo-hint">Could not reach the server.</p>';
      return;
    }

    const items = projects
      .map(
        (p) =>
          `<button class="cmo-item" data-path="${encodeURIComponent(p.path)}">${p.name}</button>`,
      )
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
        // ?folder= is code-server's own way to open a workspace.
        location.href = `/?folder=${btn.dataset.path}`;
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
          location.href = `/?folder=${encodeURIComponent(data.project.path)}`;
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

  // -------------------------------------------------------------- wiring
  document.getElementById('cmo-mic').addEventListener('click', () => {
    if (recognition) {
      stopRecognition();
      return;
    }
    if (!sheet.classList.contains('cmo-open')) openDictation();
  });
  document.getElementById('cmo-projects').addEventListener('click', openProjects);

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
