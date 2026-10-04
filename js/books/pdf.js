// The PDF parser (SPEC_dopa v3 §5.2 "PDF"; ED D-68, D-72, D-75, D-77, D-108, D-115).
//
// Two parts. The pure part, parsePdfText(), takes the text of every page as readDocument() records
// it from the pdf.js library's getTextContent() (items of {str, transform, width, height,
// vertical}, where `vertical` tells a vertical font; plus the page's view box), the outline as
// [{title, page}], and the document's title and author, and returns the book model. It has no
// browser dependency and is tested with node on recorded items. The wrapper, parsePdf(), loads
// the library from vendor/pdfjs/, reads the document with readDocument(), and calls the pure
// part.
//
// 1. A file with fewer than 20 characters per page on average is refused (D-72): parsePdfText.
// 2. Lines (runsOf, rowLinesOf, columnLinesOf, pageLines): items on the same baseline, within
//    half a line height, are joined left to right. Vertical text (rotated items, items of a
//    vertical font, or single glyphs stacked one under the other) makes columns, read top to
//    bottom, right to left.
// 3. Running heads and page numbers are dropped (dropRunningHeads): a line in the top or bottom
//    8% of the page that repeats on at least half the pages, or that holds only a number.
// 4. Blocks (D-68; measures, startsVisualBlock): a line ends a block when it ends with a sentence
//    end and the next line starts a visual block (a gap of more than 1.5 times the median line
//    gap, an indent of one character, or a new page after a line shorter than 80% of the median
//    line length). Hyphenated English line ends are joined without the hyphen.
// 5. Chapters (chapterLinesOf, setChapters): the outline's entries at their pages; else the lines
//    that pass isChapterLine.
// 6. Figures (D-108; isFigureLine): a line that starts with 図N, 表N, Figure N or Table N puts a
//    figure block of kind "pdfPage" before the block that holds it, once per page. The line
//    stays in the text.

import { BookBuilder, BookError, baseName, numberChapters, plainSpoken } from "./model.js";
import { detectLang, isJaChar } from "./sentences.js";

/** The refusal of a PDF without a text layer (D-72, ST-27). */
export const NO_TEXT = "この PDF には文字が入っていません";

const MIN_CHARS_PER_PAGE = 20;
// the top and bottom bands of a page, where running heads and numbers sit
const HEAD_BAND = 0.08;
const BLOCK_GAP_FACTOR = 1.5;
const SHORT_LINE_RATIO = 0.8;
// One character of indent. A Japanese paragraph is indented by exactly one em, so the measure
// allows for rounding: an indent of 90% of a character width or more counts.
const MIN_INDENT_CHARS = 0.9;
// §6.7: a PDF figure's label is its line cut at 24 characters
const LABEL_MAX_CHARS = 24;

const SENTENCE_END = /[。．！？.!?][」』）)\]］】〕〉》"”’']*$/;
const FIGURE_LINE =
  /^[\s　]*(図|表|Figure|Table)\s*[0-9０-９]+([.．\-－‐–][0-9０-９]+)?(?![0-9０-９])/;
const CHAPTER_LINE =
  /^[\s　]*(第[0-9０-９一二三四五六七八九十百千〇零]+[章話部]|(Chapter|CHAPTER)\s+([0-9]+|[IVXLC]+)\b)/;
const ONLY_NUMBER = /^[\s　\-–—(（[［]*([0-9０-９]+|[ivxlcdm]+|[IVXLCDM]+)[\s　\-–—)）\]］]*$/;

/**
 * Kangxi radicals, vertical presentation forms and compatibility ideographs to the ordinary
 * characters. Some fonts map their glyphs to these (⾒ for 見, ︑ for 、 in vertical text); other
 * characters are left as they are, so full-width letters stay full-width.
 */
export function normalizeText(text) {
  return text.replace(/[⺀-⿟豈-﫿︐-︟︰-﹏]/g, (ch) => ch.normalize("NFKC"));
}

/** Whether a line ends with a sentence end (。．！？.!?, then any closing brackets or quotes). */
export function endsSentencePdf(text) {
  const withoutSpaceAtEnd = text.trimEnd();
  return SENTENCE_END.test(withoutSpaceAtEnd);
}

