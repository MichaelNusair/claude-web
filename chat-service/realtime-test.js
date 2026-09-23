/**
 * The spoken conversation, checked without opening one.
 *
 * Almost everything here is about one property: **this thing cannot act.** The
 * feature is a voice channel with no transcript in front of you, discussing a message
 * that describes changes to a repository — so the failure that matters is not a
 * crash, it is a conversation that says "done, I pushed it". Nothing would be pushed;
 * something would be believed. The session is given no tools, so it genuinely
 * cannot, and the instructions say so in words, and the words are the part that can
 * regress silently in an edit. So they are asserted on, the way the auth tests assert
 * on a decision rather than on a log line.
 *
 * The rest is the money and the refusals: that the budget is spent before the call
 * rather than after it, that a failed call is handed back, that an unknown voice from
 * a phone's localStorage does not travel to OpenAI as a 400, and that nothing at all
 * is sent when there is no key or nothing to talk about.
 *
 * `mintSession` takes its `fetch` and its key lookup as arguments, so all of this
 * runs against a fake: no key, no network, no realtime minutes billed.
 *
 * Run: node chat-service/realtime-test.js
 */
import { execFileSync } from 'child_process';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  buildInstructions,
  mintSession,
  realtimeStatus,
  SessionBudget,
  RealtimeError,
  MODEL,
  VOICE,
  VOICES,
  MAX_MINUTES,
} from './realtime.js';

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

const refuses = async (name, status, fn, matching = null) => {
  try {
    await fn();
    ok(false, name, 'nothing was refused');
  } catch (err) {
    const right = err instanceof RealtimeError && err.status === status
      && (!matching || matching.test(err.message));
    ok(right, name, `got ${err?.name} ${err?.status}: ${err?.message}`);
  }
};

/** OpenAI's minting endpoint, without OpenAI. Records what it was asked for. */
const fakeOpenAi = ({ status = 200, body = null } = {}) => {
  const calls = [];
  return {
    calls,
    get last() {
      return calls[calls.length - 1];
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body ?? {
          value: 'ek_testtesttest',
          expires_at: 1_777_000_000,
          session: { id: 'sess_abc', model: MODEL, audio: { output: { voice: 'marin' } } },
        },
        text: async () => JSON.stringify({ error: { message: 'no' } }),
      };
    },
  };
};

const key = async () => 'sk-test-not-a-real-key';
const noKey = async () => null;
const noAzure = async () => null;

const MESSAGE = [
  'Done. The auth gap is closed.',
  'The check now runs in auth.js, lines 42 to 51, inside the application process.',
  'Tests pass: 106 checks. Do you want me to push it?',
].join(' ');
const PROMPT = 'Have a look at why /api/auth-check answers 204 for a request with no cookie.';

// --------------------------------------------------------------------------
section('What the model is told it is:');
{
  const said = buildInstructions({ text: MESSAGE, prompt: PROMPT });

  ok(said.includes(MESSAGE), 'the message it is there to discuss is in the prompt');
  ok(said.includes(PROMPT), 'and the prompt that produced it, which is the context asked for');

  // The boundary, in words. Each of these is a sentence a future edit could drop
  // without anything failing, which is exactly why they are checked.
  ok(/not Claude/i.test(said), 'it is told it is not Claude');
  ok(/cannot\b[\s\S]{0,80}run commands/i.test(said), 'and that it cannot run commands', said.match(/cannot[^.]*/i)?.[0]);
  ok(/edit files/i.test(said) && /push/i.test(said) && /deploy/i.test(said), 'nor edit, push or deploy');
  ok(/no tools/i.test(said), 'and that it has no tools at all');
  ok(/say it to Claude/i.test(said), 'and is told what to say instead: take it back to Claude');
  ok(
    /Never\s+imply that you have done something/i.test(said),
    'and told not to claim it has done something, which is the failure that would be believed',
  );
  ok(/nothing said here\s*\n?reaches Claude/i.test(said), 'it is told the channel is one-way');

  // The shape of the conversation. Long turns are the difference between a
  // discussion and a podcast you cannot interrupt.
  ok(/interrupt/i.test(said), 'it is told it can be interrupted and to stop when it is');
  ok(/two or three sentences/i.test(said), 'and to take short turns');
  ok(said.includes(String(MAX_MINUTES)), 'it knows how long it has', `${MAX_MINUTES} minutes`);

  // The message is generated text going into a system prompt. Not hostile here — it
  // is the caller's own conversation — but labelled rather than trusted.
  ok(
    /not instructions to follow/i.test(said),
    'the message is labelled as material to discuss rather than as instructions',
  );
  ok(said.includes('"""'), 'and delimited, so where it starts and ends is not a guess');
}

