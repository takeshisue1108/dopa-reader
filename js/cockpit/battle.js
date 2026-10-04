// The battle outside the glass and Elena at the controls (SPEC_dopa v3 §6.4, §6.6; ED D-39 to
// D-46, D-81, D-82, D-95, D-102, D-107, D-110, ST-05, ST-29, ST-30, ST-35). A separate piece: it
// knows the road's projection, its sprites and a sound hook, and nothing of the book.
//
// Taken from the battle of the accepted test scene (D-48): what an enemy, a volley, a burst, the
// shout and Elena's hands look like is unchanged. What changed: every enemy is the Kommy-type
// M.E.O.W (D-110) and carries one noun of the text as its sign; enemies come one at a time
// (send); a robot whose window closes unshot rushes past beside Elena, and one sent away (at a
// block's end, or to make room on a full road) leaves spinning over the cockpit (D-82); the boss
// has hit points (D-102). M.E.O.W is the robot model: Elena pilots one, and the enemies are the
// Kommy type.
//
// A robot's life: coming → standing → rushing through its window → either hit (frozen for 4
// ticks, then shattered) or passed beside Elena; or, at any time, sent away: leaving, spinning,
// for 30 ticks.
import { drawOutlined, ladderCell, textSprite } from "./pixel.js";
import { KZ, Missiles } from "./missiles.js";

const ENEMY_HEIGHT = 88, // at z = 1, in world pixels
  BOSS_HEIGHT = 170;
const SHOUT_TICKS = 36; // a shout stays 1.2 s (§6.4)
const LEAVE_TICKS = 30; // a robot sent away passes over the cockpit in 1 s (ST-30)
// the ring of a small burst at each of its 12 ticks, as a share of its radius
const BOOM_RADII = [0.3, 0.6, 0.85, 1, 1.05, 1.05, 1, 0.9, 0.75, 0.55, 0.35, 0.2];
const LANES = [-46, 0, 46]; // left, middle, right
const HIT_FLASH_TICKS = 4; // a robot that is hit stops and flashes this long before it explodes
const RUSH_NEAR = 0.45; // the depth at which a rushing robot passes beside Elena (D-125)
const CHARGE_NEAR = 0.7; // where its straight charge ends and the swerve begins (D-141)
const SWERVE_AT = 0.75; // the part of the window spent charging straight
const RUSH_DRIFT = 120; // how far it moves to the side of its lane while it rushes
// how far the right hand reaches forward (up on the screen) in each tick of a button press
const PRESS_REACH = [-3, -7, -7, -7, -7, -7, -5, -3, -1, 0];

export class Battle {
  /** `sprites`: {cockpit, elena: {back, fist}, kommy, kommyTurn (the robot's turn sheet, or
   * null), boss (or null), missiles}; kommy, boss and the missiles are ladders (one picture in
   * several sizes, pixel.js). `sfx(name)` plays a sound. `smoke()`: whether missiles leave a
   * wake. */
  constructor({ road, sprites, sfx = () => {}, smoke = () => true }) {
    Object.assign(this, { road, sprites, sfx, smoke });
    this.missiles = new Missiles({
      project: (X, H, z) => road.project3(X, H, z),
      ladders: sprites.missiles,
      sfx: () => sfx("launch"),
    });
    this.lane = 0; // how many robots were sent: the next takes the lane after the last one's
    this.pressSide = -1; // the corner the next volley comes from: left, then right, in turn (D-136)
    this.reset();
    // Elena: her pose ("back", or "fist" until the tick poseUntil), the count of presses (the
    // fist and the button in turn), and the tick of her last press on the button
    this.pose = "back";
    this.poseUntil = 0;
    this.poseTurn = 0;
    this.pressAt = -99;
  }

  /** Take everything off the road: enemies, the boss, missiles, explosions, shouts. */
  reset() {
    this.enemies = [];
    this.boss = null;
    this.booms = [];
    this.shout = null;
    this.now = 0;
    this.missiles.list.length = 0;
    this.missiles.puffs.length = 0;
    this.missiles.flashes.length = 0;
  }

