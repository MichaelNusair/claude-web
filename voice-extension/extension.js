const vscode = require('vscode');

/**
 * Voice dictation for code-server.
 *
 * Recording has to happen in a webview: getUserMedia/MediaRecorder are browser
 * APIs, and the extension host runs on the server with no microphone. So the
 * webview records and transcribes, then posts the text back here, and the
 * extension inserts it at the cursor.
 *
 * Insertion mirrors the GetVL VoiceTask behaviour: capture the selection before
 * recording, insert at that point with smart spacing, then leave the cursor
 * after the inserted text so you can immediately dictate again elsewhere.
 */

let panel = null;
/** Where to put the next transcript: the editor + selection captured at record time. */
let pendingTarget = null;

function activate(context) {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'claudeVoice.dictate';
  status.text = '$(mic) Dictate';
  status.tooltip = 'Voice: Dictate at Cursor';
  status.show();
  context.subscriptions.push(status);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeVoice.dictate', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage(
          'Voice: open a file first, or use "Voice: Dictate to Claude Code".',
        );
        return;
      }
      // Capture target before the webview steals focus.
      pendingTarget = { kind: 'editor', uri: editor.document.uri, selection: editor.selection };
      openRecorder(context, status, 'insert');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeVoice.dictateToClaude', () => {
      pendingTarget = { kind: 'claude' };
      openRecorder(context, status, 'claude');
    }),
  );
}

function openRecorder(context, status, mode) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside, true);
    panel.webview.postMessage({ type: 'reset', mode });
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'claudeVoiceRecorder',
    'Voice Dictation',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
    { enableScripts: true, retainContextWhenHidden: true },
  );

  panel.webview.html = recorderHtml(mode);

  panel.onDidDispose(() => {
    panel = null;
  }, null, context.subscriptions);

  panel.webview.onDidReceiveMessage(
    async (msg) => {
      if (msg.type === 'status') {
        status.text = `$(sync~spin) ${msg.text}`;
        return;
      }
      if (msg.type === 'error') {
        status.text = '$(mic) Dictate';
        vscode.window.showErrorMessage(`Voice: ${msg.text}`);
        return;
      }
      if (msg.type === 'transcript') {
        status.text = '$(mic) Dictate';
        await deliverTranscript(msg.text, msg.mode);
      }
    },
    null,
    context.subscriptions,
  );
}

async function deliverTranscript(text, mode) {
  const transcript = (text || '').trim();
  if (!transcript) {
    vscode.window.showWarningMessage('Voice: nothing was transcribed.');
    return;
  }

  if (mode === 'claude' || !pendingTarget || pendingTarget.kind === 'claude') {
    // The Claude Code extension's input lives in a sandboxed webview we cannot
    // write into, so hand the text over via the clipboard and focus its input.
    await vscode.env.clipboard.writeText(transcript);
    try {
      await vscode.commands.executeCommand('claude-vscode.focus');
    } catch {
      /* extension may not be active; clipboard still holds the text */
    }
    vscode.window.setStatusBarMessage('$(check) Transcript copied — paste into Claude', 4000);
    return;
  }

  const doc = await vscode.workspace.openTextDocument(pendingTarget.uri);
  const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false });
  const sel = pendingTarget.selection || editor.selection;

  // Smart spacing: don't glue words together, don't double up existing spaces.
  const line = doc.lineAt(sel.start.line).text;
  const charBefore = sel.start.character > 0 ? line[sel.start.character - 1] : '';
  const charAfter = line[sel.end.character] || '';
  const needsSpaceBefore = charBefore !== '' && !/\s/.test(charBefore);
  const needsSpaceAfter = charAfter !== '' && !/\s/.test(charAfter);
  const insertText =
    (needsSpaceBefore ? ' ' : '') + transcript + (needsSpaceAfter ? ' ' : '');

  await editor.edit((edit) => {
    if (sel.isEmpty) edit.insert(sel.start, insertText);
    else edit.replace(sel, insertText);
  });

  // Leave the cursor after the inserted text so the next dictation continues
  // naturally from here.
  const endPos = doc.positionAt(doc.offsetAt(sel.start) + insertText.length);
  editor.selection = new vscode.Selection(endPos, endPos);
  pendingTarget = { kind: 'editor', uri: doc.uri, selection: editor.selection };
}

