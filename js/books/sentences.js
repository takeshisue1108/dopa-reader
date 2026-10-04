// Sentences of a block (SPEC_dopa v3 §5.2 "Sentences"; ED D-68).
// Japanese sentences end at 。．！？ (and the half-width ! ?) outside brackets, and at the block's
// end. English sentences are cut by the rule-based splitter of the old adapter (base SPEC §5.1
// step 6, `dbr/adapter.py` split_ja and split_en), carried over here. A long sentence is not cut
// (D-47: the caption scrolls). The splitters work on offsets, so that the caller can cut a speech
// text and its map the same way.

const JA_OPEN = "「『（(【〔［[〈《“";
const JA_CLOSE = "」』）)】〕］]〉》”";
const JA_END = "。！？!?．";
// A tail this short with no end mark, after a closing bracket or quote, joins the sentence
// before it.
const JA_TAIL_MAX_CHARS = 3;

/** Whether a character is kana, a CJK ideograph or half-width katakana (adapter is_ja_char). */
export function isJaChar(ch) {
  const code = ch.codePointAt(0);

  const isKana = code >= 0x3040 && code <= 0x30ff;
  const isIdeograph = code >= 0x3400 && code <= 0x9fff;
  const isHalfWidthKatakana = code >= 0xff66 && code <= 0xff9f;
  const isRareIdeograph = code >= 0x20000 && code <= 0x2ffff;

  return isKana || isIdeograph || isHalfWidthKatakana || isRareIdeograph;
}

/**
 * "ja" when more than 30% of the letters are Japanese, else "en" (adapter detect_lang).
 * A text with no letters at all is "ja" only if it has a Japanese character: a block of digits or
 * of marks only (「１９４５」, 「……」) is "en".
 */
export function detectLang(text) {
  const chars = Array.from(text);
  const letters = chars.filter((ch) => /\p{L}/u.test(ch));

  if (letters.length === 0) {
    const hasJapanese = chars.some(isJaChar);
    return hasJapanese ? "ja" : "en";
  }

  const japaneseLetters = letters.filter(isJaChar);
  const japanese = japaneseLetters.length;
  const japaneseShare = japanese / letters.length;
  return japaneseShare > 0.3 ? "ja" : "en";
}

/** The range [start, end) without the white space at either side; null when nothing is left. */
function trimmedRange(text, start, end) {
  while (start < end && /\s/.test(text[start])) {
    start++;
  }
  while (end > start && /\s/.test(text[end - 1])) {
    end--;
  }

  if (start < end) {
    return [start, end];
  }
  return null;
}

/**
 * The sentences of Japanese text as offset ranges [start, end) (adapter split_ja).
 * A sentence ends at an end mark (JA_END) outside brackets, with any end marks and closing
 * brackets after it; a quote that fills a sentence (「…。」) ends at its closing bracket. A tail
 * of up to 3 characters without an end mark after a closing bracket or quote joins the sentence
 * before it (「…。」と).
 */
export function jaRanges(text) {
  const ranges = [];
  let start = 0;
  // depth: how many brackets are open
  let depth = 0;

  // end the sentence that started at `start` just before `end`
  const cutAt = (end) => {
    const range = trimmedRange(text, start, end);
    if (range) {
      ranges.push(range);
    }
    start = end;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (JA_OPEN.includes(ch)) {
      depth++;
    } else if (JA_CLOSE.includes(ch)) {
      depth = Math.max(0, depth - 1);
    }

    if (JA_END.includes(ch) && depth === 0) {
      while (i + 1 < text.length) {
        const next = text[i + 1];
        const belongsToTheEnd = JA_END.includes(next) || JA_CLOSE.includes(next);
        if (!belongsToTheEnd) {
          break;
        }
        i++;
      }
      cutAt(i + 1);
    } else {
      // a 」 right after an end mark ends the sentence only when the sentence began with the
      // quote (「…。」 alone); 彼は「…。」と stays one sentence
      const closesQuote = "」』".includes(ch) && depth === 0;
      const textFollows = i + 1 < text.length;
      if (closesQuote && textFollows && i > 0) {
        const comesAfterEndMark = JA_END.includes(text[i - 1]);
        if (comesAfterEndMark) {
          const sentenceSoFar = text.slice(start, i + 1);
          const firstChar = sentenceSoFar.trimStart()[0] ?? "";
          const beganWithQuote = "「『".includes(firstChar);
          if (beganWithQuote) {
            cutAt(i + 1);
          }
        }
      }
    }
  }

  cutAt(text.length);
  return withTailsJoined(text, ranges);
}

/**
 * The sentence ranges with each short tail joined to the sentence before it: a tail is a range of
 * up to JA_TAIL_MAX_CHARS characters with no end mark, after a sentence that ends with a closing
 * bracket or quote (「…。」と).
 */
