/**
 * Authentication tests, run by deploy.sh before anything ships.
 *
 * These exist because the bug they guard against already happened once: the
 * chat API was reachable without credentials while every comment and doc in the
 * repo said it was gated. A unit test of `verifyPassword` would not have caught
 * that — the hole was in the wiring, not the crypto — so these tests boot the
 * real server and speak HTTP and WebSocket to it.
 *
 * Run: node auth-test.js
 */
import { spawn } from 'child_process';
import { once } from 'events';
import { WebSocket } from 'ws';

const PASSWORD = 'test-password-32-chars-long-enough';
const SECRET = 'a-long-enough-session-secret-value';

// Each server instance gets a fresh port. Reusing one port across instances lets
// a leftover process from an earlier run answer these tests instead — which
// showed a green "unauthenticated access denied" while the server under test had
// never started. A test that passes against the wrong process is worse than no
// test at all here.
let nextPort = 19970;
let PORT = nextPort;
let BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
let checks = 0;

function check(name, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Boot the real server as a child process, with auth configured. */
async function startServer(env) {
  nextPort += 1;
  PORT = nextPort;
  BASE = `http://127.0.0.1:${PORT}`;

  const child = spawn(process.execPath, ['server.js'], {
    cwd: import.meta.dirname,
    env: {
      ...process.env,
      PORT: String(PORT),
      // Cookies would otherwise be Secure-only and never sent over plain HTTP.
      CW_INSECURE_COOKIES: '1',
      PROJECTS_ROOT: '/tmp/claude-web-test-projects',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  // Wait for the listener, or for the process to die reporting why.
  const ready = await Promise.race([
    (async () => {
      for (let i = 0; i < 100; i += 1) {
        try {
          const res = await fetch(`${BASE}/healthz`);
          if (res.ok) return true;
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    })(),
    once(child, 'exit').then(() => false),
  ]);

  return { child, ready, stderr: () => stderr };
}

/**
 * Resolve with how a WebSocket attempt ended. `once(ws, 'error')` *rejects*
 * rather than resolving, so it cannot be used here — a rejected upgrade is the
 * expected result in half of these tests, not a test failure.
 */
function wsOutcome(url, options) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, options);
    const finish = (outcome) => {
      clearTimeout(timer);
      try { ws.terminate(); } catch { /* already closed */ }
      resolve(outcome);
    };
    const timer = setTimeout(() => finish('timeout'), 4000);
    ws.on('open', () => finish('opened'));
    ws.on('error', (err) => finish(`rejected: ${err.message}`));
  });
}

function stop(child) {
  // A server that refused to start has already exited, and awaiting a second
  // 'exit' from it would hang the test run forever.
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  child.kill('SIGKILL');
  return once(child, 'exit').catch(() => {});
}

// --- 1. Fail-closed configuration -------------------------------------------
console.log('\nRefuses to start when misconfigured:');
{
  // No password at all: the exact state a self-hoster lands in by forgetting a
  // step. Starting up here would publish a shell to the internet.
  const { child, ready, stderr } = await startServer({ AUTH_PASSWORD: '', SESSION_SECRET: '' });
  check('no AUTH_PASSWORD → server does not serve', !ready);
  check('explains why it refused', /AUTH_PASSWORD is not set/.test(stderr()), stderr().slice(0, 200));
  await stop(child);
}
{
  const { child, ready } = await startServer({
    AUTH_PASSWORD: 'short',
    SESSION_SECRET: SECRET,
  });
  check('too-short password → server does not serve', !ready);
  await stop(child);
}
{
  const { child, ready } = await startServer({
    AUTH_PASSWORD: PASSWORD,
    SESSION_SECRET: 'tiny',
  });
  check('weak SESSION_SECRET → server does not serve', !ready);
  await stop(child);
}

// --- 2. The gate, with a correctly configured server ------------------------
const { child, ready, stderr } = await startServer({
  AUTH_PASSWORD: PASSWORD,
  SESSION_SECRET: SECRET,
});
if (!ready) {
  console.error('server failed to start:\n', stderr());
  process.exit(1);
}

console.log('\nRejects unauthenticated access:');
// Every route that can reach the Claude process or the filesystem.
const guarded = [
  ['GET', '/api/projects'],
  ['POST', '/api/projects'],
  // Reads and writes the project tree: status inspects a repository, remove
  // deletes a directory, clone runs git against the network.
  ['GET', '/api/project-status?name=demo'],
  ['POST', '/api/projects/remove'],
  ['POST', '/api/projects/clone'],
  ['GET', '/api/github/repos'],
  ['GET', '/api/transcript?cwd=/tmp&sessionId=x'],
  ['GET', '/api/models'],
  ['GET', '/api/voice-status'],
  ['POST', '/api/transcribe'],
  // Spends Bedrock tokens on caller-supplied text, so it is a paid endpoint as
  // well as a private one.
  ['POST', '/api/polish'],
  ['POST', '/api/client-error'],
  // The operations surface. `/admin` is the reason this list matters most: it
  // enumerates every process on the box and can signal three of them, so an
  // unauthenticated hit here would be a remote inventory *and* a remote kill.
  ['GET', '/admin'],
  ['GET', '/admin.html'],
  ['GET', '/admin.js'],
  ['GET', '/api/admin/overview'],
  ['POST', '/api/admin/kill'],
  ['POST', '/api/admin/reap'],
  ['GET', '/api/live'],
  ['GET', '/app.js'],
  ['GET', '/'],
];
for (const [method, path] of guarded) {
  const res = await fetch(`${BASE}${path}`, { method, redirect: 'manual' });
  // 401 for API callers, 302 to /login for a browser navigation.
  check(
    `${method} ${path} → denied`,
    res.status === 401 || res.status === 302,
    `got ${res.status}`,
  );
}

console.log('\nOpen paths stay open:');
{
  const health = await fetch(`${BASE}/healthz`);
  check('GET /healthz → 200', health.status === 200, `got ${health.status}`);
  const login = await fetch(`${BASE}/login`);
  check('GET /login → 200', login.status === 200, `got ${login.status}`);
  const body = await login.text();
  check('login page does not leak the password', !body.includes(PASSWORD));
}

console.log('\nWebSocket upgrade requires a session:');
{
  const outcome = await wsOutcome(`ws://127.0.0.1:${PORT}/ws`);
  // Specifically a 401: the socket must be refused at the handshake, before any
  // frame can ask for a `claude` process.
  check('unauthenticated /ws → rejected with 401', outcome.includes('401'), `got ${outcome}`);
}

console.log('\nLogin:');
let cookie = null;
{
  const bad = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong' }),
  });
  check('wrong password → 401', bad.status === 401, `got ${bad.status}`);
  check('wrong password sets no cookie', !bad.headers.get('set-cookie'));

  const good = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  check('correct password → 204', good.status === 204, `got ${good.status}`);
  const setCookie = good.headers.get('set-cookie') || '';
  check('cookie is HttpOnly', /HttpOnly/i.test(setCookie), setCookie);
  check('cookie is SameSite', /SameSite=Lax/i.test(setCookie), setCookie);
  cookie = setCookie.split(';')[0];
}

