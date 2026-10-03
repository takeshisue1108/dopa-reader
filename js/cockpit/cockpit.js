// The cockpit: the frame of five pixel layers, the 30-tick clock, and what the reading shows on it
// (SPEC_dopa v3 §6.1, §6.3 to §6.7, SD-W11, SD-W13; ED V-02 to V-06, ST-03 to ST-05, ST-12 to
// ST-19, ST-24 to ST-32, ST-35). Taken from the frame of the old display (dopa.js), without the
// diagram, the display switch and the calm display. The reader tells it what happens; it streams
// the enemies, judges presses and plays the bomb.
import * as clock from "./clock.js";
import { Bomb } from "./bomb.js";
import { Battle } from "./battle.js";
import { Caption } from "./caption.js";
import { heardAt, judge, openAt } from "./fire.js";
import { level, levelStart as levelStartOf } from "./levels.js";
import { Monitor } from "./monitor.js";
import { canvas, ctx2d, ditheredGradient, drawOutlined, loadImage, textSprite } from "./pixel.js";
import { Road } from "./road.js";

const WORLD = { w: 426, h: 240 },
  TEXT = { w: 852, h: 480 };
const LAYERS = ["w-back", "t-back", "w-mid", "w-front", "t-front"];
const SPRITES = "data/sprites/";
const BUILDINGS = 6;
const MAX_STANDING = 6; // D-81
const NEAR = 1.5; // seconds: a robot appears this long before its window opens (D-140)
const BOSS_DELAY_TICKS = 150; // the boss stands before the glass after 5 s (ST-35)
const REST_MS = 3000;
// the console's controls, in world pixels (D-126): the missile at the lower right, the lever at the lower left
const MISSILE = { x: 336, y: 192 },
  LEVER = { x: 44, y: 182 };
// the book list's scene (ST-24, D-122)
const RUN_Y = 234, // the pixel Elena's feet, at the bottom middle, in front
  MEOW_FEET = 196, // M.E.O.W far ahead, just under the list
  VANISH_Y = 176; // where the particles spring from: M.E.O.W

let frame = null,
  layer = null,
  pieces = null,
  loading = null,
  tickNow = 0,
  options = null;

// what the reading has told the cockpit
const scene = {
  list: false, // the book list (V-06)
  boarding: null, // { t0, resolve } while Elena boards (ST-25)
  singing: false, // the song is running: Elena's hands type
  queue: [], // targets of the block still to send: [{ id, label }]
  sentAt: -99,
  hit: new Set(), // targets hit (or gone) in this block
  bossBlock: false,
  card: null, // { lines: [sprites], t0 } a clear card or the book's end
};
const flashTimes = []; // large flashes, for the limiter (ED-10)
const knownWindows = new Map(); // id -> {from, to}: every window seen in this block, also once it has closed
const flashLog = []; // every large flash allowed, in ms, for the check of SC-W08

const json = async (url) => (await fetch(url)).json();
const sprite = async (name) => ({ img: await loadImage(`${SPRITES}${name}.png`), meta: await json(`${SPRITES}${name}.json`) });

/**
 * Set the cockpit up. `opts`: { windows() → the open sentences' windows [{id, from, to, display}],
 * audio() → the song's AudioContext or null, onHit(id), onCount(count), sfx(role), onStageTap() }.
 */
export function init(opts) {
  options = opts;
}

/** Load the sprites and make the frame (once). */
export function load() {
  if (!loading) loading = loadSprites().then(build);
  return loading;
}

