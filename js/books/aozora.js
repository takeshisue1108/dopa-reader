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
  "1-13-1": "①", "1-13-2": "②", "1-13-3": "③", "1-13-4": "④", "1-13-5": "⑤",
  "1-13-6": "⑥", "1-13-7": "⑦", "1-13-8": "⑧", "1-13-9": "⑨", "1-13-10": "⑩",
  "1-13-11": "⑪", "1-13-12": "⑫", "1-13-13": "⑬", "1-13-14": "⑭", "1-13-15": "⑮",
  "1-13-16": "⑯", "1-13-17": "⑰", "1-13-18": "⑱", "1-13-19": "⑲", "1-13-20": "⑳",
  "1-13-21": "Ⅰ", "1-13-22": "Ⅱ", "1-13-23": "Ⅲ", "1-13-24": "Ⅳ", "1-13-25": "Ⅴ",
  "1-13-26": "Ⅵ", "1-13-27": "Ⅶ", "1-13-28": "Ⅷ", "1-13-29": "Ⅸ", "1-13-30": "Ⅹ",
  "1-13-31": "Ⅺ",
  "1-13-55": "Ⅻ",
  "1-84-31": "彽",
  "1-87-71": "犍",
  "1-90-47": "腊",
  "1-93-14": "銈",
  "2-12-67": "慠",
};

// Placeholders for gaiji while a line is parsed, so that a gaiji counts as a kanji in a ruby base
// and a mapped 《 or ［ cannot be taken for markup. Private-use characters, never in a 青空文庫 text.
const HOLD_BASE = 0xe000;
const HOLD = /[-]/;
const GAIJI_NOTE = /※［＃([^［］]*)］/g;
const NOTE = /［＃[^［］]*］/g;
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
const INLINE_BRACKETED = /［＃(?:窓|同行)([大中小])見出し］([^［］]*(?:［＃(?!(?:窓|同行)?[大中小]見出し終わり)[^［］]*］[^［］]*)*)［＃(?:窓|同行)?[大中小]見出し終わり］/;
const INLINE_QUOTED = /［＃「([^［］]*)」は(?:窓|同行)([大中小])見出し］/;
// 「［＃キャプション］…［＃キャプション終わり］」 alone on a line (after any indent notes)
const CAPTION_LINE = /^[\s　]*(?:［＃[^［］]*字下げ］)*［＃キャプション］(.*?)［＃キャプション終わり］[\s　]*$/;
const DASHES = /^-{20,}\s*$/;

