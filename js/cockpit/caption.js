// The caption of ドパドパ (ドパ ED D-08, D-47, ST-03, ST-04, PR-02; SPEC_dopa SD-D05, §6.3).
// Only the sentence being read, in DotGothic16 with hard alpha and a 1-pixel outline, white
// turning gold as spoken, redrawn on the 30-tick clock from the last light value it was given
// (D-20).
//
// A window of a fixed number of lines (D-47): the letters keep one size however long the sentence
// is; at most `lines` lines show; when more follow, the last shown line is translucent and
// nothing below it is drawn. When the light enters that translucent line, the text scrolls up one
// line in 6 ticks and the top line fades out. So a long sentence takes no more room than
// `lines` lines (a short one takes fewer); only while it scrolls, the line coming in is drawn up
// to 5/6 of a line under the box and the line leaving above it.
//
// All offsets count the characters of [...text]. `lit` is how many are lit, a whole number;
// `progress` is the same place with a fraction, for the bars. "Window" has two meanings here:
// the window of lines, and the time in which a noun can be shot (ST-28), which makes it flash.
import { canvas, ctx2d, hardAlpha, tint, drawOutlined } from "./pixel.js";

const NO_START =
  "、。，．・：；？！ー）」』】〕〉》’”ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ々…‥,.)!?;:";
const NO_END = "（「『【〔〈《‘“(";
const INK = "#1d1a2e",
  WHITE = "#ffffff",
  GOLD = "#ffcf3f";
const SCROLL_TICKS = 6, // the window goes down one line in this many ticks
  // the alpha of the last shown line while more lines follow (drawn at 0.5: blit rounds to
  // quarters)
  FADE_ALPHA = 0.45;

export class Caption {
  constructor({ x, y, w, h, font = "DotGothic16", lang = "ja", size = 32, lines = 3 }) {
    Object.assign(this, { box: { x, y, w, h }, font, lang, size, maxLines: lines });
    this.text = "";
    this.lit = 0; // how many characters are lit, from the start
    this.prev = null; // the sentence before, while it fades: { layout, topF, age (ticks) }
    this.terms = []; // the words that can be targets: [{ start, end, color? }] in display offsets
    this.topF = 0; // the first line shown; a fraction while the window scrolls
    // the nouns that can be shot now, which flash: [{start, end}] in display offsets (ST-28)
    this.flash = [];
    this.progress = 0; // where the song is, in display characters, fractional (D-132)
    this.flashOn = false; // the flash's phase: white on every other 4 ticks
  }
  /** The nouns whose window is open, and whether this tick shows them white (ST-28). */
  setFlash(ranges, on) {
    this.flash = ranges;
    this.flashOn = on;
  }

  /** New sentence (ST-03): laid out at the fixed size; the window starts at its first line.
   * `lang` "en" breaks lines at spaces; any other language between characters. */
  set(text, terms = [], lang = this.lang) {
    if (this.layout) this.prev = { layout: this.layout, topF: this.topF, age: 0 };
    this.lang = lang;
    this.text = text;
    this.terms = terms;
    this.lit = 0;
    this.topF = 0;
    this.layout = this.lay(text, this.size);
    this.render(this.layout);
  }
  /** Light the first n characters. */
  light(n) {
    this.lit = n;
  }
  /** Where the song is now, in display characters (fractional), for the progress bars (D-132). */
  setProgress(position) {
    this.progress = position;
  }
  /** Draw the caption (dx, dy) pixels from its place. */
  offset(dx, dy) {
    this.dx = dx;
    this.dy = dy;
  }
  /** The window's height in pixels (for placing the caption). */
  height() {
    return this.maxLines * Math.round(this.size * 1.25);
  }

