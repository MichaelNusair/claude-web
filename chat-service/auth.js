/**
 * Authentication for the chat service.
 *
 * This is THE security boundary, and it lives here on purpose. An earlier
 * version of this project delegated the decision to nginx — the config comment
 * claimed an `auth_request` gate that had never been written — which left
 * `/api/*` and `/ws` open to the internet while every doc said otherwise. The
 * process that spawns `claude --permission-mode bypassPermissions` now refuses
 * to serve a single byte to an unauthenticated caller, regardless of what any
 * reverse proxy in front of it does or doesn't do.
 *
 * Two modes:
 *
 *   password (default) — one shared secret, verified here, exchanged for an
 *     HMAC-signed session cookie. No external dependency, so a fresh deploy is
 *     closed without the operator configuring an identity provider.
 *
 *   oidc — authentication happens at the load balancer, which forwards a signed
 *     JWT. We still verify that JWT's signature: "the ALB checked it" is only
 *     true if the header actually came from the ALB.
 *
 * Both modes fail closed. Missing or weak configuration aborts startup rather
 * than degrading to open access, because the failure mode of the alternative is
 * remote code execution.
 *
 * AUTHENTICATION IS NOT AUTHORIZATION, and in oidc mode that distinction is the
 * whole ball game. An ALB `authenticate-oidc` action proves the caller holds an
 * account with the provider — not that they are *you*. Pointed at Google with no
 * further check, "logged in" means every Google account in existence, which on a
 * box running `claude --permission-mode bypassPermissions` is a world-readable
 * shell. So oidc mode additionally requires an identity allowlist
 * (CW_OIDC_ALLOWED_EMAILS / CW_OIDC_ALLOWED_DOMAIN) and refuses to start without
 * one. The allowlist is checked only against claims from a JWT whose signature
 * has already been verified — see verifyOidc.
 */
import { createHmac, timingSafeEqual, createHash, randomUUID } from 'crypto';
import { createVerify } from 'crypto';

const COOKIE_NAME = 'cw_session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days — this is a personal tool.
const MIN_SECRET_LENGTH = 16;

export const AUTH_MODE = (process.env.CW_AUTH_MODE || 'password').toLowerCase();

/**
 * Startup validation. Called once at boot; throws to kill the process.
 *
 * Deliberately strict: a self-hoster who forgets to set a password should get a
 * service that does not start, not one that starts and lets anyone in.
 */
export function assertAuthConfig() {
  if (AUTH_MODE === 'password') {
    const password = process.env.AUTH_PASSWORD || '';
    const secret = process.env.SESSION_SECRET || '';
    if (!password) {
      throw new Error(
        'AUTH_PASSWORD is not set. Refusing to start: the chat service executes ' +
          'shell commands, so running it unauthenticated would expose remote code ' +
          'execution. Set AUTH_PASSWORD (see docs/DEPLOY.md).',
      );
    }
    if (password.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `AUTH_PASSWORD is only ${password.length} characters; ${MIN_SECRET_LENGTH} is the ` +
          'minimum. This password is the only thing between the internet and a shell.',
      );
    }
    if (!secret || secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        'SESSION_SECRET is missing or too short. It signs session cookies; a ' +
          `predictable value lets anyone forge one. Need ${MIN_SECRET_LENGTH}+ characters.`,
      );
    }
    return;
  }

  if (AUTH_MODE === 'oidc') {
    if (!process.env.CW_OIDC_EXPECTED_CLIENT_ID) {
      throw new Error(
        'CW_AUTH_MODE=oidc requires CW_OIDC_EXPECTED_CLIENT_ID so forwarded tokens ' +
          'can be checked against the app they were issued for.',
      );
    }
    if (!process.env.AWS_REGION && !process.env.CW_REGION) {
      throw new Error('CW_AUTH_MODE=oidc requires AWS_REGION to fetch ALB signing keys.');
    }
    // The one that matters. Without it the provider's entire user base is
    // authorised, which for a public provider like Google is the internet.
    const { emails, domain } = oidcAllowList();
    if (!emails.size && !domain) {
      throw new Error(
        'CW_AUTH_MODE=oidc requires CW_OIDC_ALLOWED_EMAILS (or CW_OIDC_ALLOWED_DOMAIN). ' +
          'The load balancer only proves the caller has an account with your identity ' +
          'provider — with Google, that is every Google account in existence. This ' +
          'service hands out a shell, so it refuses to start without knowing which ' +
          'identities are yours. Set oidc.allowedEmails in triplec.config.json.',
      );
    }
    return;
  }

  throw new Error(`Unknown CW_AUTH_MODE "${AUTH_MODE}". Expected "password" or "oidc".`);
}

// --- password mode ----------------------------------------------------------

/**
 * Cookies are signed with a key derived from both the session secret and the
 * current password, so rotating the password invalidates every outstanding
 * session for free. Without this, a leaked password stays useful after rotation
 * for as long as the attacker's cookie lives.
 */
