// The PDF parser (SPEC_dopa v3 §5.2 "PDF"; ED D-68, D-72, D-75, D-77, D-108, D-115).
//
// Two parts. The pure part, parsePdfText(), takes the text of every page as pdf.js's
// getTextContent() gives it (items of {str, transform, width, height, hasEOL}, plus the page's
// view box), the outline as [{title, page}], and the document's title and author, and returns the
// book model. It has no browser dependency and is tested with node on recorded items. The wrapper,
// parsePdf(), loads pdf.js from vendor/pdfjs/, reads the document with readDocument(), and calls
// the pure part.
//
// 1. A file with fewer than 20 characters per page on average is refused (D-72).
// 2. Lines: items on the same baseline, within half a line height, are joined left to right.
//    Vertical text (rotated items, items of a vertical font, or single glyphs stacked one under
//    the other) makes columns, read top to bottom, right to left.
// 3. Running heads and page numbers are dropped: a line in the top or bottom 8% of the page that
//    repeats on at least half the pages, or that holds only a number.
// 4. Blocks (D-68): a line ends a block when it ends with a sentence end and the next line starts
//    a visual block (a gap of more than 1.5 times the median line gap, an indent of one character,
//    or a new page after a line shorter than 80% of the median line length). Hyphenated English
//    line ends are joined without the hyphen.
// 5. Chapters: the outline's entries at their pages; else lines that pass text.js's isChapterLine.
// 6. Figures (D-108): a line that starts with 図N, 表N, Figure N or Table N puts a figure block of
//    kind "pdfPage" before the block that holds it, once per page. The line stays in the text.

import { BookBuilder, BookError, baseName, plainSpoken } from "./model.js";
import { detectLang, isJaChar, joinLines } from "./sentences.js";
import { isChapterLine } from "./text.js";

/** The refusal of a PDF without a text layer (D-72, ST-27). */
export const NO_TEXT = "この PDF には文字が入っていません";

const MIN_CHARS_PER_PAGE = 20;
const BAND = 0.08; // the top and bottom bands of a page, where running heads and numbers sit
const GAP_FACTOR = 1.5;
const SHORT_LINE = 0.8;
// One character of indent. A Japanese paragraph is indented by exactly one em, so the measure
// allows for rounding: an indent of 90% of a character width or more counts.
const INDENT_CHARS = 0.9;
const LABEL_CHARS = 24; // §6.7: a PDF figure's label is its line cut at 24 characters

const SENTENCE_END = /[。．！？.!?][」』）)\]］】〕〉》"”’']*$/;
const FIGURE_LINE = /^[\s　]*(図|表|Figure|Table)\s*[0-9０-９]+([.．\-－‐–][0-9０-９]+)?(?![0-9０-９])/;
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
  return SENTENCE_END.test(text.trimEnd());
}

/** Whether a line marks a figure (§5.2 step 6). */
export function isFigureLine(text) {
  return FIGURE_LINE.test(text);
}

const median = (values) => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// ------------------------------------------------------------------ lines (step 2)

/**
 * The glyph runs of a page in reading space. y grows downward from the page's top. A horizontal
 * run starts at x and is `length` long; a vertical run starts at y (its top) and goes down.
 */