async function loadSprites() {
  await Promise.all([document.fonts.load('16px "DotGothic16"'), document.fonts.load('16px "Misaki Mincho"')]);
  const elena = {};
  for (const pose of ["back", "fist", "button"]) {
    const base = `${SPRITES}elena/elena_${pose}`;
    elena[pose] = await Promise.all([json(`${base}.json`), loadImage(`${base}_body.png`), loadImage(`${base}_hand_l.png`), loadImage(`${base}_hand_r.png`)])
      .then(([meta, body, l, r]) => ({ meta, body, l, r }))
      .catch(() => null);
  }
  const button = {};
  for (const name of ["up", "pressed", "lit"]) button[name] = await loadImage(`${SPRITES}button_${name}.png`);
  const missiles = [],
    buildings = [];
  for (let i = 0; i < 5; i++) missiles.push(await sprite(`missile_${i}`));
  for (let i = 0; i < BUILDINGS; i++) buildings.push(await sprite(`building_${i}`));
  return {
    cockpit: await loadImage(`${SPRITES}cockpit.png`),
    elena,
    button,
    missiles,
    buildings,
    turn: await sprite("meow_turn"),
    kommy: await sprite("kommy_meow_ladder"),
    kommyTurn: await sprite("kommy_meow_turn").catch(() => null), // the relief turn (D-129)
    boss: await sprite("robohilde_ladder").catch(() => null),
  };
}

function glassOf(cockpit) {
  const x = ctx2d(canvas(WORLD.w, WORLD.h));
  x.drawImage(cockpit, 0, 0);
  const alpha = x.getImageData(0, 0, WORLD.w, WORLD.h).data;
  let left = WORLD.w,
    top = WORLD.h,
    right = 0,
    bottom = 0;
  for (let y = 0; y < WORLD.h; y++)
    for (let q = 0; q < WORLD.w; q++)
      if (alpha[(y * WORLD.w + q) * 4 + 3] === 0) {
        left = Math.min(left, q);
        right = Math.max(right, q);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

function build(sprites) {
  frame = document.getElementById("stage");
  layer = {};
  for (const name of LAYERS) {
    const size = name.startsWith("w-") ? WORLD : TEXT,
      element = canvas(size.w, size.h);
    element.dataset.layer = name;
    frame.prepend(element);
    layer[name] = ctx2d(element);
  }
  // the layers in order, back to front, under the HTML of the frame
  for (const name of [...LAYERS].reverse()) frame.prepend(frame.querySelector(`canvas[data-layer="${name}"]`));
  frame.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button, .list, .card-skip, #gear")) return;
    options.onStageTap && options.onStageTap(event);
  });
  addEventListener("resize", fit);
  fit();

  const glass = glassOf(sprites.cockpit),
    glassText = { x: glass.x * 2, y: glass.y * 2, w: glass.w * 2, h: glass.h * 2 };
  const road = new Road(glass, sprites.buildings);
  const battle = new Battle({ road, sprites, sfx: (role) => options.sfx(role), smoke: () => true }); // always full: there is no effect level (ED D-120)
  const lines = 3,
    lineHeight = 30,
    captionBottom = sprites.elena.back.meta.body[1] * 2 - 4;
  const caption = new Caption({ x: glassText.x + Math.round(glassText.w * 0.08), y: captionBottom - lines * lineHeight, w: Math.round(glassText.w * 0.84), h: lines * lineHeight, size: 24, lines });
  const main = { x: Math.round(TEXT.w * 0.2), y: 34, w: Math.round(TEXT.w * 0.6), h: Math.round(TEXT.h * 0.55) };
  const monitor = new Monitor(main, main, sprites.turn);
  const bomb = new Bomb({ place: { x: 150, y: 418 }, flash: allowFlash, sfx: (role) => options.sfx(role) });
  // a blue sky (D-137), fitting for books from 青空文庫; the ground under the horizon as before
  const sky = ditheredGradient(WORLD.w, WORLD.h, [
    [0, "#2a6fd6"],
    [0.22, "#5aa0ee"],
    [0.4, "#cfeaff"],
    [0.42, "#3a3040"],
    [1, "#221c2a"],
  ]);
  pieces = { road, battle, caption, monitor, bomb, sky, sprites, main };
  placeHtml();
  clock.start(tick, { measure: true });
}

/** The HTML laid over the frame at the places of the pictures (SD-W13): the two console buttons
 * and the list's place over the main monitor. Positions are fractions of the frame. */
