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
      const fromSide = side || (k % 2 ? 1 : -1);
      const position = { X: fromSide * (70 + 12 * k), H: 30 + 5 * k, D: 0.55 * KZ };
      const velocity = {
        X: fromSide * (5 + 3 * k) * spread,
        H: (3 + 2 * ((k + 1) % 3)) * spread,
        D: 12 + 2 * k,
      };
      // a missile: p (its place), v (its move a tick), prev (its place a tick ago), t0 (the tick
      // of its launch: one every 3 ticks), vmax (its top speed now), start and bend (the curve of
      // a guided one)
      this.list.push({
        p: position,
        v: velocity,
        prev: null,
        t0: tick + k * 3,
        target,
        onHit: k === 0 ? onHit : null,
        onEachHit,
        vmax: 10,
        alive: true,
        // guided: the missile meets the target where it is after this many ticks (D-130)
        guided: guided ? guided + k * 2 : 0,
        start: { ...position },
        bend: {
          X: position.X + fromSide * (90 + 20 * k) * spread,
          H: position.H + 70 + 10 * k,
          D: position.D + 60,
        },
      });
      this.flashes.push({ p: { ...position }, t0: tick + k * 3 });
    }
    this.sfx("ミサイル");
  }

  /** One tick: every launched missile moves and leaves its smoke; one that arrives (a guided one
   * after its ticks, the others within 16 units of the target or after 50 ticks) is taken away
   * and its onHit and onEachHit are called. Old smoke and flashes are dropped. */
  tick(tickNumber) {
    for (const missile of this.list) {
      if (!missile.alive || tickNumber < missile.t0) continue;
      const age = tickNumber - missile.t0,
        target = missile.target();
      if (missile.guided) {
        // a curve from the launch, bending out like the fan of the volley, to the target's place
        // now
        const progress = Math.min(1, age / missile.guided),
          startShare = (1 - progress) * (1 - progress),
          bendShare = 2 * progress * (1 - progress),
          targetShare = progress * progress;
        missile.prev = { ...missile.p };
        missile.p = {
          X: startShare * missile.start.X + bendShare * missile.bend.X + targetShare * target.X,
          H: startShare * missile.start.H + bendShare * missile.bend.H + targetShare * target.H,
          D: startShare * missile.start.D + bendShare * missile.bend.D + targetShare * target.D,
        };
        missile.v = {
          X: missile.p.X - missile.prev.X,
          H: missile.p.H - missile.prev.H,
          D: missile.p.D - missile.prev.D,
        };
        if (this.smoke !== false)
          for (const share of [0.33, 0.66, 1])
            this.puffs.push({
              X: missile.prev.X + (missile.p.X - missile.prev.X) * share,
              H: missile.prev.H + (missile.p.H - missile.prev.H) * share,
              D: missile.prev.D + (missile.p.D - missile.prev.D) * share,
              t0: tickNumber,
            });
        if (progress >= 1) {
          arrive(missile, target, tickNumber);
        }
        continue;
      }
      // pursuit: aim at where the target will be, further ahead when far (T = distance * c)
      const toTargetX = target.X - missile.p.X,
        toTargetH = target.H - missile.p.H,
        toTargetD = target.D - missile.p.D;
      const dist = Math.hypot(toTargetX, toTargetH, toTargetD),
        leadTicks = Math.min(8, (dist / Math.max(1, missile.vmax)) * 0.5);
      const aim = { X: target.X, H: target.H, D: target.D + (target.vD || 0) * leadTicks };
      const aimX = aim.X - missile.p.X,
        aimH = aim.H - missile.p.H,
        aimD = aim.D - missile.p.D,
        aimLength = Math.hypot(aimX, aimH, aimD) || 1;
      missile.vmax = Math.min(34, 10 + age * 1.4);
      // the first ticks keep the fan-out, then the missile turns hard
      const maxSteer = age < 5 ? 0.8 : 4.5;
      let steerX = (aimX / aimLength) * missile.vmax - missile.v.X,
        steerH = (aimH / aimLength) * missile.vmax - missile.v.H,
        steerD = (aimD / aimLength) * missile.vmax - missile.v.D;
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
      for (const share of this.smoke === false ? [] : [0.33, 0.66, 1]) {
        // three puffs per tick fill the wake between positions (none when `smoke` is turned off)
        this.puffs.push({
          X: missile.prev.X + (missile.p.X - missile.prev.X) * share + (Math.random() - 0.5) * 2,
          H: missile.prev.H + (missile.p.H - missile.prev.H) * share + (Math.random() - 0.5) * 2,
          D: missile.prev.D + (missile.p.D - missile.prev.D) * share,
          t0: tickNumber,
        });
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
    const puffs = this.puffs.slice().sort((one, other) => other.D - one.D);
    for (const puff of puffs) {
      const z = puff.D / KZ;
      if (z < 0.4) continue;
      const age = tickNumber - puff.t0,
        at = this.project(puff.X, puff.H + age * 0.4, z),
        radius = Math.max(1, Math.round((1.4 + age * 0.45) / z));
      ctx.fillStyle = age < 3 ? "#f4f1ff" : age < 8 ? "#c8c4d4" : age < 12 ? "#8c8898" : "#5c5868";
      // the last ticks thin out like a dither
      if (age >= 12 && (Math.round(at.x) + Math.round(at.y)) % 2) continue;
      disc(ctx, at.x, at.y, radius);
    }
    for (const flash of this.flashes) {
      // muzzle flash at the pod
      if (tickNumber < flash.t0) continue;
      const at = this.project(flash.p.X, flash.p.H, flash.p.D / KZ),
        radius = [10, 14, 9, 4][tickNumber - flash.t0];
      ctx.fillStyle = tickNumber - flash.t0 < 2 ? "#ffffff" : "#ffcf3f";
      disc(ctx, at.x, at.y, radius);
    }
    // missiles, far to near, with the sprite whose heading matches the screen motion
    const flying = this.list
      .filter((missile) => tickNumber >= missile.t0 && missile.prev)
      .sort((one, other) => other.p.D - one.p.D);
    for (const missile of flying) {
      const z = missile.p.D / KZ,
        at = this.project(missile.p.X, missile.p.H, z),
        before = this.project(missile.prev.X, missile.prev.H, missile.prev.D / KZ);
      const heading = (Math.atan2(at.x - before.x, -(at.y - before.y)) * 180) / Math.PI;
      let nearest = 0;
      YAWS.forEach((yaw, index) => {
        if (Math.abs(yaw - heading) < Math.abs(YAWS[nearest] - heading)) nearest = index;
      });
      const ladder = this.ladders[nearest],
        cell = ladderCell(ladder.meta, 20 / z);
      ctx.drawImage(
        ladder.img,
        cell.x,
        ladder.meta.H - cell.h,
        cell.w,
        cell.h,
        Math.round(at.x - cell.w / 2),
        Math.round(at.y - cell.h / 2),
        cell.w,
        cell.h,
      );
      // exhaust: a flickering white-yellow core just behind the sprite
      ctx.fillStyle = (tickNumber + nearest) % 2 ? "#ffffff" : "#ffcf3f";
      disc(
        ctx,
        before.x * 0.4 + at.x * 0.6,
        before.y * 0.4 + at.y * 0.6 + cell.h * 0.2,
        Math.max(1, Math.round(3 / z)),
      );
    }
  }
}

/** A missile reaches its target: it is gone, and its owner is told (onHit for the missile
 * launched first, onEachHit for every one). */
function arrive(missile, target, tickNumber) {
  missile.alive = false;
  if (missile.onHit) missile.onHit(tickNumber);
  if (missile.onEachHit) missile.onEachHit(target, tickNumber);
}

/** A filled circle of whole pixels, row by row (no smooth edge). */
function disc(ctx, cx, cy, radius) {
  cx = Math.round(cx);
  cy = Math.round(cy);
  for (let dy = -radius; dy <= radius; dy++) {
    const half = Math.round(Math.sqrt(radius * radius - dy * dy));
    ctx.fillRect(cx - half, cy + dy, half * 2 + 1, 1);
  }
}
