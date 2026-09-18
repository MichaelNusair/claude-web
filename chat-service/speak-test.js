/**
 * The voice that reads a message out loud, checked without spending anything.
 *
 * Two things here are worth more than the rest.
 *
 * **The segmenting.** It decides where the voice takes a breath and what gets
 * billed, and it is the one part of this that a listener can hear: a piece ending
 * mid-clause is audible as a stumble, and a first piece that grew past its limit is
 * heard as a long silence after the tap. So the checks are about the boundaries —
 * that the first piece is short, that the later ones are not, that no piece is
 * oversized, and that nothing said is lost or repeated between them.
 *
 * **The refusals.** Every one of them is a path a real phone reaches: a message
 * that aged out while the phone was in a pocket, a segment that does not exist, the
 * daily budget, a Polly call that fails. The overlay's answer to all of them is to
 * fall back to the browser's own voice, so a refusal that arrives as a hang, or as
 * a 500 with no sentence in it, is a read that goes quiet for no stated reason.
 *
 * `VoiceCache` takes its synthesiser as an argument for exactly this reason, so
 * everything below runs against a fake that counts characters instead of Polly,
 * which charges for them: no credentials, no network, no bill. The Polly call
 * itself is the part that cannot be checked here — `/api/voice-status` is what
 * reports whether it works on the box.
 *
 * Run: node chat-service/speak-test.js
 */
import {
  VoiceCache,
  SpeakError,
  splitSegments,
  messageId,
  prepare,
  speechStatus,
  FALLBACK_VOICES,
  FIRST_SEGMENT_CHARS,
  SEGMENT_CHARS,
} from './speak.js';

let checks = 0;
let failures = 0;
const ok = (condition, name, detail = '') => {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const section = (name) => console.log(`\n${name}`);

/** A stand-in for Polly: says what it was asked to, in fake bytes, for free. */
const fakeVoice = () => {
  const calls = [];
  return {
    calls,
    synthesize: async (text, voice, engine) => {
      calls.push({ text, voice, engine });
      return Buffer.from(`mp3:${voice}:${text}`);
    },
    get chars() {
      return calls.reduce((n, c) => n + c.text.length, 0);
    },
  };
};

const words = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).join(' ');

// A message shaped like the ones this reads: a summary with short sentences, long
// sentences, decimals, filenames and line ranges in it.
const MESSAGE = [
  'Done. The auth gap is closed.',
  'The check now runs in auth.js, lines 42 to 51, inside the application process rather than in nginx, which is where the previous version claimed it was while the proxy config had no such rule at all.',
  'I also bumped the timeout from 1.5 to 3.5 seconds, because the first Bedrock call of a process resolves credentials and was timing out on a cold start.',
  'Tests pass: 106 checks. Do you want me to push it?',
].join(' ');