/** Whether a line reads as a chapter heading, for a PDF without an outline (§5.2 PDF step 5): it
 * starts with 「第N章」「第N話」「第N部」「Chapter N」 or 「CHAPTER N」 and is shorter than 40 characters. */
export function isChapterLine(line) {
  if (!CHAPTER_LINE.test(line)) {
    return false;
  }

  const trimmed = line.trim();
  const characters = Array.from(trimmed);
  return characters.length < 40;
}

/** Whether a line marks a figure (§5.2 step 6). */
export function isFigureLine(text) {
  return FIGURE_LINE.test(text);
}

const median = (values) => {
  if (!values.length) {
    return NaN;
  }

  const sorted = [...values];
  sorted.sort((a, b) => a - b);

  const mid = sorted.length >> 1;
  const countIsOdd = sorted.length % 2;
  if (countIsOdd) {
    return sorted[mid];
  }

  const sumOfMiddleTwo = sorted[mid - 1] + sorted[mid];
  return sumOfMiddleTwo / 2;
};

// ------------------------------------------------------------------ lines (step 2)

/**
 * Find vertical text drawn glyph by glyph, and make its glyphs vertical runs (in place). A single
 * glyph placed right under or above the run before or after it (in the order of the content
 * stream), and not beside either, is such a glyph. The glyphs are marked first and turned into
 * vertical runs after: `stacked` must see every neighbour as still horizontal.
 */
function turnStackedGlyphs(runs) {
  // stacked: at nearly the same x (within 0.3 of a character) and between half a character and
  // two characters above or below
  const stacked = (run, other) => {
    if (!other) {
      return other;
    }
    if (other.vertical) {
      return false;
    }

    const xDistance = Math.abs(other.x - run.x);
    const atSameX = xDistance < 0.3 * run.size;
    if (!atSameX) {
      return false;
    }

    const yDistance = Math.abs(other.y - run.y);
    return yDistance > 0.5 * run.size && yDistance < 2 * run.size;
  };

  // beside: on nearly the same baseline (within 0.3 of a character), and its near edge within
  // one character of the run's left or right end
  const beside = (run, other) => {
    if (!other) {
      return other;
    }

    const baselineDistance = Math.abs(other.y - run.y);
    const onSameBaseline = baselineDistance < 0.3 * run.size;
    if (!onSameBaseline) {
      return false;
    }

    const runRightEnd = run.x + run.width;
    const gapAtRight = Math.abs(other.x - runRightEnd);
    if (gapAtRight < run.size) {
      return true;
    }

    const otherRightEnd = other.x + other.width;
    const gapAtLeft = Math.abs(run.x - otherRightEnd);
    return gapAtLeft < run.size;
  };

  runs.forEach((run, i) => {
    if (run.vertical) {
      return;
    }
    const glyphs = Array.from(run.str.trim());
    if (glyphs.length !== 1) {
      return;
    }

    const before = runs[i - 1];
    const after = runs[i + 1];

    const isStacked = stacked(run, before) || stacked(run, after);
    if (!isStacked) {
      return;
    }
    if (beside(run, before)) {
      return;
    }
    if (beside(run, after)) {
      return;
    }

    run.kind = "glyph";
  });

  for (const run of runs) {
    if (run.kind === "glyph") {
      const asVerticalRun = {
        vertical: true,
        top: run.y - run.size,
        bottom: run.y,
      };
      Object.assign(run, asVerticalRun);
    }
  }
}

/**
 * The glyph runs of a page in reading space. y grows downward from the page's top. A horizontal
 * run starts at x and is `width` long; a vertical run goes from `top` down to `bottom`.
 */
