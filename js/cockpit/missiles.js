// Missiles that fly from the cockpit into the depth toward their targets (research 13; ドパ ED
// ST-05, D-41). A separate piece (ドパ ED D-19): it knows only a projection function, its sprite
// ladders and a sound hook.
//
// Each missile lives in 3D: X (lateral), H (height above the ground) and D (depth), in one unit,
// so that steering is the same in every direction; the screen uses z = D / KZ, as the road does
// (x = road + X / z). There are two flights. A guided missile (D-130) follows a curve from its
// launch, bending out like the fan of the volley, to the place where its target is at that tick,
// and arrives after a set number of ticks. The others are launched from a shoulder pod between
// the viewer and the glass (z = 0.55), first fan out and up (the Itano Circus spread), then steer
// toward a predicted target point by Reynolds' seek/pursuit:
//   desired = normalize(target - p) * vmax;  steer = truncate(desired - v, fmax);
//   v = truncate(v + steer, vmax)
// while vmax grows, so the path curves and speeds up. A puff of smoke is left at each tick and
// drawn with perspective (size ~ 1/z), so the trail reads as a wake going into the distance.
import { ladderCell } from "./pixel.js";

export const KZ = 200; // depth units per z (the "focal length" of the projection)

// the headings of the five missile sprites, in degrees on the screen: 0 is straight up, + is to
// the right
const YAWS = [-40, -20, 0, 20, 40];

export class Missiles {
  constructor({ project, ladders, sfx = () => {} }) {
    this.project = project; // (X, H, z) -> {x, y} in world pixels
    this.ladders = ladders; // [{img, meta}] for YAWS
    this.sfx = sfx;

    this.list = [];
    this.puffs = [];
    this.flashes = [];

    // `smoke` is set by the owner (battle.js): false turns the wake off. It is read at every
    // tick, so it also holds for the missiles already flying.
  }

  /** Launch a volley of `count` missiles at one target, from `side` (-1 left, 1 right; 0: from
   * both in turn). target() returns {X, H, D, vD} (vD = its depth speed per tick). `onHit(tick)`
   * is called when the missile launched first arrives, `onEachHit(target, tick)` for every one.
   * `tick`: the tick of the first launch; each later missile starts 3 ticks after the one before.
   * `spread`: how wide the volley fans out (1 as drawn). `guided`: in how many ticks the first
   * arrives, each later one taking 2 more (0: the missiles steer by themselves). */
  volley({ count = 3, side = 0, target, onHit, onEachHit = null, tick, spread = 1, guided = 0 }) {
    for (let k = 0; k < count; k++) {
      let fromSide = side;
      if (!fromSide) {
        fromSide = k % 2 ? 1 : -1;
      }

      const position = {
        X: fromSide * (70 + 12 * k),
        H: 30 + 5 * k,
        D: 0.55 * KZ,
      };

      const riseStep = (k + 1) % 3;
      const velocity = {
        X: fromSide * (5 + 3 * k) * spread,
        H: (3 + 2 * riseStep) * spread,
        D: 12 + 2 * k,
      };

      const launchTick = tick + k * 3;

      let onFirstHit = null;
      if (k === 0) {
        onFirstHit = onHit;
      }

      // guided: the missile meets the target where it is after this many ticks (D-130)
      let guidedTicks = 0;
      if (guided) {
        guidedTicks = guided + k * 2;
      }

      const bendOut = fromSide * (90 + 20 * k) * spread;
      const bend = {
        X: position.X + bendOut,
        H: position.H + 70 + 10 * k,
        D: position.D + 60,
      };

      // a missile: p (its place), v (its move a tick), prev (its place a tick ago), t0 (the tick
      // of its launch: one every 3 ticks), vmax (its top speed now), start and bend (the curve of
      // a guided one)
      const missile = {
        p: position,
        v: velocity,
        prev: null,
        t0: launchTick,
        target,
        onHit: onFirstHit,
        onEachHit,
        vmax: 10,
        alive: true,
        guided: guidedTicks,
        start: { ...position },
        bend,
      };
      this.list.push(missile);

      const flash = {
        p: { ...position },
        t0: launchTick,
      };
      this.flashes.push(flash);
    }

    this.sfx("ミサイル");
  }

