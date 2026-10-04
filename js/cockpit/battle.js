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

// at z = 1, in world pixels
const ENEMY_HEIGHT = 88;
const BOSS_HEIGHT = 170;

const SHOUT_TICKS = 36; // a shout stays 1.2 s (§6.4)
const LEAVE_TICKS = 30; // a robot sent away passes over the cockpit in 1 s (ST-30)

// the ring of a small burst at each of its 12 ticks, as a share of its radius
const BOOM_RADII = [0.3, 0.6, 0.85, 1, 1.05, 1.05, 1, 0.9, 0.75, 0.55, 0.35, 0.2];

const LANES = [-46, 0, 46]; // left, middle, right

// a robot that is hit stops and flashes this long before it explodes
const HIT_FLASH_TICKS = 4;

// the depth at which a rushing robot passes beside Elena (D-125)
const RUSH_NEAR = 0.45;

// where its straight charge ends and the swerve begins (D-141)
const CHARGE_NEAR = 0.7;

const SWERVE_AT = 0.75; // the part of the window spent charging straight

// how far it moves to the side of its lane while it rushes
const RUSH_DRIFT = 120;

// how far the right hand reaches forward (up on the screen) in each tick of a button press
const PRESS_REACH = [-3, -7, -7, -7, -7, -7, -5, -3, -1, 0];

export class Battle {
  /** `sprites`: {cockpit, elena: {back, fist}, kommy, kommyTurn (the robot's turn sheet, or
   * null), boss (or null), missiles}; kommy, boss and the missiles are ladders (one picture in
   * several sizes, pixel.js). `sfx(name)` plays a sound. `smoke()`: whether missiles leave a
   * wake. */
  constructor({ road, sprites, sfx = () => {}, smoke = () => true }) {
    const given = {
      road,
      sprites,
      sfx,
      smoke,
    };
    Object.assign(this, given);

    const missileParts = {
      project: (X, H, z) => road.project3(X, H, z),
      ladders: sprites.missiles,
      sfx: () => sfx("launch"),
    };
    this.missiles = new Missiles(missileParts);

    // how many robots were sent: the next takes the lane after the last one's
    this.lane = 0;

    // the corner the next volley comes from: left, then right, in turn (D-136)
    this.pressSide = -1;

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
    const z0 = 11;

    const standingCount = this.standing().length;
    const zEnd = 2.2 + 0.15 * (standingCount % 6);

    const ticksToCome = Math.max(8, inTicks - 4);
    const speedToBeInTime = (z0 - zEnd) / ticksToCome;
    const speed = Math.max(0.07, speedToBeInTime);

    const laneX = LANES[this.lane % LANES.length];
    this.lane++;

    let sign = null;
    if (label) {
      sign = textSprite(label, 16, "DotGothic16");
    }

    const side = this.lane % 2 ? 1 : -1;

    // a robot: laneX (its lane, in pixels from the middle at z = 1), z0 and zEnd (where it sets
    // out and where it stands), born (the tick it was sent), speed (z a tick), sign (its noun);
    // aimed (shot: its missiles are on their way, and until they arrive it does not pass by,
    // leave or meet the lever's explosion, D-149);
    // later: frozen and stopAt (hit: where and when), shatterAt (destroyed), leftAt and leaveFrom
    // (sent away), forcedAt (rushing after the lever's explosion), passed (gone by, uncounted)
    const enemy = {
      id,
      laneX,
      z0,
      zEnd,
      born: tick,
      speed,
      sign,
      alive: true,
      aimed: false,
      leftAt: null,
      rush: 0, // 0 to 1 through its window (D-125); set by the cockpit
      side,
    };
    this.enemies.push(enemy);
  }

  /** Where each robot is in its window: `progress` maps an enemy id to a value under 0 before
   * the window opens, 0..1 while it is open, and 1 or more once it has closed. A robot past its
   * window has gone by Elena, uncounted; one that was shot stays at the end of its rush for its
   * missile (D-149). */
  setRush(progress) {
    for (const enemy of this.enemies) {
      const outOfTheRush = !enemy.alive || enemy.leftAt || enemy.frozen;
      if (outOfTheRush) {
        continue;
      }

      const through = progress.get(enemy.id);
      if (through === undefined) {
        continue;
      }

      const windowClosed = through >= 1;
      if (windowClosed && !enemy.aimed) {
        enemy.alive = false;
        enemy.passed = true; // ST-30: not counted
      } else {
        const fromZero = Math.max(0, through);
        const inWindow = Math.min(1, fromZero);
        enemy.rush = Math.max(enemy.rush, inWindow);
      }
    }
  }