  /** Enemies standing or coming (alive and not leaving). */
  standing() {
    return this.enemies.filter((enemy) => enemy.alive && !enemy.leftAt);
  }

  /**
   * One enemy sets out for a target noun (D-107): `id`, its sign `label`, and `inTicks`, the
   * ticks until its window opens. It comes from z 11 and stands at z 2.2 or a little behind; when
   * its window is near it comes faster, so that it stands before the window opens (§6.4).
   */
  send({ id, label }, tick, inTicks = 60) {
    const z0 = 11,
      zEnd = 2.2 + 0.15 * (this.standing().length % 6),
      speed = Math.max(0.07, (z0 - zEnd) / Math.max(8, inTicks - 4));
    // a robot: laneX (its lane, in pixels from the middle at z = 1), z0 and zEnd (where it sets
    // out and where it stands), born (the tick it was sent), speed (z a tick), sign (its noun);
    // aimed (shot: its missiles are on their way, and until they arrive it does not pass by,
    // leave or meet the lever's explosion, D-149);
    // later: frozen and stopAt (hit: where and when), shatterAt (destroyed), leftAt and leaveFrom
    // (sent away), forcedAt (rushing after the lever's explosion), passed (gone by, uncounted)
    this.enemies.push({
      id,
      laneX: LANES[this.lane++ % LANES.length],
      z0,
      zEnd,
      born: tick,
      speed,
      sign: label ? textSprite(label, 16, "DotGothic16") : null,
      alive: true,
      aimed: false,
      leftAt: null,
      rush: 0, // 0 to 1 through its window (D-125); set by the cockpit
      side: this.lane % 2 ? 1 : -1,
    });
  }

  /** Where each robot is in its window: `progress` maps an enemy id to a value under 0 before
   * the window opens, 0..1 while it is open, and 1 or more once it has closed. A robot past its
   * window has gone by Elena, uncounted; one that was shot stays at the end of its rush for its
   * missile (D-149). */
  setRush(progress) {
    for (const enemy of this.enemies) {
      if (!enemy.alive || enemy.leftAt || enemy.frozen) continue;
      const through = progress.get(enemy.id);
      if (through === undefined) continue;
      if (through >= 1 && !enemy.aimed) {
        enemy.alive = false;
        enemy.passed = true; // ST-30: not counted
      } else enemy.rush = Math.max(enemy.rush, Math.min(1, Math.max(0, through)));
    }
  }

  /** The enemy of a target, if it is still on the road. */
  enemyOf(id) {
    return this.enemies.find((enemy) => enemy.id === id && enemy.alive && !enemy.leftAt) || null;
  }