  /** One tick: every launched missile moves and leaves its smoke; one that arrives (a guided one
   * after its ticks, the others within 16 units of the target or after 50 ticks) is taken away
   * and its onHit and onEachHit are called. Old smoke and flashes are dropped. */
  tick(tickNumber) {
    for (const missile of this.list) {
      if (!missile.alive) {
        continue;
      }
      if (tickNumber < missile.t0) {
        continue;
      }

      const age = tickNumber - missile.t0;
      const target = missile.target();

      if (missile.guided) {
        // a curve from the launch, bending out like the fan of the volley, to the target's place
        // now
        const flown = age / missile.guided;
        const progress = Math.min(1, flown);
        const remaining = 1 - progress;

        const startShare = remaining * remaining;
        const bendShare = 2 * progress * remaining;
        const targetShare = progress * progress;

        missile.prev = { ...missile.p };

        const startX = startShare * missile.start.X;
        const bendX = bendShare * missile.bend.X;
        const targetX = targetShare * target.X;

        const startH = startShare * missile.start.H;
        const bendH = bendShare * missile.bend.H;
        const targetH = targetShare * target.H;

        const startD = startShare * missile.start.D;
        const bendD = bendShare * missile.bend.D;
        const targetD = targetShare * target.D;

        missile.p = {
          X: startX + bendX + targetX,
          H: startH + bendH + targetH,
          D: startD + bendD + targetD,
        };
        missile.v = {
          X: missile.p.X - missile.prev.X,
          H: missile.p.H - missile.prev.H,
          D: missile.p.D - missile.prev.D,
        };

        if (this.smoke !== false) {
          for (const share of [0.33, 0.66, 1]) {
            const movedX = missile.p.X - missile.prev.X;
            const movedH = missile.p.H - missile.prev.H;
            const movedD = missile.p.D - missile.prev.D;

            const puff = {
              X: missile.prev.X + movedX * share,
              H: missile.prev.H + movedH * share,
              D: missile.prev.D + movedD * share,
              t0: tickNumber,
            };
            this.puffs.push(puff);
          }
        }

        if (progress >= 1) {
          arrive(missile, target, tickNumber);
        }
        continue;
      }

      // pursuit: aim at where the target will be, further ahead when far (T = distance * c)
      const toTargetX = target.X - missile.p.X;
      const toTargetH = target.H - missile.p.H;
      const toTargetD = target.D - missile.p.D;
      const dist = Math.hypot(toTargetX, toTargetH, toTargetD);

      const speedForLead = Math.max(1, missile.vmax);
      const ticksAway = dist / speedForLead;
      const halfTicksAway = ticksAway * 0.5;
      const leadTicks = Math.min(8, halfTicksAway);

      const targetSpeedD = target.vD || 0;
      const aim = {
        X: target.X,
        H: target.H,
        D: target.D + targetSpeedD * leadTicks,
      };

      const aimX = aim.X - missile.p.X;
      const aimH = aim.H - missile.p.H;
      const aimD = aim.D - missile.p.D;
      let aimLength = Math.hypot(aimX, aimH, aimD);
      if (!aimLength) {
        aimLength = 1;
      }

      const grownSpeed = 10 + age * 1.4;
      missile.vmax = Math.min(34, grownSpeed);

      // the first ticks keep the fan-out, then the missile turns hard
      const maxSteer = age < 5 ? 0.8 : 4.5;

      const desiredX = (aimX / aimLength) * missile.vmax;
      const desiredH = (aimH / aimLength) * missile.vmax;
      const desiredD = (aimD / aimLength) * missile.vmax;

      let steerX = desiredX - missile.v.X;
      let steerH = desiredH - missile.v.H;
      let steerD = desiredD - missile.v.D;

      const steerLength = Math.hypot(steerX, steerH, steerD);
      if (steerLength > maxSteer) {
        steerX *= maxSteer / steerLength;
        steerH *= maxSteer / steerLength;
        steerD *= maxSteer / steerLength;
      }

      missile.v.X += steerX;
      missile.v.H += steerH;
      missile.v.D += steerD;

      const speed = Math.hypot(missile.v.X, missile.v.H, missile.v.D);
      if (speed > missile.vmax) {
        missile.v.X *= missile.vmax / speed;
        missile.v.H *= missile.vmax / speed;
        missile.v.D *= missile.vmax / speed;
      }

      missile.prev = { ...missile.p };
      missile.p.X += missile.v.X;
      missile.p.H += missile.v.H;
      missile.p.D += missile.v.D;

      // three puffs per tick fill the wake between positions (none when `smoke` is turned off)
      let shares = [0.33, 0.66, 1];
      if (this.smoke === false) {
        shares = [];
      }
      for (const share of shares) {
        const movedX = missile.p.X - missile.prev.X;
        const scatterX = (Math.random() - 0.5) * 2;

        const movedH = missile.p.H - missile.prev.H;
        const scatterH = (Math.random() - 0.5) * 2;

        const movedD = missile.p.D - missile.prev.D;

        const puff = {
          X: missile.prev.X + movedX * share + scatterX,
          H: missile.prev.H + movedH * share + scatterH,
          D: missile.prev.D + movedD * share,
          t0: tickNumber,
        };
        this.puffs.push(puff);
      }

      if (dist < 16 || age > 50) {
        arrive(missile, target, tickNumber);
      }
    }

    this.list = this.list.filter((missile) => missile.alive);
    this.puffs = this.puffs.filter((puff) => tickNumber - puff.t0 < 16);
    this.flashes = this.flashes.filter((flash) => tickNumber - flash.t0 < 4);
  }

