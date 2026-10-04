// The target nouns of an English sentence (SPEC_dopa v3.18 §5.6 step 6; ED D-98, D-161).
// kuromoji's tokens say nothing of English words, so an English part-of-speech tagger
// (compromise, loaded by the worker) gives each word its tags, and the rules here pick the
// targets: every noun except pronouns and numerals (as D-62 and D-64 do for Japanese), and nouns
// next to each other as one target (as D-79). Pure: the tagger is passed in, so the rules are
// tested with node on words tagged by hand.

// Pronouns that the tagger tags as plain nouns: not targets either (D-62).
const INDEFINITE_PRONOUNS = new Set([
  "someone",
  "anyone",
  "everyone",
  "somebody",
  "anybody",
  "everybody",
  "nobody",
  "something",
  "anything",
  "everything",
  "nothing",
]);

/**
 * The words of an English text as the rules take them: [{ start, end, tags }], `start` and `end`
 * being the word's place in `speech` and `tags` the tagger's names for it ("Noun", "Pronoun",
 * "Value", …). `nlp` is compromise: `nlp(text).json({ offset: true })` gives the sentences with
 * their terms. A term of no length (the "not" inside don't) is left out.
 */
export function termsOf(nlp, speech) {
  return nlp(speech)
    .json({ offset: true })
    .flatMap((sentence) => sentence.terms)
    .filter((term) => term.offset.length > 0)
    .map((term) => ({
      start: term.offset.start,
      end: term.offset.start + term.offset.length,
      tags: term.tags,
    }));
}

/** Whether a tagged word is a target word on its own. */
function isTargetWord(speech, term) {
  const word = speech.slice(term.start, term.end);
  return (
    term.tags.includes("Noun") &&
    !term.tags.includes("Pronoun") &&
    !term.tags.includes("Value") && // a numeral
    !INDEFINITE_PRONOUNS.has(word.toLowerCase()) &&
    /[A-Za-z]/.test(word)
  );
}

/**
 * The targets of an English sentence, in order, as [{ start, end, text, lang: "en" }]: the same
 * shape as a Japanese target (nouns.js), with `lang` for the shout 「{noun} MISSILE!」. `terms`
 * come from termsOf(). Target words with only spaces between them are one target (New York; the
 * cat's toy).
 */
export function englishTargets(speech, terms) {
  const targets = [];
  let run = null; // the target being gathered: { start, end }
  for (const term of terms) {
    if (!isTargetWord(speech, term)) {
      run = null;
      continue;
    }
    if (run && !speech.slice(run.end, term.start).trim()) run.end = term.end;
    else {
      run = { start: term.start, end: term.end };
      targets.push(run);
    }
  }
  return targets.map(({ start, end }) => ({
    start,
    end,
    text: speech.slice(start, end),
    lang: "en",
  }));
}
