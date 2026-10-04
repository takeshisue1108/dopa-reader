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
  const nonBlank = [];
  for (const line of lines) {
    const withoutSpaceAtEnd = line.trimEnd();
    if (withoutSpaceAtEnd.trim()) {
      nonBlank.push(withoutSpaceAtEnd);
    }
  }
  if (!nonBlank.length) {
    return false;
  }

  let unfinished = 0;
  for (const line of nonBlank) {
    if (!endsSentence(line)) {
      unfinished++;
    }
  }

  const lengths = nonBlank.map((line) => Array.from(line).length);

  const counts = new Map();
  for (const length of lengths) {
    const countSoFar = counts.get(length) ?? 0;
    counts.set(length, countSoFar + 1);
  }

  // the most common length; of two equally common ones, the longer
  let commonLength = 0;
  let commonCount = -1;
  for (const [length, count] of counts) {
    const moreCommon = count > commonCount;
    const asCommonAndLonger = count === commonCount && length > commonLength;
    if (moreCommon || asCommonAndLonger) {
      commonLength = length;
      commonCount = count;
    }
  }

  let nearCommon = 0;
  for (const length of lengths) {
    const distance = Math.abs(length - commonLength);
    if (distance <= 2) {
      nearCommon++;
    }
  }

  const unfinishedShare = unfinished / nonBlank.length;
  const nearCommonShare = nearCommon / nonBlank.length;
  return unfinishedShare > 0.4 && nearCommonShare > 0.3;
}

/**
 * Parse a plain text (already decoded) into the book model.
 * @param {string} text
 * @param {{name?: string, key?: string|null}} options
 */
export function parseTextFile(text, { name = "", key = null } = {}) {
  const withoutByteOrderMark = text.replace(/^\uFEFF/, "");
  const lines = withoutByteOrderMark.split(/\r?\n/);
  const builder = new BookBuilder();

  if (!isHardWrapped(lines)) {
    for (const line of lines) {
      if (isBlank(line)) {
        continue;
      }
      const trimmed = line.trim();
      const spoken = plainSpoken(trimmed);
      builder.addText(spoken);
    }
  } else {
    // the lines of the block being joined, not yet a block
    let pending = [];

    // a blank line came after the last line of `pending`
    let blankSince = false;

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
      if (pending.length) {
        const lastLine = pending[pending.length - 1];
        if (endsSentence(lastLine) && startsVisualBlock) {
          flush();
        }
      }

      pending.push(line);
      blankSince = false;
    }
    flush();
  }

  const title = baseName(name);
  const bookFields = {
    key,
    title,
    author: null,
    format: "text",
  };
  return builder.build(bookFields);
}
