// The caption of ドパドパ (ドパ ED D-08, D-47, ST-03, ST-04, PR-02; SPEC_dopa SD-D05, §6.3).
// Only the sentence being read, in DotGothic16 with hard alpha and a 1-pixel outline, white turning
// gold as spoken, redrawn on the 30-tick clock from the last light value it was given (D-20).
//
// A window of a fixed number of lines (D-47): the letters keep one size however long the sentence is;
// at most `lines` lines show; when more follow, the last shown line is translucent and nothing below
// it is drawn. When the light enters that translucent line, the text scrolls up one line in 6 ticks
// and the top line fades out. So the caption always has the same height and never covers what is
// below it.
import { canvas, ctx2d, hardAlpha, tint, drawOutlined } from "./pixel.js";

const NO_START =
  "、。，．・：；？！ー）」』】〕〉》’”ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ々…‥,.)!?;:";
const NO_END = "（「『【〔〈《‘“(";
const INK = "#1d1a2e",
  WHITE = "#ffffff",
  GOLD = "#ffcf3f";
const SCROLL_TICKS = 6,
  FADE_ALPHA = 0.45;

export class Caption {
  constructor({ x, y, w, h, font = "DotGothic16", lang = "ja", size = 32, lines = 3 }) {
    Object.assign(this, { box: { x, y, w, h }, font, lang, size, maxLines: lines });
    this.text = "";
    this.lit = 0;
    this.prev = null;
    this.terms = [];
    this.topF = 0;
    this.flash = []; // nouns in their window: [{start, end}] in display offsets (ST-28)
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
  light(n) {
    this.lit = n;
  }
  /** Where the song is now, in display characters (fractional), for the progress bars (D-132). */
  setProgress(position) {
    this.progress = position;
  }
  offset(dx, dy) {
    this.dx = dx;
    this.dy = dy;
  }
  /** The window's height in pixels (for placing the caption). */
  height() {
    return this.maxLines * Math.round(this.size * 1.25);
  }

  lay(text, size) {
    const m = ctx2d(canvas(4, 4));
    m.font = `${size}px "${this.font}"`;
    const maxW = this.box.w,
      lines = [];
    let line = [],
      wsum = 0;
    const chars = [...text];
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i],
        cw = m.measureText(ch).width;
      if (wsum + cw > maxW && line.length && !NO_START.includes(ch)) {
        let carry = []; // a line must not end with an opening bracket
        while (line.length && NO_END.includes(line[line.length - 1].ch)) carry.unshift(line.pop());
        if (this.lang === "en" && ch !== " " && line.some((c) => c.ch === " ")) {
          // English: the word being written goes to the next line whole
          while (line.length && line[line.length - 1].ch !== " ") carry.unshift(line.pop());
        }
        lines.push(line);
        line = carry;
        wsum = carry.reduce((a, c) => a + c.w, 0);
      }
      line.push({ ch, i, w: cw });
      wsum += cw;
    }
    if (line.length) lines.push(line);
    const lh = Math.round(size * 1.25);
    const out = lines.map((ln, k) => {
      const lw = ln.reduce((a, c) => a + c.w, 0);
      let x = Math.round((maxW - lw) / 2);
      return ln.map((c) => {
        const o = { ...c, x, y: k * lh };
        x += c.w;
        return o;
      });
    });
    return { size, lh, lines: out, height: out.length * lh };
  }

  render(lay) {
    const c = canvas(this.box.w, lay.height + 4),
      x = ctx2d(c);
    x.font = `${lay.size}px "${this.font}"`;
    x.textBaseline = "top";
    x.fillStyle = "#fff";
    lay.lines.flat().forEach((g) => x.fillText(g.ch, Math.round(g.x), g.y + 2));
    hardAlpha(c, 110);
    lay.white = tint(c, WHITE);
    lay.ink = tint(c, INK);
    lay.gold = tint(c, GOLD);
    lay.colored = this.terms.map((t) => ({ ...t, img: tint(c, t.color || GOLD) }));
    lay.full = canvas(this.box.w + 2, lay.height + 6);
    lay.fx = ctx2d(lay.full);
  }

  /** The line that holds the last lit character. */
  litLine(lay) {
    if (this.lit <= 0) return 0;
    for (let k = 0; k < lay.lines.length; k++) {
      const ln = lay.lines[k];
      if (ln.length && ln[ln.length - 1].i >= this.lit - 1) return k;
    }
    return lay.lines.length - 1;
  }

  /** Compose the whole sentence (outline, white, term colors, gold light) into lay.full. */
  compose(lay, lit) {
    const x = lay.fx;
    x.clearRect(0, 0, lay.full.width, lay.full.height);
    drawOutlined(x, lay.white, lay.ink, 1, 1);
    for (const t of lay.colored) clipChars(x, lay, t.start, t.end, () => x.drawImage(t.img, 1, 1));
    clipChars(x, lay, 0, lit, () => {
      x.globalAlpha = 0.4;
      x.drawImage(lay.gold, 2, 2);
      x.globalAlpha = 1; // the glow, never blurred
      x.drawImage(lay.gold, 1, 1);
    });
    // the progress bar under each line (D-132): dark track, gold fill up to where the song is;
    // under a word that can be a target, blue, brighter while the bar is on it
    if (lay === this.layout) this.drawBars(x, lay);
    // a noun in its window flashes white, with a brighter outline (ST-28)
    if (lay === this.layout && this.flashOn)
      for (const range of this.flash)
        clipChars(x, lay, range.start, range.end, () => {
          x.drawImage(lay.gold, 0, 1);
          x.drawImage(lay.gold, 2, 1);
          x.drawImage(lay.gold, 1, 0);
          x.drawImage(lay.gold, 1, 2);
          x.drawImage(lay.white, 1, 1);
        });
  }

  drawBars(x, lay) {
    const at = this.progress,
      targetOf = (i) => this.terms.find((t) => i >= t.start && i < t.end);
    for (const line of lay.lines) {
      if (!line.length) continue;
      const y = line[0].y + lay.lh - 3;
      for (const g of line) {
        const left = Math.floor(g.x) + 1,
          width = Math.ceil(g.x + g.w) - Math.floor(g.x),
          filled = Math.max(0, Math.min(1, at - g.i)),
          term = targetOf(g.i),
          on = term && at >= term.start && at < term.end;
        x.fillStyle = term ? "#2f6fb0" : "#3a3040";
        x.fillRect(left, y, width, 3);
        if (filled > 0) {
          x.fillStyle = term ? (on ? "#d8f2ff" : "#8fd0ff") : "#ffcf3f";
          x.fillRect(left, y, Math.max(1, Math.round(width * filled)), 3);
        }
      }
    }
  }

  /** Copy the window of lines [topF, topF + maxLines) into the box, bottom-aligned. */
  blit(x, lay, topF, alpha = 1) {
    const b = this.box,
      n = lay.lines.length,
      L = this.maxLines,
      lh = lay.lh;
    const shown = Math.min(L, n),
      boxTop = b.y + b.h - shown * lh + (this.dy || 0),
      left = b.x + (this.dx || 0) - 1;
    const first = Math.floor(topF),
      frac = topF - first;
    for (let k = first; k < Math.min(n, first + L + 1); k++) {
      const row = k - topF; // the line's place in the window, in lines
      if (row <= -1 || row >= L) continue;
      let a = alpha;
      if (row < 0) a *= 1 + row; // the top line fades as it scrolls out
      const lastShown = Math.floor(topF + 1e-6) + L - 1;
      if (k === lastShown && k < n - 1) a *= FADE_ALPHA; // more follows: the last shown line is translucent
      if (k > lastShown) a *= frac; // the next line comes in while scrolling
      if (a <= 0.02) continue;
      x.globalAlpha = Math.round(a * 4) / 4 || 0.25; // alpha in steps, like everything at 30 ticks
      const dy = Math.round(boxTop + row * lh);
      // one line's own rows only: 4 rows more would show the tops of the letters of the line below
      x.drawImage(lay.full, 0, k * lh, lay.full.width, lh, left, dy, lay.full.width, lh);
    }
    x.globalAlpha = 1;
  }

  /** Where the window stands, for checks: how many lines the sentence has, the first line shown
   * (a fraction while it scrolls), and the line that holds the last lit letter. */
  window() {
    const lay = this.layout;
    return lay ? { lines: lay.lines.length, top: this.topF, litLine: this.litLine(lay) } : null;
  }

  /** Take the sentence away (a chapter starts, a card is up). */
  clear() {
    this.layout = null;
    this.prev = null;
    this.text = "";
    this.lit = 0;
  }

  /** Draw at the current tick. */
  draw(x) {
    const lay = this.layout;
    if (this.prev && this.prev.age < 9) {
      // the previous caption fades upward in 3 steps (ST-03)
      const p = this.prev;
      this.compose(p.layout, 1e9);
      x.save();
      x.translate(0, -2 * p.age);
      this.blit(x, p.layout, p.topF, [0.66, 0.33, 0.15][Math.floor(p.age / 3)]);
      x.restore();
      p.age++;
    }
    if (!lay) return;
    // the window's top line: keep the line being read out of the translucent last place;
    // stop when the sentence's last line is shown
    const n = lay.lines.length,
      L = this.maxLines;
    const want = n <= L ? 0 : Math.max(0, Math.min(this.litLine(lay) - (L - 2), n - (L - 1)));
    if (this.topF < want) this.topF = Math.min(want, this.topF + 1 / SCROLL_TICKS);
    else if (this.topF > want) this.topF = want;
    this.compose(lay, this.lit);
    this.blit(x, lay, this.topF);
  }
}

function clipChars(x, lay, from, to, fn) {
  if (to <= from) return;
  x.save();
  x.beginPath();
  for (const g of lay.lines.flat())
    if (g.i >= from && g.i < to) x.rect(Math.floor(g.x), g.y, Math.ceil(g.w) + 2, lay.lh + 2);
  x.clip();
  fn();
  x.restore();
}