function placeHtml() {
  const pct = (v, of) => `${(v / of) * 100}%`;
  const fire = document.getElementById("fire"),
    gear = document.getElementById("gear"),
    list = document.getElementById("list");
  Object.assign(fire.style, { left: pct(MISSILE.x - 6, WORLD.w), top: pct(MISSILE.y - 8, WORLD.h), width: pct(52, WORLD.w), height: pct(34, WORLD.h) });
  Object.assign(gear.style, { left: pct(LEVER.x - 14, WORLD.w), top: pct(LEVER.y - 6, WORLD.h), width: pct(28, WORLD.w), height: pct(44, WORLD.h) });
  const main = pieces.main;
  Object.assign(list.style, { left: pct(main.x + 8, TEXT.w), top: pct(main.y + 8, TEXT.h), width: pct(main.w - 16, TEXT.w), height: pct(main.h - 16, TEXT.h) });
}

function fit() {
  const scale = Math.min(innerWidth / WORLD.w, innerHeight / WORLD.h);
  frame.style.width = Math.floor(WORLD.w * scale) + "px";
  frame.style.height = Math.floor(WORLD.h * scale) + "px";
  frame.style.setProperty("--px", `${scale / 2}px`); // one text-layer pixel, for the HTML
}

/** At most 2 large flashes a second, across everything (ED-10, SC-W08). */
function allowFlash() {
  const now = performance.now();
  while (flashTimes.length && now - flashTimes[0] > 1000) flashTimes.shift();
  if (flashTimes.length >= 2) return false;
  flashTimes.push(now);
  flashLog.push(now);
  if (flashLog.length > 200) flashLog.shift();
  return true;
}

// ---------------------------------------------------------------- what the reading tells it
/** The book list (V-06, ST-24): the cockpit stops, the list is on the main monitor, the pixel
 * Elena runs toward M.E.O.W. */
export function showList() {
  scene.list = true;
  scene.singing = false;
  scene.card = null;
  pieces.battle.reset();
  pieces.caption.clear();
  pieces.monitor.showList(tickNow);
  clock.resume();
}
/** Elena boards (ST-25): resolves when the boarding has played (1.5 s). */
export function board() {
  pieces.monitor.hide();
  return new Promise((resolve) => (scene.boarding = { t0: tickNow, resolve }));
}
/** The launch of a chapter (ST-13, D-103): resolves after 4 s, or at a click on the card. */
export function launch(title, call) {
  scene.list = false;
  scene.card = null;
  pieces.caption.clear();
  pieces.monitor.showLaunch(title, call, tickNow);
  options.sfx("siren");
  return waitOrClick(120, () => pieces.monitor.hide());
}
/** A section heading (ST-12): the call with its sting, the heading on the monitor for 1.5 s. */
export function section(heading, call) {
  pieces.battle.say(call, tickNow);
  options.sfx("sting");
  pieces.monitor.showText("quote", heading, tickNow);
  setTimeout(() => pieces.monitor.kind === "quote" && pieces.monitor.hide(), 1500);
}
/** A new sentence on the caption (ST-03); `targets` are display spans shown blue (D-124). */
export function sentence(display, lang, targets = []) {
  pieces.caption.set(display, targets.map((t) => ({ start: t.start, end: t.end, color: "#4aa8ff" })), lang);
}
/** The light: `n` displayed characters are lit (ST-04). */
export function light(n, position = n) {
  pieces.caption.light(n);
  pieces.caption.setProgress(position); // the progress bars (D-132)
}
export function clearCaption() {
  pieces.caption.clear();
}
/** Whether the song runs (Elena's hands type) and whether the cockpit moves. */
export function setSinging(on) {
  scene.singing = on;
}

/** A block starts (D-107): its targets come as a stream; `boss` is the hit points of a boss that
 * comes in this block (the chapter's last block), or null. */
