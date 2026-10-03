// The 青空文庫 parser (SPEC_dopa v3 §5.2 "青空文庫"; ED D-68, D-77, D-78, D-108).
//
// 1. The first line is the title, the second the author; a third line before the first blank
//    line is joined to the title.
// 2. The symbol note, from the first line of dashes to the second, is dropped.
// 3. The end notes, from the line that starts with 「底本：」 to the end, go to `endNotes`.
// 4. Ruby: the base is shown and the reading is sung.
// 5. Heading notes make the line a heading (the 窓 and 同行 forms: their own words); illustration
//    notes make a figure block (only when the book's images are at hand), and a caption line right
//    after one is its label; every other ［＃…］ note is removed.
// 6. Gaiji notes become their character when the note gives a Unicode code point or a JIS X 0213
//    position of the table below; otherwise 「※」 stays and is not sung.
// 7. Every line is a block; blank lines and lines of full-width spaces are skipped.

import { BookBuilder, Spoken, baseName } from "./model.js";
import { isBlank } from "./sentences.js";

/**
 * JIS X 0213 positions (plane-row-cell) to characters. Kept small: row 1-13 (circled numbers and
 * Roman numerals, which 工藝の道 uses for its figures), a few common kana forms, and the kanji the
 * bundled books use (`tools/site/fetch_aozora.py` prints any that are missing).
 */
export const GAIJI = {
  "1-2-22": "〻",
  "1-7-82": "ヷ",
  "1-7-83": "ヸ",
  "1-7-84": "ヹ",
  "1-7-85": "ヺ",
  "1-13-1": "①",
  "1-13-2": "②",
  "1-13-3": "③",
  "1-13-4": "④",
  "1-13-5": "⑤",
  "1-13-6": "⑥",
  "1-13-7": "⑦",
  "1-13-8": "⑧",
  "1-13-9": "⑨",
  "1-13-10": "⑩",
  "1-13-11": "⑪",
  "1-13-12": "⑫",
  "1-13-13": "⑬",
  "1-13-14": "⑭",
  "1-13-15": "⑮",
  "1-13-16": "⑯",
  "1-13-17": "⑰",
  "1-13-18": "⑱",
  "1-13-19": "⑲",
  "1-13-20": "⑳",
  "1-13-21": "Ⅰ",
  "1-13-22": "Ⅱ",
  "1-13-23": "Ⅲ",
  "1-13-24": "Ⅳ",
  "1-13-25": "Ⅴ",
  "1-13-26": "Ⅵ",
  "1-13-27": "Ⅶ",
  "1-13-28": "Ⅷ",
  "1-13-29": "Ⅸ",
  "1-13-30": "Ⅹ",
  "1-13-31": "Ⅺ",
  "1-13-55": "Ⅻ",
  "1-84-31": "彽",
  "1-87-71": "犍",
  "1-90-47": "腊",
  "1-93-14": "銈",
  "2-12-67": "慠",
};

// Placeholders for gaiji while the book is parsed (they are numbered through the whole book), so
// that a gaiji counts as a kanji in a ruby base and a mapped 《 or ［ cannot be taken for markup.
// Private-use characters, never in a 青空文庫 text.
const FIRST_PLACEHOLDER = 0xe000;
const PLACEHOLDER = /[\uE000-\uF8FF]/;
const GAIJI_NOTE = /※［＃([^［］]*)］/g;
const NOTE = /［＃[^［］]*］/g;
// 「［＃「窯の図」のキャプション付きの図（fig1.png、横300×縦200）入る］」: the quoted words, then
// キャプション付きの or nothing, then the file's name.
const FIGURE_NOTE =
  /［＃(?:「([^［］]*?)」の(キャプション付きの)?)?(?:挿絵|図|写真)（([^、）]+)[^）]*）入る］/g;
const HEADING_LEVELS = { 大: 1, 中: 2, 小: 3 };
// Heading notes. The plain forms make the whole line a heading: 「［＃「…」は大見出し］」 and
// 「［＃大見出し］…［＃大見出し終わり］」. The 窓 and 同行 forms are headings of the same level, but
// they stand inside a line of text: only their own words are the heading, and the rest of the
// line is a text block.
const HEADING_NOTE = /［＃(?:「[^［］]*」は)?([大中小])見出し(?:終わり)?］/;
const HEADING_FROM = /［＃ここから(?:窓|同行)?([大中小])見出し］/;
const HEADING_TO = /［＃ここで(?:窓|同行)?[大中小]見出し終わり］/;
// 「［＃窓中見出し］Ⅱ［＃窓中見出し終わり］」: the level's letter, then the heading's words.
const INLINE_BRACKETED =
  /［＃(?:窓|同行)([大中小])見出し］([^［］]*(?:［＃(?!(?:窓|同行)?[大中小]見出し終わり)[^［］]*］[^［］]*)*)［＃(?:窓|同行)?[大中小]見出し終わり］/;