function runsOf(page) {
  const [x0, y0, x1, y1] = page.view ?? [0, 0, page.width, page.height];

  // the items that have text, with their text normalized
  const items = [];
  for (const item of page.items) {
    const str = normalizeText(item.str ?? "");
    const normalized = {
      ...item,
      str,
    };
    if (normalized.str.trim()) {
      items.push(normalized);
    }
  }

  const runs = items.map((item) => {
    // the item's matrix: (e, f) is its origin on the page; b is not 0 when the text is turned
    const [a, b, c, d, e, f] = item.transform;
    const scaleX = Math.hypot(a, b);
    const scaleY = Math.hypot(c, d);
    const rotated = Math.abs(b) > Math.abs(a);

    // the library gives the font size as the height of horizontal text; of a vertical font the
    // height is the advance down the column, so there the size comes from the matrix
    let size;
    const heightIsFontSize = Math.abs(item.height) > 0 && !item.vertical;
    if (heightIsFontSize) {
      size = Math.abs(item.height);
    } else {
      size = Math.max(scaleX, scaleY);
    }

    const run = {
      str: item.str.trim(),
      x: e - x0,
      y: y1 - f,
      size,
      width: Math.abs(item.width),
      vertical: false,
      kind: "h",
    };
    // leading spaces drawn as glyphs indent the text: an em for a full-width space, a quarter else
    const leadingSpaces = item.str.match(/^\s*/)[0];
    let leadInChars = 0;
    for (const ch of Array.from(leadingSpaces)) {
      const spaceInChars = ch === "　" ? 1 : 0.25;
      leadInChars = leadInChars + spaceInChars;
    }
    const leadShift = leadInChars * size;

    if (item.vertical) {
      // a vertical font: the item's origin is its top, and its height is its advance down the
      // column
      const advance = Math.abs(item.height);
      const asFontColumn = {
        vertical: true,
        kind: "font",
        top: run.y + leadShift,
        bottom: run.y + advance,
        size: scaleX,
      };
      Object.assign(run, asFontColumn);
    } else if (rotated) {
      // text turned by a quarter: it runs down the page (b < 0) or up. Text that runs up is
      // still joined top to bottom: its reading order is not followed
      const length = Math.abs(item.width);

      let topBeforeLead;
      let bottom;
      if (b < 0) {
        topBeforeLead = run.y;
        bottom = run.y + length;
      } else {
        topBeforeLead = run.y - length;
        bottom = run.y;
      }

      const asTurnedText = {
        vertical: true,
        kind: "rotated",
        top: topBeforeLead + leadShift,
        bottom,
        size: scaleX,
      };
      Object.assign(run, asTurnedText);
    } else {
      run.x += leadShift;
      const widthAfterLead = run.width - leadShift;
      run.width = Math.max(0, widthAfterLead);
    }

    return run;
  });

  turnStackedGlyphs(runs);

  return {
    runs,
    width: x1 - x0,
    height: y1 - y0,
  };
}

/**
 * Text pieces joined in order. Where a Japanese letter stands at either side of a join, a gap of
 * half a character or more is a full-width space; at any other join a gap of more than a quarter
 * is a space.
 */
function joinPieces(pieces, gapOf) {
  let text = "";

  pieces.forEach((piece, i) => {
    const str = piece.str;

    if (i && text) {
      const gap = gapOf(pieces[i - 1], piece);
      const japanese = isJaChar(text[text.length - 1]) || isJaChar(str[0]);

      if (japanese) {
        if (gap >= 0.5 * piece.size) {
          text += "　";
        }
      } else if (gap > 0.25 * piece.size) {
        text += " ";
      }
    }

    text += str;
  });

  const singleSpaced = text.replace(/[ \t\r\n]+/g, " ");
  return singleSpaced.trim();
}

/** The horizontal lines of a page, top to bottom: runs within half the larger font size of a
 * line's baseline join it, and are joined left to right. */