{
  // No prompt is the normal case for an older message, and an empty quote block
  // invites the model to invent what was in it.
  const alone = buildInstructions({ text: MESSAGE });
  ok(/not provided/i.test(alone), 'a message with no prompt says so rather than quoting nothing');
  ok(alone.includes(MESSAGE), 'and is still discussed');
}

{
  // Language. A Hebrew message discussed in English is not what anyone wanted, and
  // this is stated rather than inferred because these models follow it far better.
  const hebrew = Array.from({ length: 30 }, (_, i) => String.fromCodePoint(0x05d0 + (i % 27))).join('');
  const heb = buildInstructions({ text: `${hebrew} auth.js ${hebrew}` });
  ok(/Speak Hebrew/.test(heb), 'a Hebrew message is discussed in Hebrew');
  const eng = buildInstructions({ text: MESSAGE });
  ok(!/Speak Hebrew/.test(eng), 'an English one is not');
  ok(/defaulting to English/.test(eng), 'and follows whoever is talking to it', eng.match(/Speak the language[^.]*/)?.[0]);
  ok(
    /Speak Hebrew/.test(buildInstructions({ text: MESSAGE, lang: 'he-IL' })),
    "a phone set to Hebrew gets Hebrew even when the message it is about is not",
  );
}

{
  // A whole file pasted into a message must not become a whole file in every
  // session's prompt: that is paid for per token at realtime rates.
  const huge = `Here is the file:\n${'const x = 1;\n'.repeat(4000)}`;
  const clipped = buildInstructions({ text: huge });
  ok(clipped.length < huge.length / 2, 'a huge message is clipped, not sent whole', `${huge.length} -> ${clipped.length}`);
  ok(/truncated/.test(clipped), 'and says it was clipped, so the model does not treat it as the end');
  const longPrompt = buildInstructions({ text: MESSAGE, prompt: 'x '.repeat(4000) });
  ok(longPrompt.length < 20_000, 'and so is an over-long prompt', `${longPrompt.length}`);
}

// --------------------------------------------------------------------------
section('Sessions per day, which is the only real bound:');
{
  let now = Date.parse('2026-09-21T22:00:00Z');
  const sessions = new SessionBudget({ dailySessions: 2, now: () => now });

  ok(sessions.state().sessions === 0 && sessions.state().limit === 2, 'a fresh day has none spent');
  sessions.reserve();
  sessions.reserve();
  ok(sessions.state().sessions === 2, 'each conversation is counted', JSON.stringify(sessions.state()));

  let over = null;
  try {
    sessions.reserve();
  } catch (err) {
    over = err;
  }
  ok(over?.status === 429, 'the day’s limit is refused', `got ${over?.status}`);
  ok(/REALTIME_DAILY_SESSIONS/.test(over?.message || ''), 'and the refusal names the knob', `got: ${over?.message}`);

  sessions.refund();
  ok(sessions.state().sessions === 1, 'a conversation that never opened is handed back');

  now = Date.parse('2026-09-22T00:30:00Z');
  ok(
    sessions.state().sessions === 0 && sessions.state().day === '2026-09-22',
    'and the count resets overnight',
    JSON.stringify(sessions.state()),
  );
}

