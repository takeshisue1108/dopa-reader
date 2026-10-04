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

const INK = "#1d1a2e";
const WHITE = "#ffffff";
const GOLD = "#ffcf3f";

const SCROLL_TICKS = 6; // the window goes down one line in this many ticks

// the alpha of the last shown line while more lines follow (drawn at 0.5: blit rounds to
// quarters)
const FADE_ALPHA = 0.45;

export class Caption {
  constructor({ x, y, w, h, font = "DotGothic16", lang = "ja", size = 32, lines = 3 }) {
    const box = { x, y, w, h };
    const given = {
      box,
      font,
      lang,
      size,
      maxLines: lines,
    };
    Object.assign(this, given);

    this.text = "";
    this.lit = 0; // how many characters are lit, from the start

    // the sentence before, while it fades: { layout, topF, age (ticks) }
    this.prev = null;

    // the words that can be targets: [{ start, end, color? }] in display offsets
    this.terms = [];

    this.topF = 0; // the first line shown; a fraction while the window scrolls

    // the nouns that can be shot now, which flash: [{start, end}] in display offsets (ST-28)
    this.flash = [];

    // where the song is, in display characters, fractional (D-132)
    this.progress = 0;

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
    if (this.layout) {
      this.prev = {
        layout: this.layout,
        topF: this.topF,
        age: 0,
      };
    }

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
    const lineHeight = Math.round(this.size * 1.25);
    return this.maxLines * lineHeight;
  }

  /** Cut the text into lines that fit the box's width: { size, lh (the height of a line), lines,
   * height }, each line a list of glyphs { ch, i (its index among the text's characters), w, x,
   * y }, centered. A line does not start with a closing mark (NO_START) and does not end with an
   * opening bracket (NO_END); English goes to the next line by whole words. */
  lay(text, size) {
    const scratch = canvas(4, 4);
    const measure = ctx2d(scratch);
    measure.font = `${size}px "${this.font}"`;

    const maxWidth = this.box.w;
    const lines = [];
    let line = [];
    let widthSoFar = 0;

    const chars = [...text];
    for (let i = 0; i < chars.length; i++) {
      const char = chars[i];
      const charWidth = measure.measureText(char).width;

      const tooWide = widthSoFar + charWidth > maxWidth;
      if (tooWide && line.length && !NO_START.includes(char)) {
        // a line must not end with an opening bracket
        let carry = [];
        while (line.length) {
          const last = line[line.length - 1];
          if (!NO_END.includes(last.ch)) {
            break;
          }
          const taken = line.pop();
          carry.unshift(taken);
        }

        const inEnglishWord = this.lang === "en" && char !== " ";
        if (inEnglishWord && line.some((glyph) => glyph.ch === " ")) {
          // English: the word being written goes to the next line whole
          while (line.length) {
            const last = line[line.length - 1];
            if (last.ch === " ") {
              break;
            }
            const taken = line.pop();
            carry.unshift(taken);
          }
        }

        lines.push(line);
        line = carry;
        widthSoFar = carry.reduce((sum, glyph) => sum + glyph.w, 0);
      }

      const glyph = {
        ch: char,
        i,
        w: charWidth,
      };
      line.push(glyph);
      widthSoFar += charWidth;
    }

    if (line.length) {
      lines.push(line);
    }

    const lineHeight = Math.round(size * 1.25);

    const placedLines = lines.map((row, rowIndex) => {
      const rowWidth = row.reduce((sum, glyph) => sum + glyph.w, 0);
      const margin = (maxWidth - rowWidth) / 2;
      let left = Math.round(margin);
      const top = rowIndex * lineHeight;

      return row.map((glyph) => {
        const placed = {
          ...glyph,
          x: left,
          y: top,
        };
        left += glyph.w;
        return placed;
      });
    });

    return {
      size,
      lh: lineHeight,
      lines: placedLines,
      height: placedLines.length * lineHeight,
    };
  }