function rowLinesOf(runs, pageNumber) {
  const rowLines = [];

  // the horizontal runs, top to bottom, and left to right on one baseline
  const horizontal = runs.filter((run) => !run.vertical);
  horizontal.sort((p, q) => {
    const byBaseline = p.y - q.y;
    if (byBaseline) {
      return byBaseline;
    }
    return p.x - q.x;
  });

  const rows = [];
  for (const run of horizontal) {
    const row = rows.find((candidate) => {
      const baselineDistance = Math.abs(candidate.y - run.y);
      const largerSize = Math.max(candidate.size, run.size);
      return baselineDistance <= 0.5 * largerSize;
    });

    if (row) {
      row.runs.push(run);
      row.size = Math.max(row.size, run.size);
    } else {
      const newRow = {
        y: run.y,
        size: run.size,
        runs: [run],
      };
      rows.push(newRow);
    }
  }

  for (const row of rows) {
    row.runs.sort((p, q) => p.x - q.x);

    // the gap from the right end of one run to the start of the next
    const gapBetween = (p, q) => {
      const rightEndOfP = p.x + p.width;
      return q.x - rightEndOfP;
    };
    const text = joinPieces(row.runs, gapBetween);
    if (!text) {
      continue;
    }

    const start = row.runs[0].x;
    const rightEnds = row.runs.map((run) => run.x + run.width);
    const end = Math.max(...rightEnds);

    const rowLine = {
      text,
      page: pageNumber,
      vertical: false,
      pos: row.y,
      start,
      end,
      size: row.size,
      top: row.y - row.size,
      bottom: row.y,
    };
    rowLines.push(rowLine);
  }

  return rowLines;
}

/** The vertical lines of a page, right to left: runs at the same x (within half the larger font
 * size) make a column, which is split where a gap of two characters or more opens or where a
 * run starts above the column's top, and are joined top to bottom. */
function columnLinesOf(runs, pageNumber) {
  // the vertical runs, right to left, and top to bottom at one x
  const vertical = runs.filter((run) => run.vertical);
  vertical.sort((p, q) => {
    const byX = q.x - p.x;
    if (byX) {
      return byX;
    }
    return p.top - q.top;
  });

  const columns = [];
  for (const run of vertical) {
    const column = columns.find((candidate) => {
      const xDistance = Math.abs(candidate.x - run.x);
      const largerSize = Math.max(candidate.size, run.size);
      const atSameX = xDistance <= 0.5 * largerSize;
      if (!atSameX) {
        return false;
      }

      const gapUnderColumn = run.top - candidate.bottom;
      const closeUnderColumn = gapUnderColumn < 2 * candidate.size;
      const notAboveColumn = run.top >= candidate.top;
      return closeUnderColumn && notAboveColumn;
    });

    if (column) {
      column.runs.push(run);
      column.bottom = Math.max(column.bottom, run.bottom);
    } else {
      const newColumn = {
        x: run.x,
        size: run.size,
        top: run.top,
        bottom: run.bottom,
        runs: [run],
      };
      columns.push(newColumn);
    }
  }

  const columnLines = [];

  // the columns, right to left, and top to bottom at one x
  columns.sort((p, q) => {
    const byX = q.x - p.x;
    if (byX) {
      return byX;
    }
    return p.top - q.top;
  });

  for (const column of columns) {
    column.runs.sort((p, q) => p.top - q.top);

    const text = joinPieces(column.runs, (p, q) => q.top - p.bottom);
    if (!text) {
      continue;
    }

    const columnLine = {
      text,
      page: pageNumber,
      vertical: true,
      pos: -column.x,
      start: column.top,
      end: column.bottom,
      size: column.size,
      top: column.top,
      bottom: column.bottom,
    };
    columnLines.push(columnLine);
  }

  return columnLines;
}

/**
 * The lines of one page, in reading order. A line is
 * { text, page, vertical, pos, start, end, size, top, bottom, pageHeight }: `page` is its page's
 * number; `pos` is where the line stands across the reading direction (its baseline, or minus its
 * column's x, so that it grows in reading order); `start` and `end` are its extent along the
 * line; `top` and `bottom` bound it on the page; `pageHeight` is for the bands of running heads.
 * @param {{view?: number[], width?: number, height?: number, items: object[]}} page
 * @param {number} pageNumber from 1
 */
export function pageLines(page, pageNumber) {
  const { runs, height } = runsOf(page);

  const rowLines = rowLinesOf(runs, pageNumber);
  const columnLines = columnLinesOf(runs, pageNumber);

  // a page of mostly vertical text: horizontal lines above its columns come first, the rest after
  const charsIn = (list) => {
    let chars = 0;
    for (const line of list) {
      chars = chars + Array.from(line.text).length;
    }
    return chars;
  };

  let ordered = [...rowLines, ...columnLines];

  if (charsIn(columnLines) > charsIn(rowLines)) {
    const columnTops = columnLines.map((line) => line.top);
    const topOfColumns = Math.min(...columnTops);

    const rowsAboveColumns = rowLines.filter((line) => line.bottom <= topOfColumns);
    const rowsAfterColumns = rowLines.filter((line) => line.bottom > topOfColumns);
    ordered = [...rowsAboveColumns, ...columnLines, ...rowsAfterColumns];
  }

  return ordered.map((line) => ({ ...line, pageHeight: height }));
}