// --------------------------------------------------------------------------
section('Minting a credential:');
{
  /*
   * An OpenAI-only box, said rather than assumed. `azureFor` defaults to the real
   * one, which reads the environment *and* the voice secret — so on a box that has
   * Azure configured (this one, and production) Azure wins the provider choice and
   * every assertion below about OpenAI's endpoint, key and body shape is answered by
   * a request that was never made. These checks are about the OpenAI path; they have
   * to pin the provider to keep being about it.
   */
  const api = fakeOpenAi();
  const sessions = new SessionBudget({ dailySessions: 5 });
  const minted = await mintSession(
    { text: MESSAGE, prompt: PROMPT, voice: 'cedar' },
    { fetchImpl: api.fetchImpl, keyFor: key, azureFor: noAzure, sessions },
  );

  ok(minted.value === 'ek_testtesttest', 'the browser gets the ephemeral secret');
  ok(minted.maxMinutes === MAX_MINUTES, 'and is told when to hang up, so the two halves agree');
  ok(minted.budget.sessions === 1, 'and what the day has spent', JSON.stringify(minted.budget));

  const sent = api.last.body;
  ok(api.last.url.endsWith('/v1/realtime/client_secrets'), 'minted at the client-secrets endpoint', api.last.url);
  ok(api.last.init.headers.Authorization === 'Bearer sk-test-not-a-real-key', 'with the real key, which stays on this box');
  ok(!JSON.stringify(sent).includes('sk-test'), 'and the real key is not in the body');

  ok(sent.session.type === 'realtime' && sent.session.model === MODEL, 'for a realtime session on the configured model');
  ok(sent.session.instructions.includes(MESSAGE), 'seeded with the message');

  /*
   * The disconnection, as a property of the request rather than of the prose: no
   * tools, and no way to add one from the client. A future edit that passed a tool
   * list through from the request body would make every sentence in the
   * instructions a lie, and nothing else here would fail.
   */
  ok(sent.session.tools === undefined, 'with no tools, so it cannot act even if it is asked to');
  ok(sent.session.tool_choice === undefined, 'and nothing that would let it pick one');

  ok(sent.session.output_modalities.join() === 'audio', 'audio out');
  ok(sent.session.max_output_tokens > 0, 'with one reply capped, so a recital is not a bill');
  ok(sent.session.audio.input.turn_detection.type === 'semantic_vad', 'turn-taking by meaning, not by silence');
  ok(
    sent.session.audio.input.turn_detection.interrupt_response === true,
    'and it can be cut off mid-sentence, which is what makes it a conversation',
  );
  ok(sent.session.audio.input.transcription?.model, 'what it heard is transcribed, so the channel is auditable');

  // Short-lived: the credential leaves this box, so its window is the exposure.
  ok(
    sent.expires_after.anchor === 'created_at' && sent.expires_after.seconds <= 300,
    'the secret expires in minutes, not the ten OpenAI defaults to',
    JSON.stringify(sent.expires_after),
  );

  ok(sent.session.audio.output.voice === 'cedar', 'the voice asked for is used');

  // A phone remembers a voice name in localStorage. A Polly name, or a retired one,
  // must not travel to OpenAI — that is a 400 and a conversation that never opens.
  const api2 = fakeOpenAi();
  await mintSession(
    { text: MESSAGE, voice: 'Ruth' },
    { fetchImpl: api2.fetchImpl, keyFor: key, azureFor: noAzure, sessions },
  );
  ok(api2.last.body.session.audio.output.voice === VOICE, 'an unknown voice becomes the default rather than a 400', api2.last.body.session.audio.output.voice);
  ok(VOICES.includes(VOICE), 'and the default is one the realtime models accept');
}