function signingKey() {
  return createHmac('sha256', process.env.SESSION_SECRET || '')
    .update('cw-session-v1')
    .update(createHash('sha256').update(process.env.AUTH_PASSWORD || '').digest())
    .digest();
}

/** Compare digests, not strings: string comparison leaks length and prefix via timing. */
function constantTimeEqual(a, b) {
  const da = createHash('sha256').update(String(a)).digest();
  const db = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(da, db);
}

export function verifyPassword(candidate) {
  if (typeof candidate !== 'string' || !candidate) return false;
  return constantTimeEqual(candidate, process.env.AUTH_PASSWORD || '');
}

function sign(payload) {
  return createHmac('sha256', signingKey()).update(payload).digest('base64url');
}

/** A session token is `<expiry>.<session-id>.<hmac>` — no secrets inside it. */
function mintToken() {
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${expires}.${randomUUID()}`;
  return `${payload}.${sign(payload)}`;
}

function tokenIsValid(token) {
  if (typeof token !== 'string') return false;
  // Split from the right: the signature is the last segment, everything before
  // it is the signed payload.
  const lastDot = token.lastIndexOf('.');
  if (lastDot < 1) return false;
  const payload = token.slice(0, lastDot);
  const signature = token.slice(lastDot + 1);

  const expected = sign(payload);
  // timingSafeEqual throws on length mismatch, so check that first.
  if (signature.length !== expected.length) return false;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;

  const expires = Number(payload.split('.')[0]);
  if (!Number.isFinite(expires)) return false;
  return expires > Math.floor(Date.now() / 1000);
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/**
 * `Secure` is set unless we're explicitly told the deployment is plain HTTP
 * (local development). In production the cookie must never travel in the clear.
 */
export function sessionCookie() {
  const secure = process.env.CW_INSECURE_COOKIES === '1' ? '' : ' Secure;';
  return (
    `${COOKIE_NAME}=${mintToken()}; Path=/; HttpOnly;${secure} ` +
    `SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`
  );
}

export function clearedCookie() {
  const secure = process.env.CW_INSECURE_COOKIES === '1' ? '' : ' Secure;';
  return `${COOKIE_NAME}=; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=0`;
}

// --- login throttling -------------------------------------------------------

/**
 * Per-IP lockout with exponential backoff. nginx also rate-limits the login
 * route, but that protects the box rather than the password: this is what makes
 * an online guessing attack against a 32-character secret hopeless even if the
 * proxy limit is raised or removed.
 */
const attempts = new Map();
const MAX_TRACKED_IPS = 10_000;
const FREE_ATTEMPTS = 5;

export function throttleStatus(ip) {
  const record = attempts.get(ip);
  if (!record) return { locked: false };
  if (record.lockedUntil > Date.now()) {
    return { locked: true, retryAfter: Math.ceil((record.lockedUntil - Date.now()) / 1000) };
  }
  return { locked: false };
}

export function recordFailure(ip) {
  // Bound memory: a spray across forged source addresses must not grow this
  // map without limit. Oldest entries go first.
  if (attempts.size > MAX_TRACKED_IPS) {
    for (const key of attempts.keys()) {
      attempts.delete(key);
      if (attempts.size <= MAX_TRACKED_IPS / 2) break;
    }
  }
  const record = attempts.get(ip) || { fails: 0, lockedUntil: 0 };
  record.fails += 1;
  if (record.fails > FREE_ATTEMPTS) {
    const over = record.fails - FREE_ATTEMPTS;
    const backoffSeconds = Math.min(15 * 60, 2 ** Math.min(over, 10));
    record.lockedUntil = Date.now() + backoffSeconds * 1000;
  }
  attempts.set(ip, record);
}

export function recordSuccess(ip) {
  attempts.delete(ip);
}

/**
 * nginx is configured with `real_ip_header X-Forwarded-For` and the VPC CIDR as
 * a trusted source, so by the time a request reaches us X-Real-IP holds the
 * true client address rather than the load balancer's. Falling back to the
 * socket address yields 127.0.0.1, which throttles all callers as one — worse
 * for availability, but never less safe.
 */
export function clientIp(req) {
  const header = req.headers['x-real-ip'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  return req.socket?.remoteAddress || 'unknown';
}

// --- oidc mode --------------------------------------------------------------

const albKeyCache = new Map();

/**
 * Who is allowed in, read at call time rather than at import so the value is the
 * one the process was configured with — and so a test can set it per case.
 *
 * Emails are compared lowercased: providers are inconsistent about case in the
 * local part, and a mismatch here fails closed in the direction of locking the
 * operator out of their own box.
 */
function oidcAllowList() {
  const emails = new Set(
    String(process.env.CW_OIDC_ALLOWED_EMAILS || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
  const domain = String(process.env.CW_OIDC_ALLOWED_DOMAIN || '').trim().toLowerCase();
  return { emails, domain };
}

/**
 * Is this verified token's subject one of ours?
 *
 * Called only with claims from a signature-checked JWT. Calling it with an
 * unverified payload would be worse than not calling it at all, because an
 * attacker writes their own claims.
 *
 * `email_verified` is required, and required to be true, because an unverified
 * email is a claim the provider itself does not stand behind — with some
 * providers it is simply whatever the user typed at signup, which would make the
 * allowlist a formality. Accepted as either a boolean or the string "true": the
 * ALB re-serialises provider claims and does not promise to preserve the type.
 *
 * Exported for auth-test.js. This is the one decision in oidc mode that a
 * network-free test can cover exhaustively — every case-, domain-suffix- and
 * missing-claim variant — and it is the decision that separates "has a Google
 * account" from "has a shell on this box", so it is worth covering exhaustively.
 * Exporting it grants nothing: the only caller that matters is verifyOidc, after
 * the signature check.
 */
export function oidcIdentityAllowed(claims) {
  if (!claims || typeof claims !== 'object') return false;

  const { emails, domain } = oidcAllowList();
  // Defence in depth: assertAuthConfig already refused to start in this state.
  if (!emails.size && !domain) return false;

  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email) {
    console.warn('oidc: token carried no email claim; check the provider scope includes "email"');
    return false;
  }

  const verified = claims.email_verified;
  if (verified !== true && verified !== 'true') {
    console.warn(`oidc: rejecting ${email} — provider did not report the address as verified`);
    return false;
  }

  if (emails.has(email)) return true;

  // Domain form, for a Workspace/hosted provider. Compared against the email's
  // own domain rather than a separate `hd` claim, so it cannot be satisfied by a
  // provider that omits `hd` — and anchored to the final label so that
  // "notexample.com" cannot pass as "example.com".
  if (domain && (email.endsWith(`@${domain}`) || email.endsWith(`.${domain}`))) {
    const claimedDomain = email.slice(email.indexOf('@') + 1);
    if (claimedDomain === domain || claimedDomain.endsWith(`.${domain}`)) return true;
  }

  console.warn(`oidc: rejecting ${email} — not in the configured allowlist`);
  return false;
}

async function albPublicKey(kid, region) {
  if (albKeyCache.has(kid)) return albKeyCache.get(kid);
  // Documented endpoint; returns a PEM-encoded EC public key.
  const url = `https://public-keys.auth.elb.${region}.amazonaws.com/${encodeURIComponent(kid)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`ALB key fetch failed for kid ${kid}: ${res.status}`);
  const pem = (await res.text()).trim();
  if (!pem.includes('BEGIN PUBLIC KEY')) throw new Error('ALB key endpoint returned no PEM');
  albKeyCache.set(kid, pem);
  return pem;
}