// ------------------------------------------------------------------ running heads (step 3)

const inBand = (line) => {
  const middle = (line.top + line.bottom) / 2;

  const topBandEnd = HEAD_BAND * line.pageHeight;
  if (middle < topBandEnd) {
    return true;
  }

  const bottomBandStart = (1 - HEAD_BAND) * line.pageHeight;
  return middle > bottomBandStart;
};

const headKey = (text) => {
  const withoutSpaces = text.replace(/[\s　]/g, "");
  return withoutSpaces.replace(/[0-9０-９]+/g, "#");
};

/**
 * The lines of every page without running heads and page numbers: a line in the top or bottom 8%
 * that holds only a number, or whose words (numbers aside) repeat there on at least half the pages
 * (and on two pages at least).
 * @param {object[][]} pages the lines of each page
 */
export function dropRunningHeads(pages) {
  // head key -> the set of pages it is on
  const pagesOfHead = new Map();

  for (const lines of pages) {
    for (const line of lines) {
      if (inBand(line)) {
        const key = headKey(line.text);
        if (!pagesOfHead.has(key)) {
          pagesOfHead.set(key, new Set());
        }
        const pagesWithHead = pagesOfHead.get(key);
        pagesWithHead.add(line.page);
      }
    }
  }

  const halfOfPages = Math.ceil(pages.length / 2);
  const pagesNeeded = Math.max(2, halfOfPages);

  return pages.map((lines) => {
    return lines.filter((line) => {
      if (!inBand(line)) {
        return true;
      }
      if (ONLY_NUMBER.test(line.text)) {
        return false;
      }

      // every line in a band was keyed in the loop above, so its set is there
      const key = headKey(line.text);
      const pagesWithHead = pagesOfHead.get(key);
      const repeats = pagesWithHead.size >= pagesNeeded;
      return !repeats;
    });
  });
}

// ------------------------------------------------------------------ blocks (step 4)

/**
 * The measures of the visual rules: the median line gap and the median line length of each
 * direction, and the left (or top) margin of each page and direction (its smallest start).
 */
function measures(lines) {
  const gaps = {
    false: [],
    true: [],
  };
  const lengths = {
    false: [],
    true: [],
  };
  const margins = new Map();

  lines.forEach((line, i) => {
    const lineLength = line.end - line.start;
    lengths[line.vertical].push(lineLength);

    const pageAndDirection = `${line.page}:${line.vertical}`;
    const marginSoFar = margins.get(pageAndDirection) ?? Infinity;
    const margin = Math.min(marginSoFar, line.start);
    margins.set(pageAndDirection, margin);

    const before = lines[i - 1];
    if (!before) {
      return;
    }
    const inSameText = before.page === line.page && before.vertical === line.vertical;
    if (inSameText && line.pos > before.pos) {
      const lineGap = line.pos - before.pos;
      gaps[line.vertical].push(lineGap);
    }
  });

  // keyed by a line's `vertical`: false for horizontal lines, true for vertical ones. A median of
  // nothing is NaN, and a comparison with NaN is false: the rule that uses it then never fires.
  const gap = {
    false: median(gaps.false),
    true: median(gaps.true),
  };
  const length = {
    false: median(lengths.false),
    true: median(lengths.true),
  };
  return {
    gap,
    length,
    margins,
  };
}

/** The width of one character of a line: an em for Japanese, else its mean advance. */
function charWidth(line) {
  if (detectLang(line.text) === "ja") {
    return line.size;
  }

  const lineLength = line.end - line.start;
  const charCount = Array.from(line.text).length;
  const atLeastOneChar = Math.max(1, charCount);
  return lineLength / atLeastOneChar;
}

/** Whether `next` starts a visual block after `before` (§5.2 step 4). The rules are tried in
 * this order, and the first that applies decides. */
