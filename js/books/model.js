// The book model shared by every parser (SPEC_dopa v3 §5.1; ED D-68, D-77, D-78, D-103, D-107).
//
//   { key, title, author, format,
//     chapters: [{ title, firstBlock }],
//     blocks:   [{ kind: "text" | "heading" | "figure", chapter, page, lang,
//                  sentences: [{ display, speech, map }], figure }],
//     endNotes: [ "底本：…", … ] }
//
// A sentence's `map` follows the old reader (`dbr/adapter.py` speech_of, `app/js/player.js`
// speechToDisplay): null when the speech equals the display, else an array where
// map[speechIndex] = displayIndex. A ruby's reading is spoken; its base is displayed, and every
// character of the reading maps to the base's first character.

import { detectLang, sentenceRanges } from "./sentences.js";

/** A refusal of a file, shown as one line under the book list (ED ST-27). */
export class BookError extends Error {
  /** @param {string} message the exact string of the spec; @param {string} code a short name */
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
 * k-th speech character.
 */
export class Spoken {
  constructor() {
    this.display = "";
    this.speech = "";
    this.map = [];
  }

  /** Text that is shown and sung as written. */
  plain(text) {
    for (let k = 0; k < text.length; k++) this.map.push(this.display.length + k);
    this.display += text;
    this.speech += text;
    return this;
  }

  /** A ruby: `base` is shown, `reading` is sung (every reading character maps to the base's start). */
  ruby(base, reading) {
    for (let k = 0; k < reading.length; k++) this.map.push(this.display.length);
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
  const { display, speech, map } = spoken;
  let ranges;
  if (whole) {
    const start = display.length - display.trimStart().length;
    const end = display.trimEnd().length;
    ranges = start < end ? [[start, end]] : [];
  } else ranges = sentenceRanges(display, lang);
  const sentences = [];
  let k = 0; // the speech index; map is non-decreasing, so each sentence's speech is one run
  for (const [start, end] of ranges) {
    while (k < map.length && map[k] < start) k++;
    const from = k;
    while (k < map.length && map[k] < end) k++;
    const shown = display.slice(start, end);
    const sung = speech.slice(from, k);
    sentences.push({
      display: shown,
      speech: sung,
      map: sung === shown ? null : map.slice(from, k).map((index) => index - start),
    });
  }
  return sentences;
}

/** A Spoken text of plain characters only. */
export function plainSpoken(text) {
  return new Spoken().plain(text);
}

/**
 * Collects the blocks of a book and its headings, and makes the model.
 * Parsers call text(), heading() and figure() in reading order, then book().
 */
export class BookBuilder {
  constructor() {
    this.blocks = [];
    this.headingLevels = []; // [blockIndex, level] of every heading block
    this.chapterMarks = null; // block indexes that start a chapter, when the parser decides them
  }

  /** A text block; nothing is added when it has no sentence. */
  text(spoken, { page = null, lang = null } = {}) {
    const blockLang = lang ?? detectLang(spoken.display);
    const sentences = sentencesOf(spoken, blockLang);
    if (!sentences.length) return null;
    return this.push({ kind: "text", chapter: 0, page, lang: blockLang, sentences, figure: null });
  }

  /** A heading block, sung as one sentence (D-103). `level`: 1 is the shallowest. */
  heading(spoken, level, { page = null } = {}) {
    const lang = detectLang(spoken.display);
    const sentences = sentencesOf(spoken, lang, true);
    if (!sentences.length) return null;
    const index = this.push({ kind: "heading", chapter: 0, page, lang, sentences, figure: null });
    this.headingLevels.push([index, level]);
    return index;
  }

  /** A figure block: no sentences, no enemies (D-107). */
  figure({ src = null, label = null, page = null, kind = "image", table = null }) {
    return this.push({
      kind: "figure",
      chapter: 0,
      page,
      lang: null,
      sentences: [],
      figure: { src, label, page, kind, table },
    });
  }

  push(block) {
    this.blocks.push(block);
    return this.blocks.length - 1;
  }

  /**
   * The chapters (D-77): the heading blocks of the shallowest heading level used at least twice.
   * Blocks before the first such heading form a chapter titled with the book's title, and a book
   * with no chapter heading is one chapter titled with its title.
   */
  chapterStarts() {
    if (this.chapterMarks) return this.chapterMarks;
    const counts = new Map();
    for (const [, level] of this.headingLevels) counts.set(level, (counts.get(level) ?? 0) + 1);
    const levels = [...counts.keys()].sort((a, b) => a - b);
    const level = levels.find((l) => counts.get(l) >= 2);
    if (level === undefined) return [];
    return this.headingLevels.filter(([, l]) => l === level).map(([index]) => index);
  }

  /**
   * The model. Throws 「読める本文がありませんでした」 when no block has a sentence.
   * Figure blocks take the language of the book (the language of most of its sentences).
   */
  book({ key = null, title, author = null, format, endNotes = [] }) {
    const blocks = this.blocks;
    if (!blocks.some((block) => block.sentences.length)) throw new BookError(MESSAGES.empty, "empty");
    const starts = this.chapterStarts();
    const chapters = [];
    if (!starts.length || starts[0] > 0) chapters.push({ title, firstBlock: 0 });
    for (const index of starts)
      chapters.push({ title: blocks[index].sentences[0].display, firstBlock: index });
    let chapter = 0;
    for (let index = 0; index < blocks.length; index++) {
      while (chapter + 1 < chapters.length && chapters[chapter + 1].firstBlock <= index) chapter++;
      blocks[index].chapter = chapter;
    }
    let ja = 0,
      en = 0;
    for (const block of blocks)
      if (block.lang === "ja") ja += block.sentences.length;
      else if (block.lang === "en") en += block.sentences.length;
    const bookLang = ja >= en ? "ja" : "en";
    for (const block of blocks) if (block.kind === "figure") block.lang = bookLang;
    return { key, title, author, format, chapters, blocks, endNotes };
  }
}

/** A file name without its folder and its extension. */
export function baseName(name) {
  const file = String(name ?? "").split(/[\\/]/).pop();
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
}