  /** The enemy of a target, if it is still on the road. */
  enemyOf(id) {
    const found = this.enemies.find((enemy) => {
      const onRoad = enemy.alive && !enemy.leftAt;
      return enemy.id === id && onRoad;
    });

    return found || null;
  }

  /** The depth z of a robot or of the boss at a tick: coming from z0 to zEnd at its speed; a
   * robot in its window charges at the cockpit from there; one that is hit stays where it was. */
  depthOf(thing, tick) {
    if (thing.frozen) {
      return thing.frozen.z; // hit: it stops where it is (D-130)
    }

    const ticksOnTheWay = Math.max(0, tick - thing.born);
    const come = ticksOnTheWay * thing.speed;
    const waiting = Math.max(thing.zEnd, thing.z0 - come);

    if (!thing.rush) {
      return waiting;
    }

    // in its window the robot charges straight at the cockpit, faster as it comes, and swerves in
    // the last quarter (D-141)
    const rush = thing.rush;
    if (rush < SWERVE_AT) {
      const charge = rush / SWERVE_AT;
      const toChargeEnd = CHARGE_NEAR - waiting;
      return waiting + toChargeEnd * charge * charge;
    }

    const swerve = (rush - SWERVE_AT) / (1 - SWERVE_AT);
    const toRushEnd = RUSH_NEAR - CHARGE_NEAR;
    return CHARGE_NEAR + toRushEnd * swerve;
  }
  /** The side a robot swerves to: away from the middle; the middle lane has its own (D-141). */
  sideOf(thing) {
    if (thing.laneX === 0) {
      return thing.side || 1;
    }
    return Math.sign(thing.laneX);
  }
  /** How far into its swerve a robot is, 0 to 1 (0 while it charges straight). */
  swerveOf(thing) {
    if (thing.rush > SWERVE_AT) {
      return (thing.rush - SWERVE_AT) / (1 - SWERVE_AT);
    }
    return 0;
  }
  /** Its lane, drifting outward while it rushes, so that it passes beside Elena (D-125). */
  laneOf(thing) {
    if (thing.frozen) {
      return thing.frozen.lane;
    }
    if (!thing.rush) {
      return thing.laneX;
    }

    // straight down its lane, then a sharp curve outward
    const swerve = this.swerveOf(thing);
    const side = this.sideOf(thing);
    const drift = side * RUSH_DRIFT * swerve * swerve;
    return thing.laneX + drift;
  }
  /** Where a robot or the boss is drawn: { x, y (its feet, in world pixels; it bobs by a pixel
   * every 8 ticks), h (its height there), z }. `heightAtGlass` is its height at z = 1. */
  onScreen(thing, tick, heightAtGlass) {
    const z = this.depthOf(thing, tick);
    const lane = this.laneOf(thing);
    const feet = this.road.project(lane, z);

    const bobStep = Math.floor((tick + thing.laneX) / 8);
    const bob = bobStep % 2;

    return {
      x: feet.x,
      y: feet.y - bob,
      h: heightAtGlass / z,
      z,
    };
  }
  /** What the missiles ask of their target at each tick: a function giving the middle of the
   * robot or the boss as { X, H, D, vD } at the battle's tick (missiles.js). */
  targetOf(thing, heightAtGlass) {
    return () => {
      const z = this.depthOf(thing, this.now);
      const moving = z > thing.zEnd;
      const lane = this.laneOf(thing);

      let depthSpeed = 0;
      if (moving) {
        depthSpeed = -thing.speed * KZ;
      }

      return {
        X: lane,
        H: heightAtGlass * 0.5,
        D: z * KZ,
        vD: depthSpeed,
      };
    };
  }
  /** A small burst where a missile arrived, up to 3 pixels off by chance. */
  boomAt(target, tick, radius) {
    const z = target.D / KZ;
    const at = this.road.project3(target.X, target.H, z);

    const offX = (Math.random() - 0.5) * 6;
    const offY = (Math.random() - 0.5) * 6;

    const boom = {
      x: at.x + offX,
      y: at.y + offY,
      t0: tick,
      r: radius,
    };
    this.booms.push(boom);
  }

