// The battle outside the glass and Elena at the controls (SPEC_dopa v3 §6.4, §6.6; ED D-39 to
// D-46, D-81, D-82, D-95, D-102, D-107, D-110, ST-05, ST-29, ST-30, ST-35). A separate piece: it
// knows the road's projection, its sprites and a sound hook, and nothing of the book.
//
// Taken from the battle of the accepted test scene (D-48): what an enemy, a volley, a burst, the
// shout and Elena's hands look like is unchanged. What changed: every enemy is the Kommy-type
// M.E.O.W (D-110) and carries one noun of the text as its sign; enemies come one at a time
// (send); a missed enemy leaves spinning over the cockpit (D-82); the boss has hit points (D-102).
import { drawOutlined, textSprite } from "./pixel.js";
import { ladderCell } from "./road.js";
import { KZ, Missiles } from "./missiles.js";

const ENEMY_HEIGHT = 88, // at z = 1, in world pixels
  BOSS_HEIGHT = 170;
const SHOUT_TICKS = 36; // a shout stays 1.2 s (§6.4)
const LEAVE_TICKS = 30; // a missed enemy passes over the cockpit in 1 s (ST-30)
const BOOM_RADII = [0.3, 0.6, 0.85, 1, 1.05, 1.05, 1, 0.9, 0.75, 0.55, 0.35, 0.2];
const LANES = [-46, 0, 46]; // left, middle, right
const HIT_FLASH_TICKS = 4; // a robot that is hit stops and flashes this long before it explodes
const RUSH_NEAR = 0.45; // the depth at which a rushing robot passes beside Elena (D-125)
const CHARGE_NEAR = 0.7; // where its straight charge ends and the swerve begins (D-141)
const SWERVE_AT = 0.75; // the part of the window spent charging straight
const RUSH_DRIFT = 120; // how far it moves to the side of its lane while it rushes
// how far the left hand reaches forward (up on the screen) in each tick of a button press
const PRESS_REACH = [-3, -7, -7, -7, -7, -7, -5, -3, -1, 0];

