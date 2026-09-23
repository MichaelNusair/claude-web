/**
 * The dictation cleanup pass, and the two ways it could hurt rather than help.
 *
 * It sends somebody's half-finished message to a model and puts the answer back
 * in their composer, so the failures worth testing are not "the punctuation is
 * imperfect". They are:
 *
 *  1. **The model replies instead of editing.** Dictation is usually an
 *     instruction ("delete the old login page"), and a model that obeyed it, or
 *     answered it, or explained what it changed, would put text in the composer
 *     that the user never said. `looksLikeCleanup` is the bound that catches that,
 *     and it is pure, so it is tested directly.
 *  2. **Words go missing.** Speech is frequently the only copy of what was said.
 *     Every failure path has to return the raw transcript, so the test runs
 *     `polish` against a model id that cannot exist and asserts the text survives.
 *
 * Run: node polish-test.js
 */
import { looksLikeCleanup } from './polish.js';

let failures = 0;
let checks = 0;

function check(name, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\nAccepts a cleanup:');
{
  const raw = 'the one last thing that transcription works much much less good '
    + 'compared to Georgia PT and Germany apps for consumers that used to just '
    + 'dictate a message';
  const clean = 'The one last thing: transcription works much, much less well '
    + 'compared to the ChatGPT and Gemini apps for consumers that you use to just '
    + 'dictate a message.';
  check('the real dictation this feature was built for', looksLikeCleanup(raw, clean));
  check('punctuation only', looksLikeCleanup('send it now please', 'Send it now, please.'));
  check(
    'filler removed',
    looksLikeCleanup('um so I think uh we should ship it', 'So I think we should ship it.'),
  );
  check('nothing to change', looksLikeCleanup('Ship it now.', 'Ship it now.'));
}

console.log('\nRejects a model that stopped editing and started talking:');
{
  // The dictated text is an instruction, which is the normal case here.
  const raw = 'delete the old login page and push it';
  check(
    'answering the instruction',
    !looksLikeCleanup(
      raw,
      'I have deleted the old login page and pushed the change to the main branch. '
      + 'Let me know if you would like me to open a pull request as well, or if there '
      + 'is anything else you would like me to take care of in the meantime.',
    ),
  );
  check(
    'explaining itself',
    !looksLikeCleanup(
      'so we should ship it today',
      'Here is the corrected transcript: "So we should ship it today." I added a '
      + 'capital letter at the start and a full stop at the end, and left the '
      + 'wording exactly as dictated.',
    ),
  );
  check(
    'summarising instead of punctuating',
    !looksLikeCleanup(
      'the transcription is much worse than the consumer apps and the names all '
      + 'come out wrong so I would like it fixed before the next release if that '
      + 'is at all possible',
      'The user is unhappy with transcription quality.',
    ),
  );
  check('refusing', !looksLikeCleanup('delete the old login page', 'I cannot help with that.'));
  check('empty answer', !looksLikeCleanup('some words here', ''));
  check('no answer at all', !looksLikeCleanup('some words here', undefined));
}

console.log('\nA short utterance is judged absolutely, not by ratio:');
{
  // "send it" → "Send it." is a 1.0 ratio, but "yes" → a whole sentence is a 5x
  // one, and both are the same handful of words. Only a word bound separates them.
  check('two words punctuated', looksLikeCleanup('send it', 'Send it.'));
  check('two words expanded into a sentence', !looksLikeCleanup('send it', 'Sure, I have sent it for you now.'));
}

console.log('\nNever loses the transcript:');
{
  // A model id that cannot resolve, so the Bedrock call fails however this is run:
  // with credentials it is a validation error, without them a credentials error,
  // and offline a network error. All three must look the same from here.
  process.env.POLISH_MODEL = 'no.such.model-that-could-ever-exist:0';
  process.env.POLISH_TIMEOUT_MS = '4000';
  // Imported after the env is set: the module reads it once, at load.
  const { polish } = await import(`./polish.js?fallback=${Date.now()}`);

  const raw = 'this is what I said out loud and it is the only copy of it';
  const started = Date.now();
  const result = await polish(raw);
  check('a failed call returns the text unchanged', result.text === raw, JSON.stringify(result));
  check('and reports that it changed nothing', result.changed === false);
  check(
    'and does not hang past the timeout',
    Date.now() - started < 8000,
    `took ${Date.now() - started}ms`,
  );

  const blank = await polish('   ');
  check('blank input is not sent anywhere', blank.text === '   ' && blank.changed === false);

  const long = 'word '.repeat(4000);
  const tooLong = await polish(long);
  check('a document-sized input is left alone', tooLong.text === long && !tooLong.changed);

  const missing = await polish(undefined);
  check('no input at all is survivable', missing.text === '' && !missing.changed);

  // The vocabulary option is what carries the project names into the prompt. Its
  // effect is not observable from out here, but a bad shape breaking the call is.
  const withVocab = await polish(raw, { vocabulary: ['triplec', 'bedrock'] });
  check('project names do not break the call', withVocab.text === raw);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
