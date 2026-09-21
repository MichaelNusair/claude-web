/**
 * The Hebrew voice and the Hebrew ear, checked without speaking or listening.
 *
 * Two things here are worth more than the rest.
 *
 * The first is **escaping**. SSML is XML, and the case this whole feature was asked
 * for is reading a code block aloud — so the text handed to Azure routinely contains
 * `&&` and `<`. Unescaped, the first `<` makes the document invalid, Azure answers
 * 400, and the shape of the bug is that prose reads fine and code never does. That is
 * a thing a reasonable edit ("just interpolate the text") breaks silently, so the
 * escape is asserted on directly and through `ssmlFor`.
 *
 * The second is the **money**, which for this backend means the absence of it. The
 * resource is an `F0` free tier that answers 429 rather than billing, and the standing
 * rule for this deployment is credits only, never a card. So the 429 path is asserted
 * to say in words that nothing is charged and that it comes back on the 1st — because
 * the person who sees that message is deciding whether to go and pay for something.
 *
 * Everything else is refusals: a box with no credentials (the normal state of a fresh
 * deployment, and of any clone of this repo), a recording longer than the recognizer
 * takes — refused *before* the upload, not after — `NoMatch` said in a way that sends
 * someone to the language picker rather than to their microphone, and Azure's statuses
 * remapped so a 401 from Azure does not reach a phone as a 401 from this service.
 *
 * `speakAzure` and `hearAzure` take their `fetch` and their credentials as arguments,
 * so none of this touches the network, the secret, or the month's free quota. The
 * credential *lookup* itself only reads `process.env` at import, so the one case that
 * cannot be injected — credentials arriving from the environment — is a second pass in
 * a second process, at the bottom of this file.
 *
 * Run: node chat-service/azure-speech-test.js
 */
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const MODE = process.argv[2] === 'env' ? 'env' : 'bare';

/*
 * A box with no Azure credentials, whichever box this is. The real secret on the
 * instance now genuinely holds a key, and a test that inherited it would pass here and
 * fail in every clone — or, worse, spend the quota it is asserting about.
 */
const ENV_CREDS = { key: 'azure-test-not-a-real-key', region: 'westus2' };
if (MODE === 'bare') {
  delete process.env.AZURE_SPEECH_KEY;
  delete process.env.AZURE_SPEECH_REGION;
  delete process.env.AZURE_SPEECH_SECRET_ARN;
  delete process.env.WHISPER_SECRET_ARN;
}

const {
  AZURE_VOICES,
  azureLocale,
  azureSpeech,
  azureSpeechConfigured,
  azureSpeechRefusal,
  azureSpeechStatus,
  hearAzure,
  resetAzureSpeech,
  speakAzure,
  ssmlEscape,
  ssmlFor,
  wavSeconds,
} = await import('./azure-speech.js');

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

const refuses = async (name, fn, matching = null, status = null) => {
  try {
    await fn();
    ok(false, name, 'nothing was refused');
  } catch (err) {
    const right =
      (!matching || matching.test(err?.message || '')) &&
      (status === null || err?.status === status);
    ok(right, name, `got ${err?.status} ${err?.message}`);
  }
};

/** A stub Azure, recording what it was asked and answering what it was told to. */
const fakeAzure = (reply = {}) => {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init, headers: init?.headers || {}, body: init?.body });
    const status = reply.status ?? 200;
    const body = reply.body ?? '';
    if (reply.throws) throw reply.throws;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      arrayBuffer: async () => Buffer.from(reply.audio ?? 'mp3-bytes'),
    };
  };
  return { calls, impl };
};

/** A WAV header whose byte rate says how long the payload is. */
const wav = (seconds, byteRate = 1000) => {
  const data = Buffer.alloc(Math.round(seconds * byteRate));
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(byteRate / 2, 24);
  head.writeUInt32LE(byteRate, 28);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
};