function runsOf(page) {
  const [x0, y0, x1, y1] = page.view ?? [0, 0, page.width, page.height];
  const items = page.items
    .map((item) => ({ ...item, str: normalizeText(item.str ?? "") }))
    .filter((item) => item.str.trim());
  const runs = items.map((item) => {
    const [a, b, c, d, e, f] = item.transform;
    const scaleX = Math.hypot(a, b),
      scaleY = Math.hypot(c, d);
    const rotated = Math.abs(b) > Math.abs(a);
    const size = Math.abs(item.height) > 0 && !item.vertical ? Math.abs(item.height) : Math.max(scaleX, scaleY);
    const run = { str: item.str.trim(), x: e - x0, y: y1 - f, size, width: Math.abs(item.width), vertical: false, kind: "h" };
    // leading spaces drawn as glyphs indent the text: an em for a full-width space, a quarter else
    const lead = item.str.match(/^\s*/)[0];
    const shift = Array.from(lead).reduce((sum, ch) => sum + (ch === "　" ? 1 : 0.25), 0) * size;
    if (item.vertical) {
      // a vertical font: the item's origin is its top, and its height is its advance down the column
      Object.assign(run, { vertical: true, kind: "font", top: run.y + shift, bottom: run.y + Math.abs(item.height), size: scaleX });
    } else if (rotated) {
      // text turned by a quarter: it runs down the page (b < 0) or up (read as if down)
      const length = Math.abs(item.width);
      Object.assign(run, { vertical: true, kind: "rotated", top: (b < 0 ? run.y : run.y - length) + shift, bottom: b < 0 ? run.y + length : run.y, size: scaleX });
    } else {
      run.x += shift;
      run.width = Math.max(0, run.width - shift);
    }
    return run;
  });
  // A single glyph placed right under the glyph before or after it (in the order of the content
  // stream), and not beside either, is vertical text drawn glyph by glyph.
  const stacked = (r, o) => o && !o.vertical && Math.abs(o.x - r.x) < 0.3 * r.size && Math.abs(o.y - r.y) > 0.5 * r.size && Math.abs(o.y - r.y) < 2 * r.size;
  const beside = (r, o) =>
    o && Math.abs(o.y - r.y) < 0.3 * r.size && (Math.abs(o.x - (r.x + r.width)) < r.size || Math.abs(r.x - (o.x + o.width)) < r.size);
  runs.forEach((run, i) => {
    if (run.vertical || Array.from(run.str.trim()).length !== 1) return;
    const before = runs[i - 1],
      after = runs[i + 1];
    if ((stacked(run, before) || stacked(run, after)) && !beside(run, before) && !beside(run, after)) run.kind = "glyph";
  });
  for (const run of runs)
    if (run.kind === "glyph") Object.assign(run, { vertical: true, top: run.y - run.size, bottom: run.y });
  return { runs, width: x1 - x0, height: y1 - y0 };
}

/**
 * Text pieces joined in order. A gap of half a character or more between Japanese letters is a
 * full-width space; a gap of a quarter between other letters is a space.
 */
function joinPieces(pieces, gapOf) {
  let text = "";
  pieces.forEach((piece, i) => {
    const str = piece.str;
    if (i && text) {
      const gap = gapOf(pieces[i - 1], piece);
      const japanese = isJaChar(text[text.length - 1]) || isJaChar(str[0]);
      if (japanese && gap >= 0.5 * piece.size) text += "　";
      else if (!japanese && gap > 0.25 * piece.size) text += " ";
    }
    text += str;
  });
  return text.replace(/[ \t\r\n]+/g, " ").trim();
}

/**
 * The lines of one page, in reading order. A line is
 * { text, page, vertical, pos, start, end, size, top, bottom }: `pos` is where the line stands
 * across the reading direction (its baseline, or minus its column's x, so that it grows in reading
 * order); `start` and `end` are its extent along the line; `top` and `bottom` bound it on the page.
 * @param {{view?: number[], width?: number, height?: number, items: object[]}} page
 * @param {number} number the page number (from 1)
 */
