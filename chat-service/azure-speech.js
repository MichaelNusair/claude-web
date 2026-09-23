/**
 * Azure AI Speech: the Hebrew voice, and the Hebrew ear.
 *
 * This box had neither. Polly reads English well and does not have a Hebrew voice at
 * all — `DescribeVoices` returns 40 languages and `he-IL` is not one of them — and the
 * only dictation model installed here is `ggml-base.en.bin`, whose `.en` is the point
 * of it. Both failures are silent in the same way: Polly skips Hebrew characters
 * rather than mispronouncing them, and an English-only Whisper answers Hebrew speech
 * with fluent English nobody said. Neither one raises anything.
 *
 * Azure has both, and — the reason it is here rather than OpenAI — it has them on a
 * tier that cannot bill. The `F0` SKU of a Speech resource is free, not trial: 0.5
 * million characters of neural TTS and 5 audio hours of recognition per month, and
 * when a month's quota is gone the API answers 429 instead of charging anyone. The
 * standing instruction for this deployment is credits only, never a card, and a free
 * tier is the only arrangement that is true of by construction rather than by
 * watching a dashboard.
 *
 * Measured on the resource this talks to, from this instance:
 *   - `he-IL-HilaNeural`, 66 characters of Hebrew → 52 KB of mp3 in 555 ms.
 *   - the same sentence spoken back through recognition → returned verbatim, with
 *     punctuation it added itself, in 710 ms.
 *   - `en-US-AvaMultilingualNeural`, 62 characters of English → 33 KB in 387 ms.
 *
 * Hebrew is why this file exists, but it is not the only thing the resource is used
 * for any more: the *free* part is the point, so English reads here too and Polly is
 * the paid alternative in the picker. See `AZURE_VOICES` and `preferredVoice` in
 * speak.js.
 *
 * Where the credentials live: the `speechKey` and `speechRegion` fields of the same
 * voice secret that holds the optional Azure Whisper endpoint and the optional OpenAI
 * key. That secret is already granted to the instance role one ARN at a time in
 * `infra/lib/stack.js`, and a *new* secret would mean a stack change, a full deploy, a
 * replaced UserData and a reboot that kills every live conversation on this box. A
 * field costs an app-only deploy and nothing else. `AZURE_SPEECH_KEY` and
 * `AZURE_SPEECH_REGION` override it, for running the service on a laptop.
 *
 * Nothing here throws when the credentials are absent: a box without them is the
 * normal state of a fresh deployment, and every caller's answer is the same as it is
 * for the other two optional backends — report it, say why, and let the client fall
 * back to the device's own voice.
 */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const SECRET_ARN = process.env.AZURE_SPEECH_SECRET_ARN || process.env.WHISPER_SECRET_ARN || '';

const ENV_KEY = (process.env.AZURE_SPEECH_KEY || '').trim();
const ENV_REGION = (process.env.AZURE_SPEECH_REGION || '').trim();

const TIMEOUT_MS = Number(process.env.AZURE_SPEECH_TIMEOUT_MS || 30_000);

/**
 * mp3 at 48 kbit, which is what the read-aloud path serves.
 *
 * Complete files with a Content-Length, not a stream — iOS Safari is unreliable about
 * media it cannot range-request, and this feature exists for a phone. 24 kHz mono is
 * plenty for speech and keeps a segment small enough to arrive before it is wanted.
 */
const TTS_FORMAT = process.env.AZURE_SPEECH_FORMAT || 'audio-24khz-48kbitrate-mono-mp3';

/**
 * The recognizer this uses takes one utterance at a time and stops at 60 seconds.
 *
 * Refused here at 55 rather than let Azure answer, because its own error for this is
 * about the request body and reads like a bug in the app rather than "that was too
 * long to say in one go".
 */
export const MAX_AUDIO_SECONDS = Number(process.env.AZURE_SPEECH_MAX_SECONDS || 55);

const secrets = new SecretsManagerClient({ region: REGION });

