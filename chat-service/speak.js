/**
 * The voice that reads a message out loud.
 *
 * Read aloud used to be the browser's own `speechSynthesis`, which is the voice
 * the platform gives away: on Android it is flat, it mispronounces every
 * identifier, and it breathes in the wrong places, so a summary read out of it is
 * something you decode rather than listen to. The point of that button is to hear
 * the answer while walking, driving or waiting — and a voice you have to
 * concentrate on defeats it.
 *
 * So the audio is synthesised on the box now, and the browser only plays it.
 * Amazon Polly, because this instance already has an AWS role and already talks to
 * Bedrock: nothing new to sign up for, no API key to keep, and no third party in
 * the path of a private conversation. Its *generative* engine, because that is the
 * tier that sounds like a person rather than an announcement — it pauses where the
 * sentence pauses, puts the stress on the right word, and reads "auth.js, line 42
 * to 51" as a phrase instead of a list of tokens.
 *
 * Measured from this instance against us-east-1 on 2026-09-18, Ruth/generative:
 *
 *     chars   first byte   synthesis   audio it makes   synthesis/audio
 *       160        204ms        1.9s            9.4s            0.20x
 *       240        143ms        2.7s           13.7s            0.20x
 *       450        134ms        4.7s           25.7s            0.18x
 *       850        148ms        9.3s           48.5s            0.19x
 *      1600        149ms       16.8s           90.7s            0.18x
 *
 * Two of those numbers decide the whole design.
 *
 * **Synthesis takes about a fifth of the time its own audio takes to play.** So a
 * message is cut into pieces and each piece is built while the previous one is
 * still playing, with a five-fold margin. Nothing has to be waited for after the
 * first piece, and a listener hears one continuous message.
 *
 * **The wait for that first piece is proportional to its length.** Hence
 * `FIRST_SEGMENT_CHARS`: the opening piece is one or two sentences, so the voice
 * starts in about two seconds instead of the twenty-three a whole message takes.
 * Everything after it is `SEGMENT_CHARS`, which is long enough that the boundaries
 * are rare and always fall where a sentence already ended.
 *
 * Pieces are also what makes stopping cheap. Polly bills per character submitted,
 * so a message abandoned after the first sentence costs one segment rather than
 * all of it — which matters because the *reason* to stop is usually that you have
 * heard enough.
 *
 * What this refuses, and why each refusal exists:
 *
 *  - **A daily character budget** (`SPEAK_DAILY_CHARS`). Generative Polly is $30
 *    per million characters, so a full 2400-character read is about 7 cents and a
 *    loop that re-reads a message every few seconds is real money. A caller that
 *    reaches the budget gets 429 with a sentence saying so, and the client falls
 *    back to the browser voice rather than going quiet.
 *  - **A cap on the text** (`SPEAK_MAX_CHARS`). This is a spoken summary, not an
 *    audiobook; the client already cuts at 2400 characters.
 *  - **An allowlist of voices.** A caller-supplied string is never passed through
 *    to the API: an unknown voice falls back to the default and the answer says
 *    which voice was actually used, so a stale phone with an old name in
 *    localStorage still gets audio.
 *
 * And what it caches: audio is keyed by (engine, voice, text), which is exact,
 * because Polly is deterministic — the same request twice returned byte-identical
 * audio when this was measured. So re-reading a message, or the same message on a
 * second device, is free and instant.
 */
import { createHash } from 'crypto';
import {
  PollyClient,
  SynthesizeSpeechCommand,
  DescribeVoicesCommand,
} from '@aws-sdk/client-polly';

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
// `generative` is the point of this file. `neural` ($16/M) and `standard` ($4/M)
// are here as an escape hatch for a region without generative voices, or for an
// operator who would rather pay less — both still beat the browser's voice.
const ENGINE = process.env.SPEAK_ENGINE || 'generative';
const DEFAULT_VOICE = process.env.SPEAK_VOICE || 'Ruth';

