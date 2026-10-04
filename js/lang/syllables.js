// The sung syllables of an English sentence (SPEC_dopa §5.8; ED D-168, D-169, A-45). The English
// voice sings a syllable where the Japanese voice sings a mora, so an English sentence gets a
// second score beside its katakana one: the same shape, { pause, morae: [...] }, with a syllable
// in each place. Pure.
//
// A sung syllable is { k, start, end, tails: [], syllable: { onset, nucleus, coda } }: `k` is the
// syllable in IPA ("blaɪnd"), `start` and `end` its characters in the sentence, onset and coda
// lists of consonants. A syllable is sung over two slots, except in a short weak word (the, of): the slot after it holds
// { k: "", held: true, start, end, tails: [] }, which sings nothing itself.
import { ONSETS, phonemesOf } from "./ipa.js";

// Short words that are weak in a sentence, although the dictionary gives them a stress: each of
// their syllables is sung on one slot.
const WEAK_WORDS = new Set(
  (
    "a an the of to in on at by for from with as and or but nor if than that so " +
    "is am are was were be been has have had do does did will would shall should can could may " +
    "might must it its he she we they you me him her us them his their our your my this these " +
    "not no there"
  ).split(" "),
);

const SLOTS_PER_BAR = 8; // as sing/bars.js cuts a long phrase

/**
 * The syllables of a pronunciation in IPA (ipa.js): [{ onset, nucleus, coda, stress }], `stress`
 * being "ˈ", "ˌ" or "". The consonants between two vowels are cut as the IPA's stress marks are
 * placed: the longest end of them that can begin an English syllable goes to the second vowel.
 * A pronunciation of several words (the parts of a hyphenated word, the letters of NATO) has a
 * space between them, and each is cut by itself. A part without a vowel has no syllable.
 *
 *     syllablesOf("kəmˈpjutɚ") -> kəm / pju (ˈ) / tɚ
 */
export function syllablesOf(pronunciation) {
  const syllables = [];

  for (const part of pronunciation.split(" ")) {
    const phonemes = phonemesOf(part);

    const vowelPlaces = [];
    phonemes.forEach((phoneme, index) => {
      if (phoneme.vowel) {
        vowelPlaces.push(index);
      }
    });

    // where each syllable begins
    const starts = [];
    let previousVowel = -1;
    for (const vowelPlace of vowelPlaces) {
      let start = vowelPlace;

      while (start - 1 > previousVowel) {
        const consonants = phonemes.slice(start - 1, vowelPlace);
        const cluster = consonants.map((one) => one.ipa).join("");
        const single = start === vowelPlace && phonemes[start - 1].ipa !== "ŋ";

        // before the first vowel every consonant belongs to the syllable
        if (previousVowel >= 0 && !single && !ONSETS.has(cluster)) {
          break;
        }
        start -= 1;
      }

      starts.push(start);
      previousVowel = vowelPlace;
    }

    vowelPlaces.forEach((vowelPlace, index) => {
      const isLast = index === vowelPlaces.length - 1;
      const end = isLast ? phonemes.length : starts[index + 1];

      const before = phonemes.slice(starts[index], vowelPlace);
      const after = phonemes.slice(vowelPlace + 1, end);
      const upToVowel = phonemes.slice(starts[index], vowelPlace + 1);
      const marked = upToVowel.find((phoneme) => phoneme.stress !== "");

      const syllable = {
        onset: before.map((phoneme) => phoneme.ipa),
        nucleus: phonemes[vowelPlace].ipa,
        coda: after.map((phoneme) => phoneme.ipa),
        stress: marked ? marked.stress : "",
      };
      syllables.push(syllable);
    });
  }

  return syllables;
}

/** How many slots each syllable of `word` is sung over: 1 in a short weak word (the, of, and),
 * 2 in any other. One slot (0.15 s at the song's usual speed) is too short for an English
 * syllable with consonants on both sides: measured on 130 words, a recogniser gets 31% of them
 * wrong when only the stressed syllables have two slots, and 19% when all these have (調査/16). */
export function slotsOf(word) {
  const lowerCase = word.toLowerCase();
  if (WEAK_WORDS.has(lowerCase)) {
    return 1;
  }
  return 2;
}

/**
 * The English score of a sentence. `words` are the sentence's words in order, each
 * { start, end, ipa } (`ipa` a pronunciation, or null for a word that is not sung: a mark, a
 * space, a sign). A mark that is not a space ends the phrase with a pause, as in the katakana
 * score; a space does not. A word's syllables share its characters among them. A syllable of two
 * slots takes one when it would otherwise be cut by the bar line that sing/bars.js draws through
 * a long phrase every 8 slots.
 *
 * Returns the phrases, or null when no word is sung.
 */
export function englishPhrases(speech, words) {
  const phrases = [];
  let open = null; // the phrase that still takes syllables

  for (const word of words) {
    let syllables = [];
    if (word.ipa) {
      syllables = syllablesOf(word.ipa);
    }

    if (!syllables.length) {
      // nothing to sing: lit with the syllable before it; a mark that is no space is a pause
      const lastPhrase = phrases[phrases.length - 1];
      if (lastPhrase) {
        const before = lastPhrase.morae[lastPhrase.morae.length - 1];
        before.end = word.end;

        const written = speech.slice(word.start, word.end);
        if (written.trim()) {
          lastPhrase.pause = true;
          open = null;
        }
      }
      continue;
    }

    if (!open) {
      open = {
        pause: false,
        morae: [],
      };
      phrases.push(open);
    }

    const written = speech.slice(word.start, word.end);
    const length = word.end - word.start;

    syllables.forEach((syllable, index) => {
      // the word's characters, shared among its syllables
      const start = word.start + Math.floor((index * length) / syllables.length);
      const end = word.start + Math.floor(((index + 1) * length) / syllables.length);

      const sounds = [...syllable.onset, syllable.nucleus, ...syllable.coda];
      const sung = {
        k: sounds.join(""),
        start,
        end,
        tails: [],
        syllable: {
          onset: syllable.onset,
          nucleus: syllable.nucleus,
          coda: syllable.coda,
        },
      };

      const place = open.morae.length;
      open.morae.push(sung);

      const lastOfBar = place % SLOTS_PER_BAR === SLOTS_PER_BAR - 1;
      if (slotsOf(written) === 2 && !lastOfBar) {
        const held = {
          k: "",
          held: true,
          start,
          end,
          tails: [],
        };
        open.morae.push(held);
      }
    });
  }

  if (!phrases.length) {
    return null;
  }

  // marks at the very start and end of the sentence light with the first and the last syllable
  phrases[0].morae[0].start = 0;
  const lastPhrase = phrases[phrases.length - 1];
  for (let index = lastPhrase.morae.length - 1; index >= 0; index -= 1) {
    const last = lastPhrase.morae[index];
    last.end = speech.length;
    if (!last.held) {
      break;
    }
  }

  return phrases;
}