export function pageLines(page, number) {
  const { runs, height } = runsOf(page);
  const lines = [];

  // horizontal lines: runs within half a line height of a line's baseline join it
  const horizontal = runs.filter((run) => !run.vertical).sort((p, q) => p.y - q.y || p.x - q.x);
  const rows = [];
  for (const run of horizontal) {
    const row = rows.find((r) => Math.abs(r.y - run.y) <= 0.5 * Math.max(r.size, run.size));
    if (row) {
      row.runs.push(run);
      row.size = Math.max(row.size, run.size);
    } else rows.push({ y: run.y, size: run.size, runs: [run] });
  }
  for (const row of rows) {
    row.runs.sort((p, q) => p.x - q.x);
    const text = joinPieces(row.runs, (p, q) => q.x - (p.x + p.width));
    if (!text) continue;
    const start = row.runs[0].x,
      end = Math.max(...row.runs.map((r) => r.x + r.width));
    lines.push({ text, page: number, vertical: false, pos: row.y, start, end, size: row.size, top: row.y - row.size, bottom: row.y });
  }

  // vertical columns: runs at the same x, split where a gap of more than two characters opens
  const vertical = runs.filter((run) => run.vertical).sort((p, q) => q.x - p.x || p.top - q.top);
  const columns = [];
  for (const run of vertical) {
    const column = columns.find((c) => Math.abs(c.x - run.x) <= 0.5 * Math.max(c.size, run.size) && run.top - c.bottom < 2 * c.size && run.top >= c.top);
    if (column) {
      column.runs.push(run);
      column.bottom = Math.max(column.bottom, run.bottom);
    } else columns.push({ x: run.x, size: run.size, top: run.top, bottom: run.bottom, runs: [run] });
  }
  const columnLines = [];
  for (const column of columns.sort((p, q) => q.x - p.x || p.top - q.top)) {
    column.runs.sort((p, q) => p.top - q.top);
    const text = joinPieces(column.runs, (p, q) => q.top - p.bottom);
    if (!text) continue;
    columnLines.push({ text, page: number, vertical: true, pos: -column.x, start: column.top, end: column.bottom, size: column.size, top: column.top, bottom: column.bottom });
  }

  // a page of mostly vertical text: horizontal lines above its columns come first, the rest after
  const chars = (list) => list.reduce((n, line) => n + Array.from(line.text).length, 0);
  if (chars(columnLines) > chars(lines)) {
    const topOfColumns = Math.min(...columnLines.map((line) => line.top));
    return [...lines.filter((line) => line.bottom <= topOfColumns), ...columnLines, ...lines.filter((line) => line.bottom > topOfColumns)].map((line) => ({ ...line, pageHeight: height }));
  }
  return [...lines, ...columnLines].map((line) => ({ ...line, pageHeight: height }));
}

// ------------------------------------------------------------------ running heads (step 3)

const inBand = (line) => {
  const middle = (line.top + line.bottom) / 2;
  return middle < BAND * line.pageHeight || middle > (1 - BAND) * line.pageHeight;
};
const headKey = (text) => text.replace(/[\s　]/g, "").replace(/[0-9０-９]+/g, "#");

/**
 * The lines of every page without running heads and page numbers: a line in the top or bottom 8%
 * that holds only a number, or whose words (numbers aside) repeat there on at least half the pages
 * (and on two pages at least).
 * @param {object[][]} pages the lines of each page
 */
export function dropRunningHeads(pages) {
  const seen = new Map(); // head key -> the set of pages it is on
  for (const lines of pages)
    for (const line of lines)
      if (inBand(line)) {
        const key = headKey(line.text);
        if (!seen.has(key)) seen.set(key, new Set());
        seen.get(key).add(line.page);
      }
  const needed = Math.max(2, Math.ceil(pages.length / 2));
  return pages.map((lines) =>
    lines.filter((line) => !(inBand(line) && (ONLY_NUMBER.test(line.text) || seen.get(headKey(line.text)).size >= needed))),
  );
}

// ------------------------------------------------------------------ blocks (step 4)

/**
 * The measures of the visual rules: the median line gap and the median line length of each
 * direction, and the left (or top) margin of each page and direction (its smallest start).
 */
function measures(lines) {
  const gaps = { false: [], true: [] },
    lengths = { false: [], true: [] },
    margins = new Map();
  lines.forEach((line, i) => {
    lengths[line.vertical].push(line.end - line.start);
    const key = `${line.page}:${line.vertical}`;
    margins.set(key, Math.min(margins.get(key) ?? Infinity, line.start));
    const before = lines[i - 1];
    if (before && before.page === line.page && before.vertical === line.vertical && line.pos > before.pos)
      gaps[line.vertical].push(line.pos - before.pos);
  });
  return {
    gap: { false: median(gaps.false), true: median(gaps.true) },
    length: { false: median(lengths.false), true: median(lengths.true) },
    margins,
  };
}

/** The width of one character of a line: an em for Japanese, else its mean advance. */
function charWidth(line) {
  if (detectLang(line.text) === "ja") return line.size;
  return (line.end - line.start) / Math.max(1, Array.from(line.text).length);
}

/** Whether `next` starts a visual block after `before` (§5.2 step 4). */
export function startsVisualBlock(before, next, m) {
  const indent = next.start - m.margins.get(`${next.page}:${next.vertical}`);
  if (indent >= INDENT_CHARS * charWidth(next)) return true;
  if (next.page !== before.page) return before.end - before.start < SHORT_LINE * m.length[before.vertical];
  if (next.vertical !== before.vertical) return true;
  return next.pos - before.pos > GAP_FACTOR * m.gap[next.vertical];
}

