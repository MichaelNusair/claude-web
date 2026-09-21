/**
 * Which model hears you, checked without speaking to any of them.
 *
 * One branch in this file matters more than everything else in it: a request that
 * says it is not English must never reach the local model. `ggml-base.en.bin` given
 * Hebrew speech does not fail — it returns a fluent English sentence that nobody
 * said, and that sentence then lands in the box where a prompt is typed. There is no
 * status code, no warning and nothing in the logs. A refusal is strictly better, and
 * the only way to know a refusal is still there is to ask for one.
 *
 * The mirror of it matters nearly as much and is easier to break by accident: English
 * must keep going to the free local model. Dictation on this box has been free since
 * it was built, and "add a hosted backend" is one careless line away from routing
 * every existing English recording through a metered third party, which nobody would
 * notice until a bill or a privacy conversation.
 *
 * It runs in two passes, in two processes, because which backends exist is decided
 * when the module is imported and a key cannot be un-imported: first a box with
 * nothing on it, then — spawned from here with a key in the environment and `fetch`
 * replaced — a box with OpenAI. No whisper is run, no network is touched, and no
 * audio is transcribed by anyone.
 *
 * Run: node chat-service/transcribe-test.js
 */
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

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

/** `local` is a box with no backend at all; `hosted` is the same box with a key. */
const MODE = process.argv[2] === 'hosted' ? 'hosted' : 'local';

// Arranged before the import, because the paths and the secret ARN are read once at
// module load: no local binary, no Azure secret. The model's *name* is still the real
// one, because the refusal quotes it and the `.en` in it is the entire reason this
// routing exists — and in the hosted pass it is what English must still fall back to.
process.env.WHISPER_BIN = '/nonexistent/whisper-cli';
process.env.WHISPER_MODEL = '/nonexistent/models/ggml-base.en.bin';
delete process.env.WHISPER_SECRET_ARN;
delete process.env.OPENAI_SECRET_ARN;
if (MODE === 'local') delete process.env.OPENAI_API_KEY;

const FAKE_KEY = 'sk-test-not-a-real-key';

/**
 * OpenAI's transcription endpoint, without OpenAI. Records the form it was handed,
 * which is where the `language` field either is or is not.
 */
const api = { calls: [], reply: { status: 200, text: '  a sentence someone said \n' } };
const lastCall = () => api.calls[api.calls.length - 1];
if (MODE === 'hosted') {
  globalThis.fetch = async (url, init) => {
    api.calls.push({ url: String(url), init, form: init?.body });
    return {
      ok: api.reply.status >= 200 && api.reply.status < 300,
      status: api.reply.status,
      text: async () => api.reply.text,
    };
  };
}

const { transcribe, spokenLanguage, voiceStatus } = await import('./transcribe.js');

