/**
 * Transcription with three backends.
 *
 * Local whisper.cpp is the default: no quota to request, no API key, no
 * per-request cost, and nothing leaves the box. Measured on this instance
 * (t4g.large, 2 vCPU) with the base.en model: ~4s for 11s of audio, so a
 * typical few-second dictation lands in ~1-3s.
 *
 * Azure OpenAI Whisper is used instead when credentials are present, for when
 * a bigger/faster hosted model is wanted.
 *
 * **OpenAI is used when the language is not English, and that is not a preference.**
 * The model installed on this box is `ggml-base.en.bin` — the `.en` is the whole
 * point of it — and the way an English-only Whisper model fails on Hebrew speech is
 * the worst available: not an error, not silence, but a fluent English sentence that
 * nobody said. It transliterates, it guesses, and it hands back something that looks
 * exactly like a successful dictation, which then goes into the box where a prompt is
 * typed. So a request that says it is not English is never given to the local model,
 * and if there is no hosted backend to give it to instead, it is refused with a
 * sentence saying why. Same reasoning as read aloud, where Polly skips Hebrew
 * characters rather than mispronouncing them: the refusals here exist because the
 * successes are indistinguishable from them.
 */
import { execFile } from 'child_process';
import { writeFile, unlink, mkdtemp, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join, basename } from 'path';
import { promisify } from 'util';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { openAiKey, openAiRefusal, resetOpenAi } from './openai.js';

const execFileAsync = promisify(execFile);

const WHISPER_BIN = process.env.WHISPER_BIN || '/opt/whisper/whisper-cli';
const WHISPER_MODEL = process.env.WHISPER_MODEL || '/opt/whisper/models/ggml-base.en.bin';
// Guard against a pathological file pinning both cores indefinitely.
const LOCAL_TIMEOUT_MS = Number(process.env.WHISPER_TIMEOUT_MS || 120_000);

const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';
/**
 * `gpt-4o-transcribe` rather than `whisper-1`: it is more accurate on the thing this
 * is actually used for, which is a sentence with `auth.js`, `SPEAK_DAILY_CHARS` and
 * a version number in it, spoken into a phone microphone on a street.
 */
const OPENAI_MODEL = process.env.TRANSCRIBE_OPENAI_MODEL || 'gpt-4o-transcribe';
const OPENAI_TIMEOUT_MS = Number(process.env.TRANSCRIBE_TIMEOUT_MS || 60_000);

/**
 * A day's worth of uploaded audio, in megabytes.
 *
 * Small guard for a small cost — transcription is about a third of a cent a minute,
 * so this is not where a bill comes from — but it is an authenticated POST that
 * forwards a body to a metered third party, and the honest bound on how many of
 * those arrive is "however many the client sends". 200 MB is hours of speech.
 */
const OPENAI_DAILY_MB = Number(process.env.TRANSCRIBE_OPENAI_DAILY_MB || 200);
let uploaded = { day: '', bytes: 0 };

const secretsClient = new SecretsManagerClient({
  region: process.env.AWS_REGION || 'us-east-1',
});

let cachedAzure = null;      // resolved Azure config, or false when unavailable
let localAvailable = null;   // cached probe of the local binary

/** Drop cached config so a rotated secret or new install is picked up. */
export function resetConfigCache() {
  cachedAzure = null;
  localAvailable = null;
  // The OpenAI key too, so that a key added by hand takes effect on the same refresh
  // as a rotated Azure one. `resetSpeech()` also does this and the second call is a
  // no-op; both are here so neither module depends on the other being called.
  resetOpenAi();
}

async function haveLocalWhisper() {
  if (localAvailable !== null) return localAvailable;
  try {
    await access(WHISPER_BIN);
    await access(WHISPER_MODEL);
    localAvailable = true;
  } catch {
    localAvailable = false;
  }
  return localAvailable;
}

async function loadAzure() {
  if (cachedAzure !== null) return cachedAzure;

  const arn = process.env.WHISPER_SECRET_ARN;
  if (!arn) {
    cachedAzure = false;
    return cachedAzure;
  }

  try {
    const res = await secretsClient.send(new GetSecretValueCommand({ SecretId: arn }));
    const raw = JSON.parse(res.SecretString || '{}');
    const endpoint = raw.endpoint || raw.AZURE_OPENAI_ENDPOINT;
    const apiKey = raw.apiKey || raw.AZURE_OPENAI_API_KEY;
    const deployment = raw.deployment || raw.AZURE_OPENAI_WHISPER_DEPLOYMENT || 'whisper';
    const apiVersion = raw.apiVersion || '2024-10-21';

    if (!endpoint || !apiKey) {
      cachedAzure = false;
      return cachedAzure;
    }
    cachedAzure = {
      url: `${endpoint.replace(/\/$/, '')}/openai/deployments/${deployment}/audio/transcriptions?api-version=${apiVersion}`,
      apiKey,
      deployment,
      endpoint,
    };
  } catch {
    cachedAzure = false;
  }
  return cachedAzure;
}