  /** Draw the layout's letters once, as masks of one color each: white, ink (the outline), gold
   * (lit), and the color of each target word; and make `full`, the canvas on which compose() puts
   * them together at each tick. */
  render(layout) {
    const sheet = canvas(this.box.w, layout.height + 4);
    const ctx = ctx2d(sheet);

    ctx.font = `${layout.size}px "${this.font}"`;
    ctx.textBaseline = "top";
    ctx.fillStyle = "#fff";

    const glyphs = layout.lines.flat();
    for (const glyph of glyphs) {
      const left = Math.round(glyph.x);
      ctx.fillText(glyph.ch, left, glyph.y + 2);
    }
    hardAlpha(sheet, 110);

    layout.white = tint(sheet, WHITE);
    layout.ink = tint(sheet, INK);
    layout.gold = tint(sheet, GOLD);

    layout.colored = this.terms.map((term) => {
      const color = term.color || GOLD;
      const img = tint(sheet, color);
      return { ...term, img };
    });

    layout.full = canvas(this.box.w + 2, layout.height + 6);
    layout.fx = ctx2d(layout.full);
  }

  /** The line that holds the last lit character. */
  litLine(layout) {
    if (this.lit <= 0) {
      return 0;
    }

    for (let index = 0; index < layout.lines.length; index++) {
      const line = layout.lines[index];
      if (!line.length) {
        continue;
      }

      const lastGlyph = line[line.length - 1];
      if (lastGlyph.i >= this.lit - 1) {
        return index;
      }
    }

    return layout.lines.length - 1;
  }

  /** Compose the whole sentence (outline, white, term colors, gold light) into layout.full. */
  compose(layout, lit) {
    const ctx = layout.fx;
    ctx.clearRect(0, 0, layout.full.width, layout.full.height);
    drawOutlined(ctx, layout.white, layout.ink, 1, 1);

    for (const term of layout.colored) {
      clipChars(ctx, layout, term.start, term.end, () => ctx.drawImage(term.img, 1, 1));
    }

    clipChars(ctx, layout, 0, lit, () => {
      // the glow, never blurred: the gold letters once more, faint, one pixel down and right
      ctx.globalAlpha = 0.4;
      ctx.drawImage(layout.gold, 2, 2);
      ctx.globalAlpha = 1;
      ctx.drawImage(layout.gold, 1, 1);
    });

    // the progress bar under each line (D-132): dark track, gold fill up to where the song is;
    // under a word that can be a target, blue, brighter while the bar is on it
    if (layout === this.layout) {
      this.drawBars(ctx, layout);
    }

    // a noun in its window flashes white, with a brighter outline (ST-28)
    if (layout === this.layout && this.flashOn) {
      for (const range of this.flash) {
        clipChars(ctx, layout, range.start, range.end, () => {
          ctx.drawImage(layout.gold, 0, 1);
          ctx.drawImage(layout.gold, 2, 1);
          ctx.drawImage(layout.gold, 1, 0);
          ctx.drawImage(layout.gold, 1, 2);
          ctx.drawImage(layout.white, 1, 1);
        });
      }
    }
  }

  /** The progress bar under each letter: a dark track (blue under a target word), filled as far
   * as the song has come. */
  drawBars(ctx, layout) {
    const songAt = this.progress;
    const targetOf = (index) => this.terms.find((term) => index >= term.start && index < term.end);

    for (const line of layout.lines) {
      if (!line.length) {
        continue;
      }

      const y = line[0].y + layout.lh - 3;

      for (const glyph of line) {
        const glyphLeft = Math.floor(glyph.x);
        const glyphRight = Math.ceil(glyph.x + glyph.w);
        const left = glyphLeft + 1;
        const width = glyphRight - glyphLeft;

        const sungOfGlyph = songAt - glyph.i;
        const sungAtMost = Math.min(1, sungOfGlyph);
        const filled = Math.max(0, sungAtMost);

        const term = targetOf(glyph.i);

        ctx.fillStyle = term ? "#2f6fb0" : "#3a3040";
        ctx.fillRect(left, y, width, 3);

        if (filled > 0) {
          if (term) {
            const on = songAt >= term.start && songAt < term.end;
            ctx.fillStyle = on ? "#d8f2ff" : "#8fd0ff";
          } else {
            ctx.fillStyle = "#ffcf3f";
          }

          const filledWidth = Math.round(width * filled);
          const drawnWidth = Math.max(1, filledWidth);
          ctx.fillRect(left, y, drawnWidth, 3);
        }
      }
    }
  }

