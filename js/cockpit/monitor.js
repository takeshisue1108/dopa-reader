// The main monitor of the cockpit (ED D-33, D-75, D-97, D-108, ST-13, ST-19, ST-24; SPEC_dopa v3
// §6.1, §6.7): the upper middle of the glass. It shows the launch of a chapter, a figure of the
// book (an image or a PDF page through the PlayStation pass, or a Markdown table drawn as a
// grid), a text (a heading or a quoted sentence), and the empty screen behind the book list,
// which is HTML laid over it. It opens in 6 ticks from a line. Its frame is taken from the
// accepted test scene.
import { canvas, ctx2d, drawOutlined, hardAlpha, loadImage, ps1, textSprite } from "./pixel.js";

const OPEN_TICKS = 6;
const FACE = { title: ["Misaki Mincho", 24], sentence: ["DotGothic16", 24] };

/** A text cut into rows that fit `width` at a face and size, one sprite a row (draw() centers
 * them). */
function wrapToSprites(text, width, [font, size], color) {
  const measure = ctx2d(canvas(4, 4));
  measure.font = `${size}px "${font}"`;
  const rows = [];
  let row = "";
  for (const letter of [...text]) {
    if (row && measure.measureText(row + letter).width > width) {
      rows.push(row);
      row = "";
    }
    row += letter;
  }
  if (row) rows.push(row);
  return rows.map((rowText) => textSprite(rowText, size, font, color));
}

/**
 * Put a struck word (D-35) at the next free place of an area {x, y, w, h}, in rows from the left;
 * when the area is full the words start again. `words` is the list of those placed so far, and
 * the new one is added to it: {sprite, x, y, there} (`there` turns true when the missile arrives).
 */
export function placeWord(words, sprite, area) {
  const rowHeight = sprite.h + 6,
    last = words[words.length - 1];
  let at = last ? { x: last.x + last.sprite.w + 14, y: last.y } : { x: area.x, y: area.y };
  if (at.x + sprite.w > area.x + area.w) at = { x: area.x, y: at.y + rowHeight };
  if (at.y + rowHeight > area.y + area.h) {
    words.length = 0;
    at = { x: area.x, y: area.y };
  }
  const word = { sprite, x: at.x, y: at.y, there: false };
  words.push(word);
  return word;
}

export class Monitor {
  /** `main`: the monitor's place; `top`: the smaller place of a title, at the top of the glass. */
  constructor(main, top, turn = null) {
    this.main = main; // the monitor's place on the text layer {x, y, w, h}
    this.top = top; // the place of a title
    this.turn = turn; // M.E.O.W turning, for the launch: {img, meta: {w, h, frames, cols}}
    this.box = main; // where the thing shown now is
    // what is shown: {kind, t0 (the tick it came), words: []} and, by kind, figure and label, or
    // table, rowH and label, or rows, or rows and call
    this.shown = null;
  }

  /** Whether the monitor shows something (the formation then stands back, D-33). */
  get on() {
    return !!this.shown;
  }
  /** What it shows: "figure", "list", "launch", the kind given to showText ("quote", "title"),
   * or null. */
  get kind() {
    return this.shown ? this.shown.kind : null;
  }

  /** Show nothing; a picture still loading is not shown when it arrives. */
  hide() {
    this.request = null;
    this.shown = null;
  }