/**
 * Pull the single audio part out of a multipart body without taking a parser
 * dependency.
 */
function extractAudio(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) throw new Error('missing multipart boundary');
  const boundary = Buffer.from(`--${(match[1] || match[2]).trim()}`);

  let start = buffer.indexOf(boundary);
  while (start !== -1) {
    const headerStart = start + boundary.length;
    const headerEnd = buffer.indexOf('\r\n\r\n', headerStart);
    if (headerEnd === -1) break;

    const headers = buffer.slice(headerStart, headerEnd).toString();
    const next = buffer.indexOf(boundary, headerEnd);
    if (next === -1) break;

    if (/name="audio"/i.test(headers)) {
      // The trailing CRLF belongs to the delimiter, not the payload.
      return buffer.slice(headerEnd + 4, next - 2);
    }
    start = next;
  }
  throw new Error('no "audio" part in request');
}

async function transcribeLocal(audio) {
  const dir = await mkdtemp(join(tmpdir(), 'voice-'));
  const input = join(dir, 'input.webm');
  await writeFile(input, audio);

  try {
    // whisper.cpp decodes container formats itself (miniaudio), so browser
    // webm/opus can be passed straight through with no ffmpeg step.
    const { stdout } = await execFileAsync(
      WHISPER_BIN,
      [
        '-m', WHISPER_MODEL,
        '-f', input,
        '-nt',          // no timestamps — we want plain text
        '-np',          // no progress prints
        '-t', '2',      // match the instance's vCPU count
      ],
      { timeout: LOCAL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    );

    const text = stdout
      .split('\n')
      // Drop whisper.cpp's own diagnostic lines.
      .filter((line) => !/^(read_audio_data|whisper_|main:|ggml_)/.test(line.trim()))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text) throw new Error('no speech detected');
    return text;
  } catch (err) {
    if (err.killed || err.signal === 'SIGTERM') {
      throw new Error('transcription timed out — try a shorter recording');
    }
    // miniaudio handles WAV/MP3/FLAC/Vorbis but not Opus. The browser converts
    // to WAV before upload, so this only fires if that conversion was skipped.
    if (/failed to (read|open|decode)|unsupported/i.test(`${err.stderr || ''}${err.message}`)) {
      throw new Error(
        'could not decode the audio (Opus is unsupported server-side) — reload the page so the browser converts it to WAV',
      );
    }
    throw err;
  } finally {
    await unlink(input).catch(() => {});
  }
}

/**
 * Which language a request is asking to be heard in, reduced to a decision.
 *
 * Exported and pure because it is the branch that decides whether an English-only
 * model gets to answer, and the cost of getting it wrong is a confident wrong
 * transcript rather than a visible failure. An absent or unparseable value means
 * English — the existing behaviour, and the language the local model is for.
 */
export function spokenLanguage(lang) {
  const wanted = String(lang || '').trim().toLowerCase().slice(0, 5);
  const code = /^[a-z]{2}/.test(wanted) ? wanted.slice(0, 2) : 'en';
  return { code, english: code === 'en' };
}

/** Today's uploaded megabytes, and the day's allowance. */
function uploadBudget(bytes = 0) {
  const day = new Date().toISOString().slice(0, 10);
  if (uploaded.day !== day) uploaded = { day, bytes: 0 };
  const limit = OPENAI_DAILY_MB * 1024 * 1024;
  if (bytes && uploaded.bytes + bytes > limit) {
    throw new Error(
      `that is ${Math.round(uploaded.bytes / 1e6)} MB of audio transcribed today and ` +
        `the daily limit is ${OPENAI_DAILY_MB} MB — it resets at midnight UTC, or raise ` +
        'TRANSCRIBE_OPENAI_DAILY_MB',
    );
  }
  return { day, mb: Math.round((uploaded.bytes / 1e6) * 10) / 10, limitMb: OPENAI_DAILY_MB };
}

/**
 * OpenAI's transcription, which is the only backend here that hears Hebrew.
 *
 * `language` is sent rather than left to detection. It is a hint the model is
 * documented to use, and the case it fixes is the common one for this speaker: a
 * Hebrew sentence with English identifiers in it, which auto-detection can decide is
 * English and then transliterate the Hebrew half of into nothing useful.
 */
async function transcribeOpenAi(audio, code) {
  const key = await openAiKey();
  if (!key) throw new Error('no OpenAI key on this box');
  uploadBudget(audio.length);

  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/webm' }), 'audio.webm');
  form.append('model', OPENAI_MODEL);
  form.append('response_format', 'text');
  if (code && code !== 'auto') form.append('language', code);

  let res;
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
    });
  } catch (err) {
    if (/abort|timeout/i.test(`${err?.name} ${err?.message}`)) {
      throw new Error(`transcription took longer than ${OPENAI_TIMEOUT_MS}ms — try a shorter recording`);
    }
    throw new Error(`could not reach OpenAI: ${err?.message || 'unknown error'}`);
  }

  const text = await res.text();
  if (!res.ok) throw new Error(openAiRefusal(res.status, text));

  // Counted after the fact: a refused call is not billed, so it is not charged.
  uploaded.bytes += audio.length;
  const trimmed = text.trim();
  if (!trimmed) throw new Error('no speech detected');
  return trimmed;
}