// --------------------------------------------------------------------------
section('Refusing, before anything is spent:');
{
  const sessions = new SessionBudget({ dailySessions: 5 });

  const quiet = fakeOpenAi();
  await refuses('nothing to talk about is a 400', 400, () =>
    mintSession({ text: '   ' }, { fetchImpl: quiet.fetchImpl, keyFor: key, azureFor: noAzure, sessions }));
  ok(quiet.calls.length === 0, 'and OpenAI was never called, so it cost nothing');
  ok(sessions.state().sessions === 0, 'and the day was not charged');

  const keyless = fakeOpenAi();
  await refuses(
    'a box with no key says so, with what to do about it',
    503,
    () => mintSession({ text: MESSAGE }, { fetchImpl: keyless.fetchImpl, keyFor: noKey, azureFor: noAzure, sessions }),
    /openaiApiKey/,
  );
  ok(keyless.calls.length === 0, 'and does not call OpenAI without one');

  // The budget must stop the call, not merely notice it afterwards.
  const spent = new SessionBudget({ dailySessions: 1 });
  const once = fakeOpenAi();
  await mintSession({ text: MESSAGE }, { fetchImpl: once.fetchImpl, keyFor: key, azureFor: noAzure, sessions: spent });
  await refuses('the day’s limit refuses the next one', 429, () =>
    mintSession({ text: MESSAGE }, { fetchImpl: once.fetchImpl, keyFor: key, azureFor: noAzure, sessions: spent }));
  ok(once.calls.length === 1, 'and refuses it before the call, not after', `${once.calls.length} calls made`);

  // OpenAI's own statuses, remapped: a 401 travelling through as a 401 would read
  // to the client as its own login expiring.
  const rejected = fakeOpenAi({ status: 401 });
  const fresh = new SessionBudget({ dailySessions: 5 });
  await refuses('a rejected key is not answered as a 401', 403, () =>
    mintSession({ text: MESSAGE }, { fetchImpl: rejected.fetchImpl, keyFor: key, azureFor: noAzure, sessions: fresh }), /key/i);
  ok(fresh.state().sessions === 0, 'and a failed mint is refunded, so a bad key cannot eat the day');

  const throttled = fakeOpenAi({ status: 429 });
  await refuses('OpenAI throttling stays a 429', 429, () =>
    mintSession({ text: MESSAGE }, { fetchImpl: throttled.fetchImpl, keyFor: key, azureFor: noAzure, sessions: fresh }));

  const broken = fakeOpenAi({ status: 503 });
  await refuses('OpenAI failing is a 502 from here', 502, () =>
    mintSession({ text: MESSAGE }, { fetchImpl: broken.fetchImpl, keyFor: key, azureFor: noAzure, sessions: fresh }));

  const empty = fakeOpenAi({ body: { expires_at: 1 } });
  await refuses('a response with no secret in it is a 502, not an undefined handed to a browser', 502, () =>
    mintSession({ text: MESSAGE }, { fetchImpl: empty.fetchImpl, keyFor: key, azureFor: noAzure, sessions: fresh }));
  ok(fresh.state().sessions === 0, 'and none of those were charged', JSON.stringify(fresh.state()));

  const dead = {
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND api.openai.com');
    },
  };
  await refuses('an unreachable OpenAI is a 502 with the reason in it', 502, () =>
    mintSession({ text: MESSAGE }, { fetchImpl: dead.fetchImpl, keyFor: key, azureFor: noAzure, sessions: fresh }), /ENOTFOUND/);
}

// --------------------------------------------------------------------------
section('What the client is told before it offers the button:');
{
  const sessions = new SessionBudget({ dailySessions: 7 });
  // `azureFor` is passed explicitly everywhere below, not left to default: the real
  // one reads the environment, and a machine that happens to have AZURE_REALTIME_*
  // set would otherwise flip these answers.
  const off = await realtimeStatus({ keyFor: noKey, azureFor: noAzure, sessions });
  ok(off.configured === false, 'a box with no key cannot hold a conversation');
  ok(/openaiApiKey/.test(off.reason || ''), 'and says how to change that', `got: ${off.reason}`);

  const on = await realtimeStatus({ keyFor: key, azureFor: noAzure, sessions });
  ok(on.configured === true && on.reason === null, 'a box with one can');
  ok(on.model === MODEL && on.voice === VOICE, 'and names the model and voice it would use');
  ok(on.budget.limit === 7, 'and what the day allows', JSON.stringify(on.budget));
  ok(on.maxMinutes === MAX_MINUTES, 'and how long a conversation lasts');
}