export function block(targets, boss = null) {
  scene.queue = targets.slice();
  scene.hit = new Set();
  knownWindows.clear();
  scene.sentAt = -99;
  scene.bossBlock = false;
  if (boss !== null && boss > 0 && targets.length) {
    scene.bossBlock = true;
    pieces.battle.bossComes(tickNow + 1, boss);
  }
}
/** The block ends: enemies still standing leave, spinning, uncounted (ST-30). */
export function blockEnd() {
  pieces.battle.leave(null, tickNow);
  scene.queue = [];
}
/** A jump: everything leaves the road at once (§6.2). */
export function clearRoad() {
  pieces.battle.reset();
  scene.queue = [];
  scene.hit = new Set();
  scene.bossBlock = false;
}

/** A figure of the book on the main monitor (ST-19). `figure` from the book model; `line` the
 * label and page line. */
export async function figure(fig, line) {
  pieces.caption.clear();
  if (fig.kind === "table") pieces.monitor.showTable(fig.table, line, tickNow);
  else if (fig.kind === "canvas") pieces.monitor.showCanvas(fig.canvas, line, tickNow);
  else
    await pieces.monitor.showFigure(fig.src, line, () => tickNow).catch(() => {
      // an image that cannot be read for the pass is skipped (G-W2, A-37)
    });
}
export function hideMonitor() {
  pieces.monitor.hide();
}

/** A card over the cockpit: the clear (V-04) or the book's end. Resolves after `seconds` or a
 * click. `lines` are [text, face] pairs. */
export function card(lines, seconds) {
  scene.card = {
    t0: tickNow,
    lines: lines.map(([text, big]) => textSprite(text, big ? 24 : 16, big ? "Misaki Mincho" : "DotGothic16", big ? "#ffcf3f" : "#ffffff")),
  };
  return waitOrClick(Math.round(seconds * 30), () => (scene.card = null));
}

function waitOrClick(ticks, done) {
  return new Promise((resolve) => {
    const skip = document.getElementById("card-skip");
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      skip.hidden = true;
      skip.onclick = null;
      clearInterval(timer);
      done();
      resolve();
    };
    const t0 = tickNow;
    const timer = setInterval(() => tickNow - t0 >= ticks && finish(), 50);
    skip.hidden = false;
    skip.onclick = finish;
  });
}

/** Hold the cockpit still (⏸, a drawer) or let it go on (ST-18). */
export function hold(on) {
  if (on) clock.pause();
  else clock.resume();
}

// ---------------------------------------------------------------- firing and the bomb
/** A press on 「発射」 or on the stage (D-61, D-83, D-100). `eventMs` is the event's timeStamp. */
export function press(eventMs) {
  if (scene.list || scene.card || scene.boarding || pieces.monitor.kind === "launch") return;
  const ctx = options.audio();
  const heard = ctx ? heardAt(ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null, eventMs, ctx) : 0;
  const windows = options.windows(),
    id = judge(windows, heard, scene.hit);
  const battle = pieces.battle;
  if (!id) {
    battle.miss(tickNow); // ST-29
    return;
  }
  scene.hit.add(id);
  if (!battle.enemyOf(id)) {
    // its enemy has not come yet (a crowded block): it comes now and is hit at once
    const at = scene.queue.findIndex((target) => target.id === id);
    const target = at >= 0 ? scene.queue.splice(at, 1)[0] : { id, label: (windows.find((w) => w.id === id) || {}).label };
    makeRoom();
    battle.send(target, tickNow, 8);
  }
  const label = (windows.find((w) => w.id === id) || {}).label || "";
  battle.say(`${label}ミサイル！`, tickNow); // ST-05
  battle.shoot(id, tickNow, (hitTick) => {
    pieces.bomb.add(1, hitTick);
    options.onCount(pieces.bomb.count);
  });
  if (scene.bossBlock) battle.bossHit(tickNow, () => {
    pieces.bomb.add(1, tickNow);
    options.onCount(pieces.bomb.count);
  });
}

/** The explosion of the count (ST-32). Returns { tier, level, seconds } or null. With
 * `road`, the lever's explosion also reaches the robots on the road (D-128). */