async function transcribeAzure(audio, config, code = '') {
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/webm' }), 'audio.webm');
  form.append('response_format', 'text');
  // Only when it is not English: the deployment's own default is right for English,
  // and Whisper's language hint is what keeps a Hebrew sentence with English
  // identifiers in it from being decided as English.
  if (code && code !== 'en') form.append('language', code);

  const upstream = await fetch(config.url, {
    method: 'POST',
    headers: { 'api-key': config.apiKey },
    body: form,
  });

  const text = await upstream.text();
  if (!upstream.ok) {
    console.error('azure whisper error', upstream.status, text.slice(0, 300));
    if (/DeploymentNotFound/i.test(text)) {
      throw new Error(
        `no Azure deployment named "${config.deployment}" — deploy a Whisper model or clear the secret to use local transcription`,
      );
    }
    if (upstream.status === 401 || upstream.status === 403) {
      throw new Error('Azure rejected the API key');
    }
    if (upstream.status === 429) {
      throw new Error('Azure rate limit hit — try again in a moment');
    }
    throw new Error(`Azure transcription failed (${upstream.status})`);
  }

  const trimmed = text.trim();
  if (!trimmed) throw new Error('no speech detected');
  return trimmed;
}

export async function transcribe(body, contentType, { lang } = {}) {
  const audio = extractAudio(body, contentType);
  const { code, english } = spokenLanguage(lang);
  const azure = await loadAzure();

  /*
   * Not English. The local model is `.en` and would answer with fluent nonsense, so
   * it is not in this branch at all — not even as a last resort, because a last
   * resort whose output cannot be told apart from a success is worse than a refusal.
   * OpenAI first, Azure's Whisper second (multilingual, if a deployment happens to be
   * configured), and then a sentence saying what to do.
   */
  if (!english) {
    if (await openAiKey()) {
      try {
        return await transcribeOpenAi(audio, code);
      } catch (err) {
        if (!azure) throw err;
        console.warn(`openai transcription failed, falling back to azure: ${err.message}`);
      }
    }
    if (azure) return transcribeAzure(audio, azure, code);
    throw new Error(
      `dictation in "${code}" needs a hosted model: the only one installed here is ` +
        `${basename(WHISPER_MODEL)}, which is English-only and would answer with ` +
        'confident English nonsense rather than an error. Put an OpenAI key in the ' +
        '`openaiApiKey` field of the voice secret and call /api/voice-status?refresh=1',
    );
  }

  // English, unchanged: Azure when configured (bigger model), falling back to local
  // on failure. Nothing on this path is sent to OpenAI, so a box with a key does not
  // start paying for the dictation it was already doing for free.
  if (azure) {
    try {
      return await transcribeAzure(audio, azure);
    } catch (err) {
      if (await haveLocalWhisper()) {
        console.warn('azure transcription failed, falling back to local:', err.message);
        return transcribeLocal(audio);
      }
      throw err;
    }
  }

  if (await haveLocalWhisper()) return transcribeLocal(audio);

  throw new Error(
    'voice transcription is unavailable: local whisper is not installed and no Azure credentials are set',
  );
}

/** Report which backend will be used, without exposing the key. */
export async function voiceStatus() {
  const azure = await loadAzure();
  const local = await haveLocalWhisper();
  const openai = Boolean(await openAiKey());
  // The local model's filename is the whole story: `.en` means English-only, which
  // is why a language is a routing decision here and not a parameter.
  const englishOnly = /\.en\b/.test(basename(WHISPER_MODEL));
  return {
    configured: Boolean(azure) || local || openai,
    backend: azure ? 'azure' : local ? 'local' : openai ? 'openai' : 'none',
    local: { available: local, binary: WHISPER_BIN, model: WHISPER_MODEL, englishOnly },
    azure: azure
      ? { endpoint: azure.endpoint, deployment: azure.deployment }
      : { configured: false },
    openai: openai
      ? { configured: true, model: OPENAI_MODEL, budget: uploadBudget() }
      : { configured: false },
    /*
     * Whether this box can hear a language other than English, stated separately
     * from `configured` for the same reason `speechStatus` states Hebrew separately:
     * a box with local whisper is fully configured and still cannot hear a word of
     * Hebrew, so a client that only read `configured` would offer a Hebrew mic and
     * get either a refusal or, before this existed, an English sentence nobody said.
     */
    languages: {
      english: Boolean(azure) || local || openai,
      other: openai || Boolean(azure),
      via: openai ? 'openai' : azure ? 'azure' : null,
      reason: openai || azure
        ? null
        : `the only model installed here is ${basename(WHISPER_MODEL)}, which is ` +
          'English-only — put an OpenAI key in the `openaiApiKey` field of the voice ' +
          'secret to dictate in another language',
    },
  };
}