// 「皿［＃「皿」は同行中見出し］」: the quoted words, then the level's letter.
const INLINE_QUOTED = /［＃「([^［］]*)」は(?:窓|同行)([大中小])見出し］/;
// 「［＃キャプション］…［＃キャプション終わり］」 alone on a line (after any indent notes)
const CAPTION_LINE =
  /^[\s　]*(?:［＃[^［］]*字下げ］)*［＃キャプション］(.*?)［＃キャプション終わり］[\s　]*$/;
const DASHES = /^-{20,}\s*$/;

/** The character of a gaiji note's body, or null (§5.2 step 6). */
export function gaijiChar(body) {
  const unicode = body.match(/U\+([0-9A-Fa-f]{4,6})/);
  if (unicode) return String.fromCodePoint(parseInt(unicode[1], 16));
  const jis = body.match(/(?:^|、|水準)([12]-\d{1,2}-\d{1,2})(?:、|$)/);
  return jis ? (GAIJI[jis[1]] ?? null) : null;
}

/**
 * The gaiji of one book. While the book is parsed each gaiji note stands in the text as one
 * placeholder character; this keeps what each placeholder stands for: { char, describedByParts },
 * where `char` is the gaiji's character, or null when the table has none (it is then shown as
 * 「※」 and not sung), and `describedByParts` tells that its note describes a kanji by its parts
 * (「金＋圭」).
 */
class HeldGaiji {
  constructor() {
    this.byPlaceholder = new Map();
    this.nextPlaceholder = FIRST_PLACEHOLDER;
  }

  /** A line with each of its gaiji notes replaced by a new placeholder. */
  hold(line) {
    return line.replace(GAIJI_NOTE, (_, body) => {
      const placeholder = String.fromCharCode(this.nextPlaceholder++);
      this.byPlaceholder.set(placeholder, {
        char: gaijiChar(body),
        describedByParts: body.startsWith("「"),
      });
      return placeholder;
    });
  }

  /** What a character stands for when it is a placeholder; undefined for any other character. */
  of(ch) {
    return PLACEHOLDER.test(ch) ? this.byPlaceholder.get(ch) : undefined;
  }

  /** A text with each gaiji as it is shown: its character, or 「※」 when the table has none. */
  shown(text) {
    return Array.from(text)
      .map((ch) => {
        const gaiji = this.of(ch);
        return gaiji ? (gaiji.char ?? "※") : ch;
      })
      .join("");
  }
}

/** Whether a character is a kanji for a ruby base (with 々〆〇ヶ). */
function isKanji(ch) {
  return /[\p{Script=Han}々〆〇ヶ仝]/u.test(ch);
}

/**
 * The kind of letter of a character, for the run of a ruby base without 「｜」. A held gaiji is of
 * the kind of its character; an unmapped one is a kanji when its note describes a kanji by its
 * parts (「金＋圭」), and of no kind otherwise (ローマ数字13).
 */
