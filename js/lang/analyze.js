// One sentence's analysis: its sung score and its target nouns, from kuromoji's tokens of it
// (SPEC_dopa v3 §5.5, §5.6, SD-W05). The score has the shape of SPEC_sing §5.2, so `bars.js` and
// everything after it take it as they took the server's:
//
//     { phrases: [{ pause, morae: [{ k, start, end, tails }] }], targets: [{ start, end, text }] }
//
// (a target of an English sentence also has `lang: "en"`)
//
// `k` is the katakana sung in one slot: one kana, two (キャ), a closed syllable (サン) or the unit
// ニャン. `tails` is always [] here: it held a ン sung at the end of the slot before the closed
// syllables of D-118, and stays because the conductor still reads it.
// `start` and `end` are offsets in the speech string, counted as JavaScript counts them (UTF-16
// code units), so that `speech.slice(start, end)` is the text. Timing is not made here: the reader
// takes it from the song (§5.6 step 4). Pure: no browser globals, tested with node. The English
// pronunciations (§5.7) are passed in by the caller, so a test can pass a small table.
//
// An English sentence (a Latin letter, no kana and no kanji) is sung in katakana by the same
// steps (§5.5 step 6; ED D-160): its words run on without a rest at the spaces, and its 「a」 is
// the article ア.
import {
  NYAN,
  NYAN_MARK,
  SMALL_KANA,
  fit,
  moraeOf,
  spreadOverCharacters,
  toKatakana,
} from "./morae.js";
import { englishTargets } from "./english.js";
import { numberWords } from "./numbers_en.js";
import { englishPhrases } from "./syllables.js";
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
const KANA_OR_KANJI = /[\u3040-\u30ff\u3400-\u9fff]/; // hiragana, katakana, kanji
const ARTICLE_A = "ア"; // the word 「a」 of an English sentence (§5.5 step 6)
const ARTICLE_A_IPA = "ə"; // and as the English voice sings it (§5.8)

/** Whether a sentence is English: it has a Latin letter and no kana and no kanji (ED D-160). */
export function isEnglishSentence(speech) {
  const hasLatinLetter = /[A-Za-z]/.test(speech);
  if (!hasLatinLetter) {
    return false;
  }
  return !KANA_OR_KANJI.test(speech);
}