  /** Cut the text into lines that fit the box's width: { size, lh (the height of a line), lines,
   * height }, each line a list of glyphs { ch, i (its index among the text's characters), w, x,
   * y }, centered. A line does not start with a closing mark (NO_START) and does not end with an
   * opening bracket (NO_END); English goes to the next line by whole words. */
  lay(text, size) {
    const measure = ctx2d(canvas(4, 4));
    measure.font = `${size}px "${this.font}"`;
    const maxWidth = this.box.w,
      lines = [];
    let line = [],
      widthSoFar = 0;
    const chars = [...text];
    for (let i = 0; i < chars.length; i++) {
      const char = chars[i],
        charWidth = measure.measureText(char).width;
      if (widthSoFar + charWidth > maxWidth && line.length && !NO_START.includes(char)) {
        let carry = []; // a line must not end with an opening bracket
        while (line.length && NO_END.includes(line[line.length - 1].ch)) carry.unshift(line.pop());
        if (this.lang === "en" && char !== " " && line.some((glyph) => glyph.ch === " ")) {
          // English: the word being written goes to the next line whole
          while (line.length && line[line.length - 1].ch !== " ") carry.unshift(line.pop());
        }
        lines.push(line);
        line = carry;
        widthSoFar = carry.reduce((sum, glyph) => sum + glyph.w, 0);
      }
      line.push({ ch: char, i, w: charWidth });
      widthSoFar += charWidth;
    }
    if (line.length) lines.push(line);
    const lineHeight = Math.round(size * 1.25);
    const placedLines = lines.map((row, rowIndex) => {
      const rowWidth = row.reduce((sum, glyph) => sum + glyph.w, 0);
      let left = Math.round((maxWidth - rowWidth) / 2);
      return row.map((glyph) => {
        const placed = { ...glyph, x: left, y: rowIndex * lineHeight };
        left += glyph.w;
        return placed;
      });
    });
    return { size, lh: lineHeight, lines: placedLines, height: placedLines.length * lineHeight };
  }

  /** Draw the layout's letters once, as masks of one color each: white, ink (the outline), gold
   * (lit), and the color of each target word; and make `full`, the canvas on which compose() puts
   * them together at each tick. */
  render(layout) {
    const sheet = canvas(this.box.w, layout.height + 4),
      ctx = ctx2d(sheet);
    ctx.font = `${layout.size}px "${this.font}"`;
    ctx.textBaseline = "top";
    ctx.fillStyle = "#fff";
    layout.lines
      .flat()
      .forEach((glyph) => ctx.fillText(glyph.ch, Math.round(glyph.x), glyph.y + 2));
    hardAlpha(sheet, 110);
    layout.white = tint(sheet, WHITE);
    layout.ink = tint(sheet, INK);
    layout.gold = tint(sheet, GOLD);
    layout.colored = this.terms.map((term) => ({ ...term, img: tint(sheet, term.color || GOLD) }));
    layout.full = canvas(this.box.w + 2, layout.height + 6);
    layout.fx = ctx2d(layout.full);
  }

  /** The line that holds the last lit character. */
  litLine(layout) {
    if (this.lit <= 0) return 0;
    for (let index = 0; index < layout.lines.length; index++) {
      const line = layout.lines[index];
      if (line.length && line[line.length - 1].i >= this.lit - 1) return index;
    }
    return layout.lines.length - 1;
  }

  /** Compose the whole sentence (outline, white, term colors, gold light) into layout.full. */
  compose(layout, lit) {
    const ctx = layout.fx;
    ctx.clearRect(0, 0, layout.full.width, layout.full.height);
    drawOutlined(ctx, layout.white, layout.ink, 1, 1);
    for (const term of layout.colored)
      clipChars(ctx, layout, term.start, term.end, () => ctx.drawImage(term.img, 1, 1));
    clipChars(ctx, layout, 0, lit, () => {
      // the glow, never blurred: the gold letters once more, faint, one pixel down and right
      ctx.globalAlpha = 0.4;
      ctx.drawImage(layout.gold, 2, 2);
      ctx.globalAlpha = 1;
      ctx.drawImage(layout.gold, 1, 1);
    });
    // the progress bar under each line (D-132): dark track, gold fill up to where the song is;
    // under a word that can be a target, blue, brighter while the bar is on it
    if (layout === this.layout) this.drawBars(ctx, layout);
    // a noun in its window flashes white, with a brighter outline (ST-28)
    if (layout === this.layout && this.flashOn)
      for (const range of this.flash)
        clipChars(ctx, layout, range.start, range.end, () => {
          ctx.drawImage(layout.gold, 0, 1);
          ctx.drawImage(layout.gold, 2, 1);
          ctx.drawImage(layout.gold, 1, 0);
          ctx.drawImage(layout.gold, 1, 2);
          ctx.drawImage(layout.white, 1, 1);
        });
  }

  /** The progress bar under each letter: a dark track (blue under a target word), filled as far
   * as the song has come. */
  drawBars(ctx, layout) {
    const songAt = this.progress,
      targetOf = (index) => this.terms.find((term) => index >= term.start && index < term.end);
    for (const line of layout.lines) {
      if (!line.length) continue;
      const y = line[0].y + layout.lh - 3;
      for (const glyph of line) {
        const left = Math.floor(glyph.x) + 1,
          width = Math.ceil(glyph.x + glyph.w) - Math.floor(glyph.x),
          filled = Math.max(0, Math.min(1, songAt - glyph.i)),
          term = targetOf(glyph.i),
          on = term && songAt >= term.start && songAt < term.end;
        ctx.fillStyle = term ? "#2f6fb0" : "#3a3040";
        ctx.fillRect(left, y, width, 3);
        if (filled > 0) {
          ctx.fillStyle = term ? (on ? "#d8f2ff" : "#8fd0ff") : "#ffcf3f";
          ctx.fillRect(left, y, Math.max(1, Math.round(width * filled)), 3);
        }
      }
    }
  }

