/**
 * Boot the client in a real DOM and assert it renders.
 *
 * `node --check` only parses — it cannot catch a runtime ReferenceError like
 * using a `const` before its declaration, which kills the whole script and
 * leaves the page stuck on "Loading…". That exact bug shipped once; this test
 * exists so it can't again.
 *
 * Run: node chat-service/smoke-test.js
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, 'public');

const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
const js = readFileSync(join(publicDir, 'app.js'), 'utf8');

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  // Any HTTPS origin works; the client only reads location.protocol and .host to
  // build the WebSocket URL. Kept deliberately generic so this test is not tied
  // to one deployment's hostname.
  url: 'https://claude.example.com/',
});
const w = dom.window;

const calls = [];
w.fetch = (url) => {
  calls.push(String(url));
  const body = String(url).includes('/api/projects')
    ? {
        projects: [
          {
            name: 'demo',
            path: '/workspace/projects/demo',
            sessions: [{ sessionId: 'abc123', mtime: Date.now(), title: 'a past chat' }],
          },
        ],
      }
    : { models: [{ id: 'us.anthropic.claude-opus-5', label: 'Opus 5' }] };
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
};

// Minimal WebSocket stand-in: the list screen must render without a live socket.
w.WebSocket = function () {
  this.addEventListener = () => {};
  this.send = () => {};
  this.close = () => {};
  this.readyState = 0;
};
w.WebSocket.CONNECTING = 0;
w.WebSocket.OPEN = 1;
w.matchMedia = () => ({ matches: false, addEventListener() {} });

const failures = [];
w.addEventListener('error', (e) => failures.push(`uncaught: ${e.message}`));

try {
  w.eval(js);
} catch (err) {
  console.error(`FAIL: app.js threw on load — ${err.constructor.name}: ${err.message}`);
  console.error(err.stack?.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}

// Give the boot-time fetches a tick to settle.
await new Promise((resolve) => setTimeout(resolve, 300));

const listBody = w.document.querySelector('#list-body')?.innerHTML ?? '';

if (!calls.some((u) => u.includes('/api/projects'))) {
  failures.push('never fetched /api/projects');
}
if (listBody.includes('Loading')) {
  failures.push('list still shows "Loading…" after boot');
}
if (!listBody.includes('class="row"')) {
  failures.push('no conversation rows rendered');
}
if (!listBody.includes('a past chat')) {
  failures.push('session title missing from the rendered list');
}

// A resumed conversation arrives as one `history` frame. Assert the client can
// render it — this path is what a phone hits when opening an existing chat.
const handler = w.__handleEventForTest;
if (typeof handler === 'function') {
  try {
    handler({
      type: 'history',
      truncated: 340,
      messages: [
        { type: 'user_message', text: 'a question' },
        { type: 'assistant_text', text: 'an **answer** with `code`' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a/b.txt' } },
      ],
    });
    const thread = w.document.querySelector('#thread')?.innerHTML ?? '';
    if (!thread.includes('a question')) failures.push('history: user message not rendered');
    if (!thread.includes('answer')) failures.push('history: assistant message not rendered');
    if (!thread.includes('class="tool"')) failures.push('history: tool card not rendered');
    if (!thread.includes('340 earlier')) failures.push('history: truncation notice missing');
  } catch (err) {
    failures.push(`history render threw: ${err.message}`);
  }
} else {
  failures.push('client did not expose handleEvent for testing');
}

if (failures.length) {
  console.error('FAIL:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('PASS: client boots, lists conversations, and renders resumed history');