// Measured above: ~1.9s of waiting before the first word, against ~9.4s of audio
// to cover the next piece being built.
export const FIRST_SEGMENT_CHARS = Number(process.env.SPEAK_FIRST_CHARS || 160);
// ~7.7s to build, ~40s of audio. The margin is what keeps the message continuous.
export const SEGMENT_CHARS = Number(process.env.SPEAK_SEGMENT_CHARS || 700);

// The client cuts at 2400 characters (SPEECH_CAP in pwa/mobile-overlay.js) and
// may put a short lead-in in front of that. This is that, with room to spare.
const MAX_CHARS = Number(process.env.SPEAK_MAX_CHARS || 4000);
// A 700-character segment takes ~7.7s. This is for a bad day, not a normal one.
const SYNTH_TIMEOUT_MS = Number(process.env.SPEAK_TIMEOUT_MS || 30_000);
// ~$9/day at generative rates: enough for about 125 full reads, low enough that a
// runaway client is a refusal rather than an invoice.
const DAILY_CHARS = Number(process.env.SPEAK_DAILY_CHARS || 300_000);
// Long enough to finish reading a message and to read it again; short enough that
// a phone left on the sheet is not holding megabytes of audio for the afternoon.
const TTL_MS = Number(process.env.SPEAK_TTL_MS || 10 * 60 * 1000);
// A full message is ~800KB of mp3, so six of them is ~5MB — the cost of a
// conversation switched between a few times while listening.
const MAX_MESSAGES = Number(process.env.SPEAK_MAX_MESSAGES || 6);

/**
 * The generative voices in us-east-1, from `aws polly describe-voices --engine
 * generative` on 2026-09-18.
 *
 * Only a fallback: `speechStatus()` asks Polly itself, and that answer is what the
 * picker on the phone is built from. This list is what validates a voice name when
 * the account cannot call DescribeVoices, so a deployment with a narrower policy
 * than ours still gets audio instead of an error.
 */
export const FALLBACK_VOICES = [
  { id: 'Ruth', gender: 'Female', language: 'en-US' },
  { id: 'Matthew', gender: 'Male', language: 'en-US' },
  { id: 'Danielle', gender: 'Female', language: 'en-US' },
  { id: 'Stephen', gender: 'Male', language: 'en-US' },
  { id: 'Joanna', gender: 'Female', language: 'en-US' },
  { id: 'Salli', gender: 'Female', language: 'en-US' },
  { id: 'Tiffany', gender: 'Female', language: 'en-US' },
];

/** A refusal with an HTTP status on it, so the route can answer honestly. */
export class SpeakError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'SpeakError';
    this.status = status;
  }
}

/**
 * Sentences, by scanning.
 *
 * A deliberate twin of `splitSentences` in `pwa/mobile-overlay.js` rather than a
 * shared module: that file is injected raw into code-server's HTML and imports
 * nothing, so there is no module either end could hold in common. The two also
 * answer different questions — that one sizes utterances for a synthesiser in the
 * page, this one decides what gets billed and where the voice may take a breath.
 */
function splitSentences(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if ('.!?'.indexOf(text[i]) === -1) continue;
    let end = i;
    // Take a run of terminators together ("Really?!"), and only break where
    // whitespace follows — "3.5" and "auth.js" are not sentence ends.
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
 * Cut a message into the pieces that get synthesised, first one short.
 *
 * Boundaries land at sentence ends wherever possible, because that is where a
 * reader would pause anyway — a piece that ends mid-clause is audible as a
 * stumble, and the seam is the one thing a listener can hear about this design. A
 * single sentence longer than the limit is split on words rather than left to grow,
 * since a 900-character "sentence" is usually a line of prose with no full stop in
 * it and still has to be said.
 */
export function splitSegments(text) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  const segments = [];
  let current = '';
  // The first piece is the one someone is waiting on; the rest are being built
  // while the previous piece plays, so they can be long.
  const limit = () => (segments.length === 0 ? FIRST_SEGMENT_CHARS : SEGMENT_CHARS);
  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) segments.push(trimmed);
    current = '';
  };

  for (const sentence of splitSentences(clean).map((s) => s.trim()).filter(Boolean)) {
    if (sentence.length > limit()) {
      flush();
      for (const word of sentence.split(' ')) {
        if (current && current.length + word.length + 1 > limit()) flush();
        current += (current ? ' ' : '') + word;
      }
      flush();
      continue;
    }
    if (current && current.length + sentence.length + 1 > limit()) flush();
    current += (current ? ' ' : '') + sentence;
  }
  flush();
  return segments;
}