if (MODE === 'bare') {
  console.log('Azure Speech, on a box with no credentials:');

  section('The two Hebrew voices:');
  ok(AZURE_VOICES.length === 2, 'there are two of them');
  ok(
    AZURE_VOICES.every((v) => v.language === 'he-IL' && v.provider === 'azure'),
    'both are Hebrew, and both say which provider they come from',
  );
  ok(
    AZURE_VOICES.every((v) => /^he-IL-\w+Neural$/.test(v.name)),
    'each carries the full Azure name for the wire',
    JSON.stringify(AZURE_VOICES.map((v) => v.name)),
  );
  ok(
    AZURE_VOICES.every((v) => !v.id.includes('-')),
    'and a bare id for the picker and the phone',
    JSON.stringify(AZURE_VOICES.map((v) => v.id)),
  );
  ok(AZURE_VOICES[0].id === 'Hila', 'the default is the one measured on this box');
  ok(
    new Set(AZURE_VOICES.map((v) => v.gender)).size === 2,
    'one of each gender, so a picker has a real choice',
  );

  section('SSML is XML, and a code block is full of XML:');
  ok(ssmlEscape('a && b') === 'a &amp;&amp; b', 'an ampersand becomes an entity');
  ok(ssmlEscape('x < y') === 'x &lt; y', 'a less-than becomes an entity');
  ok(ssmlEscape('x > y') === 'x &gt; y', 'so does a greater-than');
  ok(ssmlEscape('say "this"') === 'say &quot;this&quot;', 'and a double quote');
  ok(ssmlEscape("it's") === 'it&apos;s', 'and an apostrophe');
  ok(
    ssmlEscape('&lt;') === '&amp;lt;',
    'the ampersand goes first, so nothing is escaped twice',
    ssmlEscape('&lt;'),
  );
  ok(ssmlEscape(null) === '' && ssmlEscape(undefined) === '', 'nothing becomes empty, not "null"');

  const block = 'if (a && b) return x < y; // <div> & more';
  const doc = ssmlFor(block, 'he-IL-HilaNeural');
  ok(doc.startsWith('<speak version="1.0"'), 'the document is a speak element');
  ok(doc.includes('<voice name="he-IL-HilaNeural">'), 'naming the voice asked for');
  ok(doc.endsWith('</voice></speak>'), 'and it is closed');
  ok(
    (doc.match(/</g) || []).length === 4,
    'a code block adds no tags of its own — four angle brackets, all structural',
    `${(doc.match(/</g) || []).length} in ${doc}`,
  );
  ok(doc.includes('&amp;&amp;') && doc.includes('&lt;div&gt;'), 'the code arrives escaped', doc);
  ok(!doc.includes('<div>'), 'and not as markup');
  ok(doc.includes('xml:lang="he-IL"'), 'the document language comes from the voice');
  ok(
    ssmlFor('hello', 'en-US-JennyNeural').includes('xml:lang="en-US"'),
    'which holds for a voice that is not Hebrew',
  );
  ok(
    ssmlFor('x', 'Nonsense').includes('xml:lang="he-IL"'),
    'a voice name with no locale in it falls back to Hebrew',
  );
  ok(
    ssmlFor('x').includes(AZURE_VOICES[0].name),
    'and no voice at all means the default one',
  );
  ok(
    ssmlFor('שלום', 'he-IL-AvriNeural').includes('שלום'),
    'Hebrew itself is left exactly as it is — it is text, not markup',
  );

  section('Azure wants a locale, the rest of this codebase has two letters:');
  ok(azureLocale('he') === 'he-IL', 'he becomes he-IL, which is the whole point of this');
  ok(azureLocale('he-IL') === 'he-IL', 'a locale that arrived complete is kept');
  ok(azureLocale('HE-il') === 'he-IL', 'and normalised rather than rejected');
  ok(azureLocale('en') === 'en-US', 'en becomes en-US');
  ok(azureLocale('en-GB') === 'en-GB', 'but en-GB stays en-GB');
  ok(azureLocale('ar') === 'ar-IL', 'Arabic gets the region this deployment means by it');
  ok(azureLocale('ru') === 'ru-RU' && azureLocale('pt') === 'pt-BR', 'the table is used');
  ok(azureLocale('zz') === 'zz-ZZ', 'an unlisted pair is guessed rather than dropped');
  ok(azureLocale('') === 'he-IL' && azureLocale(null) === 'he-IL', 'nothing means Hebrew here');
  ok(azureLocale('x') === 'he-IL', 'and so does something too short to be a language');

  section('How long a recording is, from its own header:');
  ok(Math.round(wavSeconds(wav(3))) === 3, 'three seconds of WAV reads as three');
  ok(
    Math.round(wavSeconds(wav(10, 32_000))) === 10,
    'the byte rate is read, not assumed — 16-bit 16 kHz reads right too',
    String(wavSeconds(wav(10, 32_000))),
  );
  ok(wavSeconds(Buffer.from('not audio at all, but long enough to have a header maybe')) === 0,
    'something that is not a RIFF file is 0, not a guess');
  ok(wavSeconds(Buffer.alloc(10)) === 0, 'so is something too short to hold a header');
  ok(wavSeconds('a string') === 0 && wavSeconds(null) === 0, 'and so is not-a-buffer');

  section('What Azure says when it refuses, and what we say instead:');
  const unauthorised = azureSpeechRefusal(401, 'Access denied due to invalid subscription key');
  ok(/speechKey/.test(unauthorised), 'a rejected key names the field to fix');
  ok(/voice-status\?refresh=1/.test(unauthorised), 'and the call that picks up a new one');
  ok(/invalid subscription key/.test(unauthorised), "and passes through Azure's own words");

  const quota = azureSpeechRefusal(429, '');
  ok(/free tier/.test(quota), 'a 429 says it is the free tier, not a fault');
  ok(
    /Nothing is charged/.test(quota),
    'and says plainly that nothing is charged for it — the reader is deciding whether to pay',
    quota,
  );
  ok(/1st/.test(quota), 'and when it comes back on its own');

  ok(/region/.test(azureSpeechRefusal(404, '')), 'a 404 points at the region, which is the cause');
  ok(/try again/.test(azureSpeechRefusal(503, '')), 'a 5xx is worth retrying and says so');
  ok(/418/.test(azureSpeechRefusal(418, '')), 'anything else at least reports the status');
  ok(
    !/\n/.test(azureSpeechRefusal(400, 'a\nmultiline\nbody')) &&
      azureSpeechRefusal(400, 'x'.repeat(900)).length < 400,
    'a body is collapsed to one line and truncated, because these are shown on a phone',
  );

  section('Reading aloud, against a stub:');
  const tts = fakeAzure({ audio: 'mp3' });
  const audio = await speakAzure('a && b', 'he-IL-HilaNeural', {
    fetchImpl: tts.impl,
    config: ENV_CREDS,
  });
  ok(Buffer.isBuffer(audio) && audio.toString() === 'mp3', 'the bytes come back as a Buffer');
  ok(tts.calls.length === 1, 'one request was made');
  ok(
    tts.calls[0].url === 'https://westus2.tts.speech.microsoft.com/cognitiveservices/v1',
    'to the synthesis endpoint in the configured region',
    tts.calls[0].url,
  );
  ok(tts.calls[0].init.method === 'POST', 'as a POST');
  ok(
    tts.calls[0].headers['Ocp-Apim-Subscription-Key'] === ENV_CREDS.key,
    'with the key in the header Azure reads it from',
  );
  ok(
    tts.calls[0].headers['Content-Type'] === 'application/ssml+xml',
    'declaring SSML, which is what the body is',
  );
  ok(
    /mp3$/.test(tts.calls[0].headers['X-Microsoft-OutputFormat'] || ''),
    'and asking for mp3, which is what a phone can play',
    tts.calls[0].headers['X-Microsoft-OutputFormat'],
  );
  ok(
    tts.calls[0].body === ssmlFor('a && b', 'he-IL-HilaNeural'),
    'the body is the escaped document, not the raw text',
    String(tts.calls[0].body),
  );
  ok(
    !String(tts.calls[0].url).includes(ENV_CREDS.key),
    'the key is never in the URL, where it would end up in a log',
  );

  await refuses(
    'the free tier being used up is a 429 here too, so a client can tell it apart',
    () => speakAzure('שלום', 'he-IL-HilaNeural', {
      fetchImpl: fakeAzure({ status: 429 }).impl,
      config: ENV_CREDS,
    }),
    /Nothing is charged/,
    429,
  );
  await refuses(
    "Azure's 401 does not reach a phone as a 401 — that would read as a lapsed login",
    () => speakAzure('שלום', 'he-IL-HilaNeural', {
      fetchImpl: fakeAzure({ status: 401, body: 'nope' }).impl,
      config: ENV_CREDS,
    }),
    /speechKey/,
    403,
  );
  await refuses(
    "Azure being broken is this service's 502, not its 500",
    () => speakAzure('שלום', 'he-IL-HilaNeural', {
      fetchImpl: fakeAzure({ status: 500 }).impl,
      config: ENV_CREDS,
    }),
    /failing/,
    502,
  );
  await refuses(
    'an unreachable Azure says so, as a 502',
    () => speakAzure('שלום', 'he-IL-HilaNeural', {
      fetchImpl: fakeAzure({ throws: new Error('getaddrinfo ENOTFOUND') }).impl,
      config: ENV_CREDS,
    }),
    /could not reach Azure Speech/,
    502,
  );
  await refuses(
    'a synthesis that never answers is a timeout, as a 504',
    () => speakAzure('שלום', 'he-IL-HilaNeural', {
      fetchImpl: fakeAzure({ throws: Object.assign(new Error('x'), { name: 'TimeoutError' }) }).impl,
      config: ENV_CREDS,
    }),
    /took longer than/,
    504,
  );

  section('Listening, against a stub:');
  const stt = fakeAzure({ body: { RecognitionStatus: 'Success', DisplayText: ' שלום עולם. ' } });
  const heard = await hearAzure(wav(2), 'he', { fetchImpl: stt.impl, config: ENV_CREDS });
  ok(heard === 'שלום עולם.', 'the recognised text comes back trimmed', JSON.stringify(heard));
  ok(
    stt.calls[0].url.startsWith('https://westus2.stt.speech.microsoft.com/speech/recognition/'),
    'from the recognition endpoint in the configured region',
    stt.calls[0].url,
  );
  ok(
    stt.calls[0].url.includes('language=he-IL'),
    'and a bare "he" was expanded to the locale Azure requires',
    stt.calls[0].url,
  );
  ok(stt.calls[0].body.length === wav(2).length, 'the audio is the body, unwrapped');
  ok(
    /audio\/wav/.test(stt.calls[0].headers['Content-Type'] || ''),
    'declared as WAV, which is what both clients record',
  );
  ok(
    stt.calls[0].headers['Ocp-Apim-Subscription-Key'] === ENV_CREDS.key,
    'with the same key header',
  );

  const long = fakeAzure({ body: { RecognitionStatus: 'Success', DisplayText: 'x' } });
  await refuses(
    'a recording longer than the recognizer takes is refused in seconds someone can act on',
    () => hearAzure(wav(75), 'he', { fetchImpl: long.impl, config: ENV_CREDS }),
    /75 seconds.*shorter go/s,
  );
  ok(
    long.calls.length === 0,
    'and refused before the upload, not after a minute of waiting for Azure to say it',
  );

  await refuses(
    'silence names the language, because the usual cause is the wrong one being picked',
    () => hearAzure(wav(2), 'he', {
      fetchImpl: fakeAzure({ body: { RecognitionStatus: 'NoMatch' } }).impl,
      config: ENV_CREDS,
    }),
    /no he-IL speech detected/,
  );
  await refuses(
    'so does a recording that never started',
    () => hearAzure(wav(2), 'he', {
      fetchImpl: fakeAzure({ body: { RecognitionStatus: 'InitialSilenceTimeout' } }).impl,
      config: ENV_CREDS,
    }),
    /no he-IL speech detected/,
  );
  await refuses(
    'any other recognition status is reported as itself rather than guessed at',
    () => hearAzure(wav(2), 'he', {
      fetchImpl: fakeAzure({ body: { RecognitionStatus: 'Error' } }).impl,
      config: ENV_CREDS,
    }),
    /\(Error\)/,
  );
  await refuses(
    'an empty result is "no speech", not an empty message box',
    () => hearAzure(wav(2), 'he', {
      fetchImpl: fakeAzure({ body: { RecognitionStatus: 'Success', DisplayText: '' } }).impl,
      config: ENV_CREDS,
    }),
    /no speech detected/,
  );
  await refuses(
    'an HTML error page is not mistaken for a transcript',
    () => hearAzure(wav(2), 'he', {
      fetchImpl: fakeAzure({ body: '<html>gateway</html>' }).impl,
      config: ENV_CREDS,
    }),
    /not JSON/,
  );
  await refuses(
    'the quota message reaches dictation too, in the same words',
    () => hearAzure(wav(2), 'he', {
      fetchImpl: fakeAzure({ status: 429, body: '' }).impl,
      config: ENV_CREDS,
    }),
    /Nothing is charged/,
  );

  section('A fresh deployment, which has none of this:');
  ok((await azureSpeech()) === null, 'there are no credentials, and that is not an error');
  ok((await azureSpeechConfigured()) === false, 'so nothing claims a Hebrew voice exists');
  resetAzureSpeech();
  ok((await azureSpeech()) === null, 'and asking again after a reset says the same');

  const status = await azureSpeechStatus();
  ok(status.configured === false, 'the status says so plainly');
  ok(status.voices.length === 0, 'and offers no voice it cannot actually speak in');
  ok(status.region === null, 'with no region to show');
  ok(/speechKey/.test(status.reason || ''), 'the reason names the field that is missing');
  ok(/voice-status\?refresh=1/.test(status.reason || ''), 'and how to pick it up once set');
  ok(/free/.test(status.tier) && /429/.test(status.tier), 'the tier is described, including its ceiling');

  const noCreds = fakeAzure();
  await refuses(
    'reading aloud says there is no voice here rather than failing obscurely',
    () => speakAzure('שלום', 'he-IL-HilaNeural', { fetchImpl: noCreds.impl }),
    /no Azure Speech credentials/,
    503,
  );
  ok(noCreds.calls.length === 0, 'and reaches for the network not at all');
  await refuses(
    'and so does dictation',
    () => hearAzure(wav(1), 'he', { fetchImpl: noCreds.impl }),
    /no Azure Speech credentials/,
  );
}