function withTailsJoined(text, ranges) {
  const merged = [];

  for (const range of ranges) {
    const sentence = text.slice(range[0], range[1]);
    const previous = merged[merged.length - 1];

    let isTail = false;
    if (previous && sentence.length <= JA_TAIL_MAX_CHARS) {
      const sentenceChars = Array.from(sentence);
      const hasEndMark = sentenceChars.some((ch) => JA_END.includes(ch));
      if (!hasEndMark) {
        const lastOfPrevious = text[previous[1] - 1];
        isTail = JA_CLOSE.includes(lastOfPrevious);
      }
    }

    if (isTail) {
      previous[1] = range[1];
    } else {
      merged.push(range.slice());
    }
  }

  return merged;
}

const EN_ABBR = new Set(
  (
    "mr mrs ms dr st prof sr jr vs etc cf e.g i.e viz no nos vol vols p pp fig figs ch sec ed eds " +
    "trans rev gen col lt capt mt jan feb mar apr jun jul aug sep sept oct nov dec inc ltd co corp " +
    "approx ca c ibid op cit al u.s u.k a.d b.c"
  ).split(" "),
);
const EN_BREAK = /([.!?]+["'”’)\]]*)(\s+)(?=["'“‘(\[]?[A-Z0-9])/g;

/**
 * The sentences of English text as offset ranges [start, end) (adapter split_en).
 * A sentence ends at . ! ? followed by space and an ASCII capital or a digit (closing quotes and
 * brackets may follow the mark, and one opening quote or bracket may stand before the capital),
 * unless the word before a full stop is an abbreviation (Mr., e.g.) or a single letter (an
 * initial).
 */
export function enRanges(text) {
  const ranges = [];
  let start = 0;

  for (const match of text.matchAll(EN_BREAK)) {
    const endMark = match[1];

    // the word before the mark, in lower case, without the quotes and brackets around it
    const sentenceSoFar = text.slice(start, match.index).trim();
    const pieces = sentenceSoFar.split(/\s+/);
    const words = pieces.filter(Boolean);
    let lastWord = "";
    if (words.length) {
      const lowered = words[words.length - 1].toLowerCase();
      lastWord = lowered.replace(/^["'(“‘]+|["'(“‘]+$/g, "");
    }

    const isInitial = lastWord.length === 1 && /\p{L}/u.test(lastWord);
    if (endMark.startsWith(".")) {
      const isAbbreviation = EN_ABBR.has(lastWord);
      if (isAbbreviation || isInitial) {
        continue;
      }
    }

    const sentenceEnd = match.index + endMark.length;
    const range = trimmedRange(text, start, sentenceEnd);
    if (range) {
      ranges.push(range);
    }
    start = match.index + match[0].length;
  }

  const tail = trimmedRange(text, start, text.length);
  if (tail) {
    ranges.push(tail);
  }
  return ranges;
}

/** The sentences of a text as offset ranges [start, end), by the rules of its language. */
export function sentenceRanges(text, lang) {
  if (lang === "ja") {
    return jaRanges(text);
  }
  return enRanges(text);
}

/**
 * The sentences of a text as strings.
 *
 *     splitSentences("彼は「行くぞ。」と言った。次。", "ja") // ["彼は「行くぞ。」と言った。", "次。"]
 */
export function splitSentences(text, lang) {
  const ranges = sentenceRanges(text, lang);
  return ranges.map(([start, end]) => text.slice(start, end));
}

/** Whether a line has nothing but white space (the full-width space included). */
export function isBlank(line) {
  const withoutSpaces = line.replace(/[\s　]/g, "");
  return !withoutSpaces;
}

/** Whether a line ends a sentence: 。！？」』.!?" or a closing bracket, after any spaces (§5.2). */
export function endsSentence(line) {
  return /[。．！？」』.!?"”’)）\]］】〕〉》]\s*$/.test(line);
}

/**
 * The lines of one paragraph as one string (adapter join_lines). In a Japanese paragraph two
 * lines are joined with nothing between them where a Japanese character, or one of 。、」』）！？
 * at the first line's end, stands at the join. Any other two lines are joined with a space,
 * except that a word hyphenated at the end of a line is put back together (exam-\nple ->
 * example).
 */
export function joinLines(lines, lang) {
  let joined = "";

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      continue;
    }

    if (!joined) {
      joined = line;
      continue;
    }

    const lastChar = joined[joined.length - 1];

    let joinsAsJapanese = false;
    if (lang === "ja") {
      const japaneseAtJoin = isJaChar(lastChar) || isJaChar(line[0]);
      joinsAsJapanese = japaneseAtJoin || "。、」』）！？".includes(lastChar);
    }
    if (joinsAsJapanese) {
      joined += line;
      continue;
    }

    let hyphenated = false;
    if (joined.endsWith("-") && joined.length > 1) {
      const beforeHyphen = joined[joined.length - 2];
      hyphenated = /\p{L}/u.test(beforeHyphen) && /\p{Ll}/u.test(line[0]);
    }
    if (hyphenated) {
      const withoutHyphen = joined.slice(0, -1);
      joined = withoutHyphen + line;
      continue;
    }

    joined += " " + line;
  }

  return joined;
}
