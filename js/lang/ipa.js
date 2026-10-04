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
const ONSETS = new Set(
  (
    "pl pɹ bl bɹ tɹ dɹ kl kɹ ɡl ɡɹ fl fɹ θɹ ʃɹ sp st sk sm sn sl sw sf tw dw kw ɡw θw " +
    "spl spɹ stɹ skɹ skw pj bj fj vj kj ɡj hj mj nj lj spj skj"
  ).split(" "),
);

/** The phonemes of a pronunciation written in ARPAbet ("K AE1 T", or its list), each as
 * { ipa, vowel, stress }: `stress` is 1, 2 or 0 on a vowel, and null on a consonant. A phoneme
 * that ARPAbet does not have is left out. */
function phonemesOfArpabet(arpabet) {
  const list = typeof arpabet === "string" ? arpabet.trim().split(/\s+/) : arpabet;
  const phonemes = [];
  for (const written of list) {
    const [, name, digit] = /^([A-Z]+)([0-2])?$/.exec(written) || [];
    if (!(name in IPA_OF)) continue;
    const vowel = digit !== undefined;
    const weak = vowel && digit === "0" && WEAK[name];
    phonemes.push({ ipa: weak || IPA_OF[name], vowel, stress: vowel ? Number(digit) : null });
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
    if (!phoneme.vowel) return;
    let start = index;
    while (start - 1 > previousVowel) {
      const cluster = phonemes
        .slice(start - 1, index)
        .map((one) => one.ipa)
        .join("");
      const single = start === index && phonemes[start - 1].ipa !== "ŋ";
      // before the first vowel every consonant belongs to the syllable
      if (previousVowel >= 0 && !single && !ONSETS.has(cluster)) break;
      start -= 1;
    }
    syllableStarts.set(start, phoneme.stress);
    previousVowel = index;
  });
  return phonemes
    .map((phoneme, index) => (STRESS_MARK[syllableStarts.get(index)] || "") + phoneme.ipa)
    .join("");
}

// The phonemes as they are written in IPA here, the longer ones first, for reading a string back.
const WRITTEN = [...new Set([...Object.values(IPA_OF), ...Object.values(WEAK)])].sort(
  (one, other) => other.length - one.length,
);
const VOWELS = new Set(
  Object.entries(IPA_OF)
    .filter(([name]) => /^[AEIOU]/.test(name))
    .map(([, ipa]) => ipa)
    .concat(Object.values(WEAK)),
);

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
    phonemes.push({ ipa: written, vowel: VOWELS.has(written), stress });
    stress = "";
    at += written.length;
  }
  return phonemes;
}

const HISSING = new Set(["s", "z", "ʃ", "ʒ", "tʃ", "dʒ"]);
const VOICELESS = new Set(["p", "t", "k", "f", "θ", "s", "ʃ", "tʃ", "h"]);
const lastPhoneme = (pronunciation) => phonemesOf(pronunciation).at(-1)?.ipa ?? "";

/** With the ending -s (a plural, a verb's third person, a possessive): ɪz after a hissing sound,
 * s after a voiceless one, z otherwise (ˈkæts, ˈdɔɡz, ˈbɑksɪz). */
export function withS(pronunciation) {
  const last = lastPhoneme(pronunciation);
  return pronunciation + (HISSING.has(last) ? "ɪz" : VOICELESS.has(last) ? "s" : "z");
}

/** With the ending -ed: ɪd after t and d, t after a voiceless sound, d otherwise. */
export function withEd(pronunciation) {
  const last = lastPhoneme(pronunciation);
  return pronunciation + (last === "t" || last === "d" ? "ɪd" : VOICELESS.has(last) ? "t" : "d");
}

/** With the ending -ing. */
export const withIng = (pronunciation) => pronunciation + "ɪŋ";
