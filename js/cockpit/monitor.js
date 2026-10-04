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
  const scratch = canvas(4, 4);
  const measure = ctx2d(scratch);
  measure.font = `${size}px "${font}"`;

  const rows = [];
  let row = "";

  const letters = [...text];
  for (const letter of letters) {
    if (row) {
      const widthWithLetter = measure.measureText(row + letter).width;
      if (widthWithLetter > width) {
        rows.push(row);
        row = "";
      }
    }
    row += letter;
  }

  if (row) {
    rows.push(row);
  }

  return rows.map((rowText) => textSprite(rowText, size, font, color));
}

/**
 * Put a struck word (D-35) at the next free place of an area {x, y, w, h}, in rows from the left;
 * when the area is full the words start again. `words` is the list of those placed so far, and
 * the new one is added to it: {sprite, x, y, there} (`there` turns true when the missile arrives).
 */
export function placeWord(words, sprite, area) {
  const rowHeight = sprite.h + 6;
  const last = words[words.length - 1];

  let at;
  if (last) {
    const afterLast = last.x + last.sprite.w + 14;
    at = { x: afterLast, y: last.y };
  } else {
    at = { x: area.x, y: area.y };
  }

  const areaRight = area.x + area.w;
  if (at.x + sprite.w > areaRight) {
    const nextRow = at.y + rowHeight;
    at = { x: area.x, y: nextRow };
  }

  const areaBottom = area.y + area.h;
  if (at.y + rowHeight > areaBottom) {
    words.length = 0;
    at = { x: area.x, y: area.y };
  }

  const word = {
    sprite,
    x: at.x,
    y: at.y,
    there: false,
  };
  words.push(word);
  return word;
}

export class Monitor {
  /** `main`: the monitor's place; `top`: the smaller place of a title, at the top of the glass. */
  constructor(main, top, turn = null) {
    this.main = main; // the monitor's place on the text layer {x, y, w, h}
    this.top = top; // the place of a title

    // M.E.O.W turning, for the launch: {img, meta: {w, h, frames, cols}}
    this.turn = turn;

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
    if (this.shown) {
      return this.shown.kind;
    }
    return null;
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
    const request = {};
    this.request = request;

    const image = await loadImage(url, true);
    if (this.request !== request) {
      return; // something else was asked for meanwhile
    }

    const { w, h } = this.box;
    const scaleToWidth = (w - 16) / image.width;
    const scaleToHeight = (h - 34) / image.height;
    const scale = Math.min(scaleToWidth, scaleToHeight);

    const pictureWidth = Math.round(image.width * scale);
    const pictureHeight = Math.round(image.height * scale);
    const picture = canvas(pictureWidth, pictureHeight);
    const ctx = ctx2d(picture);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, picture.width, picture.height);

    this.box = this.main;

