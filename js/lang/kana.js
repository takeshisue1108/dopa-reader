// Katakana from an English pronunciation in IPA (SPEC_dopa v3.23 §5.7; ED D-160, D-167). It is
// a plain transliteration, sound by sound, for singing English in the Japanese voice until the
// English voice is built; it is meant to be simple, not fine. Every kana it writes is one the
// voice bank can sing. Pure.
import { phonemesOf } from "./ipa.js";

// Each English vowel as the Japanese vowel (a, i, u, e, o) its kana takes, and what follows it.
const VOWEL = {
  i: ["i", "ー"],
  ɪ: ["i", ""],
  ɛ: ["e", ""],
  æ: ["a", ""],
  ɑ: ["a", ""],
  ʌ: ["a", ""],
  ə: ["a", ""],
  ɔ: ["o", "ー"],
  ʊ: ["u", ""],
  u: ["u", "ー"],
  ɝ: ["a", "ー"],
  ɚ: ["a", "ー"],
  eɪ: ["e", "イ"],
  aɪ: ["a", "イ"],
  ɔɪ: ["o", "イ"],
  aʊ: ["a", "ウ"],
  oʊ: ["o", "ー"],
};
const ALONE = { a: "ア", i: "イ", u: "ウ", e: "エ", o: "オ" };
// A consonant before each Japanese vowel, and with no vowel after it.
const ROW = {
  p: { a: "パ", i: "ピ", u: "プ", e: "ペ", o: "ポ", none: "プ" },
  b: { a: "バ", i: "ビ", u: "ブ", e: "ベ", o: "ボ", none: "ブ" },
  t: { a: "タ", i: "ティ", u: "トゥ", e: "テ", o: "ト", none: "ト" },
  d: { a: "ダ", i: "ディ", u: "ドゥ", e: "デ", o: "ド", none: "ド" },
  k: { a: "カ", i: "キ", u: "ク", e: "ケ", o: "コ", none: "ク" },
  ɡ: { a: "ガ", i: "ギ", u: "グ", e: "ゲ", o: "ゴ", none: "グ" },
  f: { a: "ファ", i: "フィ", u: "フ", e: "フェ", o: "フォ", none: "フ" },
  v: { a: "ヴァ", i: "ヴィ", u: "ヴ", e: "ヴェ", o: "ヴォ", none: "ヴ" },
  θ: { a: "サ", i: "シ", u: "ス", e: "セ", o: "ソ", none: "ス" },
  ð: { a: "ザ", i: "ジ", u: "ズ", e: "ゼ", o: "ゾ", none: "ズ" },
  s: { a: "サ", i: "シ", u: "ス", e: "セ", o: "ソ", none: "ス" },
  z: { a: "ザ", i: "ジ", u: "ズ", e: "ゼ", o: "ゾ", none: "ズ" },
  ʃ: { a: "シャ", i: "シ", u: "シュ", e: "シェ", o: "ショ", none: "シュ" },
  ʒ: { a: "ジャ", i: "ジ", u: "ジュ", e: "ジェ", o: "ジョ", none: "ジュ" },
  tʃ: { a: "チャ", i: "チ", u: "チュ", e: "チェ", o: "チョ", none: "チ" },
  dʒ: { a: "ジャ", i: "ジ", u: "ジュ", e: "ジェ", o: "ジョ", none: "ジ" },
  h: { a: "ハ", i: "ヒ", u: "フ", e: "ヘ", o: "ホ", none: "フ" },
  m: { a: "マ", i: "ミ", u: "ム", e: "メ", o: "モ", none: "ム" },
  n: { a: "ナ", i: "ニ", u: "ヌ", e: "ネ", o: "ノ", none: "ン" },
  ŋ: { a: "ンガ", i: "ンギ", u: "ング", e: "ンゲ", o: "ンゴ", none: "ング" },
  l: { a: "ラ", i: "リ", u: "ル", e: "レ", o: "ロ", none: "ル" },
  ɹ: { a: "ラ", i: "リ", u: "ル", e: "レ", o: "ロ", none: "" }, // after a vowel: not sung
  j: { a: "ヤ", i: "イ", u: "ユ", e: "イェ", o: "ヨ", none: "イ" },
  w: { a: "ワ", i: "ウィ", u: "ウ", e: "ウェ", o: "ウォ", none: "ウ" },
};
// A consonant and j before a vowel take the small ャ ュ ョ (music: ミュ), where Japanese has them.
// (f takes ヒ: the bank has no フュ)
const WITH_J = {
  p: "ピ",
  b: "ビ",
  k: "キ",
  ɡ: "ギ",
  h: "ヒ",
  f: "ヒ",
  m: "ミ",
  n: "ニ",
  l: "リ",
  ɹ: "リ",
};
const SMALL_Y = { a: "ャ", u: "ュ", o: "ョ" };
const SHORT_STRESSED = new Set(["ɪ", "ɛ", "æ", "ʌ", "ʊ", "ɑ"]);
const STOPS = new Set(["p", "t", "k", "tʃ", "d", "ɡ", "dʒ"]);
const R_AS_A = new Set(["ɛ", "ɪ", "ʊ"]); // the vowels after which ɹ is sung ア

