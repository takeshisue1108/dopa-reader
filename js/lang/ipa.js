// English pronunciations in IPA (SPEC_dopa v3.23 §5.7; ED D-80, D-167). The dictionary (CMUdict)
// and the model for words outside it (g2p.js) write a pronunciation in ARPAbet, a list of
// phonemes with a stress digit on each vowel ("K AE1 T"); here it becomes IPA ("ˈkæt"), and IPA
// is what the rest of the site keeps: the katakana that is sung for now is made from it
// (kana.js), and the English voice that comes later will be made from it too. Pure.
//
// A pronunciation in IPA here is a string of the phonemes of IPA_OF, with ˈ (the main stress)
// and ˌ (a second stress) written before the syllable they belong to: kəmˈpjutɚ, ˌʌndɚˈstænd.

// ARPAbet -> IPA, American English. AH and ER have a weak form when they are not stressed.
const IPA_OF = {
  AA: "ɑ",
  AE: "æ",
  AH: "ʌ",
  AO: "ɔ",
  AW: "aʊ",
  AY: "aɪ",
  EH: "ɛ",
  ER: "ɝ",
  EY: "eɪ",
  IH: "ɪ",
  IY: "i",
  OW: "oʊ",
  OY: "ɔɪ",
  UH: "ʊ",
  UW: "u",
  B: "b",
  CH: "tʃ",
  D: "d",
  DH: "ð",
  F: "f",
  G: "ɡ",
  HH: "h",
  JH: "dʒ",
  K: "k",
  L: "l",
  M: "m",
  N: "n",
  NG: "ŋ",
  P: "p",
  R: "ɹ",
  S: "s",
  SH: "ʃ",
  T: "t",
  TH: "θ",
  V: "v",
  W: "w",
  Y: "j",
  Z: "z",
  ZH: "ʒ",
};
const WEAK = { AH: "ə", ER: "ɚ" }; // with the stress digit 0
const STRESS_MARK = { 1: "ˈ", 2: "ˌ" };

// The clusters of consonants that can begin an English syllable, in IPA; a single consonant can
// too, except ŋ. Used to cut the consonants between two vowels (the longest end of them that can
// begin a syllable goes with the second vowel), so that a stress mark stands before its syllable.
export const ONSETS = new Set(
  (
    "pl pɹ bl bɹ tɹ dɹ kl kɹ ɡl ɡɹ fl fɹ θɹ ʃɹ sp st sk sm sn sl sw sf tw dw kw ɡw θw " +
    "spl spɹ stɹ skɹ skw pj bj fj vj kj ɡj hj mj nj lj spj skj"
  ).split(" "),
);

/** The phonemes of a pronunciation written in ARPAbet ("K AE1 T", or its list), each as
 * { ipa, vowel, stress }: `stress` is 1, 2 or 0 on a vowel, and null on a consonant. A phoneme
 * that ARPAbet does not have is left out. */
function phonemesOfArpabet(arpabet) {
  let list = arpabet;
  if (typeof arpabet === "string") {
    const trimmed = arpabet.trim();
    list = trimmed.split(/\s+/);
  }

  const phonemes = [];

  for (const written of list) {
    const nameAndDigit = /^([A-Z]+)([0-2])?$/.exec(written) || [];
    const [, name, digit] = nameAndDigit;
    if (!(name in IPA_OF)) {
      continue;
    }

    const vowel = digit !== undefined;
    const notStressed = vowel && digit === "0";

    let ipa = IPA_OF[name];
    if (notStressed && WEAK[name]) {
      ipa = WEAK[name];
    }

    let stress = null;
    if (vowel) {
      stress = Number(digit);
    }

    const phoneme = {
      ipa,
      vowel,
      stress,
    };
    phonemes.push(phoneme);
  }

  return phonemes;
}

/**
 * A pronunciation in ARPAbet as IPA, with its stress marks before their syllables.
 *
 *     arpabetToIpa("K AH0 M P Y UW1 T ER0") -> "kəmˈpjutɚ"
 *     arpabetToIpa("AH2 N D ER0 S T AE1 N D") -> "ˌʌndɚˈstænd"
 */