export class Battle {
  /** `sprites`: {cockpit, elena: {back, fist, button}, kommy, boss, button: {up, pressed, lit},
   * missiles}. `sfx(name)` plays a sound. `smoke()`: whether missiles leave a wake. */
  constructor({ road, sprites, sfx = () => {}, smoke = () => true }) {
    Object.assign(this, { road, sprites, sfx, smoke });
    this.missiles = new Missiles({
      project: (X, H, z) => road.project3(X, H, z),
      ladders: sprites.missiles,
      sfx: () => sfx("launch"),
    });
    this.lane = 0;
    this.pressSide = -1; // the corner the next volley comes from: left, then right, in turn (D-136)
    this.reset();
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

  /** Where each robot is in its window: `progress` maps an enemy id to 0..1, or to a value of 1
   * or more once its window has closed. A robot past its window has gone by Elena, uncounted. */
  setRush(progress) {
    for (const enemy of this.enemies) {
      if (!enemy.alive || enemy.leftAt || enemy.frozen) continue;
      const p = progress.get(enemy.id);
      if (p === undefined) continue;
      if (p >= 1) {
        enemy.alive = false;
        enemy.passed = true; // ST-30: not counted
      } else enemy.rush = Math.max(enemy.rush, Math.max(0, p));
    }
  }

  /** The enemy of a target, if it is still on the road. */
  enemyOf(id) {
    return this.enemies.find((enemy) => enemy.id === id && enemy.alive && !enemy.leftAt) || null;
  }

  depthOf(thing, tick) {
    if (thing.frozen) return thing.frozen.z; // hit: it stops where it is (D-130)
    const standing = Math.max(thing.zEnd, thing.z0 - Math.max(0, tick - thing.born) * thing.speed);
    if (!thing.rush) return standing;
    // in its window the robot charges straight at the cockpit, faster as it comes, and swerves in
    // the last quarter (D-141)
    const p = thing.rush;
    if (p < SWERVE_AT) {
      const q = p / SWERVE_AT;
      return standing + (CHARGE_NEAR - standing) * q * q;
    }
    return CHARGE_NEAR + (RUSH_NEAR - CHARGE_NEAR) * ((p - SWERVE_AT) / (1 - SWERVE_AT));
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
    const q = this.swerveOf(thing); // straight down its lane, then a sharp curve outward
    return thing.laneX + this.sideOf(thing) * RUSH_DRIFT * q * q;
  }
  onScreen(thing, tick, heightAtGlass) {
    const z = this.depthOf(thing, tick),
      feet = this.road.project(this.laneOf(thing), z),
      bob = Math.floor((tick + thing.laneX) / 8) % 2;
    return { x: feet.x, y: feet.y - bob, h: heightAtGlass / z, z };
  }
  targetOf(thing, heightAtGlass) {
    return () => {
      const z = this.depthOf(thing, this.now),
        moving = z > thing.zEnd;
      return { X: this.laneOf(thing), H: heightAtGlass * 0.5, D: z * KZ, vD: moving ? -thing.speed * KZ : 0 };
    };
  }
  boomAt(target, tick, radius) {
    const at = this.road.project3(target.X, target.H, target.D / KZ);
    this.booms.push({ x: at.x + (Math.random() - 0.5) * 6, y: at.y + (Math.random() - 0.5) * 6, t0: tick, r: radius });
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
   * A hit (ST-05): a volley of three at the target's enemy. When the first missile arrives the
   * enemy and its sign shatter with a small burst (D-81, D-95) and `onHit(tick)` is called.
   * Returns false when the enemy is not on the road (it has not come yet, or it is gone).
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
    const X = (Math.random() - 0.5) * 120;
    this.missiles.volley({ count: 1, side: this.nextSide(), tick, target: () => ({ X, H: 160, D: 12 * KZ, vD: 0 }) });
    this.sfx("miss");
  }

  /**
   * The lever's explosion reaches the road (D-128): the `level` nearest robots are destroyed by
   * the blast (not counted), and the others rush toward the cockpit over 20 ticks and leave.
   * Returns the ids of every robot that was on the road.
   */
  blastRoad(level, tick) {
    const standing = this.standing().filter((enemy) => tick >= enemy.born);
    standing.sort((a, b) => this.depthOf(a, tick) - this.depthOf(b, tick));
    standing.forEach((enemy, k) => {
      if (k < level) {
        const at = this.onScreen(enemy, tick, ENEMY_HEIGHT);
        enemy.alive = false;
        enemy.shatterAt = tick + k * 3;
        this.booms.push({ x: at.x, y: at.y - at.h * 0.5, t0: tick + k * 3, r: Math.max(8, at.h * 0.35) });
      } else enemy.forcedAt = tick;
    });
    return standing.map((enemy) => enemy.id);
  }

  /** Enemies leave over the cockpit, spinning, and are not counted (ST-30). `ids` null: all. */
  leave(ids, tick) {
    for (const enemy of this.enemies)
      if (enemy.alive && !enemy.leftAt && (!ids || ids.includes(enemy.id))) {
        enemy.leftAt = tick;
        enemy.leaveFrom = this.onScreen(enemy, tick, ENEMY_HEIGHT);
      }
  }

  // ---------------------------------------------------------------- the boss (D-102, ST-35)
  /** The boss sets out with `hp` hit points; it stands before the glass after 5 s. */
  bossComes(tick, hp) {
    if (!this.sprites.boss) return;
    this.boss = { laneX: 0, z0: 11, zEnd: 3.4, born: tick, speed: 0.05, alive: true, hp, hpMax: Math.max(hp, 1), hitAt: -99, gone: null };
  }
  /** One missile at the boss with a heavier burst; resolves its hit point when it arrives. */
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
  bossFalls(tick, onFall) {
    const boss = this.boss;
    if (!boss.alive) return;
    boss.alive = false;
    boss.deadAt = tick;
    const at = this.onScreen(boss, tick, BOSS_HEIGHT);
    for (let k = 0; k < 6; k++)
      this.booms.push({ x: at.x + (k - 2.5) * 10, y: at.y - at.h * (0.3 + 0.1 * (k % 3)), t0: tick + k * 4, r: 26 });
    this.sfx("boss_fall");
    onFall && onFall();
  }
  /** The boss leaves with hit points left: into the distance, or spinning away (D-102). */
  bossLeaves(tick, spinning) {
    if (this.boss && this.boss.alive) this.boss.gone = { t0: tick, spinning };
  }

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
        const p = (tick - enemy.forcedAt) / 20;
        if (p >= 1) {
          enemy.alive = false;
          enemy.passed = true;
        } else enemy.rush = Math.max(enemy.rush, p);
      }
    this.missiles.tick(tick);
    this.booms = this.booms.filter((boom) => tick - boom.t0 <= 11);
    if (this.shout && tick - this.shout.t0 > SHOUT_TICKS) this.shout = null;
    this.enemies = this.enemies.filter(
      (enemy) => (enemy.alive && !enemy.leftAt) || (enemy.leftAt && tick - enemy.leftAt <= LEAVE_TICKS) || (!enemy.alive && !enemy.passed && tick - enemy.shatterAt <= 8),
    );
  }

  /**
   * A Kommy robot from its relief turn: 96 frames of one turn, frame 0 facing the user. Standing
   * and charging, it faces the user; swerving, it turns a quarter toward the side it goes to
   * (D-141). Scaled to its depth with hard pixels.
   */
  drawRobot(m, enemy, at, tick) {
    const turn = this.sprites.kommyTurn;
    if (!turn) return this.drawSprite(m, this.sprites.kommy, at.x, at.y, at.h * 1.05);
    const { img, meta } = turn;
    let frame = 0;
    if (enemy.frozen) frame = enemy.frozenFrame ?? (enemy.frozenFrame = enemy.lastFrame || 0);
    else if (enemy.rush) {
      // frame 24 shows its left side (it heads to the user's left), frame 72 its right
      const quarter = meta.frames / 4;
      frame = Math.round(-this.sideOf(enemy) * quarter * Math.min(1, this.swerveOf(enemy) * 1.5));
    }
    frame = ((frame % meta.frames) + meta.frames) % meta.frames;
    enemy.lastFrame = frame;
    const h = Math.max(4, Math.round(at.h * 1.25)), // the cell is a little taller than the robot
      w = Math.round((h * meta.w) / meta.h);
    const smooth = m.imageSmoothingEnabled;
    m.imageSmoothingEnabled = false;
    m.drawImage(img, (frame % meta.cols) * meta.w, Math.floor(frame / meta.cols) * meta.h, meta.w, meta.h, Math.round(at.x - w / 2), Math.round(at.y - h), w, h);
    m.imageSmoothingEnabled = smooth;
  }

  drawSprite(m, sprite, centerX, footY, height, angle = 0) {
    const cell = ladderCell(sprite.meta, height);
    if (!angle) {
      m.drawImage(sprite.img, cell.x, sprite.meta.H - cell.h, cell.w, cell.h, Math.round(centerX - cell.w / 2), Math.round(footY - cell.h), cell.w, cell.h);
      return;
    }
    m.save();
    m.translate(Math.round(centerX), Math.round(footY - cell.h / 2));
    m.rotate(angle);
    m.drawImage(sprite.img, cell.x, sprite.meta.H - cell.h, cell.w, cell.h, -Math.round(cell.w / 2), -Math.round(cell.h / 2), cell.w, cell.h);
    m.restore();
  }

  /** The enemies and the boss (the farthest first), the missiles and the bursts. */
  drawWorld(m, tick) {
    const { sprites, boss } = this;
    const things = [];
    if (boss && (boss.alive || tick - boss.deadAt < 12)) things.push({ boss: true, z: this.depthOf(boss, tick) });
    for (const enemy of this.enemies)
      if (tick >= enemy.born && !enemy.passed && (enemy.alive || (!enemy.alive && tick - enemy.shatterAt < 3))) things.push({ enemy, z: enemy.leftAt ? 0.5 : this.depthOf(enemy, tick) });
    things.sort((one, other) => other.z - one.z);
    for (const thing of things) {
      if (thing.boss) this.drawBoss(m, tick);
      else {
        const enemy = thing.enemy;
        if (enemy.leftAt) {
          // over the cockpit: up and to the side, larger as it comes near, spinning (ST-30, D-82)
          const age = (tick - enemy.leftAt) / LEAVE_TICKS,
            from = enemy.leaveFrom,
            x = from.x + (from.x < 213 ? -1 : 1) * age * 160,
            y = from.y - age * 220,
            h = from.h * (1 + age * 1.6);
          this.drawSprite(m, sprites.kommy, x, y, h, ((tick - enemy.leftAt) / 8) * Math.PI * 2);
          enemy.screen = null;
        } else if (enemy.alive) {
          const at = this.onScreen(enemy, tick, ENEMY_HEIGHT);
          // a hit robot flashes, shown every other tick (D-130)
          if (!(enemy.frozen && (tick - enemy.stopAt) % 2)) this.drawRobot(m, enemy, at, tick);
          enemy.screen = at;
        }
      }
    }
    this.missiles.draw(m, tick);
    for (const boom of this.booms) {
      const age = tick - boom.t0;
      if (age < 0 || age > 11) continue;
      const radius = boom.r * BOOM_RADII[age];
      m.fillStyle = age < 3 ? "#ffffff" : age < 6 ? "#ffcf3f" : age < 9 ? "#e0603a" : "#6a4a50";
      for (let k = 0; k < 12; k++) {
        const angle = k * 0.52 + age * 0.15;
        m.fillRect(Math.round(boom.x + Math.cos(angle) * radius) - 2, Math.round(boom.y + Math.sin(angle) * radius * 0.8) - 2, 4, 4);
      }
      if (age < 4) m.fillRect(Math.round(boom.x) - 3, Math.round(boom.y) - 3, 6, 6);
    }
  }

  drawBoss(m, tick) {
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
    if (tick - boss.hitAt >= 2) this.drawSprite(m, this.sprites.boss, at.x, at.y + sink, at.h, angle);
    boss.screen = boss.alive && !boss.gone ? at : null;
  }

  /** The cockpit and Elena from behind (D-39), as in the test scene, except that the launch button
   * and the pressing hand moved to the right (D-104), so that 「爆発」 has the left. `typing`: the
   * song is running, so her hands step in turn. A press: the right hand reaches onto the button. */
  drawCockpit(f, tick, typing, seated = true) {
    const { sprites, road } = this;
    f.save();
    f.translate(213, 120);
    f.rotate(-road.tilt * 0.05);
    f.scale(1.1, 1.1);
    f.translate(-213, -120);
    f.drawImage(sprites.cockpit, 0, 0);
    if (!seated) {
      f.restore();
      return; // the book list: Elena has not boarded yet (D-97)
    }
    const posed = tick < this.poseUntil && sprites.elena[this.pose] ? sprites.elena[this.pose] : sprites.elena.back,
      place = posed.meta,
      breathe = Math.floor(tick / 24) % 2,
      keys = posed === sprites.elena.back && typing,
      beat = Math.floor(tick / 3) % 2,
      sway = Math.round(road.swayX);
    f.translate(213, 240);
    f.rotate(-road.swayX * 0.004);
    f.translate(-213, -240);
    const pressAge = tick - this.pressAt,
      reach = pressAge >= 0 && pressAge < 10 ? PRESS_REACH[pressAge] : 0;
    // the launch button is the blue missile at the far right of the console (D-126, cockpit.js)
    f.drawImage(posed.body, place.body[0] + sway, place.body[1] + breathe);
    f.drawImage(posed.l, place.hand_l[0] + sway, place.hand_l[1] + (keys && beat ? -1 : 0));
    const rightY = place.hand_r[1] + reach + (keys && !beat && !reach ? -1 : 0);
    if (reach < 0) {
      // reaching forward: the wrist stretches, so the hand never parts from the sleeve
      const w = posed.r.width,
        h = posed.r.height,
        wrist = 5;
      f.drawImage(posed.r, 0, h - wrist, w, wrist, place.hand_r[0] + sway, rightY + h - wrist, w, wrist - reach);
    }
    f.drawImage(posed.r, place.hand_r[0] + sway, rightY);
    f.restore();
  }

  /** Each standing enemy's noun as a sign over its head once it is near enough to read; the
   * enemy whose window is open wears targeting brackets (ST-28). `open` is a Set of ids. */
  drawSigns(f, open = new Set(), tick = 0) {
    const drawn = [];
    const readable = this.enemies
      .filter((enemy) => enemy.sign && enemy.alive && !enemy.leftAt && enemy.screen && enemy.screen.h >= 30)
      .sort((one, other) => other.screen.z - one.screen.z);
    for (const enemy of readable) {
      const at = enemy.screen,
        x = Math.round(at.x * 2 - enemy.sign.w / 2);
      let y = Math.round((at.y - at.h) * 2 - enemy.sign.h - 4);
      for (const box of drawn)
        if (x < box.x + box.w + 8 && box.x < x + enemy.sign.w + 8 && Math.abs(y - box.y) < box.h + 4) y = box.y - enemy.sign.h - 6;
      drawn.push({ x, y, w: enemy.sign.w, h: enemy.sign.h });
      f.fillStyle = "#1d1a2e";
      f.fillRect(x - 3, y - 1, enemy.sign.w + 6, enemy.sign.h + 2);
      f.fillStyle = "#7fe0ff";
      f.fillRect(x - 3, y - 1, enemy.sign.w + 6, 1);
      f.fillRect(x - 3, y + enemy.sign.h, enemy.sign.w + 6, 1);
      drawOutlined(f, enemy.sign.fill, enemy.sign.ink, x, y);
      if (open.has(enemy.id)) this.drawBrackets(f, at, tick);
    }
    const boss = this.boss;
    if (boss && boss.screen && boss.hpMax) this.drawHp(f, boss);
  }
  drawBrackets(f, at, tick) {
    const pulse = Math.floor(tick / 4) % 2 ? 2 : 0,
      w = Math.round(at.h * 1.4) + pulse * 2,
      h = Math.round(at.h * 2) + pulse * 2,
      x = Math.round(at.x * 2 - w / 2),
      y = Math.round((at.y - at.h) * 2 - pulse),
      arm = 8;
    f.fillStyle = "#ff5f7a";
    for (const [cx, cy, dx, dy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
      f.fillRect(dx > 0 ? cx : cx - arm, cy - (dy > 0 ? 0 : 2), arm, 2);
      f.fillRect(cx - (dx > 0 ? 0 : 2), dy > 0 ? cy : cy - arm, 2, arm);
    }
  }
  /** The boss's hit points: a bar of cells over it (ST-35). */
  drawHp(f, boss) {
    const at = boss.screen,
      cell = 12,
      gap = 2,
      w = boss.hpMax * (cell + gap) - gap,
      x = Math.round(at.x * 2 - w / 2),
      y = Math.round((at.y - at.h) * 2 - 16);
    f.fillStyle = "#1d1a2e";
    f.fillRect(x - 2, y - 2, w + 4, 12);
    for (let k = 0; k < boss.hpMax; k++) {
      f.fillStyle = k < boss.hp ? "#ff5f7a" : "#3a3040";
      f.fillRect(x + k * (cell + gap), y, cell, 8);
    }
  }

  /** Elena's call, rising a little, at the left of the glass. */
  drawShouts(f, tick) {
    const shout = this.shout;
    if (!shout) return;
    const age = tick - shout.t0;
    // above the bomb at the lower left (D-104), clear of 「爆発」 and of the caption
    drawOutlined(f, shout.sprite.fill, shout.sprite.ink, 28, 286 - Math.min(6, age));
  }
}