// ------------------------------------------------------------------ the book

const sameWords = (a, b) => a.replace(/[\s　]/g, "") === b.replace(/[\s　]/g, "");

/**
 * The book model of a PDF's recorded text (§5.1).
 * @param {{pages: {view?: number[], width?: number, height?: number, items: object[]}[],
 *          outline?: {title: string, page: number}[], title?: string|null, author?: string|null}} pdf
 * @param {{name?: string, key?: string|null}} options
 */
export function parsePdfText(pdf, { name = "", key = null } = {}) {
  const pageCount = Math.max(1, pdf.pages.length);
  let chars = 0;
  for (const page of pdf.pages) for (const item of page.items) chars += Array.from((item.str ?? "").replace(/\s/g, "")).length;
  if (chars / pageCount < MIN_CHARS_PER_PAGE) throw new BookError(NO_TEXT, "pdfNoText");

  const lines = dropRunningHeads(pdf.pages.map((page, i) => pageLines(page, i + 1))).flat();
  const m = measures(lines);
  const outline = (pdf.outline ?? []).filter((entry) => entry.title && entry.page >= 1);

  // the lines that start a chapter: a line with the outline entry's words on its page (it becomes
  // a heading), else the first line of that page or of the next page with text
  const chapterAt = new Map(); // line index -> { title, heading }
  if (outline.length) {
    for (const entry of outline) {
      const title = normalizeText(entry.title).trim();
      let index = lines.findIndex((line) => line.page === entry.page && sameWords(line.text, title));
      const heading = index >= 0;
      if (!heading) index = lines.findIndex((line) => line.page >= entry.page);
      if (index >= 0 && !chapterAt.has(index)) chapterAt.set(index, { title, heading });
    }
  } else lines.forEach((line, i) => isChapterLine(line.text) && chapterAt.set(i, { title: line.text, heading: true }));

  const builder = new BookBuilder();
  const marks = []; // [blockIndex, title] of every chapter
  const shownPages = new Set();
  let open = [];
  const flush = () => {
    if (!open.length) return;
    for (const line of open)
      if (isFigureLine(line.text) && !shownPages.has(line.page)) {
        shownPages.add(line.page);
        builder.figure({ kind: "pdfPage", page: line.page, label: Array.from(line.text).slice(0, LABEL_CHARS).join("").trim() });
      }
    const texts = open.map((line) => line.text);
    const lang = detectLang(texts.join(""));
    builder.text(plainSpoken(joinLines(texts, lang)), { page: open[0].page, lang });
    open = [];
  };

  lines.forEach((line, i) => {
    const chapter = chapterAt.get(i);
    if (chapter) {
      flush();
      marks.push([builder.blocks.length, chapter.title]);
      if (chapter.heading) {
        builder.heading(plainSpoken(line.text), 1, { page: line.page });
        return;
      }
    } else if (open.length) {
      const before = open[open.length - 1];
      if (endsSentencePdf(before.text) && startsVisualBlock(before, line, m)) flush();
    }
    open.push(line);
  });
  flush();

  const info = normalizeText(String(pdf.title ?? "")).trim();
  const book = builder.book({ key, title: info || baseName(name), author: pdf.author?.trim() || null, format: "pdf" });
  return withChapters(book, marks);
}

/** The chapters at the marked blocks (D-77); blocks before the first mark form a chapter titled with the book's title. */
function withChapters(book, marks) {
  const starts = marks.filter(([index], i) => index < book.blocks.length && (i === 0 || index > marks[i - 1][0]));
  if (!starts.length) return book;
  const chapters = [];
  if (starts[0][0] > 0) chapters.push({ title: book.title, firstBlock: 0 });
  for (const [index, title] of starts) chapters.push({ title, firstBlock: index });
  let chapter = 0;
  book.blocks.forEach((block, index) => {
    while (chapter + 1 < chapters.length && chapters[chapter + 1].firstBlock <= index) chapter++;
    block.chapter = chapter;
  });
  book.chapters = chapters;
  return book;
}