  /** Copy the window of lines [topF, topF + maxLines) into the box, bottom-aligned. */
  blit(ctx, layout, topF, alpha = 1) {
    const box = this.box,
      lineCount = layout.lines.length,
      maxLines = this.maxLines,
      lineHeight = layout.lh;
    const shown = Math.min(maxLines, lineCount),
      boxTop = box.y + box.h - shown * lineHeight + (this.dy || 0),
      left = box.x + (this.dx || 0) - 1;
    const first = Math.floor(topF),
      frac = topF - first;
    for (let line = first; line < Math.min(lineCount, first + maxLines + 1); line++) {
      const row = line - topF; // the line's place in the window, in lines
      if (row <= -1 || row >= maxLines) continue;
      let lineAlpha = alpha;
      if (row < 0) lineAlpha *= 1 + row; // the top line fades as it scrolls out
      // six steps of 1/6 add up to 0.9999999999999999: for that one tick the top counts as whole
      const lastShown = Math.floor(topF + 1e-6) + maxLines - 1;
      // more follows: the last shown line is translucent
      if (line === lastShown && line < lineCount - 1) lineAlpha *= FADE_ALPHA;
      if (line > lastShown) lineAlpha *= frac; // the next line comes in while scrolling
      if (lineAlpha <= 0.02) continue;
      // alpha in steps, like everything at 30 ticks
      ctx.globalAlpha = Math.round(lineAlpha * 4) / 4 || 0.25;
      const top = Math.round(boxTop + row * lineHeight);
      // one line's own rows only: 4 rows more would show the tops of the letters of the line below
      ctx.drawImage(
        layout.full,
        0,
        line * lineHeight,
        layout.full.width,
        lineHeight,
        left,
        top,
        layout.full.width,
        lineHeight,
      );
    }
    ctx.globalAlpha = 1;
  }

  /** Where the window stands, for checks: how many lines the sentence has, the first line shown
   * (a fraction while it scrolls), and the line that holds the last lit letter. */
  window() {
    const layout = this.layout;
    return layout
      ? { lines: layout.lines.length, top: this.topF, litLine: this.litLine(layout) }
      : null;
  }

  /** Take the sentence away (a chapter starts, a card is up). */
  clear() {
    this.layout = null;
    this.prev = null;
    this.text = "";
    this.lit = 0;
  }

  /** Draw at the current tick. Call it once a tick, no more: it also moves the window and ages
   * the sentence before. */
  draw(ctx) {
    const layout = this.layout;
    if (this.prev && this.prev.age < 9) {
      // the previous caption fades upward for 9 ticks (ST-03): 0.66, 0.33 and 0.15 for 3 ticks
      // each, which blit draws at 0.75, 0.25 and 0.25
      const previous = this.prev;
      this.compose(previous.layout, 1e9);
      ctx.save();
      ctx.translate(0, -2 * previous.age);
      this.blit(
        ctx,
        previous.layout,
        previous.topF,
        [0.66, 0.33, 0.15][Math.floor(previous.age / 3)],
      );
      ctx.restore();
      previous.age++;
    }
    if (!layout) return;
    // the window's top line: one line above the line being read, so that the line being read is
    // never in the translucent last place. With 3 lines shown: top = the lit line - 1, and at the
    // sentence's end the window holds its last two lines and an empty third row.
    const lineCount = layout.lines.length,
      maxLines = this.maxLines;
    const want =
      lineCount <= maxLines
        ? 0
        : Math.max(0, Math.min(this.litLine(layout) - (maxLines - 2), lineCount - (maxLines - 1)));
    if (this.topF < want) this.topF = Math.min(want, this.topF + 1 / SCROLL_TICKS);
    else if (this.topF > want) this.topF = want;
    this.compose(layout, this.lit);
    this.blit(ctx, layout, this.topF);
  }
}

/** Run `draw` with the drawing limited to the characters from `from` to `to` (not included). */
function clipChars(ctx, layout, from, to, draw) {
  if (to <= from) return;
  ctx.save();
  ctx.beginPath();
  for (const glyph of layout.lines.flat())
    if (glyph.i >= from && glyph.i < to)
      ctx.rect(Math.floor(glyph.x), glyph.y, Math.ceil(glyph.w) + 2, layout.lh + 2);
  ctx.clip();
  draw();
  ctx.restore();
}
