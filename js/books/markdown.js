// The Markdown parser (SPEC_dopa v3 §5.2 "Markdown"; ED D-68, D-75, D-77, D-108; base D-38).
// Front matter and HTML comments are removed. `#` headings are headings; the shallowest level
// used at least twice marks the chapters. In a soft-wrapped file every line is a block; in a
// hard-wrapped file (the test of text.js) the lines of a paragraph are joined up to a sentence
// end, and a blank line always ends a block. A pipe table is one figure block of kind "table".
// An image with a full URL is a figure block; one with a relative path is dropped. Footnote
// definitions are dropped. Lists and quotes are text blocks, one per item.

import { BookBuilder, baseName, plainSpoken } from "./model.js";
import { detectLang, endsSentence, joinLines } from "./sentences.js";
import { isHardWrapped } from "./text.js";

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const FOOTNOTE_DEF = /^\[\^[^\]]+\]:/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const QUOTE = /^\s*>\s?/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const IMAGE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const FULL_URL = /^https?:\/\//i;

/** Markdown inline syntax to plain display text (adapter clean_inline, without images). */
export function cleanInline(text) {
  return text
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*\*|___)(.+?)\1/g, "$2")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!,&'"|<>~])/g, "$1")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** The cells of a pipe table row. */
function cells(row) {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cleanInline(cell.trim()));
}

/** Remove front matter (--- … --- at the top) and HTML comments; return the lines and the front matter. */
function strip(text) {
  let body = text.replace(/^﻿/, "");
  const meta = {};
  const front = body.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/);
  if (front) {
    for (const line of front[1].split(/\r?\n/)) {
      const pair = line.match(/^(title|author)\s*:\s*(.+?)\s*$/i);
      if (pair) meta[pair[1].toLowerCase()] = pair[2].replace(/^["']|["']$/g, "");
    }
    body = body.slice(front[0].length);
  }
  body = body.replace(/<!--[\s\S]*?-->/g, "");
  return { lines: body.split(/\r?\n/), meta };
}

/**
 * Parse a Markdown text (already decoded) into the book model.
 * The title is the front matter's `title`, else a single level-1 heading that is the first
 * heading, else the file name; the author is the front matter's `author`.
 * @param {string} text
 * @param {{name?: string, key?: string|null}} options
 */
export function parseMarkdown(text, { name = "", key = null } = {}) {
  const { lines, meta } = strip(text);
  const paragraphLines = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;
    else if (
      inFence ||
      (line.trim() &&
        !HEADING.test(line) &&
        !TABLE_ROW.test(line) &&
        !FOOTNOTE_DEF.test(line) &&
        !HR.test(line) &&
        !/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(line))
    )
      paragraphLines.push(line.replace(QUOTE, "").replace(LIST_ITEM, ""));
  }
  const hard = isHardWrapped(paragraphLines);

  const builder = new BookBuilder();
  const headings = []; // [level, text] in order
  let open = []; // lines of the block being joined (hard-wrapped files)
  const flush = () => {
    if (!open.length) return;
    const lang = detectLang(open.join(""));
    builder.text(plainSpoken(joinLines(open, lang)), { lang });
    open = [];
  };
  /** A line of text: its URL images become figures after it, relative images are dropped. */
  const textLine = (raw, startsItem) => {
    const figures = [];
    const words = raw.replace(IMAGE, (_, alt, src) => {
      if (FULL_URL.test(src)) figures.push({ src, label: alt.trim() || null });
      return "";
    });
    const line = cleanInline(words);
    if (startsItem) flush();
    if (line) {
      if (!hard) builder.text(plainSpoken(line));
      else {
        open.push(line);
        if (endsSentence(line)) flush();
      }
    }
    if (figures.length) {
      flush();
      for (const figure of figures) builder.figure({ ...figure, kind: "image" });
    }
  };

  let quoting = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      flush();
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++)
        if (lines[i].trim()) builder.text(plainSpoken(lines[i].trim()));
      continue;
    }
    if (!line.trim() || HR.test(line)) {
      flush();
      quoting = false;
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      flush();
      const words = cleanInline(heading[2].replace(IMAGE, ""));
      const index = builder.heading(plainSpoken(words), heading[1].length);
      if (index !== null) headings.push([heading[1].length, words]);
      continue;
    }
    if (FOOTNOTE_DEF.test(line)) {
      flush(); // base D-38: neither read nor shown, with its indented continuation lines
      while (i + 1 < lines.length && /^(\s{2,}|\t)\S/.test(lines[i + 1])) i++;
      continue;
    }
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      flush();
      const rows = [cells(line)];
      for (i += 2; i < lines.length && TABLE_ROW.test(lines[i]); i++) rows.push(cells(lines[i]));
      i--;
      builder.figure({ kind: "table", table: rows, label: null });
      continue;
    }
    const isQuote = QUOTE.test(line);
    if (isQuote !== quoting) flush();
    quoting = isQuote;
    const body = isQuote ? line.replace(QUOTE, "") : line;
    const item = LIST_ITEM.test(body);
    textLine(item ? body.replace(LIST_ITEM, "") : body, item);
  }
  flush();

  let title = meta.title ?? null;
  if (!title && headings.length && headings[0][0] === 1 && headings.filter(([l]) => l === 1).length === 1)
    title = headings[0][1];
  return builder.book({
    key,
    title: title || baseName(name),
    author: meta.author ?? null,
    format: "markdown",
  });
}