/**
 * The voices this box offers through Azure, as records shaped like Polly's.
 *
 * Two Hebrew, because Polly has none and that is the hole this file was opened to
 * fill. Two English as well, because of what the F0 tier costs: nothing. Polly's
 * generative engine reads English beautifully at $30 per million characters; these
 * read it free until the month's half-million characters are gone and then answer 429.
 * The standing instruction for this deployment is credits only, never a card, so the
 * free pair is what a client that asks for no voice in particular is given, and Polly
 * stays one tap away in the picker for anyone who would rather have it. The choosing
 * is `preferredVoice` in speak.js.
 *
 * The English pair are the `Multilingual` variants rather than plain `AvaNeural` and
 * `AndrewNeural` — same price, and asked of this resource they carry 92 secondary
 * locales including `he-IL`, so a Hebrew word quoted inside an English sentence is
 * spoken instead of skipped. Their `language` is nonetheless `en-US`, which is what
 * they are: that is what keeps a message that is *mostly* Hebrew routed to Hila,
 * whose Hebrew is native rather than accented (see `speaksHebrew` in speak.js).
 *
 * Ids are bare — `Hila`, `Ava` — because the picker and the phone's remembered choice
 * are one flat list of names shared with Polly's. Which is also why these four and
 * not others: Polly has voices called Emma, Brian and Aria, Azure has all three too,
 * and `knownVoices` resolves a collision in Polly's favour — so an Azure voice under
 * one of those names would be quietly dropped from the list. These four collide with
 * none of Polly's 109.
 */
export const AZURE_VOICES = [
  { id: 'Hila', name: 'he-IL-HilaNeural', gender: 'Female', language: 'he-IL', provider: 'azure' },
  { id: 'Avri', name: 'he-IL-AvriNeural', gender: 'Male', language: 'he-IL', provider: 'azure' },
  {
    id: 'Ava',
    name: 'en-US-AvaMultilingualNeural',
    gender: 'Female',
    language: 'en-US',
    provider: 'azure',
  },
  {
    id: 'Andrew',
    name: 'en-US-AndrewMultilingualNeural',
    gender: 'Male',
    language: 'en-US',
    provider: 'azure',
  },
];

let cached = null; // { key, region } once resolved, false for "asked, there is none"

/** Drop the cached credentials so a newly added or rotated pair is picked up. */
export function resetAzureSpeech() {
  cached = null;
}

/**
 * The key and region, or `null`.
 *
 * Several spellings are read because the secret is populated by hand, and the one
 * thing worse than no credentials is credentials that are present and silently
 * ignored because they were filed under `AZURE_SPEECH_KEY` rather than `speechKey`.
 */
export async function azureSpeech() {
  if (cached !== null) return cached || null;

  if (ENV_KEY && ENV_REGION) {
    cached = { key: ENV_KEY, region: ENV_REGION };
    return cached;
  }

  if (!SECRET_ARN) {
    cached = false;
    return null;
  }

  try {
    const res = await secrets.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }));
    const raw = JSON.parse(res.SecretString || '{}');
    const key = String(raw.speechKey || raw.AZURE_SPEECH_KEY || raw.azureSpeechKey || '').trim();
    const region = String(
      raw.speechRegion || raw.AZURE_SPEECH_REGION || raw.azureSpeechRegion || '',
    ).trim().toLowerCase();
    cached = key && region ? { key, region } : false;
  } catch {
    // An unreadable secret and an empty one are the same thing to every caller.
    cached = false;
  }
  return cached || null;
}

/** Is there a Hebrew voice on this box? What the status routes ask. */
export async function azureSpeechConfigured() {
  return Boolean(await azureSpeech());
}

/**
 * The sentence to show when Azure refuses, given the status and its body.
 *
 * Returned rather than thrown because the two callers wrap it differently — read
 * aloud needs an HTTP status on it, dictation throws a plain error. Every one of
 * these names an action: the 429 in particular is not a fault, it is the free tier's
 * month being used up, and an operator reading it should know that it comes back on
 * its own.
 */
export function azureSpeechRefusal(status, body = '') {
  const detail = String(body || '').replace(/\s+/g, ' ').slice(0, 300);
  const tail = detail ? ` — ${detail}` : '';

  if (status === 401 || status === 403) {
    return (
      'Azure rejected the Speech key. Check the `speechKey` and `speechRegion` fields ' +
      `of the voice secret (${SECRET_ARN || 'AZURE_SPEECH_KEY'}), then GET ` +
      `/api/voice-status?refresh=1${tail}`
    );
  }
  if (status === 429) {
    return (
      "the free tier's monthly quota for this Speech resource is used up — 0.5M " +
      'characters of speech and 5 audio hours, which reset on the 1st. Nothing is ' +
      `charged for going over; it just stops until then${tail}`
    );
  }
  if (status === 400) {
    return `Azure refused the request${tail}`;
  }
  if (status === 404) {
    return (
      'Azure has no Speech endpoint in the configured region — check `speechRegion` ' +
      `against the resource's own region${tail}`
    );
  }
  if (status >= 500) {
    return `Azure Speech is failing (${status})${tail} — try again in a moment`;
  }
  return `Azure Speech answered ${status}${tail}`;
}

