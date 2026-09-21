/**
 * The OpenAI credential, and the two things this box wants it for.
 *
 * Everything else that speaks or listens here runs on AWS, through the instance
 * role: Claude on Bedrock, the voice on Polly, dictation on whisper.cpp built into
 * `/opt/whisper`. No key, nothing to rotate, no third party in the path. So a file
 * that introduces an API key needs a reason, and there are two.
 *
 * **Polly cannot say a word of Hebrew.** Not badly — at all. `polly:DescribeVoices`
 * on this account returns 40 languages and `he-IL` is not among them, and there is
 * no engine, no voice and no region that adds it. Read aloud in Hebrew is therefore
 * not a tuning problem, it is a different synthesiser; OpenAI's speech models cover
 * Hebrew (57 languages, tracking Whisper's list) and are the shortest route to it.
 *
 * **A spoken conversation needs a model that listens while it talks.** Polly reads
 * a finished string and stops. Barge-in, turn-taking and "wait, go back to the part
 * about the timeout" need audio in both directions at once, which is what the
 * Realtime API is, and nothing in Bedrock's surface here does it.
 *
 * Where the key lives, and why it is not its own secret: the instance role grants
 * `secretsmanager:GetSecretValue` per secret ARN, named one by one in
 * `infra/lib/stack.js`. A new secret therefore means a stack change, and a stack
 * change means a full deploy, which replaces UserData, which stops this instance and
 * kills every live conversation on it. The secret this box already reads for voice
 * credentials — `WhisperConfig`, holding the optional Azure dictation endpoint — is
 * already granted, already wired into the service through `/etc/claude-voice.env`,
 * and already means "the credentials the voice features use". So the key is a field
 * in it, `openaiApiKey`, and adding it costs an app-only deploy and no reboot. The
 * stack's description for that secret says so, so the next person to read it is not
 * surprised.
 *
 * `OPENAI_SECRET_ARN` overrides which secret is read, and `OPENAI_API_KEY` skips
 * Secrets Manager entirely — the second is for running the service on a laptop,
 * where there is no instance role to borrow.
 *
 * Nothing here throws when the key is absent. A box without one is the normal
 * state of a fresh deployment, and the answer everywhere is the same as it is for
 * Azure dictation: report `configured: false` with a sentence saying why, and let
 * the client fall back to what does work. For read aloud that is Polly in English
 * and the browser's own voice in Hebrew; for a spoken conversation there is no
 * fallback, so the button is not offered at all.
 */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';

/**
 * Which secret holds the key. Falls back to the voice secret deliberately — see
 * the header: that one is already granted to the instance role, and a second one
 * would cost a reboot to grant.
 */
const SECRET_ARN = process.env.OPENAI_SECRET_ARN || process.env.WHISPER_SECRET_ARN || '';

/** For a laptop, where there is no instance role to borrow. */
const ENV_KEY = (process.env.OPENAI_API_KEY || '').trim();

const secrets = new SecretsManagerClient({ region: REGION });

/**
 * The resolved key, or `false` for "asked, and there is none".
 *
 * Cached both ways on purpose. A deployment without a key must not call Secrets
 * Manager on every status poll, and `/api/voice-status?refresh=1` is the documented
 * way to pick up a key that has just been put in — the same route that already
 * re-probes Polly and re-reads the Azure credentials.
 */
let cached = null;

/** The same, for the Azure resource in `azureRealtime`. */
let cachedAzure = null;

/** Drop the cached key so a newly added or rotated one is picked up. */
export function resetOpenAi() {
  cached = null;
  cachedAzure = null;
}

/**
 * The key, or `null`.
 *
 * Reads several spellings out of the secret because the secret is populated by
 * hand, with `put-secret-value`, by whoever runs the deployment — and the one
 * thing worse than no key is a key that is present and silently ignored because it
 * was filed under `OPENAI_API_KEY` rather than `openaiApiKey`.
 */
export async function openAiKey() {
  if (cached !== null) return cached || null;

  if (ENV_KEY) {
    cached = ENV_KEY;
    return cached;
  }

  if (!SECRET_ARN) {
    cached = false;
    return null;
  }

  try {
    const res = await secrets.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }));
    const raw = JSON.parse(res.SecretString || '{}');
    const key = String(
      raw.openaiApiKey || raw.openai_api_key || raw.OPENAI_API_KEY || raw.openaiKey || '',
    ).trim();
    cached = key || false;
  } catch {
    // An unreadable secret and an empty one are the same thing to every caller:
    // there is no key, so say so rather than making each of them handle an error.
    cached = false;
  }
  return cached || null;
}

/**
 * The Azure OpenAI resource that can hold a realtime conversation, or `null`.
 *
 * Why there are two routes to the same models. The realtime API is billed per audio
 * token and nothing about it is free, so the question is not which vendor is nicer
 * but which one fails closed. `api.openai.com` bills a card unless the account is
 * on prepaid credits with auto-recharge off — an account setting this box cannot
 * see, let alone enforce. An Azure *sponsorship* subscription has no card behind it:
 * when the credit is gone the subscription stops, which is the same property the F0
 * Speech tier has and the reason read-aloud uses it. So Azure is preferred when both
 * are configured, and `REALTIME_PROVIDER=openai` is the way to say otherwise.
 *
 * The three fields, all required, in the same voice secret as everything else here:
 *
 *     azureRealtimeEndpoint    https://<resource>.openai.azure.com
 *     azureRealtimeKey         one of the resource's two keys
 *     azureRealtimeDeployment  the *deployment* name, not the model name
 *
 * The deployment is required rather than defaulted because on Azure the model name
 * in the request is whatever you called the deployment, and a wrong one is a 404 at
 * mint time with nothing on this box to say which of the two it was. Better to
 * refuse while the operator is still looking at the secret. Quota is per model and
 * per region and is frequently zero for the flagship — `gpt-realtime-mini` is what
 * a new subscription can actually deploy, which is why this is not a one-liner.
 */
