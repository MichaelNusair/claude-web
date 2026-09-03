/**
 * Transcription with two backends.
 *
 * Local whisper.cpp is the default: no quota to request, no API key, no
 * per-request cost, and nothing leaves the box. Measured on this instance
 * (t4g.large, 2 vCPU) with the base.en model: ~4s for 11s of audio, so a
 * typical few-second dictation lands in ~1-3s.
 *
 * Azure OpenAI Whisper is used instead when credentials are present, for when
 * a bigger/faster hosted model is wanted.
 */
import { execFile } from 'child_process';
import { writeFile, unlink, mkdtemp, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const execFileAsync = promisify(execFile);

const WHISPER_BIN = process.env.WHISPER_BIN || '/opt/whisper/whisper-cli';
const WHISPER_MODEL = process.env.WHISPER_MODEL || '/opt/whisper/models/ggml-base.en.bin';
// Guard against a pathological file pinning both cores indefinitely.
const LOCAL_TIMEOUT_MS = Number(process.env.WHISPER_TIMEOUT_MS || 120_000);

const secretsClient = new SecretsManagerClient({
  region: process.env.AWS_REGION || 'us-east-1',
});

let cachedAzure = null;      // resolved Azure config, or false when unavailable
let localAvailable = null;   // cached probe of the local binary

/** Drop cached config so a rotated secret or new install is picked up. */
export function resetConfigCache() {
  cachedAzure = null;
  localAvailable = null;
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

async function transcribeAzure(audio, config) {
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/webm' }), 'audio.webm');
  form.append('response_format', 'text');

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

export async function transcribe(body, contentType) {
  const audio = extractAudio(body, contentType);
  const azure = await loadAzure();

  // Prefer Azure when configured (bigger model), fall back to local on failure.
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
  return {
    configured: Boolean(azure) || local,
    backend: azure ? 'azure' : local ? 'local' : 'none',
    local: { available: local, binary: WHISPER_BIN, model: WHISPER_MODEL },
    azure: azure
      ? { endpoint: azure.endpoint, deployment: azure.deployment }
      : { configured: false },
  };
}