  /** The depth z of a robot or of the boss at a tick: coming from z0 to zEnd at its speed; a
   * robot in its window charges at the cockpit from there; one that is hit stays where it was. */
  depthOf(thing, tick) {
    if (thing.frozen) return thing.frozen.z; // hit: it stops where it is (D-130)
    const waiting = Math.max(thing.zEnd, thing.z0 - Math.max(0, tick - thing.born) * thing.speed);
    if (!thing.rush) return waiting;
    // in its window the robot charges straight at the cockpit, faster as it comes, and swerves in
    // the last quarter (D-141)
    const rush = thing.rush;
    if (rush < SWERVE_AT) {
      const charge = rush / SWERVE_AT;
      return waiting + (CHARGE_NEAR - waiting) * charge * charge;
    }
    return CHARGE_NEAR + (RUSH_NEAR - CHARGE_NEAR) * ((rush - SWERVE_AT) / (1 - SWERVE_AT));
  }
  /** The side a robot swerves to: away from the middle; the middle lane has its own (D-141). */
  sideOf(thing) {
    return thing.laneX === 0 ? thing.side || 1 : Math.sign(thing.laneX);
  }
  /** How far into its swerve a robot is, 0 to 1 (0 while it charges straight). */
  swerveOf(thing) {
    return thing.rush > SWERVE_AT ? (thing.rush - SWERVE_AT) / (1 - SWERVE_AT) : 0;
  }
  /** Its lane, drifting outward while it rushes, so that it passes beside Elena (D-125). */
  laneOf(thing) {
    if (thing.frozen) return thing.frozen.lane;
    if (!thing.rush) return thing.laneX;
    const swerve = this.swerveOf(thing); // straight down its lane, then a sharp curve outward
    return thing.laneX + this.sideOf(thing) * RUSH_DRIFT * swerve * swerve;
  }
  /** Where a robot or the boss is drawn: { x, y (its feet, in world pixels; it bobs by a pixel
   * every 8 ticks), h (its height there), z }. `heightAtGlass` is its height at z = 1. */
  onScreen(thing, tick, heightAtGlass) {
    const z = this.depthOf(thing, tick),
      feet = this.road.project(this.laneOf(thing), z),
      bob = Math.floor((tick + thing.laneX) / 8) % 2;
    return { x: feet.x, y: feet.y - bob, h: heightAtGlass / z, z };
  }
  /** What the missiles ask of their target at each tick: a function giving the middle of the
   * robot or the boss as { X, H, D, vD } at the battle's tick (missiles.js). */
  targetOf(thing, heightAtGlass) {
    return () => {
      const z = this.depthOf(thing, this.now),
        moving = z > thing.zEnd;
      return {
        X: this.laneOf(thing),
        H: heightAtGlass * 0.5,
        D: z * KZ,
        vD: moving ? -thing.speed * KZ : 0,
      };
    };
  }
  /** A small burst where a missile arrived, up to 3 pixels off by chance. */
  boomAt(target, tick, radius) {
    const at = this.road.project3(target.X, target.H, target.D / KZ);
    this.booms.push({
      x: at.x + (Math.random() - 0.5) * 6,
      y: at.y + (Math.random() - 0.5) * 6,
      t0: tick,
      r: radius,
    });
  }

  /** The corner of this press's missiles, and the next one's the other (D-136). */
  nextSide() {
    const side = this.pressSide;
    this.pressSide = -side;
    return side;
  }

  /** Elena raises her fist or hits the launch button, in turn, at every press (D-41, D-45). */
  elenaFires(tick) {
    if (this.poseTurn++ % 2) this.pressAt = tick;
    else {
      this.pose = "fist";
      this.poseUntil = tick + 16;
    }
  }

  /** Elena's call by the console (ST-05): a new one replaces the one still shown (D-81). */
  say(text, tick) {
    this.shout = { sprite: textSprite(text, 24, "Misaki Mincho"), t0: tick };
  }

  /**
   * A hit (ST-05): a volley of three at the target's enemy. When the first missile arrives,
   * `onHit(tick)` is called and the enemy stops and flashes; 4 ticks later (in tick()) it and its
   * sign shatter with a small burst (D-81, D-95). From the shot to that burst the enemy belongs
   * to its missiles (`aimed`): it does not pass by, leave or meet the lever's explosion (D-149).
   * Returns false when the enemy is not on the road (it has not come yet, or it is gone) or a
   * volley is already on its way to it.
   */
  shoot(id, tick, onHit) {
    const enemy = this.enemyOf(id);
    if (!enemy || enemy.aimed) return false;
    enemy.aimed = true;
    this.elenaFires(tick);
    this.missiles.smoke = this.smoke();
    this.missiles.volley({
      count: 3,
      side: this.nextSide(), // from the left and the right in turn (D-136)
      tick,
      guided: 10, // the missiles meet the robot where it is now, even while it rushes (D-130)
      target: this.targetOf(enemy, ENEMY_HEIGHT),
      onHit: (hitTick) => {
        // the robot stops where it is, flashes for 4 ticks, then explodes and is gone (D-130)
        enemy.frozen = { z: this.depthOf(enemy, hitTick), lane: this.laneOf(enemy) };
        enemy.stopAt = hitTick;
        this.sfx("hit");
        onHit && onHit(hitTick);
      },
      onEachHit: (target, hitTick) => this.boomAt(target, hitTick, 5),
    });
    return true;
  }