/**
 * The katakana of a pronunciation in IPA. A consonant takes the vowel after it (kæ: カ); with
 * none after it, it takes its own kana (t: ト). A long vowel and ɹ after a vowel are ー. A word
 * that ends in a short stressed vowel and one stop gets ッ before the stop (kæt: カット).
 *
 *     kanaOfIpa("kəmˈpjutɚ") -> "カムピューター", kanaOfIpa("ˈθɪŋk") -> "シンク"
 */
export function kanaOfIpa(pronunciation) {
  const phonemes = phonemesOf(pronunciation);
  let kana = "";
  for (let at = 0; at < phonemes.length; at++) {
    const { ipa, vowel } = phonemes[at];
    if (vowel) {
      kana += ALONE[VOWEL[ipa][0]] + VOWEL[ipa][1];
      continue;
    }
    const next = phonemes[at + 1],
      afterNext = phonemes[at + 2];
    if (next && next.ipa === "j" && afterNext && afterNext.vowel && WITH_J[ipa]) {
      const [japanese, tail] = VOWEL[afterNext.ipa];
      if (SMALL_Y[japanese]) {
        kana += WITH_J[ipa] + SMALL_Y[japanese] + tail;
        at += 2;
        continue;
      }
    }
    if (next && next.vowel) {
      const [japanese, tail] = VOWEL[next.ipa];
      kana += ROW[ipa][japanese] + tail;
      at += 1;
      continue;
    }
    // no vowel after it
    const previous = phonemes[at - 1];
    if (ipa === "ɹ") {
      // after a vowel: ア after ɛ, ɪ and ʊ (their: ゼア, year: イア), else the vowel is
      // lengthened, once (car: カー)
      if (previous && R_AS_A.has(previous.ipa)) kana += "ア";
      else if (previous && previous.vowel && !kana.endsWith("ー")) kana += "ー";
      continue;
    }
    if (ipa === "ŋ" && next && (next.ipa === "k" || next.ipa === "ɡ")) {
      kana += "ン"; // think: シンク, finger: フィンガー
      continue;
    }
    // t and s, d and z with no vowel after them are one kana (cats: キャッツ is カッツ here)
    if ((ipa === "t" && next?.ipa === "s") || (ipa === "d" && next?.ipa === "z")) {
      if (!afterNext || !afterNext.vowel) {
        kana += ipa === "t" ? "ツ" : "ズ";
        at += 1;
        continue;
      }
    }
    const lastOfWord = at === phonemes.length - 1;
    if (
      lastOfWord &&
      STOPS.has(ipa) &&
      previous &&
      previous.vowel &&
      SHORT_STRESSED.has(previous.ipa) &&
      (previous.stress || phonemes.filter((one) => one.vowel).length === 1)
    )
      kana += "ッ";
    kana += ROW[ipa].none;
  }
  return kana;
}
