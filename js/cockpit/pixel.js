// Pixel helpers for ドパドパ (SPEC_dopa SD-D05, SD-D07, SD-D08, §8.1): hard alpha, 15-bit color,
// the PS1 4x4 dither, tinted masks. The 15-bit and dither steps match tools/dopa/ps1.py.

export const PSX_DITHER = [
  [-4, 0, -3, 1],
  [2, -2, 3, -1],
  [-3, 1, -4, 0],
  [3, -1, 2, -2],
];

export function canvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}
export function ctx2d(c) {
  const x = c.getContext("2d", { willReadFrequently: true });
  x.imageSmoothingEnabled = false;
  return x;
}

/** In place: alpha 0 below cut, 255 above. */
export function hardAlpha(c, cut = 128) {
  const x = ctx2d(c),
    im = x.getImageData(0, 0, c.width, c.height),
    d = im.data;
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= cut ? 255 : 0;
  x.putImageData(im, 0, 0);
  return c;
}

/** In place: 15-bit color; dither "off" | "on" | "auto" (shaded areas only), hard alpha. */
export function ps1(c, dither = "auto", cut = 128) {
  const x = ctx2d(c),
    w = c.width,
    h = c.height,
    im = x.getImageData(0, 0, w, h),
    d = im.data;
  let lum = null;
  if (dither === "auto") {
    lum = new Float32Array(w * h);
    for (let i = 0, p = 0; p < w * h; p++, i += 4) lum[p] = (d[i] + d[i + 1] + d[i + 2]) / 3;
  }
  for (let y = 0; y < h; y++) {
    for (let xx = 0; xx < w; xx++) {
      const p = y * w + xx,
        i = p * 4;
      let off = 0;
      if (dither !== "off") {
        off = PSX_DITHER[y & 3][xx & 3];
        if (lum) {
          let lo = 255,
            hi = 0;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const yy = Math.min(h - 1, Math.max(0, y + dy)),
                xq = Math.min(w - 1, Math.max(0, xx + dx));
              const v = lum[yy * w + xq];
              if (v < lo) lo = v;
              if (v > hi) hi = v;
            }
          if (hi - lo <= 6) off = 0;
        }
      }
      for (let k = 0; k < 3; k++) {
        const v = Math.min(255, Math.max(0, d[i + k] + off)) >> 3;
        d[i + k] = (v << 3) | (v >> 2);
      }
      d[i + 3] = d[i + 3] >= cut ? 255 : 0;
    }
  }
  x.putImageData(im, 0, 0);
  return c;
}

/** A copy of a mask canvas, filled with one color where the mask is opaque. */
export function tint(mask, color) {
  const c = canvas(mask.width, mask.height),
    x = ctx2d(c);
  x.drawImage(mask, 0, 0);
  x.globalCompositeOperation = "source-in";
  x.fillStyle = color;
  x.fillRect(0, 0, c.width, c.height);
  return c;
}

/** Draw a mask with a 1-pixel outline around it (8 neighbors), at (dx, dy). */
export function drawOutlined(x, fill, outline, dx, dy) {
  for (let oy = -1; oy <= 1; oy++)
    for (let ox = -1; ox <= 1; ox++) if (ox || oy) x.drawImage(outline, dx + ox, dy + oy);
  x.drawImage(fill, dx, dy);
}

/** A vertical gradient drawn smooth, then cut to 15 bits with the PS1 dither everywhere. */
export function ditheredGradient(w, h, stops) {
  const c = canvas(w, h),
    x = ctx2d(c),
    g = x.createLinearGradient(0, 0, 0, h);
  stops.forEach(([t, col]) => g.addColorStop(t, col));
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);
  return ps1(c, "on");
}

/** An image; with `cors`, asked for with crossOrigin "anonymous", so that its pixels can be read
 * for the PlayStation pass (a server without the header then refuses it, §6.7). */
export function loadImage(src, cors = false) {
  return new Promise((ok, no) => {
    const im = new Image();
    if (cors) im.crossOrigin = "anonymous";
    im.onload = () => ok(im);
    im.onerror = no;
    im.src = src;
  });
}

/**
 * A short text as a pixel sprite: {w, h, fill, ink}, the letters in `color` and the same letters
 * in `ink` for the 1-pixel outline (drawOutlined). For calls, titles and signs (SPEC_dopa SD-D06).
 * The font must be loaded.
 */
export function textSprite(text, size, font, color = "#ffffff", ink = "#1d1a2e") {
  const measure = ctx2d(canvas(4, 4));
  measure.font = `${size}px "${font}"`;
  const w = Math.ceil(measure.measureText(text).width) + 4,
    h = size + 6;
  const mask = canvas(w, h),
    x = ctx2d(mask);
  x.font = measure.font;
  x.textBaseline = "top";
  x.fillStyle = "#fff";
  x.fillText(text, 2, 3);
  hardAlpha(mask, 110);
  return { w, h, fill: tint(mask, color), ink: tint(mask, ink) };
}