/** A multipart body shaped like the one the mic button sends. */
const upload = (audio = Buffer.from('not really audio')) => {
  const boundary = '----claudewebtest';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="a.wav"\r\n` +
      'Content-Type: audio/wav\r\n\r\n',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, audio, tail]),
    type: `multipart/form-data; boundary=${boundary}`,
    bytes: audio.length,
  };
};

const rejects = async (name, matching, fn) => {
  try {
    const got = await fn();
    ok(false, name, `nothing was refused; got ${JSON.stringify(got).slice(0, 120)}`);
  } catch (err) {
    ok(matching.test(err?.message || ''), name, `got: ${err?.message}`);
  }
};

if (MODE === 'local') {
  console.log('A box with no dictation backend installed:');

  // ------------------------------------------------------------------------
  section('What language a request is asking for:');
  {
    ok(
      spokenLanguage('').english && spokenLanguage('').code === 'en',
      'nothing means English, which is what every existing client sends',
    );
    ok(spokenLanguage(null).english, 'and so does a missing value');
    ok(spokenLanguage('en').english && spokenLanguage('en-US').english, 'en and en-US are English');
    ok(spokenLanguage('EN-GB').english, 'and the case it arrives in does not matter');

    const he = spokenLanguage('he-IL');
    ok(!he.english && he.code === 'he', 'he-IL is Hebrew, reduced to the two letters a model wants', JSON.stringify(he));
    ok(spokenLanguage('he').code === 'he', 'and so is a bare he');
    ok(
      !spokenLanguage('ru').english && !spokenLanguage('ar').english,
      'Hebrew is not special-cased: any other language routes the same way',
    );

    // A phone sending junk must not become a `language=` parameter that OpenAI 400s
    // on, and must not become a non-English route on a box that only has English.
    ok(spokenLanguage('; DROP TABLE').english, 'something that is not a language code is treated as English');
    ok(spokenLanguage('1234').english, 'and so is a number');
    ok(spokenLanguage('hebrew').code === 'he', 'a long name is cut to its prefix rather than rejected');
  }

  // ------------------------------------------------------------------------
  section('Hebrew is never given to the English-only model:');
  {
    const { body, type } = upload();

    await rejects('a Hebrew dictation with no hosted backend is refused', /hosted model/i, () =>
      transcribe(body, type, { lang: 'he-IL' }));
    await rejects('and the refusal names the model that would have lied to you', /ggml-base\.en\.bin/, () =>
      transcribe(body, type, { lang: 'he' }));
    await rejects('and says what it would have done: English nonsense, not an error', /English nonsense/i, () =>
      transcribe(body, type, { lang: 'he' }));
    await rejects('and says how to fix it', /openaiApiKey/, () => transcribe(body, type, { lang: 'he' }));
    await rejects('any other language is refused the same way', /hosted model/i, () =>
      transcribe(body, type, { lang: 'ru' }));

    await rejects('English gets the refusal it always got', /local whisper is not installed/, () =>
      transcribe(body, type, { lang: 'en' }));
    await rejects('and so does a request that names no language at all', /local whisper is not installed/, () =>
      transcribe(body, type));
  }

  {
    const { body } = upload();
    await rejects('a body that is not multipart is refused before any backend is chosen', /boundary/i, () =>
      transcribe(body, 'application/json', { lang: 'he' }));
    const noAudio = Buffer.from('--x\r\nContent-Disposition: form-data; name="notaudio"\r\n\r\nx\r\n--x--\r\n');
    await rejects('and so is one with no audio part in it', /no "audio" part/, () =>
      transcribe(noAudio, 'multipart/form-data; boundary=x', { lang: 'he' }));
  }

  // ------------------------------------------------------------------------
  section('What the phone is told before it offers a Hebrew mic:');
  {
    const status = await voiceStatus();

    ok(status.languages.english === false, 'a box with nothing installed cannot hear English either', JSON.stringify(status.languages));
    ok(status.languages.other === false, 'and certainly not another language');
    ok(status.languages.via === null, 'with no backend named');
    ok(/English-only/.test(status.languages.reason || ''), 'and a reason that says why', `got: ${status.languages.reason}`);
    ok(/ggml-base\.en\.bin/.test(status.languages.reason || ''), 'naming the model, so an operator can see it for themselves');
    ok(status.local.englishOnly === true, 'the local model is reported as English-only, read from its own filename');
    ok(status.openai.configured === false, 'and no OpenAI backend is claimed without a key');
    ok(
      status.backend === 'none' && status.configured === false,
      'the existing fields still say what they always said',
      JSON.stringify({ backend: status.backend, configured: status.configured }),
    );
  }
} else {
  console.log('The same box, with an OpenAI key in the voice secret:');

  // ------------------------------------------------------------------------
  section('Hebrew, on a box that can hear it:');
  {
    const { body, type, bytes } = upload();
    const heard = await transcribe(body, type, { lang: 'he-IL' });
    ok(heard === 'a sentence someone said', 'what OpenAI heard comes back, trimmed', JSON.stringify(heard));

    const call = lastCall();
    ok(call.url === 'https://api.openai.com/v1/audio/transcriptions', 'sent to the transcription endpoint', call.url);
    ok(call.init.headers.Authorization === `Bearer ${FAKE_KEY}`, 'with the key, from the server, never the browser');
    ok(
      call.form.get('language') === 'he',
      'and told which language to expect, rather than left to detect it',
      String(call.form.get('language')),
    );
    ok(call.form.get('model') === 'gpt-4o-transcribe', 'on a model that hears Hebrew', String(call.form.get('model')));
    ok(call.form.get('response_format') === 'text', 'asking for plain text, since that is all this is for');
    ok(call.form.get('file')?.size === bytes, 'with the audio attached whole', `${call.form.get('file')?.size} of ${bytes}`);
  }

  /*
   * The expensive regression. English dictation worked on this box before any of this
   * existed, for free, without leaving it. A key being present must not change that.
   */
  section('English on the same box does not quietly start costing money:');
  {
    const { body, type } = upload();
    api.calls.length = 0;

    await rejects('English falls back to local, and refuses when local is missing', /local whisper is not installed/, () =>
      transcribe(body, type, { lang: 'en' }));
    await rejects('and so does a request with no language on it', /local whisper is not installed/, () =>
      transcribe(body, type));
    ok(api.calls.length === 0, 'and neither one was sent to OpenAI', `${api.calls.length} calls made`);
  }

  // ------------------------------------------------------------------------
  section('When OpenAI refuses:');
  {
    const { body, type } = upload();

    api.reply = { status: 401, text: JSON.stringify({ error: { message: 'Incorrect API key provided' } }) };
    await rejects('a rejected key names the field to fix and how to reload it', /openaiApiKey/, () =>
      transcribe(body, type, { lang: 'he' }));
    await rejects('and passes on what OpenAI actually said', /Incorrect API key/, () =>
      transcribe(body, type, { lang: 'he' }));

    api.reply = { status: 429, text: '{}' };
    await rejects('throttling or an empty account says which', /rate limiting|out of credit/i, () =>
      transcribe(body, type, { lang: 'he' }));

    api.reply = { status: 500, text: '{}' };
    await rejects('OpenAI failing says to try again', /try again/i, () => transcribe(body, type, { lang: 'he' }));

    // A blank transcript reaching the prompt box as a blank prompt is worse than an
    // error, because it looks like the microphone worked.
    api.reply = { status: 200, text: '   \n' };
    await rejects('silence is not an empty transcript', /no speech detected/, () =>
      transcribe(body, type, { lang: 'he' }));

    api.reply = { status: 200, text: 'ok' };
  }

  // ------------------------------------------------------------------------
  section('A day of uploaded audio:');
  {
    // The pass runs with TRANSCRIBE_OPENAI_DAILY_MB=1, so two of these cross it.
    const big = upload(Buffer.alloc(700_000, 7));
    ok((await transcribe(big.body, big.type, { lang: 'he' })) === 'ok', 'a long recording goes through');

    const before = api.calls.length;
    await rejects('the next one crosses the day’s megabytes', /TRANSCRIBE_OPENAI_DAILY_MB/, () =>
      transcribe(big.body, big.type, { lang: 'he' }));
    await rejects('and the refusal says when it resets', /midnight/i, () =>
      transcribe(big.body, big.type, { lang: 'he' }));
    ok(api.calls.length === before, 'refused before the upload, not after paying for it', `${api.calls.length - before} extra calls`);
  }

  // ------------------------------------------------------------------------
  section('What the phone is told when there is a key:');
  {
    const status = await voiceStatus();

    ok(status.languages.other === true, 'this box can hear a language other than English', JSON.stringify(status.languages));
    ok(status.languages.via === 'openai', 'and says which backend does it');
    ok(status.languages.reason === null, 'with nothing to apologise for');
    ok(status.openai.configured === true, 'the OpenAI backend is reported as configured');
    ok(status.openai.budget.limitMb === 1, 'along with the day’s allowance', JSON.stringify(status.openai.budget));
    ok(status.openai.budget.mb > 0, 'and what has been spent of it', JSON.stringify(status.openai.budget));
    ok(status.local.englishOnly === true, 'and the local model is still English-only, key or no key');

    // The status route is unauthenticated-adjacent and gets logged; the key is the
    // one thing in this module that must never appear in it.
    ok(!JSON.stringify(status).includes(FAKE_KEY), 'and the key itself is nowhere in the answer');
    ok(!JSON.stringify(status).includes('sk-'), 'not even a fragment of it');
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);

if (MODE === 'local') {
  // The second pass, with a key. Spawned rather than imported: `openai.js` reads the
  // environment once, and a box with a key is a different box.
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'hosted'], {
    stdio: 'inherit',
    env: { ...process.env, OPENAI_API_KEY: FAKE_KEY, TRANSCRIBE_OPENAI_DAILY_MB: '1' },
  });
  process.exit(failures || child.status !== 0 ? 1 : 0);
}

process.exit(failures ? 1 : 0);
