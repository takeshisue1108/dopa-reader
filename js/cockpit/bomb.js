// The bomb by the console and its explosion (SPEC_dopa v3 §6.5; ED D-88 to D-92, D-105, A-30,
// ST-31, ST-32). The numbers are in levels.js; this draws the indicator (a bomb that grows one
// step at each tier, and a gauge to the next level, with no numbers, D-91) and the five tiers of
// explosion. Until the Blender sprites of stage W5 exist, both are drawn from simple shapes.
import { gauge, level, tier, TIER_SECONDS, TIERS } from "./levels.js";

const FPS = 30;
const PULSE_TICKS = 6;
const FLASH_TICKS = 2;
const MAX_SHAKE = 8; // world pixels (ED-10)

export class Bomb {
  /** `place`: the indicator's bottom center on the text layer {x, y}. `flash()` asks the flash
   * limiter for a large flash and returns whether it may be shown. `sfx(name)` plays a sound. */
  constructor({ place, flash = () => true, sfx = () => {} }) {
    Object.assign(this, { place, flash, sfx });
    this.count = 0;
    this.pulseAt = -99;
    this.blast = null; // { tier, t0, ticks, flashAt }
  }

  /** Set the count without any sign (on opening the site). */
  set(count) {
    this.count = count;
  }
  /** One more enemy shot (D-90). A new level makes the bomb pulse with a blip (ST-31). */
  add(n, tick) {
    const before = level(this.count);
    this.count += n;
    if (level(this.count) > before) {
      this.pulseAt = tick;
      this.sfx("levelup");
    }
  }

  /** Set the explosion of the current count off (ST-32). Returns { tier, level, seconds } or null
   * when the count is 0 (nothing explodes). The count returns to 0. */
  explode(tick) {
    const L = level(this.count),
      t = tier(L);
    this.count = 0;
    if (!t) return null;
    const ticks = Math.round(TIER_SECONDS[t] * FPS);
    this.blast = { tier: t, t0: tick, ticks, flashAt: null, seed: Math.random() * 1000 };
    if (TIERS.indexOf(t) >= 2 && this.flash()) this.blast.flashAt = tick + 2;
    this.sfx(`boom_${{ small: "s", medium: "m", large: "l", xlarge: "xl", max: "max" }[t]}`);
    return { tier: t, level: L, seconds: TIER_SECONDS[t] };
  }
  /** Cut a running explosion short: it ends within 0.2 s (「▶ 再生」 during it). */
  shorten(tick) {
    if (this.blast) this.blast.ticks = Math.min(this.blast.ticks, tick - this.blast.t0 + 6);
  }
  /** Whether an explosion is still playing. */
  busy(tick) {
    return !!this.blast && tick - this.blast.t0 < this.blast.ticks;
  }

  /** The cockpit's shake now, in world pixels {x, y}, at most 8 (ED-10). */
  shake(tick) {
    const b = this.blast;
    if (!b || tick - b.t0 >= b.ticks) return { x: 0, y: 0 };
    const strength = { small: 0, medium: 2, large: 5, xlarge: 7, max: MAX_SHAKE }[b.tier],
      fade = 1 - (tick - b.t0) / b.ticks,
      amount = Math.round(strength * fade);
    return { x: tick % 2 ? amount : -amount, y: tick % 3 ? Math.round(amount / 2) : -Math.round(amount / 2) };
  }

  /** The explosion on the world layer (426×240), in front of the road and the enemies. */
  drawBlast(m, tick, road) {
    const b = this.blast;
    if (!b) return;
    const age = tick - b.t0;
    if (age >= b.ticks) {
      this.blast = null;
      return;
    }
    const t = age / b.ticks,
      index = TIERS.indexOf(b.tier),
      horizon = road ? road.horizonY : 90,
      bursts = [1, 3, 7, 11, 16][index],
      spreadX = [30, 70, 180, 200, 210][index],
      size = [26, 34, 48, 60, 70][index];
    for (let k = 0; k < bursts; k++) {
      const start = (k / bursts) * 0.5, // bursts follow one another
        life = (t - start) / 0.5;
      if (life < 0 || life > 1) continue;
      const rand = Math.sin(b.seed + k * 12.9898) * 43758.5453,
        jitter = rand - Math.floor(rand),
        x = 213 + (k % 2 ? 1 : -1) * spreadX * (k / bursts) + (jitter - 0.5) * 30,
        // the largest tiers run the explosions to the horizon (A-30)
        y = index >= 3 ? horizon + 10 + (1 - k / bursts) * 90 : 150 - jitter * 20,
        r = size * (index >= 3 ? 0.4 + 0.6 * (1 - k / bursts) : 1) * Math.sin(Math.PI * Math.min(1, life * 1.2));
      drawBurst(m, x, y, r, life);
    }
    if (index >= 3 && t < 0.6) {
      // the shock ring past the edges of the picture
      const radius = (t / 0.6) * 300;
      m.strokeStyle = "#fff6d0";
      m.lineWidth = 3;
      m.beginPath();
      m.ellipse(213, 150, radius, radius * 0.45, 0, 0, Math.PI * 2);
      m.stroke();
    }
  }