  /** The corner of this press's missiles, and the next one's the other (D-136). */
  nextSide() {
    const side = this.pressSide;
    this.pressSide = -side;
    return side;
  }

  /** Elena raises her fist or hits the launch button, in turn, at every press (D-41, D-45). */
  elenaFires(tick) {
    const buttonTurn = this.poseTurn % 2;
    this.poseTurn++;

    if (buttonTurn) {
      this.pressAt = tick;
    } else {
      this.pose = "fist";
      this.poseUntil = tick + 16;
    }
  }

  /** Elena's call by the console (ST-05): a new one replaces the one still shown (D-81). */
  say(text, tick) {
    const sprite = textSprite(text, 24, "Misaki Mincho");
    this.shout = {
      sprite,
      t0: tick,
    };
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
    if (!enemy) {
      return false;
    }
    if (enemy.aimed) {
      return false;
    }

    enemy.aimed = true;
    this.elenaFires(tick);
    this.missiles.smoke = this.smoke();

    // from the left and the right in turn (D-136)
    const side = this.nextSide();
    const enemyMiddle = this.targetOf(enemy, ENEMY_HEIGHT);

    const volley = {
      count: 3,
      side,
      tick,
      // the missiles meet the robot where it is now, even while it rushes (D-130)
      guided: 10,
      target: enemyMiddle,
      onHit: (hitTick) => {
        // the robot stops where it is, flashes for 4 ticks, then explodes and is gone (D-130)
        const z = this.depthOf(enemy, hitTick);
        const lane = this.laneOf(enemy);
        enemy.frozen = { z, lane };
        enemy.stopAt = hitTick;

        this.sfx("hit");
        if (onHit) {
          onHit(hitTick);
        }
      },
      onEachHit: (target, hitTick) => this.boomAt(target, hitTick, 5),
    };
    this.missiles.volley(volley);

    return true;
  }

  /** A press outside every window (ST-29): one missile flies into the sky and misses. */
  miss(tick) {
    this.elenaFires(tick);
    this.missiles.smoke = this.smoke();

    const aimX = (Math.random() - 0.5) * 120;
    const side = this.nextSide();

    const volley = {
      count: 1,
      side,
      tick,
      target: () => ({
        X: aimX,
        H: 160,
        D: 12 * KZ,
        vD: 0,
      }),
    };
    this.missiles.volley(volley);

    this.sfx("miss");
  }

  /**
   * The lever's explosion reaches the road (D-128): the `level` nearest robots are destroyed by
   * the blast (not counted), and the others rush past the cockpit over 20 ticks and are gone.
   * A robot that was shot is left to its missile (D-149). Returns the ids of the robots it
   * reached.
   */
  blastRoad(level, tick) {
    const onRoad = this.standing();
    const standing = onRoad.filter((enemy) => {
      const hasSetOut = tick >= enemy.born;
      return hasSetOut && !enemy.aimed;
    });

    standing.sort((one, other) => {
      const oneDepth = this.depthOf(one, tick);
      const otherDepth = this.depthOf(other, tick);
      return oneDepth - otherDepth;
    });

    standing.forEach((enemy, rank) => {
      if (rank < level) {
        const at = this.onScreen(enemy, tick, ENEMY_HEIGHT);
        const burstTick = tick + rank * 3;

        enemy.alive = false;
        enemy.shatterAt = burstTick;

        const middleY = at.y - at.h * 0.5;
        const radius = Math.max(8, at.h * 0.35);
        const boom = {
          x: at.x,
          y: middleY,
          t0: burstTick,
          r: radius,
        };
        this.booms.push(boom);
      } else {
        enemy.forcedAt = tick;
      }
    });

    return standing.map((enemy) => enemy.id);
  }