/** The character of a gaiji note's body, or null (§5.2 step 6). */
export function gaijiChar(body) {
  const unicode = body.match(/U\+([0-9A-Fa-f]{4,6})/);
  if (unicode) return String.fromCodePoint(parseInt(unicode[1], 16));
  const jis = body.match(/(?:^|、|水準)([12]-\d{1,2}-\d{1,2})(?:、|$)/);
  return jis ? (GAIJI[jis[1]] ?? null) : null;
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
  if (HOLD.test(ch) && held.has(ch)) {
    const { char, kanji } = held.get(ch);
    return char === null ? (kanji ? "kanji" : null) : letterKind(char, held);
  }
  if (isKanji(ch)) return "kanji";
  if (/[\p{Script=Hiragana}]/u.test(ch)) return "hiragana";
  if (/[\p{Script=Katakana}ー]/u.test(ch)) return "katakana";
  if (/[\p{Script=Latin}0-9０-９'’]/u.test(ch)) return "latin";
  return null;
}

/**
 * One line of the book as a Spoken text (§5.2 steps 4 and 6). `held` maps a placeholder to
 * {char, kanji}: its gaiji character, or null for an unmapped gaiji (shown as 「※」 and not sung).
 */
function spokenOf(line, held) {
  const out = new Spoken();
  const chars = Array.from(line);
  const emit = (text) => {
    for (const ch of Array.from(text)) {
      if (HOLD.test(ch) && held.has(ch)) {
        const real = held.get(ch).char;
        if (real === null) out.silent("※");
        else out.plain(real);
      } else out.plain(ch);
    }
  };
  const shown = (text) =>
    Array.from(text)
      .map((ch) => (HOLD.test(ch) && held.has(ch) ? (held.get(ch).char ?? "※") : ch))
      .join("");
  let pending = []; // characters since the last ruby or 「｜」, not yet emitted
  let barAt = -1; // index in pending where 「｜」 started a base
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === "｜" || ch === "|") {
      const close = chars.indexOf("《", i + 1);
      if (close > i && !chars.slice(i + 1, close).includes("》")) {
        emit(pending.join(""));
        pending = [];
        barAt = 0;
        continue;
      }
    }
    if (ch === "《") {
      const end = chars.indexOf("》", i + 1);
      if (end > i) {
        const reading = shown(chars.slice(i + 1, end).join(""));
        let baseStart;
        if (barAt >= 0) baseStart = barAt;
        else {
          baseStart = pending.length;
          const kind = baseStart > 0 ? letterKind(pending[baseStart - 1], held) : null;
          if (kind)
            while (baseStart > 0 && letterKind(pending[baseStart - 1], held) === kind) baseStart--;
        }
        emit(pending.slice(0, baseStart).join(""));
        // the reading goes into the speech in katakana: kuromoji cuts a hiragana reading poorly
        // inside a sentence (かのじ|ゃちぼうぎゃく), and the song sings katakana anyway (§5.5)
        out.ruby(shown(pending.slice(baseStart).join("")), toKatakana(reading));
        pending = [];
        barAt = -1;
        i = end;
        continue;
      }
    }
    pending.push(ch);
  }
  emit(pending.join(""));
  return out;
}

/** The display text of a line, without its ruby readings. */
function displayOf(line, held) {
  return spokenOf(line, held).display;
}

/**
 * A piece of a line cut at its 窓 or 同行 heading: [{text, level}], where the heading's own words
 * have its level and the text around it has `level` (the level of the whole line, or null).
 */
function inlineHeadings(text, level, held) {
  const bracketed = text.match(INLINE_BRACKETED);
  if (bracketed) {
    const at = bracketed.index;
    return [
      { text: text.slice(0, at), level },
      { text: bracketed[2], level: HEADING_LEVELS[bracketed[1]] },
      ...inlineHeadings(text.slice(at + bracketed[0].length), level, held),
    ];
  }
  const quoted = text.match(INLINE_QUOTED);
  if (quoted) {
    // the heading is the run just before the note whose display is the quoted words
    const before = text.slice(0, quoted.index);
    const words = displayOf(quoted[1].replace(NOTE, ""), held);
    for (let start = before.length - 1; start >= 0; start--)
      if (displayOf(before.slice(start).replace(NOTE, ""), held) === words)
        return [
          { text: before.slice(0, start), level },
          { text: before.slice(start), level: HEADING_LEVELS[quoted[2]] },
          ...inlineHeadings(text.slice(quoted.index + quoted[0].length), level, held),
        ];
    return [{ text: before, level: HEADING_LEVELS[quoted[2]] }, ...inlineHeadings(text.slice(quoted.index + quoted[0].length), level, held)];
  }
  return [{ text, level }];
}

/**
 * Parse a 青空文庫 text (already decoded) into the book model.
 * @param {string} text
 * @param {{name?: string, key?: string|null, imageBase?: string|null, images?: Set<string>|null}} options
 *   `imageBase` is where a bundled book's images are (its folder, ending in "/"); without it an
 *   illustration note is dropped (D-108). `images`, when given, are the image files that exist.
 */
