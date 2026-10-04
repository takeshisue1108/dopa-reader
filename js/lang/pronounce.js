// How an English word is pronounced, in IPA (SPEC_dopa v3.23 §5.5 step 2, §5.7; ED D-116, D-160,
// D-167). The IPA is what is looked for with every means; the katakana that is sung for now is
// only made from it (kana.js). In order:
//
//   1. the word in the dictionary (CMUdict as IPA, data/lang/en_ipa.json); a word with two
//      pronunciations by its part of speech (refuse, record, use) takes the one of its tags;
//   2. a possessive, or a regular form in -s, -ed or -ing, of a word that is there: the word's
//      pronunciation with the ending's sound (ipa.js);
//   3. what the model has written from the spelling (g2p.js), for a word that is nowhere.
//
// The model is loaded only when such a word comes, so step 3 is in two parts: unknownWords()
// names the words of a text that need it, and learn() takes its answers. Pure: the dictionary,
// the list of words with two pronunciations and the model's answers are passed in.
import { arpabetToIpa, withEd, withIng, withS } from "./ipa.js";
import { kanaOfIpa } from "./kana.js";

// letters: a shorter rest (ad-s, th-ing) is not taken for the word
const MIN_BASE = 3;

// the word's last letter may have been doubled before the ending (knotted)
function withoutDoubled(stem) {
  const endsDoubled = /([b-df-hj-np-tv-z])\1$/.test(stem);
  if (!endsDoubled) {
    return null;
  }
  return stem.slice(0, -1);
}

// Each regular ending with the words it may have been put on (the letters before it, as written)
// and what it adds to the pronunciation.
const ENDINGS = [
  { ending: "ies", bases: (stem) => [stem + "y"], add: withS },
  { ending: "es", bases: (stem) => (/(?:s|x|z|ch|sh)$/.test(stem) ? [stem] : []), add: withS },
  { ending: "s", bases: (stem) => [stem], add: withS },
  { ending: "ied", bases: (stem) => [stem + "y"], add: withEd },
  { ending: "ed", bases: (stem) => [stem, stem + "e", withoutDoubled(stem)], add: withEd },
  { ending: "ing", bases: (stem) => [stem, stem + "e", withoutDoubled(stem)], add: withIng },
];
// The names of the letters, for a word of capitals only (NATO, AI).
const LETTER_IPA = {
  a: "ˈeɪ",
  b: "ˈbi",
  c: "ˈsi",
  d: "ˈdi",
  e: "ˈi",
  f: "ˈɛf",
  g: "ˈdʒi",
  h: "ˈeɪtʃ",
  i: "ˈaɪ",
  j: "ˈdʒeɪ",
  k: "ˈkeɪ",
  l: "ˈɛl",
  m: "ˈɛm",
  n: "ˈɛn",
  o: "ˈoʊ",
  p: "ˈpi",
  q: "ˈkju",
  r: "ˈɑɹ",
  s: "ˈɛs",
  t: "ˈti",
  u: "ˈju",
  v: "ˈvi",
  w: "ˈdʌbəlju",
  x: "ˈɛks",
  y: "ˈwaɪ",
  z: "ˈzi",
};
// The part of speech of a word with two pronunciations, as the tagger's tag (english.js).
const TAG_OF = { V: "Verb", N: "Noun", VBD: "PastTense", VBN: "Participle", ADJ: "Adjective" };
const WORD = /[A-Za-z]+(?:['’][A-Za-z]+)*/g; // a word, without its hyphens

function plain(word) {
  const lowerCase = word.toLowerCase();
  return lowerCase.replaceAll("’", "'");
}

/**
 * The English pronunciations of the site. `table` is the dictionary { word: IPA }, a plain
 * object; `homographs` is { word: [IPA when its part of speech is `pos`, IPA otherwise, pos] }.
 * Returns:
 *
 *   ipaOf(word, tags)  the word's IPA, or undefined when nothing gives one. `tags` are the
 *                      tagger's tags of the word in its sentence, when there are any. A word
 *                      with hyphens is its parts with a space between; a word of capitals only
 *                      is the names of its letters.
 *   kanaOf(word, tags) the katakana of that IPA (kana.js), or undefined.
 *   unknownWords(text) the words of a text, in lower case, that only the model can pronounce.
 *   learn(word, arpabet) keep the model's answer for such a word.
 */
export function createEnglish({ table, homographs = {} }) {
  const learned = new Map(); // word -> IPA, written by the model
  const has = (object, key) => Object.hasOwn(object, key);

  const known = (word) => {
    if (has(table, word)) {
      return table[word];
    }
    return learned.get(word);
  };

  /** One word without hyphens, in lower case: steps 1 to 3 of the header. */
  function ipaOfPlain(word, tags) {
    if (tags && has(homographs, word)) {
      const [whenTagged, otherwise, pos] = homographs[word];
      const tagOfPos = TAG_OF[pos];
      if (tags.includes(tagOfPos)) {
        return whenTagged;
      }
      return otherwise;
    }

    const direct = known(word);
    if (direct !== undefined) {
      return direct;
    }

    if (word.endsWith("'s")) {
      const ownerWord = word.slice(0, -2);
      const owner = ipaOfPlain(ownerWord, null);
      if (owner === undefined) {
        return undefined;
      }
      return withS(owner);
    }

    for (const { ending, bases, add } of ENDINGS) {
      if (!word.endsWith(ending)) {
        continue;
      }

      const stem = word.slice(0, -ending.length);
      for (const base of bases(stem)) {
        const longEnough = base && base.length >= MIN_BASE;
        if (longEnough && known(base) !== undefined) {
          const baseIpa = known(base);
          return add(baseIpa);
        }
      }
    }

    return undefined;
  }

  function ipaOf(word, tags = null) {
    const hasLowerCase = /[a-z]/.test(word);
    if (!hasLowerCase) {
      const letters = [...word.toLowerCase()];
      const namesOrNothing = letters.map((letter) => LETTER_IPA[letter]);
      const names = namesOrNothing.filter(Boolean);

      if (!names.length) {
        return undefined;
      }
      return names.join(" ");
    }

    const written = plain(word);
    const writtenParts = written.split("-");
    const parts = writtenParts.map((part) => ipaOfPlain(part, tags));

    if (parts.includes(undefined)) {
      return undefined;
    }
    return parts.join(" ");
  }

  return {
    ipaOf,

    kanaOf(word, tags = null) {
      const ipa = ipaOf(word, tags);
      if (ipa === undefined) {
        return undefined;
      }
      return kanaOfIpa(ipa);
    },

    unknownWords(text) {
      const unknown = new Set();
      const normalized = text.normalize("NFKC");

      for (const [written] of normalized.matchAll(WORD)) {
        if (!/[a-z]/.test(written)) {
          continue; // capitals only: the letters' names
        }

        const word = plain(written);
        if (ipaOfPlain(word, null) !== undefined) {
          continue;
        }

        // a possessive of an unknown word: the model reads the word, and the 's is added here
        if (word.endsWith("'s")) {
          const owner = word.slice(0, -2);
          unknown.add(owner);
        } else {
          unknown.add(word);
        }
      }

      return [...unknown];
    },

    learn(word, arpabet) {
      const ipa = arpabetToIpa(arpabet);
      if (ipa) {
        learned.set(word, ipa);
      }
    },
  };
}