/** Which audio this is, exactly: same engine, voice and words means same bytes. */
export function messageId(text, voice, engine) {
  return createHash('sha256')
    .update(`${engine}\n${voice}\n${text}`)
    .digest('hex')
    .slice(0, 32);
}

/** UTC, so the budget resets at a time that does not depend on the box's zone. */
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Prepared messages, their audio, and what the day has cost so far.
 *
 * Takes its synthesiser as an argument so the refusals — the budget, an unknown
 * id, a segment that does not exist, a synthesiser that fails — can be tested
 * without an AWS account and without spending anything. `speak-test.js` does
 * exactly that; the Polly wiring below is the only part that needs credentials.
 */
export class VoiceCache {
  constructor({
    synthesize,
    dailyChars = DAILY_CHARS,
    ttlMs = TTL_MS,
    maxMessages = MAX_MESSAGES,
    maxChars = MAX_CHARS,
    now = Date.now,
  } = {}) {
    this.synthesize = synthesize;
    this.dailyChars = dailyChars;
    this.ttlMs = ttlMs;
    this.maxMessages = maxMessages;
    this.maxChars = maxChars;
    this.now = now;
    this.messages = new Map();
    this.spent = { day: dayOf(now()), chars: 0 };
  }

  /** Drop what nobody is listening to any more. */
  sweep() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, entry] of this.messages) {
      if (entry.at < cutoff) this.messages.delete(id);
    }
    // Oldest first: the Map keeps insertion order, and `prepare` re-stamps an
    // entry it finds again, so the one evicted is the one least recently asked for.
    while (this.messages.size > this.maxMessages) {
      const oldest = [...this.messages.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!oldest) break;
      this.messages.delete(oldest[0]);
    }
  }

  /**
   * Register a message and say how many pieces it is. Synthesises nothing, so it
   * costs nothing — the client can do this the moment a message appears on screen,
   * long before anybody taps Read aloud.
   */
  prepare(text, voice, engine) {
    const body = String(text ?? '').trim();
    if (!body) throw new SpeakError('there is nothing to read', 400);
    if (body.length > this.maxChars) {
      throw new SpeakError(
        `that is ${body.length} characters; ${this.maxChars} is the most this will read aloud`,
        413,
      );
    }

    const id = messageId(body, voice, engine);
    const found = this.messages.get(id);
    if (found) {
      // Asked for again, so it is the one to keep when something has to go.
      found.at = this.now();
      this.sweep();
      return { id, voice, engine, segments: found.segments.length, chars: body.length };
    }

    const segments = splitSegments(body);
    if (!segments.length) throw new SpeakError('there is nothing to read', 400);
    this.messages.set(id, { id, voice, engine, segments, audio: new Map(), at: this.now() });
    this.sweep();
    return { id, voice, engine, segments: segments.length, chars: body.length };
  }

  /** What today has cost, and what it is allowed to cost. */
  budget() {
    if (this.spent.day !== dayOf(this.now())) this.spent = { day: dayOf(this.now()), chars: 0 };
    return { day: this.spent.day, chars: this.spent.chars, limit: this.dailyChars };
  }

  /**
   * The audio for one piece, synthesising it if this is the first ask.
   *
   * A 404 here is a normal thing for a client to meet — the service restarts, or
   * the message aged out while a phone was in a pocket — so it is worth being
   * specific about: the caller's answer is to prepare the same text again, which
   * costs nothing, and read on.
   */
  async audio(id, index) {
    this.sweep();
    const entry = this.messages.get(id);
    if (!entry) throw new SpeakError('that message is no longer prepared', 404);
    const position = Number(index);
    if (!Number.isInteger(position) || position < 0 || position >= entry.segments.length) {
      throw new SpeakError(`this message has ${entry.segments.length} pieces, not ${index}`, 404);
    }

    const already = entry.audio.get(position);
    entry.at = this.now();
    if (already) return { audio: already, cached: true, chars: 0 };

    const text = entry.segments[position];
    const budget = this.budget();
    if (budget.chars + text.length > budget.limit) {
      throw new SpeakError(
        `the voice has read ${budget.chars} characters today and the daily limit is ` +
          `${budget.limit} — it resets at midnight UTC, or raise SPEAK_DAILY_CHARS`,
        429,
      );
    }

    const audio = await this.synthesize(text, entry.voice, entry.engine);
    if (!audio || !audio.length) throw new SpeakError('the voice returned no audio', 502);
    // Counted after the fact: a failed call is not billed, so it must not be
    // charged against the budget either.
    this.spent.chars = budget.chars + text.length;
    entry.audio.set(position, audio);
    return { audio, cached: false, chars: text.length };
  }
}