  /** A figure of the book (ST-19): its picture through the PlayStation pass (D-28), with the line
   * that says where in the book it is. Resolves when the picture is ready. `tickNow` is a
   * function: the picture is ready some ticks after the call, and it opens from that tick. */
  async showFigure(url, sourceLine, tickNow) {
    const request = (this.request = {});
    const image = await loadImage(url, true);
    if (this.request !== request) return; // something else was asked for meanwhile
    const { w, h } = this.box,
      scale = Math.min((w - 16) / image.width, (h - 34) / image.height);
    const picture = canvas(Math.round(image.width * scale), Math.round(image.height * scale)),
      ctx = ctx2d(picture);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, picture.width, picture.height);
    this.box = this.main;
    this.shown = {
      kind: "figure",
      t0: tickNow(),
      figure: ps1(picture, "auto"),
      label: textSprite(sourceLine, 16, "DotGothic16"),
      words: [],
    };
  }

  /** A figure already drawn into a canvas (a PDF page, §6.7): fitted, passed, with its line. */
  showCanvas(source, sourceLine, tick) {
    this.request = null;
    const { w, h } = this.main,
      scale = Math.min((w - 16) / source.width, (h - 34) / source.height);
    const picture = canvas(
        Math.max(1, Math.round(source.width * scale)),
        Math.max(1, Math.round(source.height * scale)),
      ),
      ctx = ctx2d(picture);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, picture.width, picture.height);
    this.box = this.main;
    this.shown = {
      kind: "figure",
      t0: tick,
      figure: ps1(picture, "auto"),
      label: textSprite(sourceLine, 16, "DotGothic16"),
      words: [],
    };
  }

  /** A Markdown table as a figure (D-75, §6.7): a grid in DotGothic16 at 16 px; a table taller
   * than the monitor stands for 4 s, then scrolls down by one row every 2 s; one wider than the
   * monitor is cut at the right. `rows` is a list of lists of cells. */
  showTable(rows, sourceLine, tick) {
    this.request = null;
    const measure = ctx2d(canvas(4, 4));
    measure.font = '16px "DotGothic16"';
    // a column is as wide as its widest cell and 12 more, from 24 to 220
    const columns = Math.max(...rows.map((row) => row.length)),
      widths = [...Array(columns)].map((_, column) =>
        Math.min(
          220,
          Math.max(
            24,
            ...rows.map((row) => Math.ceil(measure.measureText(row[column] || "").width) + 12),
          ),
        ),
      ),
      rowHeight = 22,
      tableWidth = widths.reduce((sum, width) => sum + width, 0),
      sheet = canvas(tableWidth + 2, rows.length * rowHeight + 2),
      ctx = ctx2d(sheet);
    ctx.font = measure.font;
    ctx.textBaseline = "top";
    rows.forEach((row, rowIndex) => {
      let left = 1;
      ctx.fillStyle = rowIndex === 0 ? "#2a3f5a" : rowIndex % 2 ? "#141e2a" : "#1a2634";
      ctx.fillRect(1, 1 + rowIndex * rowHeight, tableWidth, rowHeight);
      widths.forEach((width, column) => {
        ctx.fillStyle = rowIndex === 0 ? "#ffcf3f" : "#ffffff";
        ctx.save();
        ctx.beginPath();
        ctx.rect(left, 1 + rowIndex * rowHeight, width - 4, rowHeight);
        ctx.clip();
        ctx.fillText(row[column] || "", left + 6, 4 + rowIndex * rowHeight);
        ctx.restore();
        ctx.fillStyle = "#3fe0a0";
        ctx.fillRect(left + width - 1, 1 + rowIndex * rowHeight, 1, rowHeight);
        left += width;
      });
    });
    hardAlpha(sheet, 110);
    this.box = this.main;
    this.shown = {
      kind: "figure",
      t0: tick,
      table: sheet,
      rowH: rowHeight,
      label: textSprite(sourceLine, 16, "DotGothic16"),
      words: [],
    };
  }

  /** The screen behind the book list (ST-24): the frame only; the list is HTML over it. */
  showList(tick) {
    this.request = null;
    this.box = this.main;
    this.shown = { kind: "list", t0: tick, words: [] };
  }

  /** The launch of a chapter (V-03, ST-13), as in the accepted test scene: M.E.O.W turns once
   * on the main monitor, with Elena's call as text (D-31) and the chapter's title above. */
  showLaunch(title, call, tick) {
    this.request = null;
    this.box = this.main;
    this.shown = {
      kind: "launch",
      t0: tick,
      rows: wrapToSprites(title, this.box.w - 40, FACE.title, "#ffffff").slice(0, 2),
      call: textSprite(call, 24, "Misaki Mincho", "#ffcf3f"),
      words: [],
    };
  }

  /** A text (ST-20 and the quote fallback): a chapter's title or a heading in the title face, a
   * quoted sentence in the sentence face. */
  showText(kind, text, tick) {
    this.request = null;
    this.box = kind === "quote" ? this.main : this.top;
    const face = kind === "quote" ? FACE.sentence : FACE.title;
    this.shown = {
      kind,
      t0: tick,
      rows: wrapToSprites(
        text,
        this.box.w - 40,
        face,
        kind === "quote" ? "#ffffff" : "#ffcf3f",
      ).slice(0, kind === "quote" ? 6 : 1),
      words: [],
    };
  }

  /** The place for the next struck word on the monitor (D-35), under its text. */
  placeWord(sprite) {
    const { x, y, w, h } = this.box,
      top = y + Math.round(h * 0.45);
    return placeWord(this.shown.words, sprite, {
      x: x + 20,
      y: top,
      w: w - 40,
      h: y + h - 6 - top,
    });
  }

  /** Draw the monitor on the text layer at this tick: its frame, which opens from a line in 6
   * ticks, and then what it shows. */
  draw(ctx, tick) {
    const shown = this.shown;
    if (!shown) return;
    const { x, y, w, h } = this.box,
      open = Math.min(1, (tick - shown.t0) / OPEN_TICKS),
      height = Math.max(2, Math.round(h * open)),
      top = y + Math.round((h - height) / 2);
    ctx.fillStyle = "#0b1a16";
    ctx.fillRect(x - 4, top - 4, w + 8, height + 8);
    ctx.fillStyle = "#3fe0a0";
    ctx.fillRect(x - 4, top - 4, w + 8, 2);
    ctx.fillRect(x - 4, top + height + 2, w + 8, 2);
    if (open < 1) return;
    if (shown.table) {
      // a tall table stands for 4 s (steps 0 and 1), scrolls one row every 2 s, and starts again
      const room = h - 34,
        extra = Math.max(0, shown.table.height - room),
        rowsOver = Math.ceil(extra / shown.rowH),
        step = rowsOver ? Math.floor((tick - shown.t0) / 60) % (rowsOver + 2) : 0,
        scrolled = Math.min(extra, Math.max(0, step - 1) * shown.rowH),
        width = Math.min(w - 16, shown.table.width);
      ctx.drawImage(
        shown.table,
        0,
        scrolled,
        width,
        Math.min(room, shown.table.height),
        x + Math.round((w - width) / 2),
        y + 6,
        width,
        Math.min(room, shown.table.height),
      );
      drawOutlined(
        ctx,
        shown.label.fill,
        shown.label.ink,
        x + w - shown.label.w - 6,
        y + h - shown.label.h - 2,
      );
    }
    if (shown.figure) {
      ctx.drawImage(shown.figure, x + Math.round((w - shown.figure.width) / 2), y + 6);
      drawOutlined(
        ctx,
        shown.label.fill,
        shown.label.ink,
        x + w - shown.label.w - 6,
        y + h - shown.label.h - 2,
      );
    }
    if (shown.kind === "launch") {
      // the robot turns once in 30 ticks and then faces the owner; the title above, the call below
      if (this.turn) {
        const { img, meta } = this.turn,
          frame = Math.round(meta.frames * Math.min(1, (tick - shown.t0) / 30)) % meta.frames,
          scale = 2;
        ctx.drawImage(
          img,
          (frame % meta.cols) * meta.w,
          Math.floor(frame / meta.cols) * meta.h,
          meta.w,
          meta.h,
          Math.round(x + w / 2 - (meta.w * scale) / 2),
          y + 36,
          meta.w * scale,
          meta.h * scale,
        );
      }
      shown.rows.forEach((row, index) =>
        drawOutlined(
          ctx,
          row.fill,
          row.ink,
          x + Math.round((w - row.w) / 2),
          y + 6 + index * (row.h + 2),
        ),
      );
      drawOutlined(
        ctx,
        shown.call.fill,
        shown.call.ink,
        x + Math.round((w - shown.call.w) / 2),
        y + h - shown.call.h - 4,
      );
    } else if (shown.rows) {
      const rowHeight = shown.rows[0] ? shown.rows[0].h + 4 : 0,
        blockTop =
          y +
          Math.round(
            h * (shown.kind === "quote" ? 0.5 : 0.28) - (shown.rows.length * rowHeight) / 2,
          );
      shown.rows.forEach((row, index) =>
        drawOutlined(
          ctx,
          row.fill,
          row.ink,
          x + Math.round((w - row.w) / 2),
          Math.max(y + 6, blockTop + index * rowHeight),
        ),
      );
    }
    for (const word of shown.words)
      if (word.there) drawOutlined(ctx, word.sprite.fill, word.sprite.ink, word.x, word.y);
  }
}