export function arpabetToIpa(arpabet) {
  const phonemes = phonemesOfArpabet(arpabet);

  // where each syllable begins: at its vowel, moved back over the consonants that can begin it
  const syllableStarts = new Map(); // index of the first phoneme of a syllable -> its stress
  let previousVowel = -1;

  phonemes.forEach((phoneme, index) => {
    if (!phoneme.vowel) {
      return;
    }

    let start = index;
    while (start - 1 > previousVowel) {
      const consonants = phonemes.slice(start - 1, index);
      const spellings = consonants.map((one) => one.ipa);
      const cluster = spellings.join("");

      const single = start === index && phonemes[start - 1].ipa !== "ŋ";

      // before the first vowel every consonant belongs to the syllable
      if (previousVowel >= 0) {
        const canBeginSyllable = single || ONSETS.has(cluster);
        if (!canBeginSyllable) {
          break;
        }
      }

      start -= 1;
    }

    syllableStarts.set(start, phoneme.stress);
    previousVowel = index;
  });

  const withMarks = phonemes.map((phoneme, index) => {
    const stress = syllableStarts.get(index);
    const mark = STRESS_MARK[stress] || "";
    return mark + phoneme.ipa;
  });
  return withMarks.join("");
}

// The phonemes as they are written in IPA here, the longer ones first, for reading a string back.
const STRONG_AND_WEAK = [...Object.values(IPA_OF), ...Object.values(WEAK)];
const WRITTEN_ONCE = [...new Set(STRONG_AND_WEAK)];
const WRITTEN = WRITTEN_ONCE.sort((one, other) => other.length - one.length);

const VOWEL_ENTRIES = Object.entries(IPA_OF).filter(([name]) => /^[AEIOU]/.test(name));
const STRONG_VOWELS = VOWEL_ENTRIES.map(([, ipa]) => ipa);
const WEAK_VOWELS = Object.values(WEAK);
const VOWELS = new Set(STRONG_VOWELS.concat(WEAK_VOWELS));

/** The phonemes of a pronunciation in IPA, in order: [{ ipa, vowel, stress }], `stress` being
 * "ˈ", "ˌ" or "" for the mark that stands before the phoneme. A character that is no phoneme of
 * this file is passed over. */
export function phonemesOf(pronunciation) {
  const phonemes = [];
  let stress = "";
  let at = 0;

  while (at < pronunciation.length) {
    const char = pronunciation[at];
    if (char === "ˈ" || char === "ˌ") {
      stress = char;
      at += 1;
      continue;
    }

    const written = WRITTEN.find((one) => pronunciation.startsWith(one, at));
    if (!written) {
      at += 1;
      continue;
    }

    const phoneme = {
      ipa: written,
      vowel: VOWELS.has(written),
      stress,
    };
    phonemes.push(phoneme);

    stress = "";
    at += written.length;
  }

  return phonemes;
}

const HISSING = new Set(["s", "z", "ʃ", "ʒ", "tʃ", "dʒ"]);
const VOICELESS = new Set(["p", "t", "k", "f", "θ", "s", "ʃ", "tʃ", "h"]);

function lastPhoneme(pronunciation) {
  const phonemes = phonemesOf(pronunciation);
  const last = phonemes.at(-1);
  return last?.ipa ?? "";
}

/** With the ending -s (a plural, a verb's third person, a possessive): ɪz after a hissing sound,
 * s after a voiceless one, z otherwise (ˈkæts, ˈdɔɡz, ˈbɑksɪz). */
export function withS(pronunciation) {
  const last = lastPhoneme(pronunciation);

  if (HISSING.has(last)) {
    return pronunciation + "ɪz";
  }
  if (VOICELESS.has(last)) {
    return pronunciation + "s";
  }
  return pronunciation + "z";
}

/** With the ending -ed: ɪd after t and d, t after a voiceless sound, d otherwise. */
export function withEd(pronunciation) {
  const last = lastPhoneme(pronunciation);

  if (last === "t" || last === "d") {
    return pronunciation + "ɪd";
  }
  if (VOICELESS.has(last)) {
    return pronunciation + "t";
  }
  return pronunciation + "d";
}

/** With the ending -ing. */
export const withIng = (pronunciation) => pronunciation + "ɪŋ";
