// The Markdown parser (SPEC_dopa v3 §5.2 "Markdown"; ED D-68, D-75, D-77, D-108; base D-38).
// Front matter and HTML comments are removed. `#` headings are headings; the shallowest level
// used at least twice marks the chapters. In a soft-wrapped file every line is a block; in a
// hard-wrapped file (the test of text.js) the lines of a paragraph are joined up to a sentence
// end, and a blank line always ends a block. A pipe table is one figure block of kind "table".
// An image with a full URL is a figure block; one with a relative path is dropped. Footnote
// definitions are dropped. Lists and quotes are text blocks, one per item in a soft-wrapped file.
// Every non-blank line inside a fenced block is a text block, read as it is written.

import { BookBuilder, baseName, plainSpoken } from "./model.js";
import { endsSentence } from "./sentences.js";
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

/** Markdown inline syntax to plain display text (adapter clean_inline). Images are taken out by
 * the caller before: here `![a](b)` would come out as `!a`. */
export function cleanInline(text) {
  // footnote marks go; a link leaves its words; code marks go
  const withoutFootnoteMarks = text.replace(/\[\^[^\]]+\]/g, "");
  const withLinkWords = withoutFootnoteMarks.replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1");
  const withoutCodeMarks = withLinkWords.replace(/`([^`]*)`/g, "$1");

  // the marks of emphasis go, the longest first: *** and ___, ** and __, then * and _
  const withoutBoldItalic = withoutCodeMarks.replace(/(\*\*\*|___)(.+?)\1/g, "$2");
  const withoutBold = withoutBoldItalic.replace(/(\*\*|__)(.+?)\1/g, "$2");
  const withoutStarItalic = withoutBold.replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, "$1");
  const withoutItalic = withoutStarItalic.replace(/(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])/g, "$1");

  // HTML tags go; an escaped mark leaves the mark; runs of spaces become one space
  const withoutTags = withoutItalic.replace(/<[^>]+>/g, "");
  const unescaped = withoutTags.replace(/\\([\\`*_{}[\]()#+\-.!,&'"|<>~])/g, "$1");
  const singleSpaced = unescaped.replace(/[ \t]+/g, " ");

  return singleSpaced.trim();
}

/** The cells of a pipe table row. */
function cellsOf(row) {
  const trimmedRow = row.trim();
  const withoutFirstPipe = trimmedRow.replace(/^\|/, "");
  const withoutEdgePipes = withoutFirstPipe.replace(/\|$/, "");
  const rawCells = withoutEdgePipes.split(/(?<!\\)\|/);

  const cells = [];
  for (const rawCell of rawCells) {
    const trimmedCell = rawCell.trim();
    const cell = cleanInline(trimmedCell);
    cells.push(cell);
  }
  return cells;
}

/** Remove front matter (--- … --- at the top) and HTML comments; return the lines, and the title
 * and the author of the front matter as `meta`. */
function splitFrontMatter(text) {
  let body = text.replace(/^\uFEFF/, "");
  const meta = {};

  const frontMatter = body.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/);
  if (frontMatter) {
    const frontMatterLines = frontMatter[1].split(/\r?\n/);
    for (const line of frontMatterLines) {
      const pair = line.match(/^(title|author)\s*:\s*(.+?)\s*$/i);
      if (pair) {
        const field = pair[1].toLowerCase();
        const valueWithoutQuotes = pair[2].replace(/^["']|["']$/g, "");
        meta[field] = valueWithoutQuotes;
      }
    }
    body = body.slice(frontMatter[0].length);
  }

  body = body.replace(/<!--[\s\S]*?-->/g, "");
  const lines = body.split(/\r?\n/);
  return {
    lines,
    meta,
  };
}

/**
 * The lines that count when a file is judged hard-wrapped or not (the test of text.js): the lines
 * of paragraphs, of quotes and of list items without their marks, and every line inside a fenced
 * block. Headings, table rows, footnote definitions, rule lines and lines that are only an image
 * do not count.
 */
function paragraphLinesOf(lines) {
  const paragraphLines = [];
  let inFence = false;

  for (const line of lines) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }

    // inside a fenced block every line counts; outside it, these do not
    if (!inFence) {
      const hasText = line.trim();
      if (!hasText) {
        continue;
      }
      if (HEADING.test(line)) {
        continue;
      }
      if (TABLE_ROW.test(line)) {
        continue;
      }
      if (FOOTNOTE_DEF.test(line)) {
        continue;
      }
      if (HR.test(line)) {
        continue;
      }
      const isOnlyAnImage = /^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(line);
      if (isOnlyAnImage) {
        continue;
      }
    }

    const withoutQuoteMark = line.replace(QUOTE, "");
    const withoutMarks = withoutQuoteMark.replace(LIST_ITEM, "");
    paragraphLines.push(withoutMarks);
  }

  return paragraphLines;
}