/**
 * Text inside SSML, which is XML, which means five characters are not text.
 *
 * Not a nicety. A code block read aloud is the case this feature was asked for, and
 * `a && b` and `x < y` are exactly what is in one — unescaped, the first `<` makes the
 * document invalid and Azure answers 400, so the effect of forgetting this is that
 * reading code fails and only reading prose works.
 */
export function ssmlEscape(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The SSML document for one segment, in one voice. */
export function ssmlFor(text, voiceName) {
  const name = String(voiceName || AZURE_VOICES[0].name);
  const lang = /^([a-z]{2}-[A-Z]{2})/.exec(name)?.[1] || 'he-IL';
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}">` +
    `<voice name="${name}">${ssmlEscape(text)}</voice></speak>`
  );
}

/**
 * One segment of text as mp3.
 *
 * `voiceName` is the full Azure name (`he-IL-HilaNeural`), which is what the voice
 * record carries in its `engine` field — the bare id is for the picker and the phone,
 * the long name is for the wire.
 */
export async function speakAzure(text, voiceName, { fetchImpl = fetch, config: given } = {}) {
  const config = given || (await azureSpeech());
  if (!config) {
    const err = new Error(
      'there are no Azure Speech credentials on this box, so this voice cannot ' +
        'speak — put `speechKey` and `speechRegion` in the voice secret and call ' +
        '/api/voice-status?refresh=1',
    );
    err.status = 503;
    throw err;
  }

  let res;
  try {
    res = await fetchImpl(`https://${config.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': config.key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': TTS_FORMAT,
        // Azure asks for one, and a resource's metrics are easier to read when the
        // caller says what it is.
        'User-Agent': 'TripleC',
      },
      body: ssmlFor(text, voiceName),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timeout = /abort|timeout/i.test(`${err?.name} ${err?.message}`);
    const wrapped = new Error(
      timeout
        ? `the Hebrew voice took longer than ${TIMEOUT_MS}ms to answer`
        : `could not reach Azure Speech: ${err?.message || 'unknown error'}`,
    );
    wrapped.status = timeout ? 504 : 502;
    throw wrapped;
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(azureSpeechRefusal(res.status, detail));
    // Remapped, not passed through: these travel to a phone whose only decision is
    // whether to fall back to its own voice, and a 401 from Azure is not a 401 from
    // this service — that would read as a login that had expired.
    err.status = res.status === 429 ? 429 : res.status >= 500 ? 502 : 403;
    throw err;
  }

  return Buffer.from(await res.arrayBuffer());
}

/**
 * How long a WAV is, in seconds, from its own header — or 0 for anything else.
 *
 * Used only to refuse before uploading. Reading the byte rate out of the header
 * rather than assuming 16 kHz mono, because the two clients record differently and a
 * refusal computed from the wrong rate would be wrong in both directions.
 */
/**
 * Can this recognizer be given these bytes at all?
 *
 * Asked because it is not the same question as whether there are credentials. The
 * short-audio API takes WAV; the editor overlay converts to WAV before uploading, but
 * the chat PWA falls back to raw webm/opus when it cannot, and the voice extension
 * sends webm always. Handed webm under a WAV content type, Azure answers 400 — so a
 * caller that routed on credentials alone would turn a working OpenAI transcription
 * into a failure for anyone on the surfaces that do not convert.
 *
 * The length ceiling is part of the same answer for the same reason: a 90-second
 * Hebrew recording is not something this backend can do, and the caller wants to know
 * that before it commits rather than after.
 */
export function azureCanHear(audio) {
  const seconds = wavSeconds(audio);
  return seconds > 0 && seconds <= MAX_AUDIO_SECONDS;
}

export function wavSeconds(audio) {
  if (!Buffer.isBuffer(audio) || audio.length < 44) return 0;
  if (audio.subarray(0, 4).toString('ascii') !== 'RIFF') return 0;
  if (audio.subarray(8, 12).toString('ascii') !== 'WAVE') return 0;
  const byteRate = audio.readUInt32LE(28);
  if (!byteRate) return 0;
  return (audio.length - 44) / byteRate;
}

/**
 * Speech to text, in whichever language it was actually spoken in.
 *
 * The short-audio recognizer rather than batch transcription: one utterance, an
 * answer in under a second, no storage account and no polling. It wants WAV or
 * OGG/Opus — the same reason the local model wants WAV, and both clients already
 * convert before uploading.
 *
 * `language` is required and is a full locale (`he-IL`), not the two letters the rest
 * of this codebase passes around, so a bare `he` is expanded here.
 */
export async function hearAzure(audio, language, { fetchImpl = fetch, config: given } = {}) {
  const config = given || (await azureSpeech());
  if (!config) throw new Error('no Azure Speech credentials on this box');

  const seconds = wavSeconds(audio);
  if (seconds > MAX_AUDIO_SECONDS) {
    throw new Error(
      `that recording is ${Math.round(seconds)} seconds long and this recognizer ` +
        `takes ${MAX_AUDIO_SECONDS} at a time — say it in a shorter go`,
    );
  }

  const locale = azureLocale(language);
  const url =
    `https://${config.region}.stt.speech.microsoft.com/speech/recognition/conversation` +
    `/cognitiveservices/v1?language=${encodeURIComponent(locale)}&format=simple` +
    '&profanity=raw';

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': config.key,
        'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
        Accept: 'application/json',
        'User-Agent': 'TripleC',
      },
      body: audio,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (/abort|timeout/i.test(`${err?.name} ${err?.message}`)) {
      throw new Error(`Azure took longer than ${TIMEOUT_MS}ms to answer — try a shorter recording`);
    }
    throw new Error(`could not reach Azure Speech: ${err?.message || 'unknown error'}`);
  }

  const body = await res.text();
  if (!res.ok) throw new Error(azureSpeechRefusal(res.status, body));

  let parsed;
  try {
    parsed = JSON.parse(body || '{}');
  } catch {
    throw new Error('Azure answered something that was not JSON');
  }

  /*
   * `NoMatch` is a real answer, not a failure: the audio arrived and held no speech
   * Azure could make out in that language. Said in those words, because the most
   * likely cause is dictating in a language the picker is not set to, and "no speech
   * detected" alone sends someone to look at their microphone.
   */
  const status = parsed.RecognitionStatus;
  if (status === 'NoMatch' || status === 'InitialSilenceTimeout') {
    throw new Error(`no ${locale} speech detected in that recording`);
  }
  if (status && status !== 'Success') {
    throw new Error(`Azure could not use that recording (${status})`);
  }

  const text = String(parsed.DisplayText || '').trim();
  if (!text) throw new Error('no speech detected');
  return text;
}