// --------------------------------------------------------------------- Polly
let polly = null;
const client = () => {
  if (!polly) polly = new PollyClient({ region: REGION });
  return polly;
};

/**
 * One piece of audio, as mp3 bytes.
 *
 * The stream is collected rather than piped to the response, deliberately. Piping
 * would put the first word in the listener's ear ~150ms after the tap instead of
 * ~2s, and it is the first thing to reach for — but a response with no
 * Content-Length is exactly what iOS Safari is unreliable about playing, and this
 * feature exists for a phone. A complete piece is an ordinary media file that any
 * browser will play, and the short first segment is what buys back most of the
 * latency. If this is ever revisited, revisit it with an iPhone in hand.
 */
async function pollySynthesize(text, voice, engine) {
  try {
    const out = await client().send(
      new SynthesizeSpeechCommand({
        Engine: engine,
        VoiceId: voice,
        OutputFormat: 'mp3',
        Text: text,
        TextType: 'text',
      }),
      { abortSignal: AbortSignal.timeout(SYNTH_TIMEOUT_MS) },
    );
    const chunks = [];
    for await (const chunk of out.AudioStream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  } catch (err) {
    throw pollyRefusal(err, voice, engine);
  }
}

/**
 * Say what went wrong in a sentence an operator can act on.
 *
 * Every one of these has been made to happen at least once while building this,
 * and the raw SDK message for the first two says nothing about what to do.
 */
function pollyRefusal(err, voice, engine) {
  const text = `${err?.name || ''} ${err?.message || ''}`;
  if (/AccessDenied|not authorized|UnrecognizedClient|CredentialsProviderError/i.test(text)) {
    return new SpeakError(
      "this instance's role cannot call polly:SynthesizeSpeech — add it to the " +
        'instance role in infra/lib/stack.js and deploy the stack',
      403,
    );
  }
  if (/ValidationException|InvalidParameter|EngineNotSupported/i.test(text)) {
    return new SpeakError(
      `Polly refused ${voice} on the ${engine} engine in ${REGION} ` +
        `(${err?.message || 'no reason given'}) — try SPEAK_ENGINE=neural`,
      400,
    );
  }
  if (/Throttling|TooManyRequests|LimitExceeded/i.test(text)) {
    return new SpeakError('Polly is throttling this account — try again in a moment', 503);
  }
  if (/Abort|TimeoutError|timed out/i.test(text)) {
    return new SpeakError(`the voice took longer than ${SYNTH_TIMEOUT_MS}ms to answer`, 504);
  }
  return new SpeakError(`the voice failed: ${err?.message || 'unknown error'}`, 502);
}

const cache = new VoiceCache({ synthesize: pollySynthesize });

/**
 * Which voices this account will actually give us, asked once.
 *
 * DescribeVoices is free and it is the only way to know whether the generative
 * engine exists in this region and whether this role may use it at all — which is
 * also why it doubles as the availability probe for `/api/voice-status`. Cached for
 * the life of the process, including the failure: a deployment without the
 * permission must not re-ask on every status poll.
 */
let probed = null;
async function describeVoices() {
  if (probed) return probed;
  try {
    const out = await client().send(new DescribeVoicesCommand({ Engine: ENGINE }), {
      abortSignal: AbortSignal.timeout(8000),
    });
    const voices = (out.Voices || []).map((v) => ({
      id: v.Id,
      gender: v.Gender,
      language: v.LanguageCode,
      name: v.Name,
    }));
    probed = { voices, reason: null };
  } catch (err) {
    probed = { voices: [], reason: pollyRefusal(err, DEFAULT_VOICE, ENGINE).message };
  }
  return probed;
}

/** Every voice this deployment is willing to use, probed or assumed. */
function knownVoices() {
  const voices = probed?.voices?.length ? probed.voices : FALLBACK_VOICES;
  return voices;
}

/**
 * The voice to use. An unknown name is not an error: a phone that remembers a
 * voice this deployment no longer offers should still be read to, in the default
 * voice, and told which one it got.
 */
function pickVoice(requested) {
  const wanted = String(requested || '').trim();
  const known = knownVoices();
  const match = known.find((v) => v.id.toLowerCase() === wanted.toLowerCase());
  if (match) return match.id;
  const fallback = known.find((v) => v.id === DEFAULT_VOICE);
  return fallback ? fallback.id : known[0]?.id || DEFAULT_VOICE;
}

/** Register a message. Costs nothing; see `VoiceCache#prepare`. */
export function prepare(text, { voice } = {}) {
  const chosen = pickVoice(voice);
  return cache.prepare(text, chosen, ENGINE);
}

/** The audio for one piece of a prepared message. */
export function speakSegment(id, index) {
  return cache.audio(id, index);
}

/**
 * Can this box speak, in which voices, and what has it spent today.
 *
 * Answers `configured: false` with a reason rather than throwing, because the
 * client's response to every failure here is the same: keep the browser's voice.
 */
export async function speechStatus({ lang = 'en', describe = describeVoices } = {}) {
  const { voices, reason } = await describe();
  const wanted = String(lang || 'en').slice(0, 5).toLowerCase();
  // Everything for this language, then everything else: a picker should offer the
  // voices that match the phone first without hiding the others.
  const matches = (v) => String(v.language || '').toLowerCase().startsWith(wanted.slice(0, 2));
  const ordered = [...voices.filter(matches), ...voices.filter((v) => !matches(v))];
  return {
    configured: ordered.length > 0,
    engine: ENGINE,
    voice: pickVoice(DEFAULT_VOICE),
    voices: ordered,
    budget: cache.budget(),
    firstSegmentChars: FIRST_SEGMENT_CHARS,
    reason: ordered.length ? null : reason,
  };
}

/**
 * Re-probe, and drop the cached audio.
 *
 * What `/api/voice-status?refresh=1` calls, so a newly granted Polly permission
 * takes effect without restarting the service. Deliberately does *not* reset the
 * day's spend: a caller who can reach that route could otherwise clear the budget
 * by polling it, which would leave the one guard against a runaway read
 * unenforceable.
 */
export function resetSpeech() {
  cache.messages.clear();
  probed = null;
}

export const speechEngine = ENGINE;