export function startsVisualBlock(before, next, measure) {
  // an indent of one character
  const margin = measure.margins.get(`${next.page}:${next.vertical}`);
  const indent = next.start - margin;
  const oneCharIndent = MIN_INDENT_CHARS * charWidth(next);
  if (indent >= oneCharIndent) {
    return true;
  }

  // a new page: only after a short line
  if (next.page !== before.page) {
    const lengthBefore = before.end - before.start;
    const shortLength = SHORT_LINE_RATIO * measure.length[before.vertical];
    return lengthBefore < shortLength;
  }

  // a change between horizontal and vertical text
  if (next.vertical !== before.vertical) {
    return true;
  }

  // a wide gap
  const gap = next.pos - before.pos;
  const wideGap = BLOCK_GAP_FACTOR * measure.gap[next.vertical];
  return gap > wideGap;
}

// ------------------------------------------------------------------ the book

const equalIgnoringSpaces = (a, b) => {
  const aWithoutSpaces = a.replace(/[\s　]/g, "");
  const bWithoutSpaces = b.replace(/[\s　]/g, "");
  return aWithoutSpaces === bWithoutSpaces;
};

/**
 * The lines that start a chapter (§5.2 step 5), as a Map from the line's index to { title,
 * heading }. With an outline: for each entry, the line on its page whose words are the entry's
 * title, white space aside (that line becomes a heading), else the first line of its page or of
 * the next page with text (the chapter takes the entry's title and the line stays text); when two
 * entries come to the same line, the first has it. Without an outline: every line that passes
 * isChapterLine, as a heading. `entries` are the outline's [{ title, page }].
 */
function chapterLinesOf(lines, entries) {
  const outline = entries.filter((entry) => entry.title && entry.page >= 1);
  // line index -> { title, heading }
  const chapterAt = new Map();

  if (outline.length) {
    for (const entry of outline) {
      const normalizedTitle = normalizeText(entry.title);
      const title = normalizedTitle.trim();

      let lineIndex = lines.findIndex(
        (line) => line.page === entry.page && equalIgnoringSpaces(line.text, title),
      );
      const lineIsHeading = lineIndex >= 0;
      if (!lineIsHeading) {
        lineIndex = lines.findIndex((line) => line.page >= entry.page);
      }

      if (lineIndex >= 0 && !chapterAt.has(lineIndex)) {
        const chapterStart = {
          title,
          heading: lineIsHeading,
        };
        chapterAt.set(lineIndex, chapterStart);
      }
    }
  } else {
    lines.forEach((line, i) => {
      if (isChapterLine(line.text)) {
        const chapterStart = {
          title: line.text,
          heading: true,
        };
        chapterAt.set(i, chapterStart);
      }
    });
  }

  return chapterAt;
}

/**
 * The book model of a PDF's recorded text (§5.1).
 * @param {{pages: {view?: number[], width?: number, height?: number, items: object[]}[],
 *          outline?: {title: string, page: number}[], title?: string|null, author?: string|null}} pdf
 * @param {{name?: string, key?: string|null}} options
 */