export function explode({ road = false } = {}) {
  const lvl = level(pieces.bomb.count);
  const done = pieces.bomb.explode(tickNow);
  options.onCount(0);
  if (road) for (const id of pieces.battle.blastRoad(lvl, tickNow)) scene.hit.add(id); // done for this block
  return done;
}
/** The lever is back: the road stops, while the explosion and the robots go on moving. */
export function setStopped(on) {
  scene.stopped = on;
}
/** The chapter-end explosion, which also strikes a boss still standing (D-102). Returns
 * { blast, bossLeft } with bossLeft the hit points left on a boss that did not fall. */
export function chapterBlast(lastChapter) {
  const lvl = level(pieces.bomb.count),
    battle = pieces.battle,
    boss = battle.boss;
  const blast = explode();
  let bossLeft = null;
  if (boss && boss.alive && !boss.gone) {
    battle.bossBlast(lvl, tickNow, () => {
      pieces.bomb.add(1, tickNow);
      options.onCount(pieces.bomb.count);
    });
    if (boss.alive) {
      bossLeft = lastChapter ? null : boss.hp;
      battle.bossLeaves(tickNow + 20, lastChapter);
    }
  }
  return { blast, bossLeft };
}
export const blastBusy = () => pieces.bomb.busy(tickNow);
export const shortenBlast = () => pieces.bomb.shorten(tickNow);
export function setCount(n) {
  pieces.bomb.set(n);
}

/** Make a place on the road: when 6 stand, the oldest whose window has passed leaves (G-W1). */
function makeRoom() {
  const battle = pieces.battle,
    standing = battle.standing();
  if (standing.length < MAX_STANDING) return;
  const now = songNow(),
    windows = options.windows();
  const passed = standing.filter((enemy) => {
    const window = windows.find((w) => w.id === enemy.id);
    return scene.hit.has(enemy.id) ? false : !window || window.to < now;
  });
  const oldest = (passed.length ? passed : standing).sort((a, b) => a.born - b.born)[0];
  battle.leave([oldest.id], tickNow);
}

const songNow = () => {
  const ctx = options.audio();
  return ctx ? ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0) : 0;
};

/** When a robot comes (§6.4, D-140): a target's robot is sent from the far end only when its
 * window is NEAR seconds away, fast enough to reach shooting distance as the window opens. Robots
 * are not sent ahead to wait; at most 6 are on the road. */
function stream() {
  const battle = pieces.battle;
  if (!scene.queue.length) return;
  const windows = options.windows(),
    now = songNow();
  for (let k = 0; k < scene.queue.length; k++) {
    const window = windows.find((w) => w.id === scene.queue[k].id);
    if (!window || window.from - now >= NEAR) continue; // not yet: it appears when its time nears
    if (battle.standing().length >= MAX_STANDING) return; // the road is full: it comes when one is gone
    const [target] = scene.queue.splice(k, 1);
    battle.send(target, tickNow, Math.max(8, Math.round((window.from - now) * 30)));
    scene.sentAt = tickNow;
    return; // one a tick
  }
}