// ------------------------------------------------------------------ the pdf.js wrapper

/** pdf.js, loaded once from vendor/pdfjs/ next to the site's js/ folder. */
let pdfjs = null;
async function loadPdfjs() {
  if (!pdfjs) {
    const base = new URL("../../vendor/pdfjs/", import.meta.url);
    pdfjs = await import(new URL("pdf.min.mjs", base).href);
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdf.worker.min.mjs", base).href;
  }
  return pdfjs;
}

/** The options of getDocument for the site: CMaps and standard fonts from vendor/pdfjs/. */
function documentOptions(data) {
  const base = new URL("../../vendor/pdfjs/", import.meta.url);
  return {
    data,
    cMapUrl: new URL("cmaps/", base).href,
    cMapPacked: true,
    standardFontDataUrl: new URL("standard_fonts/", base).href,
    isEvalSupported: false,
    verbosity: 0,
  };
}

/**
 * The outline's chapters: the shallowest level of the outline with two entries or more (else the
 * top level), each at its destination's page.
 */
async function outlineOf(doc) {
  const tree = (await doc.getOutline().catch(() => null)) ?? [];
  let level = tree,
    chosen = tree;
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
      const dest = typeof entry.dest === "string" ? await doc.getDestination(entry.dest) : entry.dest;
      if (!Array.isArray(dest)) continue;
      const target = dest[0];
      const index = typeof target === "number" ? target : await doc.getPageIndex(target);
      entries.push({ title: entry.title, page: index + 1 });
    } catch {
      // an entry that points nowhere is left out
    }
  }
  return entries;
}

/**
 * The recorded text of an open pdf.js document: the input of parsePdfText(). A page turned by
 * /Rotate has its items turned back, so that its text reads as it is shown.
 * @param {object} doc a PDFDocumentProxy
 * @param {object} lib the pdf.js module (for Util.transform)
 */
export async function readDocument(doc, lib) {
  const pages = [];
  for (let number = 1; number <= doc.numPages; number++) {
    const page = await doc.getPage(number);
    const content = await page.getTextContent();
    const styles = content.styles ?? {};
    let view = page.view.slice();
    let turn = null;
    if (page.rotate % 360) {
      const viewport = page.getViewport({ scale: 1 });
      turn = lib.Util.transform([1, 0, 0, -1, 0, viewport.height], viewport.transform);
      view = [0, 0, viewport.width, viewport.height];
    }
    const items = content.items
      .filter((item) => typeof item.str === "string")
      .map((item) => ({
        str: item.str,
        transform: turn ? lib.Util.transform(turn, item.transform) : item.transform,
        width: item.width,
        height: item.height,
        hasEOL: item.hasEOL,
        vertical: Boolean(styles[item.fontName]?.vertical),
      }));
    pages.push({ view, items });
    page.cleanup();
  }
  const { info } = await doc.getMetadata().catch(() => ({ info: {} }));
  return { pages, outline: await outlineOf(doc), title: info?.Title ?? null, author: info?.Author ?? null };
}

/**
 * Parse a PDF file in the browser. The open pdf.js document is kept on the book as the
 * non-enumerable property `pdfDocument`, for the figure pages (pdfpages.js); the caller destroys
 * it when the book is closed. A file that pdf.js cannot open (or pdf.js itself missing) is thrown
 * as an Error with code "pdf"; a file without text, as the BookError of D-72.
 * @param {{name: string, bytes: Uint8Array, key?: string|null}} file
 */
export async function parsePdf({ name, bytes, key = null }) {
  let lib, doc;
  try {
    lib = await loadPdfjs();
    // pdf.js hands its data to the worker and empties the buffer, so it gets a copy
    doc = await lib.getDocument(documentOptions(bytes.slice())).promise;
  } catch (cause) {
    // pdf.js is missing, or the file is broken or locked: the caller shows the format refusal
    const error = new Error("The PDF could not be opened", { cause });
    error.code = "pdf";
    throw error;
  }
  try {
    const book = parsePdfText(await readDocument(doc, lib), { name, key });
    Object.defineProperty(book, "pdfDocument", { value: doc, enumerable: false, configurable: true });
    return book;
  } catch (error) {
    doc.destroy();
    throw error;
  }
}
