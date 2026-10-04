// Pixel helpers for ドパドパ (SPEC_dopa SD-D05, SD-D07, SD-D08, §8.1): hard alpha, 15-bit color,
// the PS1 4x4 dither, tinted masks. The 15-bit and dither steps match tools/dopa/ps1.py.

export const PSX_DITHER = [
  [-4, 0, -3, 1],
  [2, -2, 3, -1],
  [-3, 1, -4, 0],
  [3, -1, 2, -2],
];

/** A new canvas of w × h pixels. */
export function canvas(w, h) {
  const created = document.createElement("canvas");
  created.width = w;
  created.height = h;
  return created;
}

/** The 2D context of a canvas, with smoothing off (pixels are copied as they are) and made for
 * reading its pixels often. */
export function ctx2d(target) {
  const ctx = target.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

/** In place: alpha 0 below the cut, 255 at the cut and above. */
export function hardAlpha(target, cut = 128) {
  const ctx = ctx2d(target);
  const image = ctx.getImageData(0, 0, target.width, target.height);
  const data = image.data;

  for (let i = 3; i < data.length; i += 4) {
    data[i] = data[i] >= cut ? 255 : 0;
  }

  ctx.putImageData(image, 0, 0);
  return target;
}

/** In place: 15-bit color (5 bits a channel), with the PS1 dither, and hard alpha. `dither` is
 * "off", "on" (every pixel) or "auto": only where the brightness of a pixel's 3 × 3 neighbors
 * differs by more than 6, so that a flat area keeps one color. */
export function ps1(target, dither = "auto", cut = 128) {
  const ctx = ctx2d(target);
  const w = target.width;
  const h = target.height;
  const image = ctx.getImageData(0, 0, w, h);
  const data = image.data;

  let brightness = null;
  if (dither === "auto") {
    brightness = new Float32Array(w * h);

    let offset = 0;
    for (let pixel = 0; pixel < w * h; pixel++) {
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      brightness[pixel] = (red + green + blue) / 3;

      offset += 4;
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const pixel = y * w + x;
      const offset = pixel * 4;

      let nudge = 0;
      if (dither !== "off") {
        nudge = PSX_DITHER[y & 3][x & 3];

        if (brightness) {
          let lo = 255;
          let hi = 0;

          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              // a neighbor outside the picture is the pixel at the edge
              const rowFromTop = Math.max(0, y + dy);
              const nearY = Math.min(h - 1, rowFromTop);
              const columnFromLeft = Math.max(0, x + dx);
              const nearX = Math.min(w - 1, columnFromLeft);

              const v = brightness[nearY * w + nearX];
              if (v < lo) {
                lo = v;
              }
              if (v > hi) {
                hi = v;
              }
            }
          }

          const isFlat = hi - lo <= 6;
          if (isFlat) {
            nudge = 0;
          }
        }
      }

      for (let channel = 0; channel < 3; channel++) {
        const nudged = data[offset + channel] + nudge;
        const notNegative = Math.max(0, nudged);
        const v = Math.min(255, notNegative) >> 3;

        // 5 bits back to 8: 31 gives 255
        data[offset + channel] = (v << 3) | (v >> 2);
      }

      data[offset + 3] = data[offset + 3] >= cut ? 255 : 0;
    }
  }

  ctx.putImageData(image, 0, 0);
  return target;
}

/** A copy of a mask canvas, filled with one color where the mask is opaque. */
export function tint(mask, color) {
  const tinted = canvas(mask.width, mask.height);
  const ctx = ctx2d(tinted);

  ctx.drawImage(mask, 0, 0);

  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, tinted.width, tinted.height);

  return tinted;
}

/** Draw a mask with a 1-pixel outline around it (8 neighbors), at (dx, dy). */
export function drawOutlined(ctx, fillMask, outlineMask, x, y) {
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      if (ox || oy) {
        ctx.drawImage(outlineMask, x + ox, y + oy);
      }
    }
  }

  ctx.drawImage(fillMask, x, y);
}

/** A vertical gradient drawn smooth, then cut to 15 bits with the PS1 dither everywhere. */
export function ditheredGradient(w, h, stops) {
  const target = canvas(w, h);
  const ctx = ctx2d(target);

  const gradient = ctx.createLinearGradient(0, 0, 0, h);
  stops.forEach(([at, color]) => gradient.addColorStop(at, color));

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);

  return ps1(target, "on");
}

/** The cell of a sprite ladder (one picture in several sizes, side by side on one sheet) whose
 * height is nearest to `h`. `meta` is { H (the sheet's height), sizes: [{ x, w, h }] }; every
 * cell stands on the sheet's bottom edge, so its top is at H - h. */
export function ladderCell(meta, h) {
  let best = meta.sizes[0];

  for (const size of meta.sizes) {
    const distance = Math.abs(size.h - h);
    const bestDistance = Math.abs(best.h - h);
    if (distance < bestDistance) {
      best = size;
    }
  }

  return best;
}

/** An image; with `cors`, asked for with crossOrigin "anonymous", so that its pixels can be read
 * for the PlayStation pass (when the server does not allow that, the browser fails the load,
 * §6.7). */
export function loadImage(src, cors = false) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (cors) {
      image.crossOrigin = "anonymous";
    }

    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

/**
 * A short text as a pixel sprite: {w, h, fill, ink}, the letters in `color` and the same letters
 * in `ink` for the 1-pixel outline (drawOutlined). For calls, titles and signs (SPEC_dopa SD-D06).
 * The font must be loaded.
 */
export function textSprite(text, size, font, color = "#ffffff", ink = "#1d1a2e") {
  const measureCanvas = canvas(4, 4);
  const measure = ctx2d(measureCanvas);
  measure.font = `${size}px "${font}"`;

  const measured = measure.measureText(text);
  const w = Math.ceil(measured.width) + 4;
  const h = size + 6;

  const mask = canvas(w, h);
  const ctx = ctx2d(mask);
  ctx.font = measure.font;
  ctx.textBaseline = "top";
  ctx.fillStyle = "#fff";
  ctx.fillText(text, 2, 3);
  hardAlpha(mask, 110);

  const fill = tint(mask, color);
  const inkMask = tint(mask, ink);
  return { w, h, fill, ink: inkMask };
}