    const cameAt = tickNow();
    const figure = ps1(picture, "auto");
    const label = textSprite(sourceLine, 16, "DotGothic16");
    this.shown = {
      kind: "figure",
      t0: cameAt,
      figure,
      label,
      words: [],
    };
  }

  /** A figure already drawn into a canvas (a PDF page, §6.7): fitted, passed, with its line. */
  showCanvas(source, sourceLine, tick) {
    this.request = null;

    const { w, h } = this.main;
    const scaleToWidth = (w - 16) / source.width;
    const scaleToHeight = (h - 34) / source.height;
    const scale = Math.min(scaleToWidth, scaleToHeight);

    const scaledWidth = Math.round(source.width * scale);
    const scaledHeight = Math.round(source.height * scale);
    const pictureWidth = Math.max(1, scaledWidth);
    const pictureHeight = Math.max(1, scaledHeight);
    const picture = canvas(pictureWidth, pictureHeight);
    const ctx = ctx2d(picture);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, picture.width, picture.height);

    this.box = this.main;

    const figure = ps1(picture, "auto");
    const label = textSprite(sourceLine, 16, "DotGothic16");
    this.shown = {
      kind: "figure",
      t0: tick,
      figure,
      label,
      words: [],
    };
  }

  /** A Markdown table as a figure (D-75, §6.7): a grid in DotGothic16 at 16 px; a table taller
   * than the monitor stands for 4 s, then scrolls down by one row every 2 s; one wider than the
   * monitor is cut at the right. `rows` is a list of lists of cells. */
  showTable(rows, sourceLine, tick) {
    this.request = null;

    const scratch = canvas(4, 4);
    const measure = ctx2d(scratch);
    measure.font = '16px "DotGothic16"';

    // a column is as wide as its widest cell and 12 more, from 24 to 220
    const rowLengths = rows.map((row) => row.length);
    const columns = Math.max(...rowLengths);

    const columnSlots = [...Array(columns)];
    const widths = columnSlots.map((_, column) => {
      const cellWidths = rows.map((row) => {
        const cellText = row[column] || "";
        const textWidth = measure.measureText(cellText).width;
        return Math.ceil(textWidth) + 12;
      });

      const widest = Math.max(24, ...cellWidths);
      return Math.min(220, widest);
    });

    const rowHeight = 22;
    const tableWidth = widths.reduce((sum, width) => sum + width, 0);
    const sheetHeight = rows.length * rowHeight + 2;
    const sheet = canvas(tableWidth + 2, sheetHeight);
    const ctx = ctx2d(sheet);

    ctx.font = measure.font;
    ctx.textBaseline = "top";

    rows.forEach((row, rowIndex) => {
      const isHeader = rowIndex === 0;
      const rowTop = 1 + rowIndex * rowHeight;
      let left = 1;

      if (isHeader) {
        ctx.fillStyle = "#2a3f5a";
      } else if (rowIndex % 2) {
        ctx.fillStyle = "#141e2a";
      } else {
        ctx.fillStyle = "#1a2634";
      }
      ctx.fillRect(1, rowTop, tableWidth, rowHeight);

      widths.forEach((width, column) => {
        const cellText = row[column] || "";
        const textTop = 4 + rowIndex * rowHeight;

        ctx.fillStyle = isHeader ? "#ffcf3f" : "#ffffff";
        ctx.save();
        ctx.beginPath();
        ctx.rect(left, rowTop, width - 4, rowHeight);
        ctx.clip();
        ctx.fillText(cellText, left + 6, textTop);
        ctx.restore();

        const lineLeft = left + width - 1;
        ctx.fillStyle = "#3fe0a0";
        ctx.fillRect(lineLeft, rowTop, 1, rowHeight);

        left += width;
      });
    });

    hardAlpha(sheet, 110);

    this.box = this.main;

    const label = textSprite(sourceLine, 16, "DotGothic16");
    this.shown = {
      kind: "figure",
      t0: tick,
      table: sheet,
      rowH: rowHeight,
      label,
      words: [],
    };
  }

  /** The screen behind the book list (ST-24): the frame only; the list is HTML over it. */
  showList(tick) {
    this.request = null;
    this.box = this.main;
    this.shown = {
      kind: "list",
      t0: tick,
      words: [],
    };
  }

  /** The launch of a chapter (V-03, ST-13), as in the accepted test scene: M.E.O.W turns once
   * on the main monitor, with Elena's call as text (D-31) and the chapter's title above. */
  showLaunch(title, call, tick) {
    this.request = null;
    this.box = this.main;

    const textWidth = this.box.w - 40;
    const titleRows = wrapToSprites(title, textWidth, FACE.title, "#ffffff");
    const rows = titleRows.slice(0, 2);
    const callSprite = textSprite(call, 24, "Misaki Mincho", "#ffcf3f");

    this.shown = {
      kind: "launch",
      t0: tick,
      rows,
      call: callSprite,
      words: [],
    };
  }

  /** A text (ST-20 and the quote fallback): a chapter's title or a heading in the title face, a
   * quoted sentence in the sentence face. */
  showText(kind, text, tick) {
    this.request = null;

    let face;
    let color;
    let maxRows;
    if (kind === "quote") {
      this.box = this.main;
      face = FACE.sentence;
      color = "#ffffff";
      maxRows = 6;
    } else {
      this.box = this.top;
      face = FACE.title;
      color = "#ffcf3f";
      maxRows = 1;
    }

    const textWidth = this.box.w - 40;
    const allRows = wrapToSprites(text, textWidth, face, color);
    const rows = allRows.slice(0, maxRows);

    this.shown = {
      kind,
      t0: tick,
      rows,
      words: [],
    };
  }

  /** The place for the next struck word on the monitor (D-35), under its text. */
  placeWord(sprite) {
    const { x, y, w, h } = this.box;
    const top = y + Math.round(h * 0.45);

    const area = {
      x: x + 20,
      y: top,
      w: w - 40,
      h: y + h - 6 - top,
    };
    return placeWord(this.shown.words, sprite, area);
  }

  /** Draw the monitor on the text layer at this tick: its frame, which opens from a line in 6
   * ticks, and then what it shows. */
  draw(ctx, tick) {
    const shown = this.shown;
    if (!shown) {
      return;
    }

    const { x, y, w, h } = this.box;
    const sinceShown = tick - shown.t0;
    const open = Math.min(1, sinceShown / OPEN_TICKS);
    const openHeight = Math.round(h * open);
    const height = Math.max(2, openHeight);
    const top = y + Math.round((h - height) / 2);

    const frameLeft = x - 4;
    const frameTop = top - 4;
    const frameWidth = w + 8;
    const lowerEdgeTop = top + height + 2;

    ctx.fillStyle = "#0b1a16";
    ctx.fillRect(frameLeft, frameTop, frameWidth, height + 8);

    ctx.fillStyle = "#3fe0a0";
    ctx.fillRect(frameLeft, frameTop, frameWidth, 2);
    ctx.fillRect(frameLeft, lowerEdgeTop, frameWidth, 2);

    if (open < 1) {
      return;
    }

    if (shown.table) {
      // a tall table stands for 4 s (steps 0 and 1), scrolls one row every 2 s, and starts again
      const room = h - 34;
      const extra = Math.max(0, shown.table.height - room);
      const rowsOver = Math.ceil(extra / shown.rowH);

      let step = 0;
      if (rowsOver) {
        const twoSeconds = Math.floor(sinceShown / 60);
        step = twoSeconds % (rowsOver + 2);
      }

      const rowsScrolled = Math.max(0, step - 1);
      const scrolled = Math.min(extra, rowsScrolled * shown.rowH);

      const width = Math.min(w - 16, shown.table.width);
      const shownHeight = Math.min(room, shown.table.height);
      const tableLeft = x + Math.round((w - width) / 2);
      const tableTop = y + 6;
      ctx.drawImage(
        shown.table,
        0,
        scrolled,
        width,
        shownHeight,
        tableLeft,
        tableTop,
        width,
        shownHeight,
      );

      const labelLeft = x + w - shown.label.w - 6;
      const labelTop = y + h - shown.label.h - 2;
      drawOutlined(ctx, shown.label.fill, shown.label.ink, labelLeft, labelTop);
    }

    if (shown.figure) {
      const figureLeft = x + Math.round((w - shown.figure.width) / 2);
      ctx.drawImage(shown.figure, figureLeft, y + 6);

      const labelLeft = x + w - shown.label.w - 6;
      const labelTop = y + h - shown.label.h - 2;
      drawOutlined(ctx, shown.label.fill, shown.label.ink, labelLeft, labelTop);
    }

    if (shown.kind === "launch") {
      // the robot turns once in 30 ticks and then faces the owner; the title above, the call below
      if (this.turn) {
        const { img, meta } = this.turn;
        const turned = Math.min(1, sinceShown / 30);
        const frame = Math.round(meta.frames * turned) % meta.frames;
        const scale = 2;

        const cellLeft = (frame % meta.cols) * meta.w;
        const cellTop = Math.floor(frame / meta.cols) * meta.h;

        const drawnWidth = meta.w * scale;
        const drawnHeight = meta.h * scale;
        const robotLeft = Math.round(x + w / 2 - drawnWidth / 2);
        const robotTop = y + 36;
        ctx.drawImage(
          img,
          cellLeft,
          cellTop,
          meta.w,
          meta.h,
          robotLeft,
          robotTop,
          drawnWidth,
          drawnHeight,
        );
      }

      shown.rows.forEach((row, index) => {
        const rowLeft = x + Math.round((w - row.w) / 2);
        const rowTop = y + 6 + index * (row.h + 2);
        drawOutlined(ctx, row.fill, row.ink, rowLeft, rowTop);
      });

      const callLeft = x + Math.round((w - shown.call.w) / 2);
      const callTop = y + h - shown.call.h - 4;
      drawOutlined(ctx, shown.call.fill, shown.call.ink, callLeft, callTop);
    } else if (shown.rows) {
      let rowHeight = 0;
      if (shown.rows[0]) {
        rowHeight = shown.rows[0].h + 4;
      }

      const middleShare = shown.kind === "quote" ? 0.5 : 0.28;
      const blockHeight = shown.rows.length * rowHeight;
      const blockTop = y + Math.round(h * middleShare - blockHeight / 2);

      shown.rows.forEach((row, index) => {
        const rowLeft = x + Math.round((w - row.w) / 2);
        const rowTop = Math.max(y + 6, blockTop + index * rowHeight);
        drawOutlined(ctx, row.fill, row.ink, rowLeft, rowTop);
      });
    }

    for (const word of shown.words) {
      if (word.there) {
        drawOutlined(ctx, word.sprite.fill, word.sprite.ink, word.x, word.y);
      }
    }
  }
}
