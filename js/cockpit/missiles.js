// Missiles that fly from the cockpit into the depth toward their targets (research 13; ドパ ED ST-05, D-41).
// A separate piece (ドパ ED D-19): it knows only a projection function, its sprite ladders and a sound hook.
//
// Each missile lives in 3D: X (lateral), H (height above the ground) and D (depth), in one unit, so that
// steering is the same in every direction; the screen uses z = D / KZ, as the road does (x = road + X / z).
// Flight: launched from a shoulder pod just in front of the glass, it first fans out and up (the Itano
// Circus spread), then steers toward a predicted target point by Reynolds' seek/pursuit:
//   desired = normalize(target - p) * vmax;  steer = truncate(desired - v, fmax);  v = truncate(v + steer, vmax)
// while vmax grows, so the path curves and speeds up. A puff of smoke is left at each tick and drawn
// with perspective (size ~ 1/z), so the trail reads as a wake going into the distance.

export const KZ = 200; // depth units per z (the "focal length" of the projection)
const YAWS = [-40, -20, 0, 20, 40];

export class Missiles {
  constructor({ project, ladders, sfx = () => {} }) {
    this.project = project; // (X, H, z) -> {x, y} in world pixels
    this.ladders = ladders; // [{img, meta}] for YAWS
    this.sfx = sfx;
    this.list = [];
    this.puffs = [];
    this.flashes = [];
  }

  /** Launch a volley at one target. target() returns {X, H, D, vD} (vD = its depth speed per tick). */
  volley({ count = 3, side = 0, target, onHit, onEachHit = null, tick, spread = 1, guided = 0 }) {
    for (let k = 0; k < count; k++) {
      const s = side || (k % 2 ? 1 : -1);
      const p = { X: s * (70 + 12 * k), H: 30 + 5 * k, D: 0.55 * KZ };
      const v = { X: s * (5 + 3 * k) * spread, H: (3 + 2 * ((k + 1) % 3)) * spread, D: 12 + 2 * k };
      this.list.push({
        p,
        v,
        prev: null,
        t0: tick + k * 3,
        target,
        onHit: k === 0 ? onHit : null,
        onEachHit,
        vmax: 10,
        alive: true,
        // guided: the missile meets the target where it is after this many ticks (D-130)
        guided: guided ? guided + k * 2 : 0,
        start: { ...p },
        bend: { X: p.X + s * (90 + 20 * k) * spread, H: p.H + 70 + 10 * k, D: p.D + 60 },
      });
      this.flashes.push({ p: { ...p }, t0: tick + k * 3 });
    }
    this.sfx("ミサイル");
  }

  tick(n) {
    for (const m of this.list) {
      if (!m.alive || n < m.t0) continue;
      const age = n - m.t0,
        tg = m.target();
      if (m.guided) {
        // a curve from the launch, bending out like the fan of the volley, to the target's place now
        const u = Math.min(1, age / m.guided),
          a = (1 - u) * (1 - u),
          b = 2 * u * (1 - u),
          c = u * u;
        m.prev = { ...m.p };
        m.p = {
          X: a * m.start.X + b * m.bend.X + c * tg.X,
          H: a * m.start.H + b * m.bend.H + c * tg.H,
          D: a * m.start.D + b * m.bend.D + c * tg.D,
        };
        m.v = { X: m.p.X - m.prev.X, H: m.p.H - m.prev.H, D: m.p.D - m.prev.D };
        if (this.smoke !== false)
          for (const f of [0.33, 0.66, 1])
            this.puffs.push({ X: m.prev.X + (m.p.X - m.prev.X) * f, H: m.prev.H + (m.p.H - m.prev.H) * f, D: m.prev.D + (m.p.D - m.prev.D) * f, t0: n });
        if (u >= 1) {
          m.alive = false;
          if (m.onHit) m.onHit(n);
          if (m.onEachHit) m.onEachHit(tg, n);
        }
        continue;
      }
      // pursuit: aim at where the target will be, further ahead when far (T = distance * c)
      const dx0 = tg.X - m.p.X,
        dy0 = tg.H - m.p.H,
        dz0 = tg.D - m.p.D;
      const dist = Math.hypot(dx0, dy0, dz0),
        T = Math.min(8, (dist / Math.max(1, m.vmax)) * 0.5);
      const aim = { X: tg.X, H: tg.H, D: tg.D + (tg.vD || 0) * T };
      const ax = aim.X - m.p.X,
        ay = aim.H - m.p.H,
        az = aim.D - m.p.D,
        al = Math.hypot(ax, ay, az) || 1;
      m.vmax = Math.min(34, 10 + age * 1.4);
      const fmax = age < 5 ? 0.8 : 4.5; // the first ticks keep the fan-out, then the missile turns hard
      let sx = (ax / al) * m.vmax - m.v.X,
        sy = (ay / al) * m.vmax - m.v.H,
        sz = (az / al) * m.vmax - m.v.D;
      const sl = Math.hypot(sx, sy, sz);
      if (sl > fmax) {
        sx *= fmax / sl;
        sy *= fmax / sl;
        sz *= fmax / sl;
      }
      m.v.X += sx;
      m.v.H += sy;
      m.v.D += sz;
      const vl = Math.hypot(m.v.X, m.v.H, m.v.D);
      if (vl > m.vmax) {
        m.v.X *= m.vmax / vl;
        m.v.H *= m.vmax / vl;
        m.v.D *= m.vmax / vl;
      }
      m.prev = { ...m.p };
      m.p.X += m.v.X;
      m.p.H += m.v.H;
      m.p.D += m.v.D;
      for (const f of this.smoke === false ? [] : [0.33, 0.66, 1]) {
        // three puffs per tick fill the wake between positions (none when `smoke` is turned off)
        this.puffs.push({
          X: m.prev.X + (m.p.X - m.prev.X) * f + (Math.random() - 0.5) * 2,
          H: m.prev.H + (m.p.H - m.prev.H) * f + (Math.random() - 0.5) * 2,
          D: m.prev.D + (m.p.D - m.prev.D) * f,
          t0: n,
        });
      }
      if (dist < 16 || age > 50) {
        m.alive = false;
        if (m.onHit) m.onHit(n);
        if (m.onEachHit) m.onEachHit(tg, n);
      }
    }
    this.list = this.list.filter((m) => m.alive);
    this.puffs = this.puffs.filter((p) => n - p.t0 < 16);
    this.flashes = this.flashes.filter((f) => n - f.t0 < 4);
  }

