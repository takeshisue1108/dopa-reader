// One sentence's analysis: its sung score and its target nouns, from kuromoji's tokens of it
// (SPEC_dopa v3 §5.5, §5.6, SD-W05). The score has the shape of SPEC_sing §5.2, so `bars.js` and
// everything after it take it as they took the server's:
//
//     { phrases: [{ pause, morae: [{ k, start, end, tails }] }], targets: [{ start, end, text }] }
//
// `start` and `end` are offsets in the speech string, counted as JavaScript counts them (UTF-16
// code units), so that `speech.slice(start, end)` is the text. Timing is not made here: the reader
// takes it from the song (§5.6 step 4). Pure: no browser globals, tested with node. The English
// katakana table (§5.7) is passed in by the caller, so a test can pass a small one.
import { NYAN, NYAN_MARK, SMALL_KANA, fit, moraeOf, spreadOverCharacters, toKatakana } from "./morae.js";
import { targetsOf } from "./nouns.js";
import {
  KANJI_NUMERAL,
  asciiDigits,
  kanjiNumber,
  numbersIn,
  readNumber,
  readSpecial,
} from "./numbers.js";

const KANJI = /\p{Script=Han}/u;
const KATAKANA = /[ァ-ヺー]/;
const HIRAGANA = /[ぁ-ゖ]/;
const DIGIT_CHARS = /^[0-9０-９,，.．]+$/;
const HAS_DIGIT = /[0-9０-９]/;
// A word of Latin letters (§5.5 step 2, D-116): letters, with an apostrophe or a hyphen inside.
const LATIN_WORD = /^[A-Za-z]+(?:['’-][A-Za-z]+)*$/;
const LATIN_PIECE = /^(?:[A-Za-z]+|['’-])$/;
// A word of capitals only is sung by the letters' names (ABC as エー ビー シー, as OpenJTalk did).
const LETTER_NAMES = {
  A: "エー", B: "ビー", C: "シー", D: "ディー", E: "イー", F: "エフ", G: "ジー", H: "エイチ",
  I: "アイ", J: "ジェー", K: "ケー", L: "エル", M: "エム", N: "エヌ", O: "オー", P: "ピー",
  Q: "キュー", R: "アール", S: "エス", T: "ティー", U: "ユー", V: "ブイ", W: "ダブリュー",
  X: "エックス", Y: "ワイ", Z: "ゼット",
};

/**
 * Where each token is written in `speech`, as [start, end) in UTF-16 code units. kuromoji's
 * tokens cover the text in order; `word_position` counts code points from 1, so the surfaces are
 * laid end to end instead, which gives the same places in the units the reader slices with.
 */
export function spansOf(speech, tokens) {
  const spans = [];
  let at = 0;
  for (const token of tokens) {
    const surface = token.surface_form;
    let start = speech.startsWith(surface, at) ? at : speech.indexOf(surface, at);
    if (start < 0) start = at; // never seen; keeps the spans in order
    spans.push([start, start + surface.length]);
    at = start + surface.length;
  }
  return spans;
}

/** The reading of a lower-case word in the English table, a plain object or a Map; or undefined. */
function lookUp(english, word) {
  if (!english) return undefined;
  if (english instanceof Map) return english.get(word);
  return Object.hasOwn(english, word) ? english[word] : undefined;
}

/**
 * How one word of Latin letters is sung (D-116): a word of capitals only by the letters' names;
 * any other word by its reading in the English table `english` (lower-cased, so iPhone is looked
 * up as "iphone"); a word not in the table as one ニャン (NYAN_MARK) for the whole word.
 */
export function readLatin(word, english = null) {
  if (!/[a-z]/.test(word)) {
    return [...word].map((char) => LETTER_NAMES[char] ?? "").join("");
  }
  return lookUp(english, word.toLowerCase().replaceAll("’", "'")) ?? NYAN_MARK;
}

/**
 * How a word the dictionary cannot read is sung (§5.5 step 2), in katakana; "" for none. Each
 * 「ニャン」 is written as NYAN_MARK, which morae.js sings as the one mora ニャン. `english` is the
 * English katakana table (§5.7), or null when it is not loaded.
 */
export function readUnknown(surface, english = null) {
  const text = asciiDigits(surface.normalize("NFKC"));
  if (KANJI.test(text)) {
    // D-86: one ニャン for each kanji; kana as written; anything else dropped
    let reading = "";
    for (const char of text) {
      if (KANJI.test(char)) reading += NYAN_MARK;
      else if (KATAKANA.test(char)) reading += char;
      else if (HIRAGANA.test(char)) reading += toKatakana(char);
    }
    return reading;
  }
  let reading = "";
  for (const [part] of text.matchAll(/\d+(?:\.\d+)?|[A-Za-z]+(?:['’-][A-Za-z]+)*|./gu)) {
    if (/^\d/.test(part)) reading += readNumber(part);
    else if (/^[A-Za-z]/.test(part)) reading += readLatin(part, english);
    else if (KATAKANA.test(part)) reading += part;
    else if (HIRAGANA.test(part)) reading += toKatakana(part);
  }
  return reading;
}

const known = (field) => field && field !== "*";
const pronOf = (token, english) =>
  known(token.pronunciation)
    ? token.pronunciation
    : known(token.reading)
      ? token.reading
      : readUnknown(token.surface_form, english);

// kuromoji cuts don't and well-known at the apostrophe and the hyphen; a Latin token without a
// reading is joined again with the pieces that follow it, while they stay one word (D-116).
const isLatinToken = (token) =>
  !known(token.pronunciation) &&
  !known(token.reading) &&
  LATIN_PIECE.test(token.surface_form.normalize("NFKC"));

const isDigitToken = (token) => DIGIT_CHARS.test(token.surface_form);
const isKanjiNumeral = (token) =>
  token.pos === "名詞" && token.pos_detail_1 === "数" && KANJI_NUMERAL.test(token.surface_form);

/**
 * The words that are sung, in order: { start, end, pos, pos1, pron }. Mostly one per token; a
 * number is one word however the dictionary cut it (2 . 5, or 三 百), read by numbers.js; a number
 * and its counter are one word when the pair has a reading of its own (1日 ツイタチ). A word of
 * Latin letters is one word however the dictionary cut it (don ' t). A word whose `pron` gives no
 * morae is a mark. `english` is the English katakana table (§5.7), or null.
 */
export function wordsOf(speech, tokens, spans, english = null) {
  const words = [];
  const numberWord = (start, end, number) => ({
    start,
    end,
    pos: "名詞",
    pos1: "数",
    pron: readNumber(number),
    number,
  });
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    // digits, with the commas and full stops between them, in one or more tokens
    if (isDigitToken(token)) {
      let last = i;
      while (last + 1 < tokens.length && isDigitToken(tokens[last + 1])) last += 1;
      const start = spans[i][0];
      const end = spans[last][1];
      const run = speech.slice(start, end);
      if (HAS_DIGIT.test(run)) {
        let at = 0;
        for (const found of numbersIn(run)) {
          if (found.start > at) words.push(mark(start + at, start + found.start));
          words.push(numberWord(start + found.start, start + found.end, found.number));
          at = found.end;
        }
        if (at < run.length) words.push(mark(start + at, end));
        i = last + 1;
        continue;
      }
    }
    // numerals in kanji with a unit (三百, 二千二十二) or with 〇 (二〇二二)
    if (isKanjiNumeral(token)) {
      let last = i;
      while (last + 1 < tokens.length && isKanjiNumeral(tokens[last + 1])) last += 1;
      const start = spans[i][0];
      const end = spans[last][1];
      const number = end - start > 1 ? kanjiNumber(speech.slice(start, end)) : null;
      if (number !== null) {
        words.push(numberWord(start, end, number));
        i = last + 1;
        continue;
      }
    }
    // a Latin word cut at its apostrophes or hyphens: letters, then mark and letters, touching
    if (isLatinToken(token) && /^[A-Za-z]/.test(token.surface_form.normalize("NFKC"))) {
      let last = i;
      while (
        last + 2 < tokens.length &&
        isLatinToken(tokens[last + 1]) &&
        isLatinToken(tokens[last + 2]) &&
        spans[last][1] === spans[last + 1][0] &&
        spans[last + 1][1] === spans[last + 2][0] &&
        LATIN_WORD.test(speech.slice(spans[i][0], spans[last + 2][1]).normalize("NFKC"))
      )
        last += 2;
      if (last > i) {
        const start = spans[i][0];
        const end = spans[last][1];
        const pron = readUnknown(speech.slice(start, end), english);
        words.push({ start, end, pos: token.pos, pos1: token.pos_detail_1, pron });
        i = last + 1;
        continue;
      }
    }
    words.push({
      start: spans[i][0],
      end: spans[i][1],
      pos: token.pos,
      pos1: token.pos_detail_1,
      pron: pronOf(token, english),
    });
    i += 1;
  }
  // a counter after a number keeps its own reading, but 月 is ガツ there, and a few pairs have a
  // reading of their own (§5.5 step 5)
  for (let w = 0; w + 1 < words.length; w++) {
    const number = words[w].number;
    if (number === undefined || words[w].end !== words[w + 1].start) continue;
    const counter = speech.slice(words[w + 1].start, words[w + 1].end);
    const special = readSpecial(number, counter);
    if (special) {
      words.splice(w, 2, { ...words[w], end: words[w + 1].end, pron: special, number: undefined });
    } else if (counter === "月") words[w + 1].pron = "ガツ";
  }
  return words;
}

const mark = (start, end) => ({ start, end, pos: "記号", pos1: "一般", pron: "" });

/** Whether a word starts a new 文節 after `previous` (§5.5 step 4, ED A-29). */
export function startsPhrase(word, previous) {
  if (previous && previous.pos === "接頭詞") return false; // お寿司
  switch (word.pos) {
    case "名詞":
      if (word.pos1 === "非自立" || word.pos1 === "接尾") return false;
      return !(previous && previous.pos === "名詞"); // a compound noun, and 数 after 数 (D-79)
    case "動詞":
      if (word.pos1 !== "自立") return false;
      return !(previous && previous.pos === "名詞" && previous.pos1 === "サ変接続"); // 勉強する
    case "形容詞":
      return word.pos1 === "自立";
    case "副詞":
    case "連体詞":
    case "接続詞":
    case "感動詞":
    case "接頭詞":
      return true;
    default:
      return false; // 助詞, 助動詞, 記号 and the rest join the 文節 before
  }
}

/** The phrases of the score (SPEC_sing §5.2) from the words. */
export function phrasesOf(speech, words) {
  const phrases = [];
  let lastMora = null; // across words: a word may start with a long mark that prolongs it
  let previous = null;
  for (const word of words) {
    const kana = moraeOf(word.pron, lastMora ? lastMora.k : null);
    if (!kana.length) {
      // a comma, a full stop, a bracket, a symbol: a pause, lit with the mora before it
      if (phrases.length) {
        const phrase = phrases[phrases.length - 1];
        phrase.pause = true;
        phrase.morae[phrase.morae.length - 1].end = word.end;
      }
      previous = word;
      continue;
    }
    const morae = spreadOverCharacters(kana, word.start, word.end);
    // a word cut in the middle of a syllable (かのじ|ゃちぼう in kana text): its small kana
    // joins the mora before it, as within a word (§5.5 step 3)
    const first = morae[0];
    const joins = first.k.length === 1 && SMALL_KANA.includes(first.k);
    if (lastMora && !lastMora.long && lastMora.k !== NYAN && joins) {
      lastMora.k += first.k;
      lastMora.end = Math.max(lastMora.end, first.end);
      morae.shift();
      if (!morae.length) {
        previous = word;
        continue;
      }
    }
    lastMora = morae[morae.length - 1];
    const open = phrases.length ? phrases[phrases.length - 1] : null;
    if (open && !open.pause && !startsPhrase(word, previous)) open.morae.push(...morae);
    else phrases.push({ pause: false, morae });
    previous = word;
  }
  for (const phrase of phrases) {
    phrase.morae = fit(phrase.morae).map(({ k, start, end, tails }) => ({ k, start, end, tails }));
  }
  if (phrases.length) {
    // marks at the very start and end (「 … 。) light with the first and the last mora
    phrases[0].morae[0].start = 0;
    const lastPhrase = phrases[phrases.length - 1];
    lastPhrase.morae[lastPhrase.morae.length - 1].end = speech.length;
  }
  return phrases;
}

/**
 * The score and the targets of one sentence. `tokens` are kuromoji's `tokenize(speech)`;
 * `english` is the English katakana table of §5.7 ({ word: katakana }, or a Map), or omitted, in
 * which case every Latin word that is not all capitals is sung ニャン.
 *
 *     analyze("これは本です。", tokens).phrases -> コレワ / ホンデス (pause)
 *     analyze("computerを使う", tokens, { english: { computer: "コンピューター" } })
 */
export function analyze(speech, tokens, { english = null } = {}) {
  const spans = spansOf(speech, tokens);
  const words = wordsOf(speech, tokens, spans, english);
  return { phrases: phrasesOf(speech, words), targets: targetsOf(speech, tokens, spans) };
}
