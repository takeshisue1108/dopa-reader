// The bomb by the console and its explosion (SPEC_dopa v3 §6.5; ED D-88 to D-92, D-105, A-30,
// ST-31, ST-32). The count is the enemies shot since the last explosion; the level grows with
// the count; the tier is one of five names for the size of the explosion, null at level 0. Those
// numbers are in levels.js. This draws the indicator (a bomb that grows one step at each tier,
// and a gauge to the next level, with no numbers, D-91) and the five tiers of explosion. Until
// the Blender sprites of stage W5 exist, both are drawn from simple shapes.
import { FPS } from "./clock.js";
import { gauge, level, tier, TIER_SECONDS, TIERS } from "./levels.js";

const PULSE_TICKS = 6; // how long the indicator is larger after a new level
const FLASH_TICKS = 2; // how long the white flash of a large explosion lasts
const MAX_SHAKE = 8; // world pixels (ED-10)

// the two bars of the pause mark, in text pixels: the same on every bomb (D-155)
const PAUSE_BAR = { width: 3, height: 12, gap: 4 };

export class Bomb {
  /** `place`: the indicator's bottom center on the text layer {x, y}. `flash()` asks the flash
   * limiter for a large flash and returns whether it may be shown. `sfx(name)` plays a sound. */
  constructor({ place, flash = () => true, sfx = () => {} }) {
    const given = {
      place,
      flash,
      sfx,
    };
    Object.assign(this, given);

    this.count = 0;
    this.pulseAt = -99;

    // the explosion playing: { tier, t0 (its first tick), ticks (how long), flashAt (the tick of
    // its flash, or null), seed (for the places of its bursts) }
    this.blast = null;
  }

  /** Set the count without any sign (on opening the site). */
  set(count) {
    this.count = count;
  }
  /** One more enemy shot (D-90). A new level makes the bomb pulse with a blip (ST-31). */
  add(shot, tick) {
    const before = level(this.count);
    this.count += shot;
    const after = level(this.count);

    if (after > before) {
      this.pulseAt = tick;
      this.sfx("levelup");
    }
  }

  /** Set the explosion of the current count off (ST-32). Returns { tier, level, seconds } or null
   * when the count is 0 (nothing explodes). The count returns to 0. */
  explode(tick) {
    const reached = level(this.count);
    const tierName = tier(reached);
    this.count = 0;

    if (!tierName) {
      return null;
    }

    const seconds = TIER_SECONDS[tierName];
    const ticks = Math.round(seconds * FPS);
    const seed = Math.random() * 1000;
    this.blast = {
      tier: tierName,
      t0: tick,
      ticks,
      flashAt: null,
      seed,
    };

    // from the tier "large" up, one white flash 2 ticks after the start, if the limiter allows
    const tierIndex = TIERS.indexOf(tierName);
    if (tierIndex >= 2 && this.flash()) {
      this.blast.flashAt = tick + 2;
    }

    const soundEndings = { small: "s", medium: "m", large: "l", xlarge: "xl", max: "max" };
    const soundEnding = soundEndings[tierName];
    this.sfx(`boom_${soundEnding}`);

    return {
      tier: tierName,
      level: reached,
      seconds,
    };
  }
  /** Cut a running explosion short: it ends within 0.2 s (「▶ 再生」 during it). */
  shorten(tick) {
    if (this.blast) {
      const ticksWhenCut = tick - this.blast.t0 + 6;
      this.blast.ticks = Math.min(this.blast.ticks, ticksWhenCut);
    }
  }
  /** Whether an explosion is still playing. */
  busy(tick) {
    if (!this.blast) {
      return false;
    }

    const age = tick - this.blast.t0;
    return age < this.blast.ticks;
  }