/**
 * Verify the `x-amzn-oidc-data` JWT the ALB adds after a successful login.
 *
 * The signature check is the whole point. Trusting the header's presence alone
 * would mean anyone able to reach the instance directly could authenticate by
 * inventing it — and "only the ALB can reach the instance" is a security group
 * rule, i.e. one console click away from being false.
 */
export async function verifyOidc(req) {
  const token = req.headers['x-amzn-oidc-data'];
  if (typeof token !== 'string' || !token) return false;

  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [headerB64, payloadB64, signatureB64] = parts;

  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
  } catch {
    return false;
  }

  // `JSON.parse('null')` and `JSON.parse('7')` both succeed, and reading `.alg`
  // off either throws — from inside the request path, where an exception is a 500
  // rather than a clean denial. Cheap to reject here instead.
  if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object') {
    return false;
  }

  if (header.alg !== 'ES256' || !header.kid) return false;
  if (payload.exp && Number(payload.exp) < Math.floor(Date.now() / 1000)) return false;

  const expectedClient = process.env.CW_OIDC_EXPECTED_CLIENT_ID;
  if (expectedClient && header.client !== expectedClient) return false;

  let signatureValid = false;
  try {
    const region = process.env.CW_REGION || process.env.AWS_REGION;
    const pem = await albPublicKey(header.kid, region);
    const verifier = createVerify('sha256');
    verifier.update(`${headerB64}.${payloadB64}`);
    verifier.end();
    // ALB emits JOSE-style fixed-width r||s, which Node reads with dsaEncoding.
    signatureValid = verifier.verify(
      { key: pem, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signatureB64, 'base64url'),
    );
  } catch {
    return false;
  }
  if (!signatureValid) return false;

  // Only now are the claims worth reading. The provider said who this is; this
  // line is where we decide whether that person is allowed to have a shell.
  return oidcIdentityAllowed(payload);
}

// --- the check every request goes through -----------------------------------

/** True when the request carries proof of a completed login. */
export async function isAuthenticated(req) {
  if (AUTH_MODE === 'oidc') return verifyOidc(req);
  const cookies = parseCookies(req.headers.cookie);
  return tokenIsValid(cookies[COOKIE_NAME]);
}

/**
 * Paths served before login. Everything not listed here requires a session —
 * an allowlist, so adding a route can never accidentally publish it.
 */
const OPEN_PATHS = new Set([
  '/healthz', // ALB health check; returns a constant, touches nothing.
  '/login',
  '/login.html',
  '/api/login',
  '/api/auth-mode',
]);

export function isOpenPath(pathname) {
  return OPEN_PATHS.has(pathname);
}