// --------------------------------------------------------------------------
section('Cutting a message into pieces:');
{
  const segments = splitSegments(MESSAGE);
  const sizes = segments.map((s) => s.length).join(', ');
  ok(segments.length >= 3, 'a summary becomes several pieces', `${MESSAGE.length} characters became ${segments.length}: ${sizes}`);
  ok(
    segments[0].length <= FIRST_SEGMENT_CHARS,
    'the first piece is short, so the voice starts within a couple of seconds',
    `it is ${segments[0].length} characters, over ${FIRST_SEGMENT_CHARS}`,
  );
  ok(
    segments.slice(1).every((s) => s.length <= SEGMENT_CHARS),
    'no piece is oversized',
    `sizes were ${sizes}`,
  );
  // The later pieces have to be long, or the read becomes dozens of round trips.
  ok(segments[1].length > FIRST_SEGMENT_CHARS, 'the pieces after the first are long', `the second is ${segments[1].length}`);

  ok(
    words(segments.join(' ')) === words(MESSAGE),
    'the pieces together say exactly what the message said',
    'words were lost, added or repeated across the seams',
  );

  const seams = segments.slice(0, -1);
  ok(
    seams.every((s) => /[.!?]["')\]]?$/.test(s)),
    'every seam falls at the end of a sentence, where a reader would pause anyway',
    `seams end: ${JSON.stringify(seams.map((s) => s.slice(-20)))}`,
  );
  ok(
    !seams.some((s) => /\d\.\d?$|\.js$/.test(s.slice(-8))),
    'a decimal or a filename is not mistaken for the end of a sentence',
    `seams end: ${JSON.stringify(seams.map((s) => s.slice(-10)))}`,
  );
}

{
  // Prose with no full stop in it still has to be said, so an over-long sentence
  // is split on words rather than left to grow into one huge piece.
  const long = `Right, ${'and then '.repeat(140)}done.`;
  const segments = splitSegments(long);
  ok(
    segments.every((s) => s.length <= SEGMENT_CHARS),
    'a sentence longer than a whole piece is split anyway',
    `${long.length} characters produced a piece of ${Math.max(...segments.map((s) => s.length))}`,
  );
  ok(segments.every((s) => !/\s$/.test(s)) , 'the split lands between words, not inside one');
  ok(words(segments.join(' ')) === words(long), 'nothing is lost splitting a long sentence');
}

{
  ok(splitSegments('').length === 0, 'there is nothing to synthesise for empty text');
  ok(splitSegments('   \n\t ').length === 0, 'there is nothing to synthesise for whitespace');
  ok(splitSegments('Yes.').length === 1, 'a four-character message is one piece');
  ok(
    splitSegments('Line one.\n\nLine two.')[0] === 'Line one. Line two.',
    'newlines are normalised out of the spoken text',
    `got ${JSON.stringify(splitSegments('Line one.\n\nLine two.'))}`,
  );
}

// --------------------------------------------------------------------------
section('Preparing a message costs nothing:');
{
  const voice = fakeVoice();
  const cache = new VoiceCache({ synthesize: voice.synthesize });
  const prepared = cache.prepare(MESSAGE, 'Ruth', 'generative');

  ok(voice.calls.length === 0, 'nothing is synthesised, so opening a message is never billed');
  ok(
    prepared.segments >= 3 && prepared.chars === MESSAGE.length,
    'it answers with how many pieces and how many characters',
    JSON.stringify(prepared),
  );
  ok(prepared.voice === 'Ruth' && prepared.engine === 'generative', 'it reports the voice and engine it will use');
  ok(/^[0-9a-f]{32}$/.test(prepared.id), 'the id is a hash of what will be said', `got ${prepared.id}`);

  // Content-addressed, so re-reading a message — or reading it on a second
  // device — is the same id, and therefore free.
  ok(
    cache.prepare(MESSAGE, 'Ruth', 'generative').id === prepared.id,
    'the same text gets the same id, so audio is reused instead of rebought',
  );
  ok(
    cache.prepare(MESSAGE, 'Matthew', 'generative').id !== prepared.id,
    'a different voice gets a different id, so it cannot play in the wrong voice',
  );
  ok(
    messageId(MESSAGE, 'Ruth', 'neural') !== messageId(MESSAGE, 'Ruth', 'generative'),
    'a different engine gets a different id',
  );
}

// --------------------------------------------------------------------------
section('Reading it:');
{
  const voice = fakeVoice();
  const cache = new VoiceCache({ synthesize: voice.synthesize });
  const { id, segments } = cache.prepare(MESSAGE, 'Ruth', 'generative');

  const first = await cache.audio(id, 0);
  ok(first.audio.length > 0 && !first.cached, 'the first piece comes back as fresh audio');
  ok(voice.calls.length === 1, 'asking for one piece synthesises one piece', `it made ${voice.calls.length} calls`);
  ok(voice.calls[0].voice === 'Ruth' && voice.calls[0].engine === 'generative', 'in the voice and engine that were prepared');
  ok(voice.calls[0].text.length <= FIRST_SEGMENT_CHARS, 'and it is the short piece that gets synthesised first');

  // Stopping after the first sentence is the usual case — you have heard enough —
  // and it must cost the first sentence rather than the whole message.
  ok(
    voice.chars < MESSAGE.length / 2,
    'stopping early leaves the rest of the message unsynthesised and unbilled',
    `${voice.chars} of ${MESSAGE.length} characters were submitted`,
  );

  const again = await cache.audio(id, 0);
  ok(again.cached && again.audio.equals(first.audio), 'a re-read replays the same audio instead of buying it again');
  ok(voice.calls.length === 1, 'a cached piece does not call the voice at all');

  for (let i = 1; i < segments; i += 1) await cache.audio(id, i);
  ok(voice.calls.length === segments, 'a whole message is one call per piece', `${segments} pieces took ${voice.calls.length}`);
  ok(
    voice.chars === splitSegments(MESSAGE).join('').length,
    'and the characters billed add up to the message that was read',
    `${voice.chars} submitted`,
  );
}

// --------------------------------------------------------------------------
section('Refusing, with a reason and a status:');
{
  const voice = fakeVoice();
  const cache = new VoiceCache({ synthesize: voice.synthesize, maxChars: 500 });

  const refuses = async (name, status, fn) => {
    try {
      await fn();
      ok(false, name, 'nothing was refused');
    } catch (err) {
      ok(
        err instanceof SpeakError && err.status === status && /\S/.test(err.message),
        name,
        `got ${err?.name} ${err?.status}: ${err?.message}`,
      );
    }
  };

  await refuses('nothing to read is a 400', 400, () => cache.prepare('   ', 'Ruth', 'generative'));
  await refuses('a message too long to read aloud is a 413', 413, () => cache.prepare('x. '.repeat(400), 'Ruth', 'generative'));
  await refuses('an id nobody prepared is a 404', 404, () => cache.audio('deadbeef', 0));

  const { id, segments } = cache.prepare(MESSAGE.slice(0, 300), 'Ruth', 'generative');
  await refuses('a piece past the end is a 404', 404, () => cache.audio(id, segments));
  await refuses('a negative piece is a 404', 404, () => cache.audio(id, -1));
  await refuses('a piece that is not a number is a 404', 404, () => cache.audio(id, 'first'));
  ok(voice.calls.length === 0, 'and none of those refusals reached the voice, so none of them were billed');

  // A synthesiser that fails has to surface as a refusal rather than as silence:
  // the client can only fall back to the browser's voice if it is told.
  const broken = new VoiceCache({ synthesize: async () => { throw new SpeakError('Polly is throttling this account', 503); } });
  const b = broken.prepare('Try it.', 'Ruth', 'generative');
  await refuses("a voice that fails keeps the voice's own status", 503, () => broken.audio(b.id, 0));

  const empty = new VoiceCache({ synthesize: async () => Buffer.alloc(0) });
  const e = empty.prepare('Try it.', 'Ruth', 'generative');
  await refuses('a voice that returns no audio is a 502, not an empty file to play', 502, () => empty.audio(e.id, 0));
}

// --------------------------------------------------------------------------
section('The daily budget:');
{
  const voice = fakeVoice();
  let now = Date.parse('2026-09-18T22:00:00Z');
  const cache = new VoiceCache({ synthesize: voice.synthesize, dailyChars: 200, now: () => now });

  const { id } = cache.prepare(MESSAGE, 'Ruth', 'generative');
  await cache.audio(id, 0);
  ok(
    cache.budget().chars > 0 && cache.budget().chars <= 200,
    'a read is counted against the day',
    JSON.stringify(cache.budget()),
  );

  let refused = null;
  try {
    for (let i = 1; i < 8; i += 1) await cache.audio(id, i);
  } catch (err) {
    refused = err;
  }
  ok(refused?.status === 429, 'reading past the budget is refused', `got ${refused?.status}: ${refused?.message}`);
  ok(/limit|budget|today/i.test(refused?.message || ''), 'and the refusal says why', `got: ${refused?.message}`);
  ok(cache.budget().chars <= 200, 'the budget is never overspent before refusing', `${cache.budget().chars} of 200`);

  // Audio already synthesised is already paid for, so the read in progress must
  // still finish once the budget is gone.
  ok((await cache.audio(id, 0)).cached, 'a piece already paid for still plays after the budget runs out');

  // Midnight UTC. A phone that comes back the next day re-prepares the text —
  // which is free — because the audio itself has long since aged out.
  now = Date.parse('2026-09-19T00:30:00Z');
  ok(
    cache.budget().chars === 0 && cache.budget().day === '2026-09-19',
    'the budget resets overnight',
    JSON.stringify(cache.budget()),
  );
  const tomorrow = cache.prepare(MESSAGE, 'Ruth', 'generative');
  ok((await cache.audio(tomorrow.id, 1)).audio.length > 0, 'and reading resumes the next day');
}

// --------------------------------------------------------------------------
section('Not holding audio forever:');
{
  const voice = fakeVoice();
  let now = 1_000_000;
  const cache = new VoiceCache({ synthesize: voice.synthesize, ttlMs: 60_000, maxMessages: 2, now: () => now });

  const first = cache.prepare('First message.', 'Ruth', 'generative');
  await cache.audio(first.id, 0);
  now += 61_000;
  let expired = null;
  try {
    await cache.audio(first.id, 0);
  } catch (err) {
    expired = err;
  }
  ok(expired?.status === 404, 'audio is dropped once nobody is listening to it', `got ${expired?.status}`);
  ok(cache.messages.size === 0, 'and the message goes with it', `${cache.messages.size} still held`);

  // A cap on messages too, so a long session cannot grow without bound.
  const ids = [];
  for (const text of ['One here.', 'Two here.', 'Three here.', 'Four here.']) {
    ids.push(cache.prepare(text, 'Ruth', 'generative').id);
    now += 10;
  }
  ok(cache.messages.size <= 2, 'only so many messages are held at once', `${cache.messages.size} with a limit of 2`);
  ok(cache.messages.has(ids[3]), 'and the newest is not the one evicted');

  // Re-preparing is what a phone does when it returns to a message, so it has to
  // make that message the one that survives rather than the next one to go.
  const kept = cache.prepare('Three here.', 'Ruth', 'generative').id;
  now += 10;
  cache.prepare('Five here.', 'Ruth', 'generative');
  ok(cache.messages.has(kept), 'a message asked for again is kept over an older one');
}

// --------------------------------------------------------------------------
section('What the phone is told:');
{
  // The voice picker is built from this, so a voice that cannot be used has to be
  // reported as unavailable rather than offered and then failing on the tap.
  const working = await speechStatus({
    describe: async () => ({
      voices: [
        { id: 'Lupe', gender: 'Female', language: 'es-US' },
        { id: 'Ruth', gender: 'Female', language: 'en-US' },
      ],
      reason: null,
    }),
  });
  ok(working.configured === true, 'a box that can synthesise says so');
  ok(working.voices[0].id === 'Ruth', "the phone's own language comes first in the picker", `got ${working.voices.map((v) => v.id).join(', ')}`);
  ok(working.voices.length === 2, 'without hiding the other languages');
  ok(typeof working.voice === 'string' && working.voice.length > 0, 'the default voice is named');
  ok(working.budget && typeof working.budget.limit === 'number', 'the budget is reported, so the sheet can show what is left');
  ok(working.firstSegmentChars === FIRST_SEGMENT_CHARS, 'and how long the first piece is');

  const denied = await speechStatus({
    describe: async () => ({ voices: [], reason: "this instance's role cannot call polly:SynthesizeSpeech" }),
  });
  ok(denied.configured === false, 'a box with no Polly access says it cannot speak');
  ok(/polly/i.test(denied.reason || ''), 'and says why, rather than leaving an operator guessing', `got: ${denied.reason}`);

  // A phone that remembers a voice this deployment no longer offers must still be
  // read to, in the default voice, and told which one it got. Through the module's
  // own `prepare`, since that is where a caller-supplied name is checked; it
  // synthesises nothing, so this costs nothing even against the real cache.
  const asked = prepare('Read this.', { voice: 'Matthew' });
  ok(asked.voice === 'Matthew', 'a voice this deployment offers is the one used', `got ${asked.voice}`);
  const unknown = prepare('Read this too.', { voice: 'Clippy; DROP TABLE' });
  ok(
    FALLBACK_VOICES.some((v) => v.id === unknown.voice),
    'an unknown voice falls back to a real one instead of being passed through',
    `got ${unknown.voice}`,
  );
  ok(prepare('And this.', {}).voice === unknown.voice, 'and so does no voice at all');
  ok(FALLBACK_VOICES.some((v) => v.id === 'Ruth'), 'Ruth, the default, is in the fallback list');
  ok(
    FALLBACK_VOICES.every((v) => v.id && v.gender && v.language),
    'every fallback voice has the gender and language the picker shows',
  );
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
