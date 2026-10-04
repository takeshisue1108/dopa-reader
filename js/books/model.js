// The book model shared by every parser (SPEC_dopa v3 §5.1; ED D-68, D-77, D-78, D-103, D-107).
//
//   { key, title, author, format,
//     chapters: [{ title, firstBlock }],
//     blocks:   [{ kind: "text" | "heading" | "figure", chapter, page, lang,
//                  sentences: [{ display, speech, map, ends }], figure }],
//     endNotes: [ "底本：…", … ] }
//
// `display` is what is shown, `speech` what the voice sings (the reader sings every sentence). All
// indexes are string indexes (UTF-16 code units).
//
// A sentence's `map` follows the old reader (`dbr/adapter.py` speech_of, `app/js/player.js`
// speechToDisplay): null when the speech equals the display, else an array where
// map[speechIndex] = displayIndex. A ruby's reading is spoken; its base is displayed, and every
// character of the reading maps to the base's first character. `ends` goes with `map` (null when
// it is): ends[speechIndex] is the display index just past what that speech character shows, the
// next character for plain text and the end of the base for a ruby's reading. A word's display
// span runs from map[first] to ends[last], so a word with a ruby is its whole base (ED D-146).

import { detectLang, joinLines, sentenceRanges } from "./sentences.js";

/** A refusal of a file, shown as one line under the book list (ED ST-27). */
export class BookError extends Error {
  /** @param {string} message the exact string of the spec; @param {string} code a short name:
   * "format", "encoding", "empty", or "pdfNoText" (pdf.js) */
  constructor(message, code) {
    super(message);
    this.name = "BookError";
    this.code = code;
  }
}

export const MESSAGES = {
  format: "この形式は読めません（.txt・.md・.pdf）",
  encoding: "文字コードを判別できませんでした",
  empty: "読める本文がありませんでした",
};

/**
 * A displayed text and its speech, built piece by piece. `map[k]` is the display index of the
 * k-th speech character, and `ends[k]` the display index just past what it shows.
 */
export class Spoken {
  constructor() {
    this.display = "";
    this.speech = "";
    this.map = [];
    this.ends = [];
  }

  /** Text that is shown and sung as written. */
  plain(text) {
    for (let k = 0; k < text.length; k++) {
      const displayIndex = this.display.length + k;
      this.map.push(displayIndex);
      this.ends.push(displayIndex + 1);
    }

    this.display += text;
    this.speech += text;
    return this;
  }

  /** A ruby: `base` is shown, `reading` is sung (every reading character maps to the base's start
   * and ends at the base's end). */
  ruby(base, reading) {
    for (let k = 0; k < reading.length; k++) {
      const baseStart = this.display.length;
      this.map.push(baseStart);

      const baseEnd = baseStart + base.length;
      this.ends.push(baseEnd);
    }

    this.display += base;
    this.speech += reading;
    return this;
  }

  /** Text that is shown and not sung (an unmapped gaiji 「※」). */
  silent(text) {
    this.display += text;
    return this;
  }
}

/**
 * The sentences of a block from its Spoken text. `whole` makes one sentence of the trimmed text
 * (a heading, D-103). Sentences are cut on the display text, and the speech is cut with them.
 */
export function sentencesOf(spoken, lang, whole = false) {
  const { display, speech, map, ends } = spoken;

  let ranges;
  if (whole) {
    const withoutSpaceAtStart = display.trimStart();
    const start = display.length - withoutSpaceAtStart.length;
    const end = display.trimEnd().length;
    if (start < end) {
      ranges = [[start, end]];
    } else {
      ranges = [];
    }
  } else {
    ranges = sentenceRanges(display, lang);
  }

  const sentences = [];
  // map never goes back, so the speech of each sentence is one run from here
  let speechIndex = 0;

  for (const [start, end] of ranges) {
    while (speechIndex < map.length && map[speechIndex] < start) {
      speechIndex++;
    }
    const speechStart = speechIndex;
    while (speechIndex < map.length && map[speechIndex] < end) {
      speechIndex++;
    }

    const sentenceDisplay = display.slice(start, end);
    const sentenceSpeech = speech.slice(speechStart, speechIndex);

    let sentenceMap = null;
    let sentenceEnds = null;
    if (sentenceSpeech !== sentenceDisplay) {
      // the indexes count from the sentence's start
      const mapOfRun = map.slice(speechStart, speechIndex);
      sentenceMap = mapOfRun.map((index) => index - start);

      const endsOfRun = ends.slice(speechStart, speechIndex);
      sentenceEnds = endsOfRun.map((index) => index - start);
    }

    const sentence = {
      display: sentenceDisplay,
      speech: sentenceSpeech,
      map: sentenceMap,
      ends: sentenceEnds,
    };
    sentences.push(sentence);
  }

  return sentences;
}

/** A Spoken text of plain characters only. */
export function plainSpoken(text) {
  return new Spoken().plain(text);
}

/**
 * Collects the blocks of a book and its headings, and makes the model.
 * Parsers call addText(), addParagraph(), addHeading() and addFigure() in reading order, then
 * build().
 */
export class BookBuilder {
  constructor() {
    this.blocks = [];
    this.headingLevels = []; // [blockIndex, level] of every heading block
  }