/**
 * A locale Azure will accept, from whatever the client sent.
 *
 * The rest of this codebase reduces a language to two letters, because that is what
 * OpenAI and Whisper want; Azure wants the region too and rejects the short form. A
 * locale that arrives complete is kept, and everything else gets the region this
 * deployment means by that language.
 */
const LOCALES = {
  he: 'he-IL', en: 'en-US', ar: 'ar-IL', ru: 'ru-RU', fr: 'fr-FR', es: 'es-ES',
  de: 'de-DE', it: 'it-IT', pt: 'pt-BR', nl: 'nl-NL', pl: 'pl-PL', tr: 'tr-TR',
  uk: 'uk-UA', ro: 'ro-RO', hi: 'hi-IN', ja: 'ja-JP', ko: 'ko-KR', zh: 'zh-CN',
};

export function azureLocale(language) {
  const raw = String(language || '').trim();
  if (/^[a-z]{2}-[A-Za-z]{2,}$/i.test(raw)) {
    const [lang, region] = raw.split('-');
    return `${lang.toLowerCase()}-${region.toUpperCase()}`;
  }
  const two = raw.slice(0, 2).toLowerCase();
  return LOCALES[two] || (two.length === 2 ? `${two}-${two.toUpperCase()}` : 'he-IL');
}

/** What this box can say and hear through Azure, without exposing the key. */
export async function azureSpeechStatus() {
  const config = await azureSpeech();
  return {
    configured: Boolean(config),
    region: config?.region || null,
    voices: config ? AZURE_VOICES.map((v) => ({ ...v })) : [],
    tier: 'F0 (free): 0.5M characters and 5 audio hours a month, then 429 until the 1st',
    reason: config
      ? null
      : 'no Azure Speech credentials on this box — put `speechKey` and `speechRegion` ' +
        'in the voice secret and call /api/voice-status?refresh=1',
  };
}

/** Which secret the credentials are expected in, for a status answer to name. */
export const azureSpeechSecretArn = SECRET_ARN;
