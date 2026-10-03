// The plain-text parser (SPEC_dopa v3 §5.2 "Text"; ED D-68, D-77).
// Every line is a block, unless the file breaks lines inside sentences (isHardWrapped). Such a
// file is joined by D-68's rule: a line break ends a block only after a sentence end, and only
// when the next line starts a visual block (it is indented, or a blank line comes between).
// A plain text is not divided into chapters: it is read from its start as one chapter (ED D-115).

import { BookBuilder, baseName, plainSpoken } from "./model.js";
import { endsSentence, isBlank } from "./sentences.js";

/**
 * Whether the lines break inside sentences (§5.2): more than 40% of the non-blank lines end
 * without a sentence end, and more than 30% of the non-blank lines have about the same length
 * (within 2 characters of the most common length).
 * @param {string[]} lines
 */
export function isHardWrapped(lines) {
  const nonBlank = lines.map((line) => line.trimEnd()).filter((line) => line.trim());
  if (!nonBlank.length) return false;
  const unfinished = nonBlank.filter((line) => !endsSentence(line)).length;
  const lengths = nonBlank.map((line) => Array.from(line).length);
  const counts = new Map();
  for (const length of lengths) counts.set(length, (counts.get(length) ?? 0) + 1);
  // the most common length; of two equally common ones, the longer
  let commonLength = 0,
    commonCount = -1;
  for (const [length, count] of counts)
    if (count > commonCount || (count === commonCount && length > commonLength)) {
      commonLength = length;
      commonCount = count;
    }
  const nearCommon = lengths.filter((length) => Math.abs(length - commonLength) <= 2).length;
  return unfinished / nonBlank.length > 0.4 && nearCommon / nonBlank.length > 0.3;
}

/**
 * Parse a plain text (already decoded) into the book model.
 * @param {string} text
 * @param {{name?: string, key?: string|null}} options
 */
export function parseTextFile(text, { name = "", key = null } = {}) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const builder = new BookBuilder();

  if (!isHardWrapped(lines)) {
    for (const line of lines) {
      if (isBlank(line)) continue;
      builder.addText(plainSpoken(line.trim()));
    }
  } else {
    let pending = []; // the lines of the block being joined, not yet a block
    let blankSince = false; // a blank line came after the last line of `pending`
    const flush = () => {
      builder.addParagraph(pending);
      pending = [];
    };
    for (const line of lines) {
      if (isBlank(line)) {
        blankSince = true;
        continue;
      }
      const startsVisualBlock = blankSince || /^[\s　]/.test(line);
      if (pending.length && endsSentence(pending[pending.length - 1]) && startsVisualBlock) flush();
      pending.push(line);
      blankSince = false;
    }
    flush();
  }
  return builder.build({ key, title: baseName(name), author: null, format: "text" });
}