  /** A press outside every window (ST-29): one missile flies into the sky and misses. */
  miss(tick) {
    this.elenaFires(tick);
    this.missiles.smoke = this.smoke();
    const aimX = (Math.random() - 0.5) * 120;
    this.missiles.volley({
      count: 1,
      side: this.nextSide(),
      tick,
      target: () => ({ X: aimX, H: 160, D: 12 * KZ, vD: 0 }),
    });
    this.sfx("miss");
  }

  /**
   * The lever's explosion reaches the road (D-128): the `level` nearest robots are destroyed by
   * the blast (not counted), and the others rush past the cockpit over 20 ticks and are gone.
   * A robot that was shot is left to its missile (D-149). Returns the ids of the robots it
   * reached.
   */
  blastRoad(level, tick) {
    const standing = this.standing().filter((enemy) => tick >= enemy.born && !enemy.aimed);
    standing.sort((one, other) => this.depthOf(one, tick) - this.depthOf(other, tick));
    standing.forEach((enemy, rank) => {
      if (rank < level) {
        const at = this.onScreen(enemy, tick, ENEMY_HEIGHT);
        enemy.alive = false;
        enemy.shatterAt = tick + rank * 3;
        this.booms.push({
          x: at.x,
          y: at.y - at.h * 0.5,
          t0: tick + rank * 3,
          r: Math.max(8, at.h * 0.35),
        });
      } else enemy.forcedAt = tick;
    });
    return standing.map((enemy) => enemy.id);
  }

  /** Enemies leave over the cockpit, spinning, and are not counted (ST-30). `ids` null: all. One
   * that was shot does not leave: its missile is on its way (D-149). */
  leave(ids, tick) {
    for (const enemy of this.enemies)
      if (enemy.alive && !enemy.leftAt && !enemy.aimed && (!ids || ids.includes(enemy.id))) {
        enemy.leftAt = tick;
        enemy.leaveFrom = this.onScreen(enemy, tick, ENEMY_HEIGHT);
      }
  }

  // ---------------------------------------------------------------- the boss (D-102, ST-35)
  /** The boss sets out with `hp` hit points; it stands before the glass after 5 s. */
  bossComes(tick, hp) {
    if (!this.sprites.boss) return;
    this.boss = {
      laneX: 0,
      z0: 11,
      zEnd: 3.4,
      born: tick,
      speed: 0.05,
      alive: true,
      hp,
      hpMax: Math.max(hp, 1),
      hitAt: -99,
      gone: null,
    };
  }
  /** One missile at the boss with a heavier burst; when it arrives the boss loses one hit point,
   * and at 0 it falls (`onFall()`). */
  bossHit(tick, onFall) {
    const boss = this.boss;
    if (!boss || !boss.alive || boss.gone) return;
    this.missiles.volley({
      count: 1,
      side: Math.random() < 0.5 ? -1 : 1,
      tick: tick + 2,
      target: this.targetOf(boss, BOSS_HEIGHT),
      onHit: () => {},
      onEachHit: (target, hitTick) => {
        this.boomAt(target, hitTick, 12);
        this.sfx("boss_hit");
        boss.hitAt = hitTick;
        boss.hp = Math.max(0, boss.hp - 1);
        if (boss.hp === 0) this.bossFalls(hitTick, onFall);
      },
    });
  }
  /** Take `n` hit points at once (the chapter-end explosion, D-102). */
  bossBlast(n, tick, onFall) {
    const boss = this.boss;
    if (!boss || !boss.alive || boss.gone || n <= 0) return;
    boss.hitAt = tick;
    boss.hp = Math.max(0, boss.hp - n);
    if (boss.hp === 0) this.bossFalls(tick, onFall);
  }
  /** The boss is out of hit points: six bursts across it, its sound, and `onFall()`; once. */
  bossFalls(tick, onFall) {
    const boss = this.boss;
    if (!boss.alive) return;
    boss.alive = false;
    boss.deadAt = tick;
    const at = this.onScreen(boss, tick, BOSS_HEIGHT);
    for (let k = 0; k < 6; k++)
      this.booms.push({
        x: at.x + (k - 2.5) * 10,
        y: at.y - at.h * (0.3 + 0.1 * (k % 3)),
        t0: tick + k * 4,
        r: 26,
      });
    this.sfx("boss_fall");
    onFall && onFall();
  }
  /** The boss leaves with hit points left: into the distance, or spinning away (D-102). */
  bossLeaves(tick, spinning) {
    if (this.boss && this.boss.alive) this.boss.gone = { t0: tick, spinning };
  }