// A word of Latin letters (§5.5 step 2, D-116): letters, with an apostrophe or a hyphen inside.
const LATIN_WORD = /^[A-Za-z]+(?:['’-][A-Za-z]+)*$/;
const LATIN_PIECE = /^(?:[A-Za-z]+|['’-])$/;
// A word of capitals only is sung by the letters' names (ABC as エー ビー シー, as OpenJTalk did).
const LETTER_NAMES = {
  A: "エー",
  B: "ビー",
  C: "シー",
  D: "ディー",
  E: "イー",
  F: "エフ",
  G: "ジー",
  H: "エイチ",
  I: "アイ",
  J: "ジェー",
  K: "ケー",
  L: "エル",
  M: "エム",
  N: "エヌ",
  O: "オー",
  P: "ピー",
  Q: "キュー",
  R: "アール",
  S: "エス",
  T: "ティー",
  U: "ユー",
  V: "ブイ",
  W: "ダブリュー",
  X: "エックス",
  Y: "ワイ",
  Z: "ゼット",
};

/**
 * Where each token is written in `speech`, as [start, end) in UTF-16 code units. kuromoji's
 * tokens come in the order of the text; `word_position` counts code points from 1, so each
 * surface is looked for from where the last one ended instead, which gives the places in the
 * units the reader slices with. A character that no token covers is stepped over.
 */
export function spansOf(speech, tokens) {
  const spans = [];
  let searchFrom = 0;

  for (const token of tokens) {
    const surface = token.surface_form;

    let start = searchFrom;
    const comesNext = speech.startsWith(surface, searchFrom);
    if (!comesNext) {
      start = speech.indexOf(surface, searchFrom);
    }
    if (start < 0) {
      start = searchFrom; // never seen; keeps the spans in order
    }

    const end = start + surface.length;
    spans.push([start, end]);
    searchFrom = end;
  }

  return spans;
}

/** The katakana of an English word, or undefined. `english` is the site's English
 * pronunciations (pronounce.js, createEnglish: the katakana is made from the word's IPA), or,
 * for a test, a small table of katakana readings by lower-case word: a plain object or a Map. */
function lookUp(english, word) {
  if (!english) {
    return undefined;
  }
  if (typeof english.kanaOf === "function") {
    return english.kanaOf(word);
  }

  const lowered = word.toLowerCase();
  const lowerCase = lowered.replaceAll("’", "'");

  if (english instanceof Map) {
    return english.get(lowerCase);
  }
  if (Object.hasOwn(english, lowerCase)) {
    return english[lowerCase];
  }
  return undefined;
}

/**
 * How one word of Latin letters is sung (D-116): a word of capitals only by the letters' names;
 * any other word by its English reading (lookUp: from its IPA; iPhone is looked up as "iphone");
 * a word that has none as one ニャン (NYAN_MARK) for the whole word. A word with hyphens that has
 * no reading whole is read part by part when every part has one (well-known).
 */
export function readLatin(word, english = null) {
  const hasLowerCase = /[a-z]/.test(word);
  if (!hasLowerCase) {
    const letters = [...word];
    const names = letters.map((char) => LETTER_NAMES[char] ?? "");
    return names.join("");
  }

  const known = lookUp(english, word);
  if (known !== undefined) {
    return known;
  }

  if (word.includes("-")) {
    const writtenParts = word.split("-");
    const parts = writtenParts.map((part) => readLatin(part, english));

    if (parts.includes(NYAN_MARK)) {
      return NYAN_MARK;
    }
    return parts.join("");
  }

  return NYAN_MARK;
}

/**
 * How a word the dictionary cannot read is sung (§5.5 step 2), in katakana; "" for none. Each
 * 「ニャン」 is written as NYAN_MARK, which morae.js sings as the one mora ニャン. `english` is the
 * English pronunciations (§5.7), or null when they are not loaded.
 */
export function readUnknown(surface, english = null) {
  const normalized = surface.normalize("NFKC");
  const text = asciiDigits(normalized);

  if (KANJI.test(text)) {
    // D-86: one ニャン for each kanji; kana as written; anything else dropped
    let reading = "";

    for (const char of text) {
      if (KANJI.test(char)) {
        reading += NYAN_MARK;
      } else if (KATAKANA.test(char)) {
        reading += char;
      } else if (HIRAGANA.test(char)) {
        reading += toKatakana(char);
      }
    }

    return reading;
  }

  let reading = "";

  // a number, a word of Latin letters, or any one character
  const parts = text.matchAll(/\d+(?:\.\d+)?|[A-Za-z]+(?:['’-][A-Za-z]+)*|./gu);
  for (const [part] of parts) {
    if (/^\d/.test(part)) {
      reading += readNumber(part);
    } else if (/^[A-Za-z]/.test(part)) {
      reading += readLatin(part, english);
    } else if (KATAKANA.test(part)) {
      reading += part;
    } else if (HIRAGANA.test(part)) {
      reading += toKatakana(part);
    }
  }

  return reading;
}

const isKnown = (field) => field && field !== "*";

function pronunciationOf(token, english) {
  if (isKnown(token.pronunciation)) {
    return token.pronunciation;
  }
  if (isKnown(token.reading)) {
    return token.reading;
  }
  return readUnknown(token.surface_form, english);
}

// kuromoji cuts don't and well-known at the apostrophe and the hyphen; a Latin token without a
// reading is joined again with the pieces that follow it, while they stay one word (D-116).
function isUnreadLatinPiece(token) {
  if (isKnown(token.pronunciation)) {
    return false;
  }
  if (isKnown(token.reading)) {
    return false;
  }

  const surface = token.surface_form.normalize("NFKC");
  return LATIN_PIECE.test(surface);
}

const isDigitOrSeparator = (token) => DIGIT_CHARS.test(token.surface_form);

function isKanjiNumeral(token) {
  const isNumberNoun = token.pos === "名詞" && token.pos_detail_1 === "数";
  if (!isNumberNoun) {
    return false;
  }
  return KANJI_NUMERAL.test(token.surface_form);
}

/**
 * The words that are sung, in order: { start, end, pos, pos1, pron }, and for a number written
 * in digits or kanji also `number`, its ASCII digits. Mostly one per token; a
 * number is one word however the dictionary cut it (2 . 5, or 三 百), read by numbers.js; a number
 * and its counter are one word when the pair has a reading of its own (1日 ツイタチ). A word of
 * Latin letters is one word however the dictionary cut it (don ' t). A word whose `pron` gives no
 * morae is a mark. `english` is the English pronunciations (§5.7), or null.
 */
export function wordsOf(speech, tokens, spans, english = null) {
  const words = [];
  let i = 0;

  while (i < tokens.length) {
    // a run that is read as a whole, of the first kind that starts here
    let run = digitRunAt(speech, tokens, spans, i);
    if (!run) {
      run = kanjiNumberAt(speech, tokens, spans, i);
    }
    if (!run) {
      run = latinWordAt(speech, tokens, spans, i, english);
    }

    if (run) {
      words.push(...run.words);
      i = run.next;
      continue;
    }

    const token = tokens[i];

    const word = {
      start: spans[i][0],
      end: spans[i][1],
      pos: token.pos,
      pos1: token.pos_detail_1,
      pron: pronunciationOf(token, english),
    };
    words.push(word);

    i += 1;
  }

  applyCounterReadings(words, speech);
  return words;
}

// The three kinds of run that are read as a whole. Each takes the tokens and the index `i` of
// the token a run may start at, and returns { words, next } (the words of the run and the index
// of the token after it), or null when no such run starts there.

/** A word with nothing to sing: a comma or a full stop that belongs to no number. */
const silentWord = (start, end) => ({
  start,
  end,
  pos: "記号",
  pos1: "一般",
  pron: "",
});

/** A number written in digits or kanji, as a word: `number` is its ASCII digits. */
const numberWord = (start, end, number) => ({
  start,
  end,
  pos: "名詞",
  pos1: "数",
  pron: readNumber(number),
  number,
});

/** Digits, with the commas and full stops between them, in one or more tokens: a word for each
 * number, and a mark for each comma or full stop that belongs to none. A comma alone is a
 * "digit token" too, hence the test for a digit in the run. The places that numbersIn gives are
 * places in its ASCII copy of the run, which has the same length. */
function digitRunAt(speech, tokens, spans, i) {
  if (!isDigitOrSeparator(tokens[i])) {
    return null;
  }

  let lastOfRun = i;
  while (lastOfRun + 1 < tokens.length && isDigitOrSeparator(tokens[lastOfRun + 1])) {
    lastOfRun += 1;
  }

  const start = spans[i][0];
  const end = spans[lastOfRun][1];
  const digitRun = speech.slice(start, end);
  if (!HAS_DIGIT.test(digitRun)) {
    return null;
  }

  const words = [];
  let covered = 0;

  for (const found of numbersIn(digitRun)) {
    // the number's place in the run, as its place in the text
    const numberStart = start + found.start;
    const numberEnd = start + found.end;

    // the marks between the number before and this one
    if (found.start > covered) {
      const marksStart = start + covered;
      const marks = silentWord(marksStart, numberStart);
      words.push(marks);
    }

    const number = numberWord(numberStart, numberEnd, found.number);
    words.push(number);

    covered = found.end;
  }

  // the marks after the last number
  if (covered < digitRun.length) {
    const marksStart = start + covered;
    const marks = silentWord(marksStart, end);
    words.push(marks);
  }

  return {
    words,
    next: lastOfRun + 1,
  };
}

/** Numerals in kanji with a unit (三百, 二千二十二) or with 〇 (二〇二二), in two characters or
 * more: one number word. */
function kanjiNumberAt(speech, tokens, spans, i) {
  if (!isKanjiNumeral(tokens[i])) {
    return null;
  }

  let lastOfRun = i;
  while (lastOfRun + 1 < tokens.length && isKanjiNumeral(tokens[lastOfRun + 1])) {
    lastOfRun += 1;
  }

  const start = spans[i][0];
  const end = spans[lastOfRun][1];

  const twoCharactersOrMore = end - start > 1;
  if (!twoCharactersOrMore) {
    return null;
  }

  const written = speech.slice(start, end);
  const number = kanjiNumber(written);
  if (number === null) {
    return null;
  }

  const word = numberWord(start, end, number);
  return {
    words: [word],
    next: lastOfRun + 1,
  };
}

/** A Latin word cut at its apostrophes or hyphens: letters, then a mark and letters, touching:
 * one word, read as an unknown word. */
function latinWordAt(speech, tokens, spans, i, english) {
  const token = tokens[i];

  if (!isUnreadLatinPiece(token)) {
    return null;
  }
  const firstPiece = token.surface_form.normalize("NFKC");
  if (!/^[A-Za-z]/.test(firstPiece)) {
    return null;
  }

  let lastOfRun = i;
  // two tokens at a time: the apostrophe or hyphen, and the letters after it
  while (lastOfRun + 2 < tokens.length) {
    const markAt = lastOfRun + 1;
    const lettersAt = lastOfRun + 2;

    if (!isUnreadLatinPiece(tokens[markAt])) {
      break;
    }
    if (!isUnreadLatinPiece(tokens[lettersAt])) {
      break;
    }

    // the mark touches the piece before it, and the letters touch the mark
    if (spans[lastOfRun][1] !== spans[markAt][0]) {
      break;
    }
    if (spans[markAt][1] !== spans[lettersAt][0]) {
      break;
    }

    // with them the run is still one word
    const runSoFar = speech.slice(spans[i][0], spans[lettersAt][1]);
    const normalized = runSoFar.normalize("NFKC");
    if (!LATIN_WORD.test(normalized)) {
      break;
    }

    lastOfRun += 2;
  }

  if (lastOfRun === i) {
    return null;
  }

  const start = spans[i][0];
  const end = spans[lastOfRun][1];
  const written = speech.slice(start, end);
  const pron = readUnknown(written, english);

  const word = {
    start,
    end,
    pos: token.pos,
    pos1: token.pos_detail_1,
    pron,
  };
  return {
    words: [word],
    next: lastOfRun + 1,
  };
}

/**
 * Give the counters after numbers their readings, in place (§5.5 step 5). A counter right after
 * a number keeps its own reading, but 月 is ガツ there, and a few pairs have a reading of their
 * own (1日 ツイタチ): such a pair becomes one word.
 */
function applyCounterReadings(words, speech) {
  for (let wordIndex = 0; wordIndex + 1 < words.length; wordIndex++) {
    const word = words[wordIndex];
    const wordAfter = words[wordIndex + 1];

    const number = word.number;
    if (number === undefined || word.end !== wordAfter.start) {
      continue;
    }

    const counter = speech.slice(wordAfter.start, wordAfter.end);
    const special = readSpecial(number, counter);

    if (special) {
      const numberWithCounter = {
        ...word,
        end: wordAfter.end,
        pron: special,
        number: undefined,
      };
      words.splice(wordIndex, 2, numberWithCounter);
    } else if (counter === "月") {
      wordAfter.pron = "ガツ";
    }
  }
}

/** Whether a word starts a new 文節 after `previous` (§5.5 step 4, ED A-29). */
export function startsPhrase(word, previous) {
  if (previous && previous.pos === "接頭詞") {
    return false; // お寿司
  }

  switch (word.pos) {
    case "名詞": {
      if (word.pos1 === "非自立" || word.pos1 === "接尾") {
        return false;
      }
      // a compound noun, and 数 after 数 (D-79)
      const afterNoun = previous && previous.pos === "名詞";
      return !afterNoun;
    }
    case "動詞": {
      if (word.pos1 !== "自立") {
        return false;
      }
      // 勉強する
      const afterVerbalNoun = previous && previous.pos === "名詞" && previous.pos1 === "サ変接続";
      return !afterVerbalNoun;
    }
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

/** The phrases of the score (SPEC_sing §5.2) from the words. `spacesPause` is false for an
 * English sentence: a space between its words is lit with the word before it and is no pause, so
 * that the rests fall at the punctuation marks only (§5.5 step 6). */
export function phrasesOf(speech, words, { spacesPause = true } = {}) {
  const phrases = [];
  let lastMora = null; // across words: a word may start with a long mark that prolongs it
  let previous = null;

  for (const word of words) {
    let kanaBefore = null;
    if (lastMora) {
      kanaBefore = lastMora.k;
    }
    const wordSounds = moraeOf(word.pron, kanaBefore);

    if (!wordSounds.length) {
      // a word with nothing to sing (a comma, a full stop, a bracket, a symbol, a space): a
      // pause, lit with the mora before it
      if (phrases.length) {
        const phrase = phrases[phrases.length - 1];

        const written = speech.slice(word.start, word.end);
        const isSpace = !written.trim();
        if (spacesPause || !isSpace) {
          phrase.pause = true;
        }

        const moraBefore = phrase.morae[phrase.morae.length - 1];
        moraBefore.end = word.end;
      }

      previous = word;
      continue;
    }

    const morae = spreadOverCharacters(wordSounds, word.start, word.end);
    joinLeadingSmallKana(lastMora, morae);
    if (!morae.length) {
      previous = word;
      continue;
    }
    lastMora = morae[morae.length - 1];

    let openPhrase = null;
    if (phrases.length) {
      openPhrase = phrases[phrases.length - 1];
    }

    let goesOnInOpenPhrase = false;
    if (openPhrase && !openPhrase.pause) {
      goesOnInOpenPhrase = !startsPhrase(word, previous);
    }

    if (goesOnInOpenPhrase) {
      openPhrase.morae.push(...morae);
    } else {
      const newPhrase = {
        pause: false,
        morae,
      };
      phrases.push(newPhrase);
    }

    previous = word;
  }

  for (const phrase of phrases) {
    const fitted = fit(phrase.morae);

    phrase.morae = fitted.map(({ k, start, end, tails }) => ({
      k,
      start,
      end,
      tails,
    }));
  }

  widenToTheEnds(phrases, speech);
  return phrases;
}

/**
 * A word cut in the middle of a syllable (かのじ|ゃちぼう in kana text): its small kana joins the
 * mora before it, as within a word (§5.5 step 3). Both are changed in place: `lastMora` takes the
 * kana and its characters, and the word's `morae` lose their first. lastMora is the very object
 * that stands in its phrase, so changing it changes the score; it is kept across a pause. A long
 * vowel and the unit ニャン take no small kana.
 */
function joinLeadingSmallKana(lastMora, morae) {
  const firstMora = morae[0];
  const startsWithSmallKana = firstMora.k.length === 1 && SMALL_KANA.includes(firstMora.k);

  let lastTakesSmallKana = false;
  if (lastMora) {
    lastTakesSmallKana = !lastMora.long && lastMora.k !== NYAN;
  }

  if (lastTakesSmallKana && startsWithSmallKana) {
    lastMora.k += firstMora.k;
    lastMora.end = Math.max(lastMora.end, firstMora.end);
    morae.shift();
  }
}

/** Marks at the very start and end of the sentence (「 … 。) light with the first and the last
 * mora: the first mora starts at 0 and the last ends at the end of the text (in place). */
function widenToTheEnds(phrases, speech) {
  if (!phrases.length) {
    return;
  }

  const firstMora = phrases[0].morae[0];
  firstMora.start = 0;

  const lastPhrase = phrases[phrases.length - 1];
  const lastMora = lastPhrase.morae[lastPhrase.morae.length - 1];
  lastMora.end = speech.length;
}

/**
 * The score and the targets of one sentence. `tokens` are kuromoji's `tokenize(speech)`;
 * `english` is the site's English pronunciations (pronounce.js; for a test, a small table
 * { word: katakana } or a Map), or omitted, in which case every Latin word that is not all
 * capitals is sung ニャン. An English sentence
 * (isEnglishSentence) is sung in katakana with no rest at its spaces, and its 「a」 as ア; its
 * targets come from `englishTerms`, the words of the English tagger (english.js, termsOf), and
 * without them it has none. With the site's `english` (pronounce.js) the result also has `ipa`:
 * [{ start, end, ipa }], the IPA of each word of Latin letters (ED D-167), and an English
 * sentence also has `englishPhrases`: its score in syllables for the English voice (syllables.js;
 * ED D-170), beside the katakana one that is sung when that voice cannot be used.
 *
 *     analyze("これは本です。", tokens).phrases -> コレワ / ホンデス (pause)
 *     analyze("computerを使う", tokens, { english: { computer: "コンピューター" } })
 */
export function analyze(speech, tokens, { english = null, englishTerms = null } = {}) {
  const spans = spansOf(speech, tokens);
  const words = wordsOf(speech, tokens, spans, english);
  const inEnglish = isEnglishSentence(speech);

  let ipa = null;
  if (english && typeof english.ipaOf === "function") {
    ipa = [];
  }

  // every word of an English sentence with its English pronunciation, or null when it has none
  let sungInEnglish = null;
  if (inEnglish && ipa) {
    sungInEnglish = [];
  }

  for (const word of words) {
    const inSpeech = speech.slice(word.start, word.end);
    const written = inSpeech.normalize("NFKC");
    if (!LATIN_WORD.test(written)) {
      if (sungInEnglish) {
        const sung = {
          start: word.start,
          end: word.end,
          ipa: numberIpa(written, english),
        };
        sungInEnglish.push(sung);
      }
      continue;
    }

    // in an English sentence the tagger's tags choose between two pronunciations (refuse)
    let tags = null;
    if (inEnglish && englishTerms) {
      tags = tagsAt(englishTerms, word.start, word.end);
    }

    if (ipa) {
      const pronunciation = english.ipaOf(written, tags);
      if (pronunciation !== undefined) {
        const wordIpa = {
          start: word.start,
          end: word.end,
          ipa: pronunciation,
        };
        ipa.push(wordIpa);
      }

      if (tags && /[a-z]/.test(written)) {
        const kanaByTags = english.kanaOf(written, tags);
        word.pron = kanaByTags ?? word.pron;
      }
    }

    const isArticleA = inEnglish && /^a$/i.test(written);
    if (isArticleA) {
      word.pron = ARTICLE_A;
    }

    if (sungInEnglish) {
      let pronunciation = english.ipaOf(written, tags) ?? null;
      if (isArticleA) {
        pronunciation = ARTICLE_A_IPA;
      }
      const sung = {
        start: word.start,
        end: word.end,
        ipa: pronunciation,
      };
      sungInEnglish.push(sung);
    }
  }

  // an English sentence takes its targets from the English tagger's words (§5.6 step 6);
  // without them it has none, since kuromoji's tokens of Latin letters are never targets
  let targets;
  if (inEnglish && englishTerms) {
    targets = englishTargets(speech, englishTerms);
  } else {
    targets = targetsOf(speech, tokens, spans);
  }

  const spacesPause = !inEnglish;
  const phrases = phrasesOf(speech, words, { spacesPause });

  if (ipa) {
    const result = {
      phrases,
      targets,
      ipa,
    };

    if (sungInEnglish) {
      const inSyllables = englishPhrases(speech, sungInEnglish);
      if (inSyllables) {
        result.englishPhrases = inSyllables;
      }
    }
    return result;
  }
  return {
    phrases,
    targets,
  };
}

/** The English pronunciation of a number written in digits (1848, 3.5): the IPA of its words with
 * a space between them, or null when it is no number or a word of it has no pronunciation. */
function numberIpa(written, english) {
  const words = numberWords(written);
  if (!words) {
    return null;
  }

  const pronunciations = words.map((word) => english.ipaOf(word));
  if (pronunciations.includes(undefined)) {
    return null;
  }
  return pronunciations.join(" ");
}

/** The tags of the tagger's word that lies at [start, end) of the text, or null. */
function tagsAt(englishTerms, start, end) {
  const term = englishTerms.find((one) => one.start < end && one.end > start);
  if (!term) {
    return null;
  }
  return term.tags;
}