function letterKind(ch, held) {
  const gaiji = held.of(ch);
  if (gaiji) {
    const { char, describedByParts } = gaiji;
    return char === null ? (describedByParts ? "kanji" : null) : letterKind(char, held);
  }
  if (isKanji(ch)) return "kanji";
  if (/[\p{Script=Hiragana}]/u.test(ch)) return "hiragana";
  if (/[\p{Script=Katakana}ー]/u.test(ch)) return "katakana";
  if (/[\p{Script=Latin}0-9０-９'’]/u.test(ch)) return "latin";
  return null;
}

/**
 * Where the base of a ruby without 「｜」 starts in the characters before its 《: at the start of
 * the run of letters of one kind (kanji, hiragana, katakana, Latin) that ends there. When the
 * last character is of no kind, the base is empty: the reading is sung and nothing is shown for it.
 */
function baseStartByKind(pending, held) {
  let baseStart = pending.length;
  const kind = baseStart > 0 ? letterKind(pending[baseStart - 1], held) : null;
  if (kind) while (baseStart > 0 && letterKind(pending[baseStart - 1], held) === kind) baseStart--;
  return baseStart;
}

/**
 * One line of the book as a Spoken text (§5.2 steps 4 and 6). `held` is the book's HeldGaiji; the
 * line has placeholders where its gaiji notes were.
 */
function spokenOf(line, held) {
  const spoken = new Spoken();
  const chars = Array.from(line);
  const emit = (text) => {
    for (const ch of Array.from(text)) {
      const gaiji = held.of(ch);
      if (!gaiji) spoken.plain(ch);
      else if (gaiji.char === null) spoken.silent("※");
      else spoken.plain(gaiji.char);
    }
  };
  let pending = []; // characters since the last ruby or 「｜」, not yet emitted
  let baseMarked = false; // a 「｜」 came: `pending` was emptied there, and all of it is the base
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    // 「｜」, or a half-width |, starts a base when a 《 follows it before any 》
    if (ch === "｜" || ch === "|") {
      const nextRubyOpen = chars.indexOf("《", i + 1);
      if (nextRubyOpen > i && !chars.slice(i + 1, nextRubyOpen).includes("》")) {
        emit(pending.join(""));
        pending = [];
        baseMarked = true;
        continue;
      }
    }
    if (ch === "《") {
      const rubyClose = chars.indexOf("》", i + 1);
      if (rubyClose > i) {
        const reading = held.shown(chars.slice(i + 1, rubyClose).join(""));
        const baseStart = baseMarked ? 0 : baseStartByKind(pending, held);
        emit(pending.slice(0, baseStart).join(""));
        // the reading goes into the speech in katakana: kuromoji cuts a hiragana reading poorly
        // inside a sentence (かのじ|ゃちぼうぎゃく), and the song sings katakana anyway (§5.5)
        spoken.ruby(held.shown(pending.slice(baseStart).join("")), toKatakana(reading));
        pending = [];
        baseMarked = false;
        i = rubyClose;
        continue;
      }
    }
    pending.push(ch);
  }
  emit(pending.join(""));
  return spoken;
}

/** The display text of a line, without its ruby readings. */
function displayWithoutRuby(line, held) {
  return spokenOf(line, held).display;
}

/**
 * A piece of a line cut at its 窓 or 同行 heading: [{text, level}], where the heading's own words
 * have its level and the text around it has `level` (the level of the whole line, or null).
 */
function splitAtInlineHeadings(text, level, held) {
  const bracketed = text.match(INLINE_BRACKETED);
  if (bracketed) {
    const noteStart = bracketed.index;
    return [
      { text: text.slice(0, noteStart), level },
      { text: bracketed[2], level: HEADING_LEVELS[bracketed[1]] },
      ...splitAtInlineHeadings(text.slice(noteStart + bracketed[0].length), level, held),
    ];
  }
  const quoted = text.match(INLINE_QUOTED);
  if (quoted) {
    // the heading is the run just before the note whose display is the quoted words
    const before = text.slice(0, quoted.index);
    const words = displayWithoutRuby(quoted[1].replace(NOTE, ""), held);
    for (let start = before.length - 1; start >= 0; start--)
      if (displayWithoutRuby(before.slice(start).replace(NOTE, ""), held) === words)
        return [
          { text: before.slice(0, start), level },
          { text: before.slice(start), level: HEADING_LEVELS[quoted[2]] },
          ...splitAtInlineHeadings(text.slice(quoted.index + quoted[0].length), level, held),
        ];
    // no run before the note shows the quoted words: all the text before it is the heading
    return [
      { text: before, level: HEADING_LEVELS[quoted[2]] },
      ...splitAtInlineHeadings(text.slice(quoted.index + quoted[0].length), level, held),
    ];
  }
  return [{ text, level }];
}

/**
 * A line cut into its pieces, in order: illustration notes split it into the text around them
 * and a figure where each stands ({ figure: the note's match }), and each text is cut at its 窓
 * and 同行 headings ({ text, level }). `level` is the heading level of the whole line, or null.
 */
function piecesOf(line, level, held) {
  const pieces = [];
  let pieceStart = 0;
  for (const match of line.matchAll(FIGURE_NOTE)) {
    pieces.push(...splitAtInlineHeadings(line.slice(pieceStart, match.index), level, held));
    pieces.push({ figure: match });
    pieceStart = match.index + match[0].length;
  }
  pieces.push(...splitAtInlineHeadings(line.slice(pieceStart), level, held));
  return pieces;
}

/**
 * Steps 1 and 2: the title and the author from the first lines, and the index of the first line
 * of the body, which is after the symbol note when the file has one. The gaiji of the header
 * lines are held in `held`.
 */
function readHeader(lines, held, name) {
  const headerText = (line) => displayWithoutRuby(held.hold(line).replace(NOTE, ""), held).trim();
  // 1. Title and author.
  let bodyStart = 0;
  const header = [];
  while (
    bodyStart < lines.length &&
    lines[bodyStart].trim() &&
    !DASHES.test(lines[bodyStart]) &&
    header.length < 3
  )
    header.push(lines[bodyStart++]);
  let title = header[0] ? headerText(header[0]) : "";
  const author = header[1] ? headerText(header[1]) || null : null;
  if (header[2]) title = `${title}　${headerText(header[2])}`;
  if (!title) title = baseName(name);

  // 2. The symbol note: the first line of dashes, if no text stands before it, to the second.
  let afterBlanks = bodyStart;
  while (afterBlanks < lines.length && !lines[afterBlanks].trim()) afterBlanks++;
  if (afterBlanks < lines.length && DASHES.test(lines[afterBlanks])) {
    let secondDashes = afterBlanks + 1;
    while (secondDashes < lines.length && !DASHES.test(lines[secondDashes])) secondDashes++;
    bodyStart = Math.min(secondDashes + 1, lines.length);
  }
  return { title, author, bodyStart };
}

/**
 * Step 3: the index of the line where the body ends, and the end notes from there, with their
 * gaiji as they are shown.
 */
function endNotesOf(lines, bodyStart, held) {
  // 3. The end notes.
  let bodyEnd = lines.length;
  for (let i = bodyStart; i < lines.length; i++)
    if (lines[i].startsWith("底本：")) {
      bodyEnd = i;
      break;
    }
  const endNotes = lines
    .slice(bodyEnd)
    .map((line) => held.shown(held.hold(line)).replace(/\s+$/, ""))
    .filter((line) => line.trim());
  return { bodyEnd, endNotes };
}

/**
 * Parse a 青空文庫 text (already decoded) into the book model.
 * @param {string} text
 * @param {{name?: string, key?: string|null, imageBase?: string|null, images?: Set<string>|null}} options
 *   `imageBase` is where a bundled book's images are (its folder, ending in "/"); without it an
 *   illustration note is dropped (D-108). `images`, when given, are the image files that exist.
 */
export function parseAozora(text, { name = "", key = null, imageBase = null, images = null } = {}) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const held = new HeldGaiji();
  const { title, author, bodyStart } = readHeader(lines, held, name);
  const { bodyEnd, endNotes } = endNotesOf(lines, bodyStart, held);

  // 5 and 7. The body, line by line.
  const builder = new BookBuilder();
  let rangeLevel = null; // inside 「［＃ここから大見出し］」 … 「［＃ここで大見出し終わり］」
  // The figure that a caption line would name now: the block index of the figure of the last
  // non-blank line, or null when that figure was dropped (an upload, D-108); undefined when the
  // last non-blank line had no figure.
  // The next piece of text resets it; a line of notes only does not.
  let figureForCaption;
  for (let i = bodyStart; i < bodyEnd; i++) {
    const line = held.hold(lines[i]);
    if (isBlank(line)) continue;

    const caption = line.match(CAPTION_LINE);
    if (caption && figureForCaption !== undefined) {
      if (figureForCaption !== null)
        builder.blocks[figureForCaption].figure.label =
          displayWithoutRuby(caption[1].replace(NOTE, ""), held).trim() || null;
      figureForCaption = undefined;
      continue;
    }

    let level = null;
    const rangeNote = line.match(HEADING_FROM);
    if (rangeNote) rangeLevel = HEADING_LEVELS[rangeNote[1]];
    const rangeEnds = HEADING_TO.test(line);
    const headingNote = line.match(HEADING_NOTE);
    if (headingNote) level = HEADING_LEVELS[headingNote[1]];
    else if (rangeLevel !== null) level = rangeLevel;
    if (rangeEnds) rangeLevel = null;

    for (const piece of piecesOf(line, level, held)) {
      if (piece.figure) {
        const [, quoted, captioned, file] = piece.figure;
        if (imageBase === null || (images && !images.has(file))) {
          figureForCaption = null; // D-108: the image is not at hand, the figure is dropped
          continue;
        }
        figureForCaption = builder.addFigure({
          src: imageBase + file,
          label: captioned && quoted ? held.shown(quoted.replace(NOTE, "")) : null,
          kind: "image",
        });
        continue;
      }
      const body = piece.text.replace(NOTE, "");
      if (isBlank(body)) continue;
      figureForCaption = undefined;
      const spoken = spokenOf(body, held);
      if (piece.level !== null) builder.addHeading(spoken, piece.level);
      else builder.addText(spoken);
    }
  }
  return builder.build({ key, title, author, format: "aozora", endNotes });
}

/** Hiragana to katakana (ぁ–ゖ → ァ–ヶ); everything else is kept. */
function toKatakana(text) {
  return text.replace(/[\u3041-\u3096]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}