export function parsePdfText(pdf, { name = "", key = null } = {}) {
  const pageCount = Math.max(1, pdf.pages.length);
  let charCount = 0;
  for (const page of pdf.pages) {
    for (const item of page.items) {
      const str = item.str ?? "";
      const withoutSpaces = str.replace(/\s/g, "");
      charCount += Array.from(withoutSpaces).length;
    }
  }

  const charsPerPage = charCount / pageCount;
  if (charsPerPage < MIN_CHARS_PER_PAGE) {
    throw new BookError(NO_TEXT, "pdfNoText");
  }

  const linesOfPages = pdf.pages.map((page, i) => pageLines(page, i + 1));
  const linesOfPagesWithoutHeads = dropRunningHeads(linesOfPages);
  const lines = linesOfPagesWithoutHeads.flat();

  const measure = measures(lines);
  const chapterAt = chapterLinesOf(lines, pdf.outline ?? []);

  const builder = new BookBuilder();
  // [blockIndex, title] of every chapter
  const chapterMarks = [];
  const pagesWithFigure = new Set();
  let pending = [];

  const flush = () => {
    if (!pending.length) {
      return;
    }

    for (const line of pending) {
      if (isFigureLine(line.text) && !pagesWithFigure.has(line.page)) {
        pagesWithFigure.add(line.page);

        const labelChars = Array.from(line.text).slice(0, LABEL_MAX_CHARS);
        const label = labelChars.join("").trim();
        const figure = {
          kind: "pdfPage",
          page: line.page,
          label,
        };
        builder.addFigure(figure);
      }
    }

    const texts = pending.map((line) => line.text);
    builder.addParagraph(texts, { page: pending[0].page });
    pending = [];
  };

  // A chapter mark is the index of the next block to be added. A chapter line that is a heading
  // becomes that block; one that is not starts the next paragraph, as the line of text it is.
  lines.forEach((line, i) => {
    const chapterStart = chapterAt.get(i);
    if (chapterStart) {
      flush();

      const nextBlockIndex = builder.blocks.length;
      chapterMarks.push([nextBlockIndex, chapterStart.title]);

      if (chapterStart.heading) {
        const spoken = plainSpoken(line.text);
        builder.addHeading(spoken, 1, { page: line.page });
        return;
      }
    } else if (pending.length) {
      const before = pending[pending.length - 1];
      if (endsSentencePdf(before.text) && startsVisualBlock(before, line, measure)) {
        flush();
      }
    }

    pending.push(line);
  });
  flush();

  const rawTitle = String(pdf.title ?? "");
  const documentTitle = normalizeText(rawTitle).trim();
  const title = documentTitle || baseName(name);
  const author = pdf.author?.trim() || null;

  const bookFields = {
    key,
    title,
    author,
    format: "pdf",
  };
  const book = builder.build(bookFields);

  return setChapters(book, chapterMarks);
}

/** The chapters at the marked blocks (D-77); blocks before the first mark form a chapter titled
 * with the book's title. */
function setChapters(book, chapterMarks) {
  // a mark counts when its block is in the book and comes after the block of the mark before it
  const chapterStarts = chapterMarks.filter(([blockIndex], i) => {
    const isBlockOfBook = blockIndex < book.blocks.length;
    if (!isBlockOfBook) {
      return false;
    }
    if (i === 0) {
      return true;
    }

    const blockOfMarkBefore = chapterMarks[i - 1][0];
    return blockIndex > blockOfMarkBefore;
  });
  if (!chapterStarts.length) {
    return book;
  }

  const chapters = [];

  const firstChapterBlock = chapterStarts[0][0];
  if (firstChapterBlock > 0) {
    const openingChapter = {
      title: book.title,
      firstBlock: 0,
    };
    chapters.push(openingChapter);
  }

  for (const [blockIndex, title] of chapterStarts) {
    const chapter = {
      title,
      firstBlock: blockIndex,
    };
    chapters.push(chapter);
  }

  numberChapters(book.blocks, chapters);
  book.chapters = chapters;
  return book;
}

// ------------------------------------------------------------------ the pdf.js wrapper

/** pdf.js, loaded once from vendor/pdfjs/ next to the site's js/ folder. */
let pdfjs = null;
async function loadPdfjs() {
  if (!pdfjs) {
    const base = new URL("../../vendor/pdfjs/", import.meta.url);

    const libraryUrl = new URL("pdf.min.mjs", base);
    pdfjs = await import(libraryUrl.href);

    const workerUrl = new URL("pdf.worker.min.mjs", base);
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.href;
  }
  return pdfjs;
}

/** The options of getDocument for the site: CMaps and standard fonts from vendor/pdfjs/. */
function documentOptions(data) {
  const base = new URL("../../vendor/pdfjs/", import.meta.url);
  const cMapFolder = new URL("cmaps/", base);
  const standardFontFolder = new URL("standard_fonts/", base);

  return {
    data,
    cMapUrl: cMapFolder.href,
    cMapPacked: true,
    standardFontDataUrl: standardFontFolder.href,
    isEvalSupported: false,
    verbosity: 0,
  };
}

/**
 * The outline's chapters: the shallowest level of the outline with two entries or more (else the
 * top level), each at its destination's page.
 */