export async function azureRealtime() {
  if (cachedAzure !== null) return cachedAzure || null;

  const shape = (endpoint, key, deployment) => {
    const host = String(endpoint || '').trim().replace(/\/+$/, '');
    const secret = String(key || '').trim();
    const name = String(deployment || '').trim();
    if (!host || !secret || !name) return false;
    // An endpoint that is not https is a key sent in clear; refuse rather than
    // downgrade, and refuse a path because the paths are appended below.
    if (!/^https:\/\/[^/]+$/.test(host)) return false;
    return { endpoint: host, key: secret, deployment: name };
  };

  const fromEnv = shape(
    process.env.AZURE_REALTIME_ENDPOINT,
    process.env.AZURE_REALTIME_KEY,
    process.env.AZURE_REALTIME_DEPLOYMENT,
  );
  if (fromEnv) {
    cachedAzure = fromEnv;
    return cachedAzure;
  }

  if (!SECRET_ARN) {
    cachedAzure = false;
    return null;
  }

  try {
    const res = await secrets.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }));
    const raw = JSON.parse(res.SecretString || '{}');
    cachedAzure = shape(
      raw.azureRealtimeEndpoint || raw.azureOpenAiEndpoint,
      raw.azureRealtimeKey || raw.azureOpenAiKey,
      raw.azureRealtimeDeployment || raw.azureOpenAiDeployment,
    );
  } catch {
    // Same as `openAiKey`: unreadable and absent are one thing to every caller.
    cachedAzure = false;
  }
  return cachedAzure || null;
}

/** Is there a key at all? What the status routes ask. */
export async function openAiConfigured() {
  return Boolean(await openAiKey());
}

/**
 * The sentence to show when OpenAI refuses, given the status and its body.
 *
 * Returned as a string rather than thrown, because the two callers wrap it in
 * different error types — `SpeakError` carries an HTTP status for the read-aloud
 * routes, the realtime route answers a plain JSON error. Every one of these has an
 * action in it: an operator reading `journalctl` should not have to look up what
 * OpenAI meant.
 */
export function openAiRefusal(status, body) {
  const text = String(body || '').slice(0, 600);
  let detail = '';
  try {
    detail = JSON.parse(text)?.error?.message || '';
  } catch {
    detail = '';
  }
  const tail = detail ? ` — ${detail}` : '';

  if (status === 401 || status === 403) {
    return (
      'OpenAI rejected the key. Check the `openaiApiKey` field of the voice secret ' +
      `(${SECRET_ARN || 'OPENAI_API_KEY'}), then GET /api/voice-status?refresh=1${tail}`
    );
  }
  if (status === 404) {
    return `OpenAI has no such model or route for this account${tail}`;
  }
  if (status === 429) {
    return `OpenAI is rate limiting this key, or the account is out of credit${tail}`;
  }
  if (status === 400 || status === 422) {
    return `OpenAI refused the request${tail}`;
  }
  if (status >= 500) {
    return `OpenAI is failing (${status})${tail} — try again in a moment`;
  }
  return `OpenAI answered ${status}${tail}`;
}

/**
 * The same, for Azure. A separate function rather than a flag on the one above,
 * because every sentence in it would have to change: the field to check has a
 * different name, a 404 means a deployment that does not exist rather than a model
 * this account cannot see, and a 429 on Azure is as likely to be a quota of zero on
 * the deployment as it is an exhausted balance. An operator who is told to check
 * `openaiApiKey` when the problem is a deployment name has been sent to the wrong
 * place, which is worse than a bare status code.
 */
export function azureRealtimeRefusal(status, body) {
  const text = String(body || '').slice(0, 600);
  let detail = '';
  try {
    detail = JSON.parse(text)?.error?.message || '';
  } catch {
    detail = '';
  }
  const tail = detail ? ` — ${detail}` : '';

  if (status === 401 || status === 403) {
    return (
      'Azure rejected the key. Check `azureRealtimeKey` in the voice secret ' +
      `(${SECRET_ARN || 'AZURE_REALTIME_KEY'}) — the resource has two, either works — ` +
      `then GET /api/voice-status?refresh=1${tail}`
    );
  }
  if (status === 404) {
    return (
      'Azure has no such deployment. `azureRealtimeDeployment` must be the name you ' +
      `gave the deployment, not the model name${tail}`
    );
  }
  if (status === 429) {
    return (
      'Azure is rate limiting this deployment, or the subscription is out of credit. ' +
      `Check the deployment's tokens-per-minute quota as well as the balance${tail}`
    );
  }
  if (status === 400 || status === 422) {
    return `Azure refused the request${tail}`;
  }
  if (status >= 500) {
    return `Azure OpenAI is failing (${status})${tail} — try again in a moment`;
  }
  return `Azure answered ${status}${tail}`;
}

/** Which secret the key is expected in, for a status answer to name. */
export const openAiSecretArn = SECRET_ARN;