  /** Draw the smoke, the muzzle flashes and the missiles on the world layer. */
  draw(ctx, tickNumber) {
    // smoke first, far to near: white puffs that grow and turn gray
    const puffs = this.puffs.slice();
    puffs.sort((one, other) => other.D - one.D);

    for (const puff of puffs) {
      const z = puff.D / KZ;
      if (z < 0.4) {
        continue;
      }

      const age = tickNumber - puff.t0;
      const risen = puff.H + age * 0.4;
      const at = this.project(puff.X, risen, z);

      const grown = (1.4 + age * 0.45) / z;
      const wholeRadius = Math.round(grown);
      const radius = Math.max(1, wholeRadius);

      if (age < 3) {
        ctx.fillStyle = "#f4f1ff";
      } else if (age < 8) {
        ctx.fillStyle = "#c8c4d4";
      } else if (age < 12) {
        ctx.fillStyle = "#8c8898";
      } else {
        ctx.fillStyle = "#5c5868";
      }

      // the last ticks thin out like a dither
      if (age >= 12) {
        const pixelSum = Math.round(at.x) + Math.round(at.y);
        if (pixelSum % 2) {
          continue;
        }
      }

      disc(ctx, at.x, at.y, radius);
    }

    for (const flash of this.flashes) {
      // muzzle flash at the pod
      if (tickNumber < flash.t0) {
        continue;
      }

      const z = flash.p.D / KZ;
      const at = this.project(flash.p.X, flash.p.H, z);

      const age = tickNumber - flash.t0;
      const radius = [10, 14, 9, 4][age];

      ctx.fillStyle = age < 2 ? "#ffffff" : "#ffcf3f";
      disc(ctx, at.x, at.y, radius);
    }

    // missiles, far to near, with the sprite whose heading matches the screen motion
    const flying = [];
    for (const missile of this.list) {
      const launched = tickNumber >= missile.t0;
      if (launched && missile.prev) {
        flying.push(missile);
      }
    }
    flying.sort((one, other) => other.p.D - one.p.D);

    for (const missile of flying) {
      const z = missile.p.D / KZ;
      const at = this.project(missile.p.X, missile.p.H, z);

      const zBefore = missile.prev.D / KZ;
      const before = this.project(missile.prev.X, missile.prev.H, zBefore);

      const movedRight = at.x - before.x;
      const movedUp = -(at.y - before.y);
      const headingRadians = Math.atan2(movedRight, movedUp);
      const heading = (headingRadians * 180) / Math.PI;

      let nearest = 0;
      YAWS.forEach((yaw, index) => {
        const off = Math.abs(yaw - heading);
        const nearestOff = Math.abs(YAWS[nearest] - heading);
        if (off < nearestOff) {
          nearest = index;
        }
      });

      const ladder = this.ladders[nearest];
      const heightOnScreen = 20 / z;
      const cell = ladderCell(ladder.meta, heightOnScreen);

      const cellTop = ladder.meta.H - cell.h;
      const left = Math.round(at.x - cell.w / 2);
      const top = Math.round(at.y - cell.h / 2);
      ctx.drawImage(ladder.img, cell.x, cellTop, cell.w, cell.h, left, top, cell.w, cell.h);

      // exhaust: a flickering white-yellow core just behind the sprite
      const flicker = (tickNumber + nearest) % 2;
      ctx.fillStyle = flicker ? "#ffffff" : "#ffcf3f";

      const exhaustX = before.x * 0.4 + at.x * 0.6;
      const exhaustY = before.y * 0.4 + at.y * 0.6 + cell.h * 0.2;
      const exhaustSize = Math.round(3 / z);
      const exhaustRadius = Math.max(1, exhaustSize);
      disc(ctx, exhaustX, exhaustY, exhaustRadius);
    }
  }
}

/** A missile reaches its target: it is gone, and its owner is told (onHit for the missile
 * launched first, onEachHit for every one). */
function arrive(missile, target, tickNumber) {
  missile.alive = false;

  if (missile.onHit) {
    missile.onHit(tickNumber);
  }
  if (missile.onEachHit) {
    missile.onEachHit(target, tickNumber);
  }
}

/** A filled circle of whole pixels, row by row (no smooth edge). */
function disc(ctx, cx, cy, radius) {
  cx = Math.round(cx);
  cy = Math.round(cy);

  for (let dy = -radius; dy <= radius; dy++) {
    const halfSquared = radius * radius - dy * dy;
    const halfExact = Math.sqrt(halfSquared);
    const half = Math.round(halfExact);

    const left = cx - half;
    const rowWidth = half * 2 + 1;
    ctx.fillRect(left, cy + dy, rowWidth, 1);
  }
}