async function chapterEntriesOf(doc) {
  const outlineOrNothing = await doc.getOutline().catch(() => null);
  const tree = outlineOrNothing ?? [];

  let level = tree;
  let chosen = tree;
  while (level.length) {
    if (level.length >= 2) {
      chosen = level;
      break;
    }
    level = level.flatMap((entry) => entry.items ?? []);
  }

  const entries = [];
  for (const entry of chosen) {
    try {
      let dest = entry.dest;
      if (typeof dest === "string") {
        dest = await doc.getDestination(dest);
      }
      if (!Array.isArray(dest)) {
        continue;
      }

      const target = dest[0];
      let index = target;
      if (typeof target !== "number") {
        index = await doc.getPageIndex(target);
      }

      const chapterEntry = {
        title: entry.title,
        page: index + 1,
      };
      entries.push(chapterEntry);
    } catch {
      // an entry that points nowhere is left out
    }
  }

  return entries;
}

/**
 * The recorded text of an open pdf.js document: the input of parsePdfText(). The items of a page
 * turned by /Rotate are moved into the space of the page as it is shown, so that runsOf can read
 * it as an unturned page whose view box is [0, 0, width, height].
 * @param {object} doc a PDFDocumentProxy
 * @param {object} lib the pdf.js module (for Util.transform)
 */
export async function readDocument(doc, lib) {
  const pages = [];

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const styles = content.styles ?? {};

    let view = page.view.slice();
    let toShownSpace = null;
    if (page.rotate % 360) {
      const viewport = page.getViewport({ scale: 1 });
      // the viewport's transform has y growing downward; this turns y back to grow upward
      const flipY = [1, 0, 0, -1, 0, viewport.height];
      toShownSpace = lib.Util.transform(flipY, viewport.transform);
      view = [0, 0, viewport.width, viewport.height];
    }

    const items = [];
    for (const item of content.items) {
      if (typeof item.str !== "string") {
        continue;
      }

      let transform = item.transform;
      if (toShownSpace) {
        transform = lib.Util.transform(toShownSpace, item.transform);
      }

      const fontStyle = styles[item.fontName];
      const vertical = Boolean(fontStyle?.vertical);

      const recorded = {
        str: item.str,
        transform,
        width: item.width,
        height: item.height,
        hasEOL: item.hasEOL,
        vertical,
      };
      items.push(recorded);
    }

    const recordedPage = {
      view,
      items,
    };
    pages.push(recordedPage);
    page.cleanup();
  }

  const { info } = await doc.getMetadata().catch(() => ({ info: {} }));
  const outline = await chapterEntriesOf(doc);
  const title = info?.Title ?? null;
  const author = info?.Author ?? null;

  return {
    pages,
    outline,
    title,
    author,
  };
}

/**
 * Parse a PDF file in the browser. The open pdf.js document is kept on the book as the
 * non-enumerable property `pdfDocument`, for the figure pages (pdfpages.js); the caller destroys
 * it when the book is closed. A file that pdf.js cannot open (or pdf.js itself missing) is thrown
 * as an Error with code "pdf"; a file without text, as the BookError of D-72 (and one whose text
 * holds no sentence, as the BookError "empty" of the model).
 * @param {{name: string, bytes: Uint8Array, key?: string|null}} file
 */
export async function parsePdf({ name, bytes, key = null }) {
  let lib;
  let doc;

  try {
    lib = await loadPdfjs();

    // pdf.js hands its data to the worker and empties the buffer, so it gets a copy
    const bytesCopy = bytes.slice();
    const options = documentOptions(bytesCopy);
    const loadingTask = lib.getDocument(options);
    doc = await loadingTask.promise;
  } catch (cause) {
    // pdf.js is missing, or the file is broken or locked: the caller shows the format refusal
    const error = new Error("The PDF could not be opened", { cause });
    error.code = "pdf";
    throw error;
  }

  try {
    const recordedText = await readDocument(doc, lib);
    const book = parsePdfText(recordedText, { name, key });

    const hiddenProperty = {
      value: doc,
      enumerable: false,
      configurable: true,
    };
    Object.defineProperty(book, "pdfDocument", hiddenProperty);

    return book;
  } catch (error) {
    doc.destroy();
    throw error;
  }
}