  /** One tick: a hit robot explodes after its flash, the robots sent off by the lever's explosion
   * rush, the missiles fly, and what is over (bursts, the shout, robots that left or were
   * destroyed) is dropped. */
  tick(tick) {
    this.now = tick;
    for (const enemy of this.enemies)
      if (enemy.frozen && enemy.alive && tick - enemy.stopAt >= HIT_FLASH_TICKS) {
        const at = this.onScreen(enemy, tick, ENEMY_HEIGHT);
        enemy.alive = false;
        enemy.shatterAt = tick;
        this.booms.push({ x: at.x, y: at.y - at.h * 0.5, t0: tick, r: Math.max(8, at.h * 0.3) });
      }
    // robots sent away by the lever's explosion rush in 20 ticks (D-128)
    for (const enemy of this.enemies)
      if (enemy.forcedAt !== undefined && enemy.alive && !enemy.leftAt) {
        const through = (tick - enemy.forcedAt) / 20;
        if (through >= 1) {
          enemy.alive = false;
          enemy.passed = true;
        } else enemy.rush = Math.max(enemy.rush, through);
      }
    this.missiles.tick(tick);
    this.booms = this.booms.filter((boom) => tick - boom.t0 <= 11);
    if (this.shout && tick - this.shout.t0 > SHOUT_TICKS) this.shout = null;
    this.enemies = this.enemies.filter(
      (enemy) =>
        (enemy.alive && !enemy.leftAt) ||
        (enemy.leftAt && tick - enemy.leftAt <= LEAVE_TICKS) ||
        (!enemy.alive && !enemy.passed && tick - enemy.shatterAt <= 8),
    );
  }