  /** The one white flash of a large explosion, on the text layer (ED-10: never blinking). */
  drawFlash(f, tick, w, h) {
    const b = this.blast;
    if (!b || b.flashAt === null) return;
    const age = tick - b.flashAt;
    if (age < 0 || age >= FLASH_TICKS) return;
    f.fillStyle = age === 0 ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.4)";
    f.fillRect(0, 0, w, h);
  }

  /** The indicator on the text layer: the bomb of the current tier, and the gauge under it. */
  drawIndicator(f, tick) {
    const L = level(this.count),
      step = L === 0 ? 0 : TIERS.indexOf(tier(L)) + 1, // 0 to 5
      pulse = tick - this.pulseAt < PULSE_TICKS ? 1.2 : 1,
      r = Math.round((9 + step * 3) * pulse),
      cx = this.place.x,
      cy = this.place.y - 16 - r;
    // the bomb: a round body, a highlight, a fuse that sparks once there is a level
    f.fillStyle = "#1d1a2e";
    f.beginPath();
    f.arc(cx, cy, r + 2, 0, Math.PI * 2);
    f.fill();
    f.fillStyle = ["#4a4458", "#5a4a70", "#6a3f78", "#8a3050", "#b02a3a", "#e0402a"][step];
    f.beginPath();
    f.arc(cx, cy, r, 0, Math.PI * 2);
    f.fill();
    f.fillStyle = "#ffffff";
    f.fillRect(cx - Math.round(r * 0.45), cy - Math.round(r * 0.5), Math.max(2, Math.round(r * 0.25)), Math.max(2, Math.round(r * 0.25)));
    f.fillStyle = "#c8b48a";
    f.fillRect(cx + Math.round(r * 0.5), cy - r - 6, 3, 8);
    if (step > 0 && Math.floor(tick / 3) % 2) {
      f.fillStyle = "#ffcf3f";
      f.fillRect(cx + Math.round(r * 0.5) - 1, cy - r - 10, 5, 5);
    }
    // the gauge, 48 × 8 text pixels, no number (D-91)
    const gw = 48,
      gx = cx - gw / 2,
      gy = this.place.y - 10;
    f.fillStyle = "#1d1a2e";
    f.fillRect(gx - 2, gy - 2, gw + 4, 12);
    f.fillStyle = "#3a3040";
    f.fillRect(gx, gy, gw, 8);
    f.fillStyle = "#ffcf3f";
    f.fillRect(gx, gy, Math.round(gw * gauge(this.count)), 8);
  }
}

function drawBurst(m, x, y, r, life) {
  if (r <= 0) return;
  const colors = life < 0.2 ? ["#ffffff", "#fff6d0"] : life < 0.5 ? ["#ffcf3f", "#ffffff"] : life < 0.8 ? ["#e0603a", "#ffcf3f"] : ["#6a4a50", "#8a6a60"];
  m.fillStyle = colors[0];
  m.beginPath();
  m.arc(Math.round(x), Math.round(y), Math.round(r), 0, Math.PI * 2);
  m.fill();
  m.fillStyle = colors[1];
  m.beginPath();
  m.arc(Math.round(x), Math.round(y), Math.round(r * 0.55), 0, Math.PI * 2);
  m.fill();
  for (let k = 0; k < 10; k++) {
    const angle = k * 0.63 + life * 2;
    m.fillRect(Math.round(x + Math.cos(angle) * r * 1.2) - 2, Math.round(y + Math.sin(angle) * r) - 2, 4, 4);
  }
}