// ---------------------------------------------------------------- the 30-tick clock
function tick(n) {
  tickNow = n;
  const { road, battle, caption, monitor, bomb, sky, sprites } = pieces;
  const moving = !scene.list && !scene.boarding && !scene.stopped;
  road.move(moving ? 1 : 0);
  battle.tick(n);
  if (moving) stream();

  // the nouns in their window flash white, and their enemies wear brackets (ST-28); the robots
  // rush toward the cockpit through their window and are past Elena when it closes (D-125)
  const windows = options.windows ? options.windows() : [],
    heard = songNow(),
    open = openAt(windows, heard, scene.hit);
  for (const w of windows) knownWindows.set(w.id, { from: w.from, to: w.to });
  scene.canShoot = open.length > 0; // the missile button flashes (D-135)
  if (moving) {
    const progress = new Map();
    for (const [id, w] of knownWindows) progress.set(id, heard < w.from ? -1 : (heard - w.from) / Math.max(0.05, w.to - w.from));
    battle.setRush(progress);
  }
  caption.setFlash(open.map((w) => w.display).filter(Boolean), Math.floor(n / 4) % 2 === 0);

  const shake = bomb.shake(n);
  const inList = scene.list || scene.boarding;
  const back = layer["w-back"];
  if (inList) {
    back.fillStyle = "#000000";
    back.fillRect(0, 0, WORLD.w, WORLD.h);
  } else {
    back.drawImage(sky, 0, 0);
    road.drawGround(back);
    road.drawBuildings(back);
  }

  layer["t-back"].clearRect(0, 0, TEXT.w, TEXT.h);

  const middle = layer["w-mid"];
  middle.clearRect(0, 0, WORLD.w, WORLD.h);
  middle.save();
  middle.translate(shake.x, shake.y);
  if (inList) drawListScene(middle, n, sprites);
  else battle.drawWorld(middle, n);
  bomb.drawBlast(middle, n, road);
  middle.restore();

  const front = layer["w-front"];
  front.clearRect(0, 0, WORLD.w, WORLD.h);
  front.save();
  front.translate(shake.x, shake.y);
  if (!inList) {
    battle.drawCockpit(front, n, scene.singing);
    drawConsole(front, n);
  }
  front.restore();

  const words = layer["t-front"];
  words.clearRect(0, 0, TEXT.w, TEXT.h);
  monitor.draw(words, n);
  battle.drawSigns(words, new Set(open.map((w) => w.id)), n);
  caption.draw(words);
  battle.drawShouts(words, n);
  if (!scene.list) bomb.drawIndicator(words, n);
  if (scene.card) drawCard(words, n);
  bomb.drawFlash(words, n, TEXT.w, TEXT.h);
}

/** The console's two controls (D-126): the blue missile of the launch button at the lower
 * right, which lights at a press, and the gear lever at the lower left, forward (toward the
 * user, lower on the screen) or back. Drawn from simple shapes in world pixels. */
let leverBack = false,
  leverMovedAt = -99,
  missileLitAt = -99;
function drawConsole(f, n) {
  // the missile: a blue body, a red nose, two fins, on a dark plate
  const mx = MISSILE.x,
    my = MISSILE.y,
    lit = n - missileLitAt < 2,
    flash = scene.canShoot && Math.floor(n / 2) % 2 === 0; // a robot can be shot now (D-135)
  if (scene.canShoot) {
    // a ring of light around the plate while a window is open
    f.fillStyle = flash ? "#ffffff" : "#7fc4ff";
    f.fillRect(mx - 4, my - 4, 44, 22);
  }
  f.fillStyle = "#14202c";
  f.fillRect(mx - 2, my - 2, 40, 18);
  f.fillStyle = lit || flash ? "#ffffff" : scene.canShoot ? "#8fd0ff" : "#2f7fe0";
  f.fillRect(mx + 6, my + 4, 24, 6);
  f.fillStyle = lit || flash ? "#ffffff" : "#7fc4ff";
  f.fillRect(mx + 6, my + 4, 24, 2);
  f.fillStyle = "#e0402a";
  f.fillRect(mx + 30, my + 5, 4, 4);
  f.fillStyle = "#1f5aa8";
  f.fillRect(mx + 4, my + 1, 4, 3);
  f.fillRect(mx + 4, my + 10, 4, 3);
  f.fillStyle = "#ffcf3f";
  if (Math.floor(n / 3) % 2) f.fillRect(mx + 2, my + 6, 3, 2); // the flame
  // the gear lever: a slot, a stick and a knob; forward is lower on the screen
  const gx = LEVER.x,
    gy = LEVER.y,
    t = Math.min(1, (n - leverMovedAt) / 4),
    back = leverBack ? t : 1 - t,
    knobY = Math.round(gy + 26 - back * 20);
  f.fillStyle = "#14202c";
  f.fillRect(gx - 6, gy - 2, 12, 34);
  f.fillStyle = "#3a4a58";
  f.fillRect(gx - 2, gy, 4, 30);
  f.fillStyle = "#8a96a0";
  f.fillRect(gx - 1, knobY, 2, gy + 30 - knobY);
  f.fillStyle = leverBack ? "#e0402a" : "#3fe0a0";
  f.fillRect(gx - 5, knobY - 5, 10, 8);
  f.fillStyle = "#ffffff";
  f.fillRect(gx - 4, knobY - 4, 3, 2);
}
/** Move the lever: true is back (the explosion), false is forward (going on). */
export function setLever(isBack) {
  if (leverBack === isBack) return;
  leverBack = isBack;
  leverMovedAt = tickNow;
  options.sfx("lever");
  const gear = document.getElementById("gear");
  if (gear) gear.setAttribute("aria-pressed", String(isBack));
}
export const lever = () => leverBack;
/** The missile button lights at a press. */
export function lightMissile() {
  missileLitAt = tickNow;
}