  ladderCell(meta, h) {
    let best = meta.sizes[0];
    for (const s of meta.sizes) if (Math.abs(s.h - h) < Math.abs(best.h - h)) best = s;
    return best;
  }

  draw(x, n) {
    // smoke first, far to near: white puffs that grow and turn gray
    const puffs = this.puffs.slice().sort((a, b) => b.D - a.D);
    for (const p of puffs) {
      const z = p.D / KZ;
      if (z < 0.4) continue;
      const age = n - p.t0,
        s = this.project(p.X, p.H + age * 0.4, z),
        r = Math.max(1, Math.round((1.4 + age * 0.45) / z));
      x.fillStyle = age < 3 ? "#f4f1ff" : age < 8 ? "#c8c4d4" : age < 12 ? "#8c8898" : "#5c5868";
      if (age >= 12 && (Math.round(s.x) + Math.round(s.y)) % 2) continue; // the last ticks thin out like a dither
      disc(x, s.x, s.y, r);
    }
    for (const f of this.flashes) {
      // muzzle flash at the pod
      if (n < f.t0) continue;
      const s = this.project(f.p.X, f.p.H, f.p.D / KZ),
        r = [10, 14, 9, 4][n - f.t0];
      x.fillStyle = n - f.t0 < 2 ? "#ffffff" : "#ffcf3f";
      disc(x, s.x, s.y, r);
    }
    // missiles, far to near, with the sprite whose heading matches the screen motion
    const ms = this.list.filter((m) => n >= m.t0 && m.prev).sort((a, b) => b.p.D - a.p.D);
    for (const m of ms) {
      const z = m.p.D / KZ,
        s = this.project(m.p.X, m.p.H, z),
        s0 = this.project(m.prev.X, m.prev.H, m.prev.D / KZ);
      const ang = (Math.atan2(s.x - s0.x, -(s.y - s0.y)) * 180) / Math.PI;
      let k = 0;
      YAWS.forEach((y, i) => {
        if (Math.abs(y - ang) < Math.abs(YAWS[k] - ang)) k = i;
      });
      const L = this.ladders[k],
        c = this.ladderCell(L.meta, 20 / z);
      x.drawImage(
        L.img,
        c.x,
        L.meta.H - c.h,
        c.w,
        c.h,
        Math.round(s.x - c.w / 2),
        Math.round(s.y - c.h / 2),
        c.w,
        c.h,
      );
      // exhaust: a flickering white-yellow core just behind the sprite
      x.fillStyle = (n + k) % 2 ? "#ffffff" : "#ffcf3f";
      disc(
        x,
        s0.x * 0.4 + s.x * 0.6,
        s0.y * 0.4 + s.y * 0.6 + c.h * 0.2,
        Math.max(1, Math.round(3 / z)),
      );
    }
  }
}

function disc(x, cx, cy, r) {
  cx = Math.round(cx);
  cy = Math.round(cy);
  for (let dy = -r; dy <= r; dy++) {
    const w = Math.round(Math.sqrt(r * r - dy * dy));
    x.fillRect(cx - w, cy + dy, w * 2 + 1, 1);
  }
}