export function parseAozora(text, { name = "", key = null, imageBase = null, images = null } = {}) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const held = new Map();
  let nextHold = HOLD_BASE;
  const hold = (line) =>
    line.replace(GAIJI_NOTE, (_, body) => {
      const placeholder = String.fromCharCode(nextHold++);
      held.set(placeholder, { char: gaijiChar(body), kanji: body.startsWith("「") });
      return placeholder;
    });
  const release = (line) =>
    Array.from(line)
      .map((ch) => (HOLD.test(ch) && held.has(ch) ? (held.get(ch).char ?? "※") : ch))
      .join("");

  // 1. Title and author.
  let index = 0;
  const header = [];
  while (index < lines.length && lines[index].trim() && !DASHES.test(lines[index]) && header.length < 3)
    header.push(lines[index++]);
  const clean = (line) => displayOf(hold(line).replace(NOTE, ""), held).trim();
  let title = header[0] ? clean(header[0]) : "";
  const author = header[1] ? clean(header[1]) || null : null;
  if (header[2]) title = `${title}　${clean(header[2])}`;
  if (!title) title = baseName(name);

  // 2. The symbol note: the first line of dashes, if no text stands before it, to the second.
  let at = index;
  while (at < lines.length && !lines[at].trim()) at++;
  if (at < lines.length && DASHES.test(lines[at])) {
    let end = at + 1;
    while (end < lines.length && !DASHES.test(lines[end])) end++;
    index = Math.min(end + 1, lines.length);
  }

  // 3. The end notes.
  let bodyEnd = lines.length;
  for (let i = index; i < lines.length; i++)
    if (lines[i].startsWith("底本：")) {
      bodyEnd = i;
      break;
    }
  const endNotes = lines
    .slice(bodyEnd)
    .map((line) => release(hold(line)).replace(/\s+$/, ""))
    .filter((line) => line.trim());

  // 5 and 7. The body, line by line.
  const builder = new BookBuilder();
  let rangeLevel = null; // inside 「［＃ここから大見出し］」 … 「［＃ここで大見出し終わり］」
  // The figure of the last non-blank line, which a caption line right after it names: its block
  // index, or null when the figure was dropped (an upload, D-108); undefined when there is none.
  let figureBefore;
  for (let i = index; i < bodyEnd; i++) {
    const line = hold(lines[i]);
    if (!line.replace(/[\s　]/g, "")) continue;

    const caption = line.match(CAPTION_LINE);
    if (caption && figureBefore !== undefined) {
      if (figureBefore !== null)
        builder.blocks[figureBefore].figure.label = displayOf(caption[1].replace(NOTE, ""), held).trim() || null;
      figureBefore = undefined;
      continue;
    }

    let level = null;
    const from = line.match(HEADING_FROM);
    if (from) rangeLevel = HEADING_LEVELS[from[1]];
    const to = HEADING_TO.test(line);
    const note = line.match(HEADING_NOTE);
    if (note) level = HEADING_LEVELS[note[1]];
    else if (rangeLevel !== null) level = rangeLevel;
    if (to) rangeLevel = null;

    // Illustration notes split the line: the text around them, and a figure where each stands.
    const pieces = [];
    let last = 0;
    for (const match of line.matchAll(FIGURE_NOTE)) {
      pieces.push(...inlineHeadings(line.slice(last, match.index), level, held));
      pieces.push({ figure: match });
      last = match.index + match[0].length;
    }
    pieces.push(...inlineHeadings(line.slice(last), level, held));

    for (const piece of pieces) {
      if (piece.figure) {
        const [, quoted, captioned, file] = piece.figure;
        if (imageBase === null || (images && !images.has(file))) {
          figureBefore = null; // D-108
          continue;
        }
        figureBefore = builder.figure({
          src: imageBase + file,
          label: captioned && quoted ? release(quoted.replace(NOTE, "")) : null,
          kind: "image",
        });
        continue;
      }
      const body = piece.text.replace(NOTE, "");
      if (!body.replace(/[\s　]/g, "")) continue;
      figureBefore = undefined;
      const spoken = spokenOf(body, held);
      if (piece.level !== null) builder.heading(spoken, piece.level);
      else builder.text(spoken);
    }
  }
  return builder.book({ key, title, author, format: "aozora", endNotes });
}

/** Hiragana to katakana (ぁ–ゖ → ァ–ヶ); everything else is kept. */
function toKatakana(text) {
  return text.replace(/[\u3041-\u3096]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}