  /** Copy the window of lines [topF, topF + maxLines) into the box, bottom-aligned. */
  blit(ctx, layout, topF, alpha = 1) {
    const box = this.box;
    const lineCount = layout.lines.length;
    const maxLines = this.maxLines;
    const lineHeight = layout.lh;

    const shown = Math.min(maxLines, lineCount);
    const boxBottom = box.y + box.h;
    const shownHeight = shown * lineHeight;
    const movedDown = this.dy || 0;
    const movedRight = this.dx || 0;
    const boxTop = boxBottom - shownHeight + movedDown;
    const left = box.x + movedRight - 1;

    const first = Math.floor(topF);
    const frac = topF - first;
    const end = Math.min(lineCount, first + maxLines + 1);

    for (let line = first; line < end; line++) {
      const row = line - topF; // the line's place in the window, in lines
      if (row <= -1 || row >= maxLines) {
        continue;
      }

      let lineAlpha = alpha;

      // the top line fades as it scrolls out
      if (row < 0) {
        lineAlpha *= 1 + row;
      }

      // six steps of 1/6 add up to 0.9999999999999999: for that one tick the top counts as whole
      const wholeTop = Math.floor(topF + 1e-6);
      const lastShown = wholeTop + maxLines - 1;

      // more follows: the last shown line is translucent
      const moreFollows = line < lineCount - 1;
      if (line === lastShown && moreFollows) {
        lineAlpha *= FADE_ALPHA;
      }

      // the next line comes in while scrolling
      if (line > lastShown) {
        lineAlpha *= frac;
      }

      if (lineAlpha <= 0.02) {
        continue;
      }

      // alpha in steps, like everything at 30 ticks
      let steppedAlpha = Math.round(lineAlpha * 4) / 4;
      if (!steppedAlpha) {
        steppedAlpha = 0.25;
      }
      ctx.globalAlpha = steppedAlpha;

      const rowTop = boxTop + row * lineHeight;
      const top = Math.round(rowTop);

      // one line's own rows only: 4 rows more would show the tops of the letters of the line below
      const sourceTop = line * lineHeight;
      const width = layout.full.width;
      ctx.drawImage(layout.full, 0, sourceTop, width, lineHeight, left, top, width, lineHeight);
    }

    ctx.globalAlpha = 1;
  }

  /** Where the window stands, for checks: how many lines the sentence has, the first line shown
   * (a fraction while it scrolls), and the line that holds the last lit letter. */
  window() {
    const layout = this.layout;
    if (!layout) {
      return null;
    }

    const litLine = this.litLine(layout);
    return {
      lines: layout.lines.length,
      top: this.topF,
      litLine,
    };
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

      const rise = -2 * previous.age;
      const fadeStep = Math.floor(previous.age / 3);
      const alpha = [0.66, 0.33, 0.15][fadeStep];

      ctx.save();
      ctx.translate(0, rise);
      this.blit(ctx, previous.layout, previous.topF, alpha);
      ctx.restore();

      previous.age++;
    }

    if (!layout) {
      return;
    }

    // the window's top line: one line above the line being read, so that the line being read is
    // never in the translucent last place. With 3 lines shown: top = the lit line - 1, and at the
    // sentence's end the window holds its last two lines and an empty third row.
    const lineCount = layout.lines.length;
    const maxLines = this.maxLines;

    let want;
    if (lineCount <= maxLines) {
      want = 0;
    } else {
      const litLine = this.litLine(layout);
      const aboveLit = litLine - (maxLines - 2);
      const lastTop = lineCount - (maxLines - 1);
      const top = Math.min(aboveLit, lastTop);
      want = Math.max(0, top);
    }

    if (this.topF < want) {
      const oneStepDown = this.topF + 1 / SCROLL_TICKS;
      this.topF = Math.min(want, oneStepDown);
    } else if (this.topF > want) {
      this.topF = want;
    }

    this.compose(layout, this.lit);
    this.blit(ctx, layout, this.topF);
  }
}

/** Run `draw` with the drawing limited to the characters from `from` to `to` (not included). */
function clipChars(ctx, layout, from, to, draw) {
  if (to <= from) {
    return;
  }

  ctx.save();
  ctx.beginPath();

  const glyphs = layout.lines.flat();
  for (const glyph of glyphs) {
    const inRange = glyph.i >= from && glyph.i < to;
    if (inRange) {
      const left = Math.floor(glyph.x);
      const width = Math.ceil(glyph.w) + 2;
      ctx.rect(left, glyph.y, width, layout.lh + 2);
    }
  }

  ctx.clip();
  draw();
  ctx.restore();
}