/** The book list's scene (ST-24, ST-25; D-122): no cockpit, a black background, M.E.O.W far
 * ahead in the middle, turning, and the cheap pixel Elena running in place in the lower middle,
 * while particles spring from the middle and fly outward to show her speed. When a book is
 * chosen the particles rush, M.E.O.W grows as she reaches it, and she leaps aboard. */
const particles = [];
function drawListScene(m, n, sprites) {
  const { img, meta } = sprites.turn;
  const boarding = scene.boarding,
    age = boarding ? n - boarding.t0 : 0;
  m.fillStyle = "#000000";
  m.fillRect(0, 0, WORLD.w, WORLD.h);
  // particles: born near the middle, flying outward, faster and larger as they go
  const speed = boarding ? 2 : 1,
    cx = WORLD.w / 2,
    cy = VANISH_Y;
  for (let k = 0; k < 3 * speed; k++) particles.push({ a: Math.random() * Math.PI * 2, r: 2 + Math.random() * 8, v: 0.6 + Math.random() * 0.8 });
  for (const p of particles) {
    p.r += p.v * speed * (1 + p.r / 40);
    const x = cx + Math.cos(p.a) * p.r,
      y = cy + Math.sin(p.a) * p.r * 0.75,
      size = p.r > 120 ? 3 : p.r > 50 ? 2 : 1;
    m.fillStyle = p.r > 90 ? "#c8f0ff" : "#6a8aa8";
    m.fillRect(Math.round(x), Math.round(y), size, size);
  }
  for (let k = particles.length - 1; k >= 0; k--) if (particles[k].r > 300) particles.splice(k, 1);
  // M.E.O.W far ahead; it grows as Elena reaches it
  let scale = 0.45 + 0.03 * Math.sin(n / 45),
    frameIndex = Math.floor(n / 2) % meta.frames;
  if (boarding) {
    scale = 0.48 + Math.min(1, age / 30) * 1.2;
    if (age >= 45) {
      const done = scene.boarding;
      scene.boarding = null;
      scene.list = false;
      particles.length = 0;
      done.resolve();
    }
  }
  const w = Math.round(meta.w * scale),
    h = Math.round(meta.h * scale);
  m.drawImage(img, (frameIndex % meta.cols) * meta.w, Math.floor(frameIndex / meta.cols) * meta.h, meta.w, meta.h, cx - Math.round(w / 2), MEOW_FEET - h, w, h);
  // Elena, in place, running; she leaps up into the robot at the end of the boarding
  if (boarding && age > 30) {
    const t = Math.min(1, (age - 30) / 10);
    if (t < 1) drawRunner(m, cx, Math.round(RUN_Y - t * (RUN_Y - MEOW_FEET + 20)), Math.floor(n / 2) % 2, 1 - t * 0.5);
    return;
  }
  drawRunner(m, cx, RUN_Y, Math.floor(n / 4) % 2, 1);
}

/** A cheap pixel Elena, about 24 pixels tall, seen from behind as she runs toward M.E.O.W
 * (§8.1): long dusty-pink hair, pointed ears, a white lab coat. Drawn from rectangles. */