/**
 * The title a Markdown file gives itself, or null: the front matter's `title`; else the first
 * heading, when it is of level 1 and the only heading of level 1. `headings` are [level, words]
 * in order.
 */
function titleOf(meta, headings) {
  let title = meta.title ?? null;

  if (!title && headings.length) {
    const firstHeading = headings[0];
    if (firstHeading[0] === 1) {
      let levelOneCount = 0;
      for (const [level] of headings) {
        if (level === 1) {
          levelOneCount++;
        }
      }

      if (levelOneCount === 1) {
        title = firstHeading[1];
      }
    }
  }

  return title;
}

/**
 * Parse a Markdown text (already decoded) into the book model.
 * The title is the front matter's `title`, else a single level-1 heading that is the first
 * heading, else the file name; the author is the front matter's `author`.
 * @param {string} text
 * @param {{name?: string, key?: string|null}} options
 */
export function parseMarkdown(text, { name = "", key = null } = {}) {
  const { lines, meta } = splitFrontMatter(text);
  const paragraphLines = paragraphLinesOf(lines);
  const hardWrapped = isHardWrapped(paragraphLines);

  const builder = new BookBuilder();
  // [level, text] in order
  const headings = [];
  // the lines of the block being joined, not yet a block (hard-wrapped files)
  let pending = [];

  const flush = () => {
    builder.addParagraph(pending);
    pending = [];
  };

  /** A line of text: its URL images become figures after it, relative images are dropped. */
  const addTextLine = (raw, startsItem) => {
    const figures = [];
    const withoutImages = raw.replace(IMAGE, (_, alt, src) => {
      if (FULL_URL.test(src)) {
        const label = alt.trim() || null;
        const figure = {
          src,
          label,
        };
        figures.push(figure);
      }
      return "";
    });
    const cleaned = cleanInline(withoutImages);

    if (startsItem) {
      flush();
    }

    if (cleaned) {
      if (!hardWrapped) {
        const spoken = plainSpoken(cleaned);
        builder.addText(spoken);
      } else {
        pending.push(cleaned);
        if (endsSentence(cleaned)) {
          flush();
        }
      }
    }

    if (figures.length) {
      flush();
      for (const figure of figures) {
        const imageFigure = {
          ...figure,
          kind: "image",
        };
        builder.addFigure(imageFigure);
      }
    }
  };

  let quoting = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (FENCE.test(line)) {
      flush();
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) {
        const fencedLine = lines[i].trim();
        if (fencedLine) {
          const spoken = plainSpoken(fencedLine);
          builder.addText(spoken);
        }
      }
      continue;
    }

    const isBlankLine = !line.trim();
    if (isBlankLine || HR.test(line)) {
      flush();
      quoting = false;
      continue;
    }

    const headingMatch = line.match(HEADING);
    if (headingMatch) {
      flush();

      const level = headingMatch[1].length;
      const wordsWithoutImages = headingMatch[2].replace(IMAGE, "");
      const words = cleanInline(wordsWithoutImages);

      const spoken = plainSpoken(words);
      const blockIndex = builder.addHeading(spoken, level);
      if (blockIndex !== null) {
        headings.push([level, words]);
      }
      continue;
    }

    if (FOOTNOTE_DEF.test(line)) {
      // base D-38: neither read nor shown, with its indented continuation lines
      flush();
      while (i + 1 < lines.length) {
        const continuesTheNote = /^(\s{2,}|\t)\S/.test(lines[i + 1]);
        if (!continuesTheNote) {
          break;
        }
        i++;
      }
      continue;
    }

    // a table: a row with a rule line right under it
    const isTableRow = TABLE_ROW.test(line);
    const hasNextLine = i + 1 < lines.length;
    if (isTableRow && hasNextLine) {
      const nextIsRule = TABLE_RULE.test(lines[i + 1]);
      if (nextIsRule) {
        flush();

        const headerCells = cellsOf(line);
        const rows = [headerCells];
        for (i += 2; i < lines.length && TABLE_ROW.test(lines[i]); i++) {
          const cells = cellsOf(lines[i]);
          rows.push(cells);
        }
        i--; // the for adds 1

        const tableFigure = {
          kind: "table",
          table: rows,
          label: null,
        };
        builder.addFigure(tableFigure);
        continue;
      }
    }

    const isQuote = QUOTE.test(line);
    if (isQuote !== quoting) {
      flush();
    }
    quoting = isQuote;

    let body = line;
    if (isQuote) {
      body = line.replace(QUOTE, "");
    }

    const isItem = LIST_ITEM.test(body);
    let words = body;
    if (isItem) {
      words = body.replace(LIST_ITEM, "");
    }
    addTextLine(words, isItem);
  }
  flush();

  const title = titleOf(meta, headings) || baseName(name);
  const author = meta.author ?? null;
  const bookFields = {
    key,
    title,
    author,
    format: "markdown",
  };
  return builder.build(bookFields);
}