// --------------------------------------------------------------------------
/*
 * Two routes to the same models, and why the choice is not cosmetic.
 *
 * Realtime audio is billed per audio token either way. The difference is what
 * happens when the money runs out: an OpenAI account bills a card unless someone
 * remembered to turn auto-recharge off, while an Azure sponsorship has no card
 * behind it and simply stops. So Azure wins when both are configured, and that
 * preference is a tested property rather than a comment — a later edit that reorders
 * those two branches would move real spending onto a credit card silently.
 *
 * The rest of this section pins the four things that actually differ between the
 * providers, because each of them is a way for the Azure path to break while every
 * OpenAI test stays green: the URL, the header the key travels in, what `model`
 * means, and the vocabulary a refusal is explained in.
 */
section('Which vendor, and on whose money:');
{
  const AZURE = {
    endpoint: 'https://claudeweb-realtime-6f2a9c.openai.azure.com',
    key: 'azure-key-not-a-real-one',
    deployment: 'gpt-realtime-mini',
  };
  const azure = async () => AZURE;

  {
    const fake = fakeOpenAi();
    const minted = await mintSession(
      { text: MESSAGE, prompt: PROMPT },
      { fetchImpl: fake.fetchImpl, keyFor: key, azureFor: azure, sessions: new SessionBudget() },
    );
    ok(
      fake.last.url === `${AZURE.endpoint}/openai/v1/realtime/client_secrets`,
      'with both configured the credential is minted on Azure, which cannot reach a card',
      fake.last.url,
    );
    ok(
      fake.last.init.headers['api-key'] === AZURE.key,
      'and the key travels in api-key, which is the only header Azure reads',
    );
    ok(
      !('Authorization' in fake.last.init.headers),
      'and not as a bearer token, which Azure would ignore and OpenAI would accept',
      JSON.stringify(Object.keys(fake.last.init.headers)),
    );
    ok(
      fake.last.body.session.model === AZURE.deployment,
      'the model field carries the deployment name, which is what Azure means by model',
      fake.last.body.session.model,
    );
    ok(
      minted.callUrl === `${AZURE.endpoint}/openai/v1/realtime/calls`,
      'the browser is told to send its offer to the Azure resource',
      minted.callUrl,
    );
    ok(
      !minted.callUrl.includes('?'),
      'with no ?model= query, which Azure ignores — the minted secret fixes the deployment',
    );
    ok(minted.provider === 'azure', 'and the answer says which vendor is in use');
    ok(
      !JSON.stringify(minted).includes(AZURE.key),
      'and the resource key is not in the answer the browser gets',
    );
  }

  {
    const fake = fakeOpenAi();
    process.env.REALTIME_PROVIDER = 'openai';
    const minted = await mintSession(
      { text: MESSAGE, prompt: PROMPT },
      { fetchImpl: fake.fetchImpl, keyFor: key, azureFor: azure, sessions: new SessionBudget() },
    );
    delete process.env.REALTIME_PROVIDER;
    ok(
      fake.last.url === 'https://api.openai.com/v1/realtime/client_secrets',
      'REALTIME_PROVIDER=openai overrides the preference, for a box that wants the flagship',
      fake.last.url,
    );
    ok(
      fake.last.init.headers.Authorization === 'Bearer sk-test-not-a-real-key',
      'and the key goes back to being a bearer token',
    );
    ok(
      minted.callUrl === `https://api.openai.com/v1/realtime/calls?model=${MODEL}`,
      'and the offer goes to OpenAI, with the model in the query where they want it',
      minted.callUrl,
    );
    ok(minted.provider === 'openai', 'and the answer names OpenAI');
  }

  {
    process.env.REALTIME_PROVIDER = 'azure';
    await refuses(
      'REALTIME_PROVIDER=azure with no Azure resource refuses rather than quietly billing OpenAI',
      503,
      () => mintSession(
        { text: MESSAGE },
        { fetchImpl: fakeOpenAi().fetchImpl, keyFor: key, azureFor: noAzure,
          sessions: new SessionBudget() },
      ),
    );
    delete process.env.REALTIME_PROVIDER;
  }

  {
    const fake = fakeOpenAi();
    await refuses(
      'a box with neither refuses',
      503,
      () => mintSession(
        { text: MESSAGE },
        { fetchImpl: fake.fetchImpl, keyFor: noKey, azureFor: noAzure,
          sessions: new SessionBudget() },
      ),
      /azureRealtimeEndpoint[\s\S]*openaiApiKey|openaiApiKey[\s\S]*azureRealtimeEndpoint/,
    );
    ok(fake.calls.length === 0, 'and sends nothing anywhere');
  }

  {
    // The claim that made this a small change instead of a second implementation:
    // the mint body is the same for both vendors. Verified against a live Azure
    // resource down to `expires_after` and the transcription model. An OpenAI-only
    // field added to that body later would 400 on Azure and nowhere else.
    const openaiSide = fakeOpenAi();
    process.env.REALTIME_PROVIDER = 'openai';
    await mintSession({ text: MESSAGE, prompt: PROMPT, voice: 'cedar' },
      { fetchImpl: openaiSide.fetchImpl, keyFor: key, azureFor: azure,
        sessions: new SessionBudget() });
    delete process.env.REALTIME_PROVIDER;

    const azureSide = fakeOpenAi();
    await mintSession({ text: MESSAGE, prompt: PROMPT, voice: 'cedar' },
      { fetchImpl: azureSide.fetchImpl, keyFor: key, azureFor: azure,
        sessions: new SessionBudget() });

    const strip = (body) => JSON.stringify({ ...body, session: { ...body.session, model: '' } });
    ok(
      strip(openaiSide.last.body) === strip(azureSide.last.body),
      'the session sent to Azure is the same one sent to OpenAI, model name aside',
    );
    ok(
      azureSide.last.body.session.audio.input.transcription.model === 'gpt-4o-transcribe',
      'including the input transcription, which Azure accepts without its own deployment',
    );
    ok(
      azureSide.last.body.expires_after.seconds === 120,
      'and the two-minute expiry, which Azure honours',
    );
  }

  {
    // A refusal has to name the field an operator should go and look at. Sending
    // someone to `openaiApiKey` when the deployment name is wrong is worse than
    // giving them the bare status code.
    const fake = fakeOpenAi({ status: 404 });
    await refuses(
      'a 404 from Azure talks about the deployment, not the model',
      403,
      () => mintSession(
        { text: MESSAGE },
        { fetchImpl: fake.fetchImpl, keyFor: key, azureFor: azure,
          sessions: new SessionBudget() },
      ),
      /deployment/,
    );

    const denied = fakeOpenAi({ status: 401 });
    await refuses(
      'and a 401 names azureRealtimeKey rather than openaiApiKey',
      403,
      () => mintSession(
        { text: MESSAGE },
        { fetchImpl: denied.fetchImpl, keyFor: key, azureFor: azure,
          sessions: new SessionBudget() },
      ),
      /azureRealtimeKey/,
    );

    const overQuota = fakeOpenAi({ status: 429 });
    await refuses(
      'and a 429 says it may be the quota rather than the balance, because on Azure it is',
      429,
      () => mintSession(
        { text: MESSAGE },
        { fetchImpl: overQuota.fetchImpl, keyFor: key, azureFor: azure,
          sessions: new SessionBudget() },
      ),
      /quota/,
    );
  }

  {
    const sessions = new SessionBudget({ dailySessions: 3 });
    const status = await realtimeStatus({ keyFor: noKey, azureFor: azure, sessions });
    ok(status.configured === true, 'a box with only Azure can hold a conversation');
    ok(status.provider === 'azure', 'and says so');
    ok(
      status.model === AZURE.deployment,
      'and names the deployment it would use, not the model default',
      status.model,
    );
    const neither = await realtimeStatus({ keyFor: noKey, azureFor: noAzure, sessions });
    ok(neither.provider === null, 'a box with neither names no provider');
    ok(
      /azureRealtimeDeployment/.test(neither.reason || ''),
      'and its reason lists all three Azure fields, since two of three is the common mistake',
      neither.reason,
    );
  }
}