function drawRunner(m, x, y, step, scale) {
  const px = (dx, dy, w, h, color) => {
    m.fillStyle = color;
    m.fillRect(Math.round(x + dx * scale), Math.round(y + dy * scale), Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
  };
  px(-4, -24, 8, 4, "#d8879a"); // hair on top
  px(-5, -21, 10, 9, "#d8879a"); // long hair down the back
  px(-6, -20, 2, 2, "#f4c9a8"); // the pointed ears
  px(4, -20, 2, 2, "#f4c9a8");
  px(-4, -12, 8, 7, "#f4f1ff"); // the lab coat
  px(-5, -6, 10, 2, "#e0dcf0");
  px(step ? -6 : 4, -11, 2, 4, "#f4c9a8"); // the swinging arms
  px(step ? 4 : -6, -10, 2, 3, "#f4c9a8");
  px(-3, -4, 2, step ? 4 : 2, "#3a3040"); // the legs, in turn
  px(1, -4, 2, step ? 2 : 4, "#3a3040");
}

function drawCard(f, n) {
  const card = scene.card,
    open = Math.min(1, (n - card.t0) / 6),
    w = 520,
    lineH = 34,
    h = Math.round((card.lines.length * lineH + 40) * open),
    x = (TEXT.w - w) / 2,
    y = 150 + Math.round((card.lines.length * lineH + 40 - h) / 2);
  f.fillStyle = "#0b1a16";
  f.fillRect(x, y, w, h);
  f.fillStyle = "#3fe0a0";
  f.fillRect(x, y, w, 2);
  f.fillRect(x, y + h - 2, w, 2);
  if (open < 1) return;
  card.lines.forEach((line, k) => drawOutlined(f, line.fill, line.ink, Math.round((TEXT.w - line.w) / 2), y + 20 + k * lineH));
}

/** The gallery (?gallery=1, Q-21): set the count, or set off one tier at once. */
function leaveListForGallery() {
  scene.list = false;
  pieces.monitor.hide();
}
export const gallery = {
  count(n) {
    leaveListForGallery();
    pieces.bomb.set(n);
  },
  blast(levelOfTier) {
    leaveListForGallery();
    pieces.bomb.set(levelStartOf(levelOfTier));
    return pieces.bomb.explode(tickNow);
  },
  leaveSpin() {
    pieces.battle.send({ id: "g" + tickNow, label: "見本" }, tickNow, 20);
    setTimeout(() => pieces.battle.leave(null, tickNow), 1200);
  },
};

/** For checks: what the cockpit shows. */
export function debug() {
  if (!pieces) return null;
  const battle = pieces.battle;
  return {
    tick: tickNow,
    list: scene.list,
    card: !!scene.card,
    monitor: pieces.monitor.kind,
    standing: battle.standing().map((enemy) => enemy.id),
    rushing: battle.enemies.filter((enemy) => enemy.rush > 0 && enemy.alive).map((enemy) => [enemy.id, Math.round(enemy.rush * 100) / 100]),
    passed: battle.enemies.filter((enemy) => enemy.passed).length,
    canShoot: !!scene.canShoot,
    lever: leverBack ? "back" : "forward",
    missileSides: battle.missiles.list.map((m) => Math.sign(m.start ? m.start.X : m.p.X)),
    leaving: battle.enemies.filter((enemy) => enemy.leftAt).length,
    queue: scene.queue.length,
    hit: [...scene.hit],
    boss: battle.boss ? { hp: battle.boss.hp, alive: battle.boss.alive, gone: !!battle.boss.gone } : null,
    count: pieces.bomb.count,
    blast: pieces.bomb.blast ? pieces.bomb.blast.tier : null,
    caption: pieces.caption.text,
    lit: pieces.caption.lit,
    tickTimes: clock.tickTimes(),
    flashes: flashLog.slice(),
    shake: pieces.bomb.shake(tickNow),
  };
}

let restTimer = null;
/** The floating controls show, and fade after 3 s of rest (ST-16, ST-17; A-15 on a phone). */
export function wake() {
  document.body.classList.remove("rest");
  clearTimeout(restTimer);
  restTimer = setTimeout(() => document.body.classList.add("rest"), REST_MS);
}