  /** Enemies leave over the cockpit, spinning, and are not counted (ST-30). `ids` null: all. One
   * that was shot does not leave: its missile is on its way (D-149). */
  leave(ids, tick) {
    for (const enemy of this.enemies) {
      const canLeave = enemy.alive && !enemy.leftAt && !enemy.aimed;
      if (!canLeave) {
        continue;
      }

      if (!ids || ids.includes(enemy.id)) {
        enemy.leftAt = tick;
        enemy.leaveFrom = this.onScreen(enemy, tick, ENEMY_HEIGHT);
      }
    }
  }

  // ---------------------------------------------------------------- the boss (D-102, ST-35)
  /** The boss sets out with `hp` hit points; it stands before the glass after 5 s. */
  bossComes(tick, hp) {
    if (!this.sprites.boss) {
      return;
    }

    const hpMax = Math.max(hp, 1);
    this.boss = {
      laneX: 0,
      z0: 11,
      zEnd: 3.4,
      born: tick,
      speed: 0.05,
      alive: true,
      hp,
      hpMax,
      hitAt: -99,
      gone: null,
    };
  }
  /** One missile at the boss with a heavier burst; when it arrives the boss loses one hit point,
   * and at 0 it falls (`onFall()`). */
  bossHit(tick, onFall) {
    const boss = this.boss;
    if (!boss) {
      return;
    }
    if (!boss.alive || boss.gone) {
      return;
    }

    const side = Math.random() < 0.5 ? -1 : 1;
    const bossMiddle = this.targetOf(boss, BOSS_HEIGHT);

    const volley = {
      count: 1,
      side,
      tick: tick + 2,
      target: bossMiddle,
      onHit: () => {},
      onEachHit: (target, hitTick) => {
        this.boomAt(target, hitTick, 12);
        this.sfx("boss_hit");

        boss.hitAt = hitTick;
        boss.hp = Math.max(0, boss.hp - 1);
        if (boss.hp === 0) {
          this.bossFalls(hitTick, onFall);
        }
      },
    };
    this.missiles.volley(volley);
  }
  /** Take `n` hit points at once (the chapter-end explosion, D-102). */
  bossBlast(n, tick, onFall) {
    const boss = this.boss;
    if (!boss) {
      return;
    }
    if (!boss.alive || boss.gone) {
      return;
    }
    if (n <= 0) {
      return;
    }

    boss.hitAt = tick;
    boss.hp = Math.max(0, boss.hp - n);
    if (boss.hp === 0) {
      this.bossFalls(tick, onFall);
    }
  }
  /** The boss is out of hit points: six bursts across it, its sound, and `onFall()`; once. */
  bossFalls(tick, onFall) {
    const boss = this.boss;
    if (!boss.alive) {
      return;
    }

    boss.alive = false;
    boss.deadAt = tick;

    const at = this.onScreen(boss, tick, BOSS_HEIGHT);
    for (let k = 0; k < 6; k++) {
      const across = (k - 2.5) * 10;
      const heightShare = 0.3 + 0.1 * (k % 3);

      const boom = {
        x: at.x + across,
        y: at.y - at.h * heightShare,
        t0: tick + k * 4,
        r: 26,
      };
      this.booms.push(boom);
    }

    this.sfx("boss_fall");
    if (onFall) {
      onFall();
    }
  }
  /** The boss leaves with hit points left: into the distance, or spinning away (D-102). */
  bossLeaves(tick, spinning) {
    if (this.boss && this.boss.alive) {
      this.boss.gone = {
        t0: tick,
        spinning,
      };
    }
  }