  /**
   * A Kommy robot from its relief turn: 96 frames of one turn, frame 0 facing the user. Standing
   * and charging, it faces the user; swerving, it turns a quarter toward the side it goes to
   * (D-141). Scaled to its depth with hard pixels.
   */
  drawRobot(ctx, enemy, at, tick) {
    const turn = this.sprites.kommyTurn;
    if (!turn) return this.drawSprite(ctx, this.sprites.kommy, at.x, at.y, at.h * 1.05);
    const { img: sheet, meta } = turn;
    let frame = 0;
    if (enemy.frozen) frame = enemy.frozenFrame ?? (enemy.frozenFrame = enemy.lastFrame || 0);
    else if (enemy.rush) {
      // frame 24 shows its left side (it heads to the user's left), frame 72 its right
      const quarter = meta.frames / 4;
      frame = Math.round(-this.sideOf(enemy) * quarter * Math.min(1, this.swerveOf(enemy) * 1.5));
    }
    frame = ((frame % meta.frames) + meta.frames) % meta.frames;
    enemy.lastFrame = frame;
    // the cell is a little taller than the robot
    const height = Math.max(4, Math.round(at.h * 1.25)),
      width = Math.round((height * meta.w) / meta.h);
    const smooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      sheet,
      (frame % meta.cols) * meta.w,
      Math.floor(frame / meta.cols) * meta.h,
      meta.w,
      meta.h,
      Math.round(at.x - width / 2),
      Math.round(at.y - height),
      width,
      height,
    );
    ctx.imageSmoothingEnabled = smooth;
  }

  /** Draw a ladder sprite at the size nearest to `height`, standing on (centerX, footY); with an
   * angle, turned about its middle. */
  drawSprite(ctx, sprite, centerX, footY, height, angle = 0) {
    const cell = ladderCell(sprite.meta, height);
    if (!angle) {
      ctx.drawImage(
        sprite.img,
        cell.x,
        sprite.meta.H - cell.h,
        cell.w,
        cell.h,
        Math.round(centerX - cell.w / 2),
        Math.round(footY - cell.h),
        cell.w,
        cell.h,
      );
      return;
    }
    ctx.save();
    ctx.translate(Math.round(centerX), Math.round(footY - cell.h / 2));
    ctx.rotate(angle);
    ctx.drawImage(
      sprite.img,
      cell.x,
      sprite.meta.H - cell.h,
      cell.w,
      cell.h,
      -Math.round(cell.w / 2),
      -Math.round(cell.h / 2),
      cell.w,
      cell.h,
    );
    ctx.restore();
  }

  /** The enemies and the boss (the farthest first), the missiles and the bursts, on a world
   * layer. It also notes where each robot and the boss were drawn (`screen`), which drawSigns
   * reads: call it before drawSigns in a tick. */
  drawWorld(ctx, tick) {
    const { sprites, boss } = this;
    const things = [];
    if (boss && (boss.alive || tick - boss.deadAt < 12))
      things.push({ boss: true, z: this.depthOf(boss, tick) });
    for (const enemy of this.enemies)
      if (
        tick >= enemy.born &&
        !enemy.passed &&
        (enemy.alive || (!enemy.alive && tick - enemy.shatterAt < 3))
      )
        things.push({ enemy, z: enemy.leftAt ? 0.5 : this.depthOf(enemy, tick) });
    things.sort((one, other) => other.z - one.z);
    for (const thing of things) {
      if (thing.boss) this.drawBoss(ctx, tick);
      else {
        const enemy = thing.enemy;
        if (enemy.leftAt) {
          // over the cockpit: up and to the side, larger as it comes near, spinning (ST-30, D-82)
          const age = (tick - enemy.leftAt) / LEAVE_TICKS,
            from = enemy.leaveFrom,
            x = from.x + (from.x < 213 ? -1 : 1) * age * 160,
            y = from.y - age * 220,
            h = from.h * (1 + age * 1.6);
          this.drawSprite(ctx, sprites.kommy, x, y, h, ((tick - enemy.leftAt) / 8) * Math.PI * 2);
          enemy.screen = null;
        } else if (enemy.alive) {
          const at = this.onScreen(enemy, tick, ENEMY_HEIGHT);
          // a hit robot flashes, shown every other tick (D-130)
          if (!(enemy.frozen && (tick - enemy.stopAt) % 2)) this.drawRobot(ctx, enemy, at, tick);
          enemy.screen = at;
        }
      }
    }
    this.missiles.draw(ctx, tick);
    this.drawBooms(ctx, tick);
  }

  /** The small bursts: a ring of 12 squares that grows and fades through four colors in 12 ticks,
   * with a square in the middle for the first 4. */
  drawBooms(ctx, tick) {
    for (const boom of this.booms) {
      const age = tick - boom.t0;
      if (age < 0 || age > 11) continue;
      const radius = boom.r * BOOM_RADII[age];
      ctx.fillStyle = age < 3 ? "#ffffff" : age < 6 ? "#ffcf3f" : age < 9 ? "#e0603a" : "#6a4a50";
      for (let k = 0; k < 12; k++) {
        const angle = k * 0.52 + age * 0.15;
        ctx.fillRect(
          Math.round(boom.x + Math.cos(angle) * radius) - 2,
          Math.round(boom.y + Math.sin(angle) * radius * 0.8) - 2,
          4,
          4,
        );
      }
      if (age < 4) ctx.fillRect(Math.round(boom.x) - 3, Math.round(boom.y) - 3, 6, 6);
    }
  }

  /** The boss: standing, hidden for 2 ticks when hit (a blink), sinking when it has fallen, and
   * leaving for 30 ticks (into the distance, or spinning away to the upper right). */
  drawBoss(ctx, tick) {
    const boss = this.boss;
    let at = this.onScreen(boss, tick, BOSS_HEIGHT),
      angle = 0;
    if (boss.gone) {
      const age = (tick - boss.gone.t0) / 30;
      if (age >= 1) return;
      if (boss.gone.spinning) {
        at = { ...at, x: at.x + age * 180, y: at.y - age * 200, h: at.h * (1 + age) };
        angle = age * Math.PI * 4;
      } else at = { ...at, y: at.y - age * 20, h: at.h * (1 - age * 0.8) };
    }
    const sink = boss.alive ? 0 : (tick - boss.deadAt) * 4;
    if (tick - boss.hitAt >= 2)
      this.drawSprite(ctx, this.sprites.boss, at.x, at.y + sink, at.h, angle);
    boss.screen = boss.alive && !boss.gone ? at : null;
  }

  /** The cockpit and Elena from behind (D-39), as in the test scene, except that the launch button
   * and the pressing hand moved to the right (D-104), so that 「爆発」 has the left. `typing`: the
   * song is running, so her hands step in turn. A press: the right hand reaches onto the button. */
  drawCockpit(ctx, tick, typing, seated = true) {
    const { sprites, road } = this;
    ctx.save();
    ctx.translate(213, 120);
    ctx.rotate(-road.tilt * 0.05);
    ctx.scale(1.1, 1.1);
    ctx.translate(-213, -120);
    ctx.drawImage(sprites.cockpit, 0, 0);
    if (!seated) {
      ctx.restore();
      return; // Elena has not boarded yet (D-97); no caller asks for this today
    }
    const posed =
        tick < this.poseUntil && sprites.elena[this.pose]
          ? sprites.elena[this.pose]
          : sprites.elena.back,
      place = posed.meta,
      breathe = Math.floor(tick / 24) % 2,
      keys = posed === sprites.elena.back && typing,
      beat = Math.floor(tick / 3) % 2,
      sway = Math.round(road.swayX);
    ctx.translate(213, 240);
    ctx.rotate(-road.swayX * 0.004);
    ctx.translate(-213, -240);
    const pressAge = tick - this.pressAt,
      reach = pressAge >= 0 && pressAge < 10 ? PRESS_REACH[pressAge] : 0;
    // (the button her right hand reaches for is the blue missile that cockpit.js draws, D-126)
    ctx.drawImage(posed.body, place.body[0] + sway, place.body[1] + breathe);
    ctx.drawImage(posed.l, place.hand_l[0] + sway, place.hand_l[1] + (keys && beat ? -1 : 0));
    const rightY = place.hand_r[1] + reach + (keys && !beat && !reach ? -1 : 0);
    if (reach < 0) {
      // reaching forward: the wrist stretches, so the hand never parts from the sleeve
      const width = posed.r.width,
        height = posed.r.height,
        wrist = 5;
      ctx.drawImage(
        posed.r,
        0,
        height - wrist,
        width,
        wrist,
        place.hand_r[0] + sway,
        rightY + height - wrist,
        width,
        wrist - reach,
      );
    }
    ctx.drawImage(posed.r, place.hand_r[0] + sway, rightY);
    ctx.restore();
  }

  /** Each standing enemy's noun as a sign over its head once it is near enough to read; the
   * enemy whose window is open wears targeting brackets (ST-28); and the boss's hit points.
   * `open` is a Set of ids. Drawn on the text layer: one world pixel is two text pixels, hence
   * the `* 2`. */
  drawSigns(ctx, open = new Set(), tick = 0) {
    const placed = [];
    const readable = this.enemies
      .filter(
        (enemy) =>
          enemy.sign && enemy.alive && !enemy.leftAt && enemy.screen && enemy.screen.h >= 30,
      )
      .sort((one, other) => other.screen.z - one.screen.z);
    for (const enemy of readable) {
      const at = enemy.screen,
        x = Math.round(at.x * 2 - enemy.sign.w / 2);
      let y = Math.round((at.y - at.h) * 2 - enemy.sign.h - 4);
      for (const box of placed)
        if (
          x < box.x + box.w + 8 &&
          box.x < x + enemy.sign.w + 8 &&
          Math.abs(y - box.y) < box.h + 4
        )
          y = box.y - enemy.sign.h - 6;
      placed.push({ x, y, w: enemy.sign.w, h: enemy.sign.h });
      ctx.fillStyle = "#1d1a2e";
      ctx.fillRect(x - 3, y - 1, enemy.sign.w + 6, enemy.sign.h + 2);
      ctx.fillStyle = "#7fe0ff";
      ctx.fillRect(x - 3, y - 1, enemy.sign.w + 6, 1);
      ctx.fillRect(x - 3, y + enemy.sign.h, enemy.sign.w + 6, 1);
      drawOutlined(ctx, enemy.sign.fill, enemy.sign.ink, x, y);
      if (open.has(enemy.id)) this.drawBrackets(ctx, at, tick);
    }
    const boss = this.boss;
    if (boss && boss.screen && boss.hpMax) this.drawHp(ctx, boss);
  }
  /** Four corner brackets around a robot that can be shot now, on the text layer; they pulse
   * every 4 ticks. */
  drawBrackets(ctx, at, tick) {
    const pulse = Math.floor(tick / 4) % 2 ? 2 : 0,
      w = Math.round(at.h * 1.4) + pulse * 2,
      h = Math.round(at.h * 2) + pulse * 2,
      x = Math.round(at.x * 2 - w / 2),
      y = Math.round((at.y - at.h) * 2 - pulse),
      arm = 8;
    ctx.fillStyle = "#ff5f7a";
    for (const [cornerX, cornerY, dx, dy] of [
      [x, y, 1, 1],
      [x + w, y, -1, 1],
      [x, y + h, 1, -1],
      [x + w, y + h, -1, -1],
    ]) {
      ctx.fillRect(dx > 0 ? cornerX : cornerX - arm, cornerY - (dy > 0 ? 0 : 2), arm, 2);
      ctx.fillRect(cornerX - (dx > 0 ? 0 : 2), dy > 0 ? cornerY : cornerY - arm, 2, arm);
    }
  }
  /** The boss's hit points: a bar of cells over it (ST-35). */
  drawHp(ctx, boss) {
    const at = boss.screen,
      cell = 12,
      gap = 2,
      width = boss.hpMax * (cell + gap) - gap,
      x = Math.round(at.x * 2 - width / 2),
      y = Math.round((at.y - at.h) * 2 - 16);
    ctx.fillStyle = "#1d1a2e";
    ctx.fillRect(x - 2, y - 2, width + 4, 12);
    for (let k = 0; k < boss.hpMax; k++) {
      ctx.fillStyle = k < boss.hp ? "#ff5f7a" : "#3a3040";
      ctx.fillRect(x + k * (cell + gap), y, cell, 8);
    }
  }

  /** Elena's call, rising a little, at the left of the glass. */
  drawShouts(ctx, tick) {
    const shout = this.shout;
    if (!shout) return;
    const age = tick - shout.t0;
    // above the bomb at the lower left (D-104), clear of 「爆発」 and of the caption
    drawOutlined(ctx, shout.sprite.fill, shout.sprite.ink, 28, 286 - Math.min(6, age));
  }
}