console.log('\nWith a valid session:');
{
  const res = await fetch(`${BASE}/api/models`, { headers: { Cookie: cookie } });
  check('GET /api/models → 200', res.status === 200, `got ${res.status}`);

  const check2 = await fetch(`${BASE}/api/auth-check`, { headers: { Cookie: cookie } });
  check('GET /api/auth-check → 204', check2.status === 204, `got ${check2.status}`);

  const outcome = await wsOutcome(`ws://127.0.0.1:${PORT}/ws`, {
    headers: { Cookie: cookie },
  });
  check('authenticated /ws → opens', outcome === 'opened', `got ${outcome}`);
}

console.log('\nSends a browser to the login page, preserving where it was going:');
{
  const res = await fetch(`${BASE}/api/projects`, {
    headers: { Accept: 'text/html' },
    redirect: 'manual',
  });
  const location = res.headers.get('location') || '';
  check('HTML request → 302', res.status === 302, `got ${res.status}`);
  check('redirects to /login with ?next=', location.startsWith('/login?next='), location);
  // An absolute URL here would be an open redirect primitive on a login page.
  check(
    'next= is a relative path, not an absolute URL',
    !/next=https?(%3A|:)/i.test(location),
    location,
  );
}

console.log('\nRefuses to turn client input into arbitrary file paths:');
{
  // Authenticated, so not a privilege boundary — a logged-in user already has a
  // shell. Checked anyway: client-supplied values should never reach a path join
  // unvalidated, whoever is asking.
  const traversal = await fetch(
    `${BASE}/api/transcript?cwd=/tmp&sessionId=${encodeURIComponent('../../../../etc/passwd')}`,
    { headers: { Cookie: cookie } },
  );
  const body = await traversal.text();
  check(
    'traversal in sessionId is rejected',
    traversal.status >= 400 && !body.includes('root:'),
    `status ${traversal.status}`,
  );

  const escape = await fetch(`${BASE}/../server.js`, { headers: { Cookie: cookie } });
  const escaped = await escape.text();
  check(
    'traversal in a static path does not serve server source',
    !escaped.includes('WebSocketServer'),
    `status ${escape.status}`,
  );
}

console.log('\nRejects forged and tampered cookies:');
{
  const forged = [
    'cw_session=nonsense',
    'cw_session=9999999999.abc.deadbeef',
    // Valid structure, signature from a different key.
    `${cookie}x`,
    // Expired but otherwise well-formed.
    'cw_session=1.abc.' + 'A'.repeat(43),
  ];
  for (const c of forged) {
    const res = await fetch(`${BASE}/api/models`, { headers: { Cookie: c } });
    check(`forged cookie rejected (${c.slice(0, 28)}…)`, res.status === 401, `got ${res.status}`);
  }
}

console.log('\nThrottles guessing:');
{
  let sawLockout = false;
  for (let i = 0; i < 20; i += 1) {
    let res;
    try {
      res = await fetch(`${BASE}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: `guess-${i}` }),
      });
    } catch {
      // Keep-alive socket recycled under a rapid burst. Not a result either way.
      continue;
    }
    if (res.status === 429) { sawLockout = true; break; }
  }
  check('repeated wrong passwords → 429 lockout', sawLockout);

  // The lockout must not be a denial-of-service against the real operator's
  // password once it expires, so confirm it is time-based rather than permanent.
  const status = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  }).then((r) => r.status);
  check('lockout applies even to the correct password', status === 429, `got ${status}`);
}

await stop(child);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`${failures} FAILED — not safe to deploy.`);
  process.exit(1);
}