// --------------------------------------------------------------------------
/*
 * The credential shape, which is the only thing standing between a key in a secret
 * and a key in a log. `azureRealtime` refuses anything it cannot use rather than
 * half-configuring itself, because the failure of a half-configured resource is a
 * 404 at mint time, ten minutes of walking later, with nothing to point at.
 */
section('What counts as a configured Azure resource:');
{
  /*
   * In a child process with no secret ARN in its environment, because `azureRealtime`
   * falls back to the voice secret when the environment does not describe a resource.
   * On a box that has that secret — this one, and production — every "…is refused"
   * below would be answered by the real credential instead: the refusal it asserts
   * would have happened, then been overwritten by a resource, and the check would
   * fail while the code was right. Unsetting it in-process is not enough; the module
   * reads the ARN once, at import.
   */
  const shaped = (endpoint, keyValue, deployment) => {
    const env = { ...process.env };
    delete env.OPENAI_SECRET_ARN;
    delete env.WHISPER_SECRET_ARN;
    for (const [name, value] of [
      ['AZURE_REALTIME_ENDPOINT', endpoint],
      ['AZURE_REALTIME_KEY', keyValue],
      ['AZURE_REALTIME_DEPLOYMENT', deployment],
    ]) {
      if (value === null) delete env[name];
      else env[name] = value;
    }
    return execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { azureRealtime } from './openai.js';" +
          'const r = await azureRealtime();' +
          "process.stdout.write(r ? r.endpoint : '');",
      ],
      { cwd: new URL('.', import.meta.url).pathname, env, encoding: 'utf8' },
    ).trim();
  };

  const GOOD = 'https://res.openai.azure.com';
  const REFUSED = '';
  ok(shaped(GOOD, 'k', 'dep') === GOOD, 'all three present is a resource', shaped(GOOD, 'k', 'dep'));
  ok(
    shaped(`${GOOD}/`, 'k', 'dep') === GOOD,
    'a trailing slash is trimmed, so the appended path cannot become a double slash',
  );
  ok(
    shaped('http://res.openai.azure.com', 'k', 'dep') === REFUSED,
    'http is refused outright rather than sending the key in clear',
  );
  ok(
    shaped(`${GOOD}/openai/v1`, 'k', 'dep') === REFUSED,
    'and so is an endpoint with a path, which would silently build the wrong URL',
  );
  ok(shaped(GOOD, 'k', null) === REFUSED, 'a missing deployment is not configured');
  ok(shaped(GOOD, null, 'dep') === REFUSED, 'nor is a missing key');
  ok(shaped(null, 'k', 'dep') === REFUSED, 'nor is a missing endpoint');
  ok(shaped(GOOD, '   ', 'dep') === REFUSED, 'nor is a key of spaces');

  /*
   * And the fallback itself, which the checks above deliberately switch off: a box
   * with nothing in its environment and nothing to read must come back with no
   * resource rather than throwing, since `realtimeStatus` calls this on every page
   * load.
   */
  ok(shaped(null, null, null) === REFUSED, 'a box with neither environment nor secret has no resource');
}

// --------------------------------------------------------------------------
/*
 * The disconnection as a property of the file, not of its prose.
 *
 * Everything above checks what the model is *told*. This checks that the module
 * could not act even if the instructions were deleted: it imports nothing that can
 * reach the Claude session, spawn a process or write to a transcript. A single
 * `import { SessionManager }` added here in a later change would pass every other
 * check in this file.
 */
section('It could not act even if it wanted to:');
{
  const here = dirname(fileURLToPath(import.meta.url));
  const source = await readFile(join(here, 'realtime.js'), 'utf8');
  const imports = [...source.matchAll(/^import[\s\S]*?from '([^']+)';/gm)].map((m) => m[1]);

  ok(imports.length > 0, 'the module was read', imports.join(', '));
  ok(
    imports.every((m) => ['./openai.js', './speak.js'].includes(m)),
    'it imports only the key and the Hebrew test — nothing that can reach a session',
    imports.join(', '),
  );
  for (const forbidden of ['session-manager', 'child_process', 'spawn(', 'exec(', 'writeFile']) {
    ok(!source.includes(forbidden), `and never mentions ${forbidden}`);
  }
  ok(
    !/console\.log\([^)]*value/.test(source),
    'and does not log the secret it mints',
  );
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