  /** A text block; nothing is added when it has no sentence. */
  addText(spoken, { page = null, lang = null } = {}) {
    const blockLang = lang ?? detectLang(spoken.display);
    const sentences = sentencesOf(spoken, blockLang);
    if (!sentences.length) {
      return null;
    }

    const block = {
      kind: "text",
      chapter: 0,
      page,
      lang: blockLang,
      sentences,
      figure: null,
    };
    return this.push(block);
  }

  /** A text block of the lines of one paragraph of a hard-wrapped file or of a PDF, joined by
   * the rule of their language (D-68). Nothing is added for no lines. */
  addParagraph(lines, { page = null } = {}) {
    if (!lines.length) {
      return null;
    }

    const allText = lines.join("");
    const lang = detectLang(allText);

    const joined = joinLines(lines, lang);
    const spoken = plainSpoken(joined);
    const blockFields = {
      page,
      lang,
    };
    return this.addText(spoken, blockFields);
  }

  /** A heading block, sung as one sentence (D-103). `level`: 1 is the shallowest. */
  addHeading(spoken, level, { page = null } = {}) {
    const lang = detectLang(spoken.display);
    const sentences = sentencesOf(spoken, lang, true);
    if (!sentences.length) {
      return null;
    }

    const block = {
      kind: "heading",
      chapter: 0,
      page,
      lang,
      sentences,
      figure: null,
    };
    const index = this.push(block);

    this.headingLevels.push([index, level]);
    return index;
  }

  /** A figure block: no sentences, so nothing to sing and nothing to shoot (D-107). */
  addFigure({ src = null, label = null, page = null, kind = "image", table = null }) {
    const figure = {
      src,
      label,
      page,
      kind,
      table,
    };
    const block = {
      kind: "figure",
      chapter: 0,
      page,
      lang: null,
      sentences: [],
      figure,
    };
    return this.push(block);
  }

  /** Add a block; returns its index. Used by the add… methods. */
  push(block) {
    this.blocks.push(block);
    return this.blocks.length - 1;
  }

  /**
   * Where the chapters start (D-77): the heading blocks of the shallowest heading level used at
   * least twice, as block indexes.
   */
  chapterStarts() {
    // how many headings each level has
    const counts = new Map();
    for (const [, level] of this.headingLevels) {
      const countSoFar = counts.get(level) ?? 0;
      counts.set(level, countSoFar + 1);
    }

    // the levels from the shallowest
    const levels = [...counts.keys()];
    levels.sort((a, b) => a - b);

    const level = levels.find((candidate) => counts.get(candidate) >= 2);
    if (level === undefined) {
      return [];
    }

    const starts = [];
    for (const [index, candidate] of this.headingLevels) {
      if (candidate === level) {
        starts.push(index);
      }
    }
    return starts;
  }

  /**
   * The model. Throws 「読める本文がありませんでした」 when no block has a sentence.
   * Blocks before the first chapter heading form a chapter titled with the book's title, and a
   * book with no chapter heading is one chapter titled with its title (D-77).
   * Figure blocks take the language of the book: Japanese when at least as many sentences stand
   * in Japanese blocks as in English ones.
   */
  build({ key = null, title, author = null, format, endNotes = [] }) {
    const blocks = this.blocks;

    const hasSentence = blocks.some((block) => block.sentences.length);
    if (!hasSentence) {
      throw new BookError(MESSAGES.empty, "empty");
    }

    const chapterBlocks = this.chapterStarts();
    const chapters = [];

    const textBeforeFirstHeading = !chapterBlocks.length || chapterBlocks[0] > 0;
    if (textBeforeFirstHeading) {
      const openingChapter = {
        title,
        firstBlock: 0,
      };
      chapters.push(openingChapter);
    }

    for (const blockIndex of chapterBlocks) {
      const headingWords = blocks[blockIndex].sentences[0].display;
      const chapter = {
        title: headingWords,
        firstBlock: blockIndex,
      };
      chapters.push(chapter);
    }

    numberChapters(blocks, chapters);

    let jaSentences = 0;
    let enSentences = 0;
    for (const block of blocks) {
      if (block.lang === "ja") {
        jaSentences += block.sentences.length;
      } else if (block.lang === "en") {
        enSentences += block.sentences.length;
      }
    }
    const bookLang = jaSentences >= enSentences ? "ja" : "en";

    for (const block of blocks) {
      if (block.kind === "figure") {
        block.lang = bookLang;
      }
    }

    return {
      key,
      title,
      author,
      format,
      chapters,
      blocks,
      endNotes,
    };
  }
}

/** Give each block the number of its chapter (from 0): the last chapter that starts at the block
 * or before it. `chapters` are in order, the first at block 0. */
export function numberChapters(blocks, chapters) {
  let chapter = 0;

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    while (chapter + 1 < chapters.length) {
      const nextChapter = chapters[chapter + 1];
      const nextHasStarted = nextChapter.firstBlock <= blockIndex;
      if (!nextHasStarted) {
        break;
      }
      chapter++;
    }

    blocks[blockIndex].chapter = chapter;
  }
}

/** A file name without its folder and its extension. */
export function baseName(name) {
  const path = String(name ?? "");
  const pathParts = path.split(/[\\/]/);
  const file = pathParts.pop();

  const dot = file.lastIndexOf(".");
  if (dot > 0) {
    return file.slice(0, dot);
  }
  return file;
}