  /** One tick: a hit robot explodes after its flash, the robots sent off by the lever's explosion
   * rush, the missiles fly, and what is over (bursts, the shout, robots that left or were
   * destroyed) is dropped. */
  tick(tick) {
    this.now = tick;

    for (const enemy of this.enemies) {
      const stopped = enemy.frozen && enemy.alive;
      if (!stopped) {
        continue;
      }

      const flashedTicks = tick - enemy.stopAt;
      if (flashedTicks >= HIT_FLASH_TICKS) {
        const at = this.onScreen(enemy, tick, ENEMY_HEIGHT);

        enemy.alive = false;
        enemy.shatterAt = tick;

        const middleY = at.y - at.h * 0.5;
        const radius = Math.max(8, at.h * 0.3);
        const boom = {
          x: at.x,
          y: middleY,
          t0: tick,
          r: radius,
        };
        this.booms.push(boom);
      }
    }

    // robots sent away by the lever's explosion rush in 20 ticks (D-128)
    for (const enemy of this.enemies) {
      const sentRushing = enemy.forcedAt !== undefined;
      const onRoad = enemy.alive && !enemy.leftAt;

      if (sentRushing && onRoad) {
        const through = (tick - enemy.forcedAt) / 20;
        if (through >= 1) {
          enemy.alive = false;
          enemy.passed = true;
        } else {
          enemy.rush = Math.max(enemy.rush, through);
        }
      }
    }

    this.missiles.tick(tick);

    this.booms = this.booms.filter((boom) => tick - boom.t0 <= 11);

    if (this.shout) {
      const shoutAge = tick - this.shout.t0;
      if (shoutAge > SHOUT_TICKS) {
        this.shout = null;
      }
    }

    this.enemies = this.enemies.filter((enemy) => {
      const onRoad = enemy.alive && !enemy.leftAt;

      const ticksGone = tick - enemy.leftAt;
      const stillLeaving = enemy.leftAt && ticksGone <= LEAVE_TICKS;

      const ticksShattered = tick - enemy.shatterAt;
      const stillShattering = !enemy.alive && !enemy.passed && ticksShattered <= 8;

      return onRoad || stillLeaving || stillShattering;
    });
  }