  /** The cockpit's shake now, in world pixels {x, y}, at most 8 (ED-10). */
  shake(tick) {
    const blast = this.blast;
    if (!blast) {
      return { x: 0, y: 0 };
    }

    const age = tick - blast.t0;
    if (age >= blast.ticks) {
      return { x: 0, y: 0 };
    }

    const strengths = { small: 0, medium: 2, large: 5, xlarge: 7, max: MAX_SHAKE };
    const strength = strengths[blast.tier];
    const fade = 1 - age / blast.ticks;
    const amount = Math.round(strength * fade);
    const half = Math.round(amount / 2);

    let x = -amount;
    if (tick % 2) {
      x = amount;
    }

    let y = -half;
    if (tick % 3) {
      y = half;
    }

    return { x, y };
  }

  /** The explosion on the world layer (426×240), in front of the road and the enemies. Call it
   * at every tick: it is also what ends an explosion whose time is over. */
  drawBlast(ctx, tick, road) {
    const blast = this.blast;
    if (!blast) {
      return;
    }

    const age = tick - blast.t0;
    if (age >= blast.ticks) {
      this.blast = null;
      return;
    }

    const progress = age / blast.ticks;
    const index = TIERS.indexOf(blast.tier);

    let horizon = 90;
    if (road) {
      horizon = road.horizonY;
    }

    // by tier: how many bursts, how far they spread to the sides, and their size
    const bursts = [1, 3, 7, 11, 16][index];
    const spreadX = [30, 70, 180, 200, 210][index];
    const size = [26, 34, 48, 60, 70][index];

    for (let k = 0; k < bursts; k++) {
      const order = k / bursts;

      // bursts follow one another
      const start = order * 0.5;
      const life = (progress - start) / 0.5;
      if (life < 0 || life > 1) {
        continue;
      }

      // a number from 0 to 1 that stays the same through the burst's life
      const burstSeed = blast.seed + k * 12.9898;
      const rand = Math.sin(burstSeed) * 43758.5453;
      const jitter = rand - Math.floor(rand);

      const side = k % 2 ? 1 : -1;
      const outward = side * spreadX * order;
      const scatter = (jitter - 0.5) * 30;
      const x = 213 + outward + scatter;

      // the largest tiers run the explosions to the horizon (A-30)
      let y;
      let scale;
      if (index >= 3) {
        const farness = 1 - order;
        y = horizon + 10 + farness * 90;
        scale = 0.4 + 0.6 * farness;
      } else {
        y = 150 - jitter * 20;
        scale = 1;
      }

      const swellAt = Math.min(1, life * 1.2);
      const swell = Math.sin(Math.PI * swellAt);
      const radius = size * scale * swell;

      drawBurst(ctx, x, y, radius, life);
    }

    if (index >= 3 && progress < 0.6) {
      // the shock ring past the edges of the picture
      const radius = (progress / 0.6) * 300;
      const radiusY = radius * 0.45;

      ctx.strokeStyle = "#fff6d0";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(213, 150, radius, radiusY, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /** The one white flash of a large explosion, on the text layer (ED-10: never blinking). */
  drawFlash(ctx, tick, w, h) {
    const blast = this.blast;
    if (!blast) {
      return;
    }
    if (blast.flashAt === null) {
      return;
    }

    const age = tick - blast.flashAt;
    if (age < 0 || age >= FLASH_TICKS) {
      return;
    }

    ctx.fillStyle = age === 0 ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.4)";
    ctx.fillRect(0, 0, w, h);
  }

  /** The indicator on the text layer: the bomb of the current tier with its pause mark, and the
   * gauge under it. */
  drawIndicator(ctx, tick) {
    const reached = level(this.count);

    // 0 to 5
    let step = 0;
    if (reached !== 0) {
      const tierName = tier(reached);
      step = TIERS.indexOf(tierName) + 1;
    }

    const sincePulse = tick - this.pulseAt;
    const pulse = sincePulse < PULSE_TICKS ? 1.2 : 1;

    const restRadius = 9 + step * 3;
    const radius = Math.round(restRadius * pulse);
    const centerX = this.place.x;
    const centerY = this.place.y - 16 - radius;

    // the bomb: a round body, a highlight, a fuse that sparks once there is a level
    ctx.fillStyle = "#1d1a2e";
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius + 2, 0, Math.PI * 2);
    ctx.fill();

    const bodyColors = ["#4a4458", "#5a4a70", "#6a3f78", "#8a3050", "#b02a3a", "#e0402a"];
    ctx.fillStyle = bodyColors[step];
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.fill();

    const highlightLeft = centerX - Math.round(radius * 0.45);
    const highlightTop = centerY - Math.round(radius * 0.5);
    const highlightSize = Math.max(2, Math.round(radius * 0.25));
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(highlightLeft, highlightTop, highlightSize, highlightSize);

    // the pause mark (D-152, A-40): two white bars with a dark edge on the body, since this is
    // the pause bomb: pressing it stops the song with the explosion. The mark has one size on
    // every bomb (D-155), the one that fits the smallest.
    const barWidth = PAUSE_BAR.width;
    const barHeight = PAUSE_BAR.height;
    const barTop = centerY - barHeight / 2;

    const halfGap = PAUSE_BAR.gap / 2;
    const leftBarLeft = centerX - halfGap - barWidth;
    const rightBarLeft = centerX + halfGap;

    for (const barLeft of [leftBarLeft, rightBarLeft]) {
      ctx.fillStyle = "#1d1a2e";
      ctx.fillRect(barLeft - 1, barTop - 1, barWidth + 2, barHeight + 2);

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(barLeft, barTop, barWidth, barHeight);
    }

    const fuseLeft = centerX + Math.round(radius * 0.5);
    const bodyTop = centerY - radius;
    ctx.fillStyle = "#c8b48a";
    ctx.fillRect(fuseLeft, bodyTop - 6, 3, 8);

    const sparkOn = Math.floor(tick / 3) % 2;
    if (step > 0 && sparkOn) {
      ctx.fillStyle = "#ffcf3f";
      ctx.fillRect(fuseLeft - 1, bodyTop - 10, 5, 5);
    }

    // the gauge, 48 × 8 text pixels, no number (D-91)
    const gaugeWidth = 48;
    const gaugeLeft = centerX - gaugeWidth / 2;
    const gaugeTop = this.place.y - 10;

    ctx.fillStyle = "#1d1a2e";
    ctx.fillRect(gaugeLeft - 2, gaugeTop - 2, gaugeWidth + 4, 12);

    ctx.fillStyle = "#3a3040";
    ctx.fillRect(gaugeLeft, gaugeTop, gaugeWidth, 8);

    const fullness = gauge(this.count);
    const filledWidth = Math.round(gaugeWidth * fullness);
    ctx.fillStyle = "#ffcf3f";
    ctx.fillRect(gaugeLeft, gaugeTop, filledWidth, 8);
  }
}

/** One burst: an outer and an inner disc whose colors go from white through gold and orange to
 * gray over its life (0 to 1), and 10 sparks around it. */
function drawBurst(ctx, x, y, radius, life) {
  if (radius <= 0) {
    return;
  }

  let colors;
  if (life < 0.2) {
    colors = ["#ffffff", "#fff6d0"];
  } else if (life < 0.5) {
    colors = ["#ffcf3f", "#ffffff"];
  } else if (life < 0.8) {
    colors = ["#e0603a", "#ffcf3f"];
  } else {
    colors = ["#6a4a50", "#8a6a60"];
  }

  const centerX = Math.round(x);
  const centerY = Math.round(y);

  const outerRadius = Math.round(radius);
  ctx.fillStyle = colors[0];
  ctx.beginPath();
  ctx.arc(centerX, centerY, outerRadius, 0, Math.PI * 2);
  ctx.fill();

  const innerRadius = Math.round(radius * 0.55);
  ctx.fillStyle = colors[1];
  ctx.beginPath();
  ctx.arc(centerX, centerY, innerRadius, 0, Math.PI * 2);
  ctx.fill();

  for (let k = 0; k < 10; k++) {
    const angle = k * 0.63 + life * 2;
    const sparkX = x + Math.cos(angle) * radius * 1.2;
    const sparkY = y + Math.sin(angle) * radius;

    const left = Math.round(sparkX) - 2;
    const top = Math.round(sparkY) - 2;
    ctx.fillRect(left, top, 4, 4);
  }
}