function recorderHtml(mode) {
  return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; height: 100vh; margin: 0; gap: 18px;
  }
  #mic {
    width: 132px; height: 132px; border-radius: 50%;
    border: none; cursor: pointer; font-size: 46px; color: #fff;
    background: var(--vscode-button-background, #0e639c);
    transition: transform .12s ease, background .2s ease;
    -webkit-tap-highlight-color: transparent; touch-action: manipulation;
  }
  #mic:active { transform: scale(.94); }
  #mic.recording { background: #d13438; animation: pulse 1.4s ease-in-out infinite; }
  #mic:disabled { opacity: .5; cursor: default; animation: none; }
  @keyframes pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(209,52,56,.55); }
                     50%     { box-shadow: 0 0 0 22px rgba(209,52,56,0); } }
  #label { font-size: 14px; opacity: .85; text-align: center; padding: 0 16px; }
  #timer { font-variant-numeric: tabular-nums; font-size: 20px; opacity: .7; }
</style>
</head>
<body>
  <button id="mic" aria-label="Record">&#127908;</button>
  <div id="timer">0:00</div>
  <div id="label">Tap to start recording. Tap again to stop and insert.</div>
<script>
  const vscodeApi = acquireVsCodeApi();
  const mic = document.getElementById('mic');
  const label = document.getElementById('label');
  const timerEl = document.getElementById('timer');
  let mode = ${JSON.stringify(mode)};
  let recorder = null, chunks = [], stream = null, recording = false;
  let started = 0, ticker = null;

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'reset') mode = e.data.mode;
  });

  function pickMimeType() {
    const types = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4'];
    return types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }

  function tick() {
    const s = Math.floor((Date.now() - started) / 1000);
    timerEl.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      // Browsers only grant mic access over a secure origin.
      vscodeApi.postMessage({ type: 'error', text: 'microphone blocked: ' + err.message });
      label.textContent = 'Microphone denied. Allow mic access for this site.';
      return;
    }
    chunks = [];
    recorder = new MediaRecorder(stream, { mimeType: pickMimeType() });
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = onStop;
    recorder.start();
    recording = true;
    started = Date.now();
    ticker = setInterval(tick, 250);
    mic.classList.add('recording');
    mic.innerHTML = '&#9632;';
    label.textContent = 'Recording… tap to stop.';
  }

  function stop() {
    if (!recorder || recorder.state === 'inactive') return;
    recording = false;
    clearInterval(ticker);
    recorder.stop();
    mic.classList.remove('recording');
    mic.disabled = true;
    mic.innerHTML = '&#8987;';
    label.textContent = 'Transcribing…';
    vscodeApi.postMessage({ type: 'status', text: 'Transcribing…' });
  }

  async function onStop() {
    const blob = new Blob(chunks, { type: recorder.mimeType });
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    try {
      const form = new FormData();
      form.append('audio', blob, 'recording.webm');
      const res = await fetch('/voice/transcribe', { method: 'POST', body: form });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(detail.slice(0, 200) || ('HTTP ' + res.status));
      }
      const data = await res.json();
      vscodeApi.postMessage({ type: 'transcript', text: data.text, mode });
      label.textContent = 'Inserted. Tap to dictate again.';
      timerEl.textContent = '0:00';
    } catch (err) {
      vscodeApi.postMessage({ type: 'error', text: err.message });
      label.textContent = 'Transcription failed. Tap to retry.';
    } finally {
      mic.disabled = false;
      mic.innerHTML = '&#127908;';
    }
  }

  mic.addEventListener('click', () => (recording ? stop() : start()));
</script>
</body>
</html>`;
}

function deactivate() {}

module.exports = { activate, deactivate };