if (MODE === 'env') {
  console.log('Azure Speech, with credentials in the environment:');

  section('Credentials from the environment, which is how a laptop runs this:');
  const config = await azureSpeech();
  ok(config?.key === ENV_CREDS.key, 'AZURE_SPEECH_KEY is read');
  ok(config?.region === ENV_CREDS.region, 'and AZURE_SPEECH_REGION with it');
  ok(await azureSpeechConfigured(), 'so the box reports a Hebrew voice');
  ok((await azureSpeech()) === config, 'the lookup is cached rather than repeated per request');
  resetAzureSpeech();
  ok((await azureSpeech())?.key === ENV_CREDS.key, 'and a reset re-reads rather than forgetting');

  section('The status, which is served to a browser:');
  const status = await azureSpeechStatus();
  ok(status.configured === true, 'it says the voice is available');
  ok(status.region === ENV_CREDS.region, 'and which region it speaks from');
  ok(status.voices.length === 2, 'and offers both Hebrew voices');
  ok(status.reason === null, 'with nothing to explain');
  ok(
    !JSON.stringify(status).includes(ENV_CREDS.key),
    'and the key is not in it — this is a public answer',
  );
  status.voices[0].id = 'mutated';
  ok(
    (await azureSpeechStatus()).voices[0].id === 'Hila',
    'the voice list is copied, so a caller cannot edit the module out from under the next one',
  );

  section('And the environment credentials actually reach the wire:');
  const tts = fakeAzure({ audio: 'ok' });
  await speakAzure('שלום', 'he-IL-AvriNeural', { fetchImpl: tts.impl });
  ok(
    tts.calls[0].url.includes(`https://${ENV_CREDS.region}.tts.`),
    'the region from the environment is the host that is called',
    tts.calls[0].url,
  );
  ok(
    tts.calls[0].headers['Ocp-Apim-Subscription-Key'] === ENV_CREDS.key,
    'with no config argument needed at the call site',
  );
}

console.log(`\n${checks - failures}/${checks} checks passed`);

if (MODE === 'bare') {
  /*
   * The second pass. `azureSpeech` reads `process.env` once, at import, so "there are
   * credentials" and "there are none" cannot both be true in one process — and the
   * one that matters most (a key present, and absent from the status) is the one this
   * box's own secret would have faked for us.
   */
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'env'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      AZURE_SPEECH_KEY: ENV_CREDS.key,
      AZURE_SPEECH_REGION: ENV_CREDS.region,
    },
  });
  process.exit(failures || child.status !== 0 ? 1 : 0);
}

process.exit(failures ? 1 : 0);
