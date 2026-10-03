// The plain-text parser (SPEC_dopa v3 §5.2 "Text"; ED D-68, D-77).
// Every line is a block, unless the file breaks lines inside sentences (isHardWrapped). Such a
// file is joined by D-68's rule: a line break ends a block only after a sentence end, and only
// when the next line starts a visual block (it is indented, or a blank line comes between).
// A plain text is not divided into chapters: it is read from its start as one chapter (ED D-115).
// isChapterLine (a line that starts with 「第N章」「第N話」「第N部」「Chapter N」 or 「CHAPTER N」 and
// is shorter than 40 characters) is kept for a PDF without an outline (§5.2 PDF step 5).

import { BookBuilder, baseName, plainSpoken } from "./model.js";
import { detectLang, endsSentence, joinLines } from "./sentences.js";

const CHAPTER_LINE = /^[\s　]*(第[0-9０-９一二三四五六七八九十百千〇零]+[章話部]|(Chapter|CHAPTER)\s+([0-9]+|[IVXLC]+)\b)/;

/** Whether a line is a chapter heading (§5.2 "Text"). */
export function isChapterLine(line) {
  return CHAPTER_LINE.test(line) && Array.from(line.trim()).length < 40;
}

/**
 * Whether the lines break inside sentences (§5.2): more than 40% of the non-blank lines end
 * without a sentence end, and more than 30% of them have about the same length (within 2
 * characters of the most common length).
 * @param {string[]} lines
 */
export function isHardWrapped(lines) {
  const filled = lines.map((line) => line.trimEnd()).filter((line) => line.trim());
  if (!filled.length) return false;
  const open = filled.filter((line) => !endsSentence(line)).length;
  const lengths = filled.map((line) => Array.from(line).length);
  const counts = new Map();
  for (const length of lengths) counts.set(length, (counts.get(length) ?? 0) + 1);
  let common = 0,
    best = -1;
  for (const [length, count] of counts)
    if (count > best || (count === best && length > common)) {
      common = length;
      best = count;
    }
  const near = lengths.filter((length) => Math.abs(length - common) <= 2).length;
  return open / filled.length > 0.4 && near / filled.length > 0.3;
}

/**
 * Parse a plain text (already decoded) into the book model.
 * @param {string} text
 * @param {{name?: string, key?: string|null}} options
 */
export function parseTextFile(text, { name = "", key = null } = {}) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const builder = new BookBuilder();

  if (!isHardWrapped(lines)) {
    for (const line of lines) {
      if (!line.replace(/[\s　]/g, "")) continue;
      builder.text(plainSpoken(line.trim()));
    }
  } else {
    let open = []; // the lines of the block being joined
    let blankSince = false; // a blank line came after the last line of `open`
    const flush = () => {
      if (!open.length) return;
      const lang = detectLang(open.join(""));
      builder.text(plainSpoken(joinLines(open, lang)), { lang });
      open = [];
    };
    for (const line of lines) {
      if (!line.replace(/[\s　]/g, "")) {
        blankSince = true;
        continue;
      }
      const startsVisualBlock = blankSince || /^[\s　]/.test(line);
      if (open.length && endsSentence(open[open.length - 1]) && startsVisualBlock) flush();
      open.push(line);
      blankSince = false;
    }
    flush();
  }
  return builder.book({ key, title: baseName(name), author: null, format: "text" });
}