  /**
   * A Kommy robot from its relief turn: 96 frames of one turn, frame 0 facing the user. Standing
   * and charging, it faces the user; swerving, it turns a quarter toward the side it goes to
   * (D-141). Scaled to its depth with hard pixels.
   */
  drawRobot(ctx, enemy, at, tick) {
    const turn = this.sprites.kommyTurn;
    if (!turn) {
      const heightWithoutTurn = at.h * 1.05;
      return this.drawSprite(ctx, this.sprites.kommy, at.x, at.y, heightWithoutTurn);
    }

    const { img: sheet, meta } = turn;

    let frame = 0;
    if (enemy.frozen) {
      const keptFrame = enemy.frozenFrame;
      if (keptFrame === undefined || keptFrame === null) {
        enemy.frozenFrame = enemy.lastFrame || 0;
      }
      frame = enemy.frozenFrame;
    } else if (enemy.rush) {
      // frame 24 shows its left side (it heads to the user's left), frame 72 its right
      const quarter = meta.frames / 4;
      const side = this.sideOf(enemy);
      const swerve = this.swerveOf(enemy);
      const turned = Math.min(1, swerve * 1.5);
      frame = Math.round(-side * quarter * turned);
    }

    frame = ((frame % meta.frames) + meta.frames) % meta.frames;
    enemy.lastFrame = frame;

    // the cell is a little taller than the robot
    const cellHeight = Math.round(at.h * 1.25);
    const height = Math.max(4, cellHeight);
    const width = Math.round((height * meta.w) / meta.h);

    const cellLeft = (frame % meta.cols) * meta.w;
    const cellTop = Math.floor(frame / meta.cols) * meta.h;
    const left = Math.round(at.x - width / 2);
    const top = Math.round(at.y - height);

    const smooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sheet, cellLeft, cellTop, meta.w, meta.h, left, top, width, height);
    ctx.imageSmoothingEnabled = smooth;
  }

  /** Draw a ladder sprite at the size nearest to `height`, standing on (centerX, footY); with an
   * angle, turned about its middle. */
  drawSprite(ctx, sprite, centerX, footY, height, angle = 0) {
    const cell = ladderCell(sprite.meta, height);
    const cellTop = sprite.meta.H - cell.h;

    if (!angle) {
      const left = Math.round(centerX - cell.w / 2);
      const top = Math.round(footY - cell.h);
      ctx.drawImage(sprite.img, cell.x, cellTop, cell.w, cell.h, left, top, cell.w, cell.h);
      return;
    }

    const middleX = Math.round(centerX);
    const middleY = Math.round(footY - cell.h / 2);
    const left = -Math.round(cell.w / 2);
    const top = -Math.round(cell.h / 2);

    ctx.save();
    ctx.translate(middleX, middleY);
    ctx.rotate(angle);
    ctx.drawImage(sprite.img, cell.x, cellTop, cell.w, cell.h, left, top, cell.w, cell.h);
    ctx.restore();
  }

  /** The enemies and the boss (the farthest first), the missiles and the bursts, on a world
   * layer. It also notes where each robot and the boss were drawn (`screen`), which drawSigns
   * reads: call it before drawSigns in a tick. */
  drawWorld(ctx, tick) {
    const { sprites, boss } = this;
    const things = [];

    if (boss) {
      const justFallen = tick - boss.deadAt < 12;
      if (boss.alive || justFallen) {
        const z = this.depthOf(boss, tick);
        things.push({ boss: true, z });
      }
    }

    for (const enemy of this.enemies) {
      const hasSetOut = tick >= enemy.born;
      const justShattered = !enemy.alive && tick - enemy.shatterAt < 3;
      const toDraw = enemy.alive || justShattered;

      if (hasSetOut && !enemy.passed && toDraw) {
        let z;
        if (enemy.leftAt) {
          z = 0.5;
        } else {
          z = this.depthOf(enemy, tick);
        }
        things.push({ enemy, z });
      }
    }

    things.sort((one, other) => other.z - one.z);

    for (const thing of things) {
      if (thing.boss) {
        this.drawBoss(ctx, tick);
      } else {
        const enemy = thing.enemy;

        if (enemy.leftAt) {
          // over the cockpit: up and to the side, larger as it comes near, spinning (ST-30, D-82)
          const ticksGone = tick - enemy.leftAt;
          const age = ticksGone / LEAVE_TICKS;
          const from = enemy.leaveFrom;

          const side = from.x < 213 ? -1 : 1;
          const x = from.x + side * age * 160;
          const y = from.y - age * 220;

          const growth = 1 + age * 1.6;
          const h = from.h * growth;

          const angle = (ticksGone / 8) * Math.PI * 2;
          this.drawSprite(ctx, sprites.kommy, x, y, h, angle);
          enemy.screen = null;
        } else if (enemy.alive) {
          const at = this.onScreen(enemy, tick, ENEMY_HEIGHT);

          // a hit robot flashes, shown every other tick (D-130)
          const hiddenNow = enemy.frozen && (tick - enemy.stopAt) % 2;
          if (!hiddenNow) {
            this.drawRobot(ctx, enemy, at, tick);
          }
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
      if (age < 0 || age > 11) {
        continue;
      }

      const radius = boom.r * BOOM_RADII[age];

      if (age < 3) {
        ctx.fillStyle = "#ffffff";
      } else if (age < 6) {
        ctx.fillStyle = "#ffcf3f";
      } else if (age < 9) {
        ctx.fillStyle = "#e0603a";
      } else {
        ctx.fillStyle = "#6a4a50";
      }

      for (let k = 0; k < 12; k++) {
        const angle = k * 0.52 + age * 0.15;
        const squareX = boom.x + Math.cos(angle) * radius;
        const squareY = boom.y + Math.sin(angle) * radius * 0.8;

        const left = Math.round(squareX) - 2;
        const top = Math.round(squareY) - 2;
        ctx.fillRect(left, top, 4, 4);
      }

      if (age < 4) {
        const left = Math.round(boom.x) - 3;
        const top = Math.round(boom.y) - 3;
        ctx.fillRect(left, top, 6, 6);
      }
    }
  }

  /** The boss: standing, hidden for 2 ticks when hit (a blink), sinking when it has fallen, and
   * leaving for 30 ticks (into the distance, or spinning away to the upper right). */
  drawBoss(ctx, tick) {
    const boss = this.boss;
    let at = this.onScreen(boss, tick, BOSS_HEIGHT);
    let angle = 0;

    if (boss.gone) {
      const age = (tick - boss.gone.t0) / 30;
      if (age >= 1) {
        return;
      }

      if (boss.gone.spinning) {
        at = {
          ...at,
          x: at.x + age * 180,
          y: at.y - age * 200,
          h: at.h * (1 + age),
        };
        angle = age * Math.PI * 4;
      } else {
        const shrink = 1 - age * 0.8;
        at = {
          ...at,
          y: at.y - age * 20,
          h: at.h * shrink,
        };
      }
    }

    let sink = 0;
    if (!boss.alive) {
      sink = (tick - boss.deadAt) * 4;
    }

    const sinceHit = tick - boss.hitAt;
    if (sinceHit >= 2) {
      this.drawSprite(ctx, this.sprites.boss, at.x, at.y + sink, at.h, angle);
    }

    if (boss.alive && !boss.gone) {
      boss.screen = at;
    } else {
      boss.screen = null;
    }
  }

  /** The cockpit and Elena from behind (D-39), as in the test scene, except that the launch button
   * and the pressing hand moved to the right (D-104), so that 「爆発」 has the left. `typing`: the
   * song is running, so her hands step in turn. A press: the right hand reaches onto the button. */
  drawCockpit(ctx, tick, typing, seated = true) {
    const { sprites, road } = this;

    const lean = -road.tilt * 0.05;
    ctx.save();
    ctx.translate(213, 120);
    ctx.rotate(lean);
    ctx.scale(1.1, 1.1);
    ctx.translate(-213, -120);
    ctx.drawImage(sprites.cockpit, 0, 0);

    if (!seated) {
      ctx.restore();
      return; // Elena has not boarded yet (D-97); no caller asks for this today
    }

    let posed = sprites.elena.back;
    const raised = sprites.elena[this.pose];
    if (tick < this.poseUntil && raised) {
      posed = raised;
    }

    const place = posed.meta;
    const breathe = Math.floor(tick / 24) % 2;
    const keys = posed === sprites.elena.back && typing;
    const beat = Math.floor(tick / 3) % 2;
    const sway = Math.round(road.swayX);

    const swayLean = -road.swayX * 0.004;
    ctx.translate(213, 240);
    ctx.rotate(swayLean);
    ctx.translate(-213, -240);

    const pressAge = tick - this.pressAt;
    let reach = 0;
    if (pressAge >= 0 && pressAge < 10) {
      reach = PRESS_REACH[pressAge];
    }

    // (the button her right hand reaches for is the blue missile that cockpit.js draws, D-126)
    const bodyX = place.body[0] + sway;
    const bodyY = place.body[1] + breathe;
    ctx.drawImage(posed.body, bodyX, bodyY);

    let leftStep = 0;
    if (keys && beat) {
      leftStep = -1;
    }
    const leftX = place.hand_l[0] + sway;
    const leftY = place.hand_l[1] + leftStep;
    ctx.drawImage(posed.l, leftX, leftY);

    let rightStep = 0;
    if (keys && !beat && !reach) {
      rightStep = -1;
    }
    const rightX = place.hand_r[0] + sway;
    const rightY = place.hand_r[1] + reach + rightStep;

    if (reach < 0) {
      // reaching forward: the wrist stretches, so the hand never parts from the sleeve
      const width = posed.r.width;
      const height = posed.r.height;
      const wrist = 5;

      const wristInHand = height - wrist;
      const wristTop = rightY + height - wrist;
      const stretched = wrist - reach;
      ctx.drawImage(posed.r, 0, wristInHand, width, wrist, rightX, wristTop, width, stretched);
    }

    ctx.drawImage(posed.r, rightX, rightY);
    ctx.restore();
  }

  /** Each standing enemy's noun as a sign over its head once it is near enough to read; the
   * enemy whose window is open wears targeting brackets (ST-28); and the boss's hit points.
   * `open` is a Set of ids. Drawn on the text layer: one world pixel is two text pixels, hence
   * the `* 2`. */
  drawSigns(ctx, open = new Set(), tick = 0) {
    const placed = [];

    const readable = this.enemies.filter((enemy) => {
      const signOnRoad = enemy.sign && enemy.alive && !enemy.leftAt;
      return signOnRoad && enemy.screen && enemy.screen.h >= 30;
    });
    readable.sort((one, other) => other.screen.z - one.screen.z);

    for (const enemy of readable) {
      const at = enemy.screen;
      const x = Math.round(at.x * 2 - enemy.sign.w / 2);

      const headY = (at.y - at.h) * 2;
      let y = Math.round(headY - enemy.sign.h - 4);

      for (const box of placed) {
        const startsBeforeBoxEnds = x < box.x + box.w + 8;
        const boxStartsBeforeEnd = box.x < x + enemy.sign.w + 8;
        const nearInHeight = Math.abs(y - box.y) < box.h + 4;

        if (startsBeforeBoxEnds && boxStartsBeforeEnd && nearInHeight) {
          y = box.y - enemy.sign.h - 6;
        }
      }

      const signBox = {
        x,
        y,
        w: enemy.sign.w,
        h: enemy.sign.h,
      };
      placed.push(signBox);

      const plateLeft = x - 3;
      const plateTop = y - 1;
      const plateWidth = enemy.sign.w + 6;
      const plateHeight = enemy.sign.h + 2;
      const lowerLineTop = y + enemy.sign.h;

      ctx.fillStyle = "#1d1a2e";
      ctx.fillRect(plateLeft, plateTop, plateWidth, plateHeight);

      ctx.fillStyle = "#7fe0ff";
      ctx.fillRect(plateLeft, plateTop, plateWidth, 1);
      ctx.fillRect(plateLeft, lowerLineTop, plateWidth, 1);

      drawOutlined(ctx, enemy.sign.fill, enemy.sign.ink, x, y);

      if (open.has(enemy.id)) {
        this.drawBrackets(ctx, at, tick);
      }
    }

    const boss = this.boss;
    if (boss && boss.screen && boss.hpMax) {
      this.drawHp(ctx, boss);
    }
  }
  /** Four corner brackets around a robot that can be shot now, on the text layer; they pulse
   * every 4 ticks. */
  drawBrackets(ctx, at, tick) {
    const pulseOn = Math.floor(tick / 4) % 2;
    const pulse = pulseOn ? 2 : 0;

    const w = Math.round(at.h * 1.4) + pulse * 2;
    const h = Math.round(at.h * 2) + pulse * 2;
    const x = Math.round(at.x * 2 - w / 2);
    const y = Math.round((at.y - at.h) * 2 - pulse);
    const arm = 8;

    ctx.fillStyle = "#ff5f7a";

    const corners = [
      [x, y, 1, 1],
      [x + w, y, -1, 1],
      [x, y + h, 1, -1],
      [x + w, y + h, -1, -1],
    ];
    for (const [cornerX, cornerY, dx, dy] of corners) {
      const armGoesRight = dx > 0;
      const armGoesDown = dy > 0;

      let acrossLeft;
      if (armGoesRight) {
        acrossLeft = cornerX;
      } else {
        acrossLeft = cornerX - arm;
      }
      const acrossRaise = armGoesDown ? 0 : 2;
      ctx.fillRect(acrossLeft, cornerY - acrossRaise, arm, 2);

      const uprightShift = armGoesRight ? 0 : 2;
      let uprightTop;
      if (armGoesDown) {
        uprightTop = cornerY;
      } else {
        uprightTop = cornerY - arm;
      }
      ctx.fillRect(cornerX - uprightShift, uprightTop, 2, arm);
    }
  }
  /** The boss's hit points: a bar of cells over it (ST-35). */
  drawHp(ctx, boss) {
    const at = boss.screen;
    const cell = 12;
    const gap = 2;
    const pitch = cell + gap;

    const width = boss.hpMax * pitch - gap;
    const x = Math.round(at.x * 2 - width / 2);
    const y = Math.round((at.y - at.h) * 2 - 16);

    ctx.fillStyle = "#1d1a2e";
    ctx.fillRect(x - 2, y - 2, width + 4, 12);

    for (let k = 0; k < boss.hpMax; k++) {
      ctx.fillStyle = k < boss.hp ? "#ff5f7a" : "#3a3040";
      ctx.fillRect(x + k * pitch, y, cell, 8);
    }
  }

  /** Elena's call, rising a little, at the left of the glass. */
  drawShouts(ctx, tick) {
    const shout = this.shout;
    if (!shout) {
      return;
    }

    const age = tick - shout.t0;
    const rise = Math.min(6, age);

    // above the bomb at the lower left (D-104), clear of 「爆発」 and of the caption
    drawOutlined(ctx, shout.sprite.fill, shout.sprite.ink, 28, 286 - rise);
  }
}
