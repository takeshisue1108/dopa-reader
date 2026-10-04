// The cockpit: the frame of five pixel layers, the 30-tick clock, and what the reading shows on it
// (SPEC_dopa v3 §6.1, §6.3 to §6.7, SD-W11, SD-W13; ED V-02 to V-06, ST-03 to ST-05, ST-12 to
// ST-19, ST-24 to ST-32, ST-35). Taken from the frame of the old display (dopa.js), without the
// diagram, the display switch and the calm display. The reader tells it what happens; it streams
// the enemies, judges presses and plays the bomb.
import * as clock from "./clock.js";
import { Bomb } from "./bomb.js";
import { Battle } from "./battle.js";
import { Caption } from "./caption.js";
import { heardAt, judge, openAt, shoutFor } from "./fire.js";
import { level, levelStart as levelStartOf } from "./levels.js";
import { Monitor } from "./monitor.js";
import { canvas, ctx2d, ditheredGradient, drawOutlined, loadImage, textSprite } from "./pixel.js";
import * as progress from "../loading.js";
import { Road } from "./road.js";

// The two sizes of layer: the world (the road, the robots, the cockpit) and the text layer at
// twice that, so that letters are sharp. One world pixel is two text pixels.
const WORLD = { w: 426, h: 240 },
  TEXT = { w: 852, h: 480 };
// the five canvases, back to front: w- are world layers, t- text layers
const LAYERS = ["w-back", "t-back", "w-mid", "w-front", "t-front"];
const SPRITES = "data/sprites/";
const BUILDINGS = 6; // how many building sprites there are
const MAX_STANDING = 6; // at most this many robots are on the road at once (D-81)
const NEAR = 1.5; // seconds: a robot appears this long before its window opens (D-140)
const BOSS_DELAY_TICKS = 150; // the boss stands before the glass after 5 s (ST-35)
const REST_MS = 3000; // the floating controls fade after this long without a touch
// the console's controls, in world pixels (D-126, D-145): the missile at the lower right; at the
// lower left the lever, and the bomb directly under it (BOMB is in text pixels, its bottom middle)
const MISSILE = { x: 336, y: 192 },
  LEVER = { x: 44, y: 164 },
  BOMB = { x: 88, y: 472 };
const GO_HEIGHT = 22; // the play icon's button above the lever, in world pixels (D-152)
// the play icon: a triangle that points right, as the length of each of its 9 rows
const PLAY_ROWS = [1, 3, 5, 7, 9, 7, 5, 3, 1];
// the book list's scene (ST-24, D-122)
const RUN_Y = 234, // the pixel Elena's feet, at the bottom middle, in front
  MEOW_FEET = 196, // M.E.O.W far ahead, just under the list
  VANISH_Y = 176; // where the particles spring from: M.E.O.W

let frame = null, // the element #stage, which holds the canvases and the HTML over them
  layer = null, // the 2D context of each canvas, by its name in LAYERS
  pieces = null, // { road, battle, caption, monitor, bomb, sky, sprites, main }, made by build()
  loading = null, // the promise of load()
  tickNow = 0, // the number of the clock's last tick
  options = null; // what init() was given

// what the reading has told the cockpit
const scene = {
  list: false, // the book list (V-06)
  boarding: null, // { t0, resolve } while Elena boards (ST-25)
  singing: false, // the song is running: Elena's hands type
  queue: [], // targets of the block still to send: [{ id, label }]
  sentAt: -99, // the tick at which the last robot was sent
  hit: new Set(), // targets hit (or gone) in this block
  bossBlock: false, // this block has the chapter's boss: a hit on a robot also hits the boss
  // and, set later: stopped (the lever is down: the road stands), canShoot (a window is open)
  card: null, // { lines: [sprites], t0 } a clear card or the book's end
};
const flashTimes = []; // large flashes, for the limiter (ED-10)
// id -> {from, to}: every window seen in this block, also once it has closed
// (the reader stops giving a sentence's windows when the sentence is over; the robot must still
// be told that its window has closed)
const knownWindows = new Map();
const flashLog = []; // every large flash allowed, in ms, for the check of SC-W08

const json = async (url) => (await fetch(url)).json();

/**
 * Set the cockpit up. `opts`: { windows() → the windows of the sentences being sung [{id, label,
 * from, to, display}] (from and to on the song's clock), audio() → the song's AudioContext or
 * null, onCount(count), sfx(role), onStageTap(event) }.
 */
export function init(opts) {
  options = opts;
}

/** Load the sprites and make the frame (once). */
export function load() {
  if (!loading) loading = loadSprites().then(build);
  return loading;
}

/** Fetch the two faces and every sprite. All are asked for at once, so their number is known
 * before the first arrives; each is counted in the group "page" as it arrives or fails, for the
 * bar of the loading words (ED D-163). Elena's poses, the relief turn and the boss may be
 * missing (null); any other file that is missing fails the load. */
async function loadSprites() {
  let asked = 0,
    arrived = 0;
  const counted = (file) => {
    asked++;
    const settle = () => progress.count("page", ++arrived, asked);
    file.then(settle, settle);
    return file;
  };
  const image = (path) => counted(loadImage(SPRITES + path)),
    data = (path) => counted(json(SPRITES + path));
  /** A sprite sheet: its picture and what the picture holds. */
  const sheet = (name) =>
    Promise.all([image(`${name}.png`), data(`${name}.json`)]).then(([img, meta]) => ({
      img,
      meta,
    }));
  const fonts = [
    counted(document.fonts.load('16px "DotGothic16"')),
    counted(document.fonts.load('16px "Misaki Mincho"')),
  ];
  const pose = (name) =>
    Promise.all([
      data(`elena/elena_${name}.json`),
      image(`elena/elena_${name}_body.png`),
      image(`elena/elena_${name}_hand_l.png`),
      image(`elena/elena_${name}_hand_r.png`),
    ])
      .then(([meta, body, l, r]) => ({ meta, body, l, r }))
      .catch(() => null);
  const optional = (sprite) => sprite.catch(() => null);
  const asking = {
    cockpit: image("cockpit.png"),
    elena: { back: pose("back"), fist: pose("fist"), button: pose("button") },
    button: {
      up: image("button_up.png"),
      pressed: image("button_pressed.png"),
      lit: image("button_lit.png"),
    },
    missiles: Array.from({ length: 5 }, (_, i) => sheet(`missile_${i}`)),
    buildings: Array.from({ length: BUILDINGS }, (_, i) => sheet(`building_${i}`)),
    turn: sheet("meow_turn"),
    kommy: sheet("kommy_meow_ladder"),
    kommyTurn: optional(sheet("kommy_meow_turn")), // the relief turn (D-129)
    boss: optional(sheet("robohilde_ladder")),
  };
  progress.count("page", arrived, asked); // everything is asked for: the whole count
  await Promise.all(fonts);
  return {
    cockpit: await asking.cockpit,
    elena: {
      back: await asking.elena.back,
      fist: await asking.elena.fist,
      button: await asking.elena.button,
    },
    button: {
      up: await asking.button.up,
      pressed: await asking.button.pressed,
      lit: await asking.button.lit,
    },
    missiles: await Promise.all(asking.missiles),
    buildings: await Promise.all(asking.buildings),
    turn: await asking.turn,
    kommy: await asking.kommy,
    kommyTurn: await asking.kommyTurn,
    boss: await asking.boss,
  };
}

/** The see-through part of the cockpit's picture: the box around its pixels of alpha 0, in world
 * pixels. */
function glassOf(cockpit) {
  const ctx = ctx2d(canvas(WORLD.w, WORLD.h));
  ctx.drawImage(cockpit, 0, 0);
  const alpha = ctx.getImageData(0, 0, WORLD.w, WORLD.h).data;
  let left = WORLD.w,
    top = WORLD.h,
    right = 0,
    bottom = 0;
  for (let y = 0; y < WORLD.h; y++)
    for (let x = 0; x < WORLD.w; x++)
      if (alpha[(y * WORLD.w + x) * 4 + 3] === 0) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

/** Make the frame: the five canvases under the HTML of #stage, and the pieces at their places
 * (the caption just above Elena's picture, the main monitor in the upper middle); then start the
 * clock. */
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
  for (const name of [...LAYERS].reverse())
    frame.prepend(frame.querySelector(`canvas[data-layer="${name}"]`));
  frame.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button, .list, .card-skip, #gear, #controls")) return;
    options.onStageTap && options.onStageTap(event);
  });
  addEventListener("resize", fit);
  // a tablet's browser shows and hides its bars without a resize of the window
  globalThis.visualViewport?.addEventListener("resize", fit);
  fit();

  const glass = glassOf(sprites.cockpit),
    glassText = { x: glass.x * 2, y: glass.y * 2, w: glass.w * 2, h: glass.h * 2 };
  const road = new Road(glass, sprites.buildings);
  // the missiles' smoke is always full: there is no effect level (ED D-120)
  const battle = new Battle({ road, sprites, sfx: (role) => options.sfx(role), smoke: () => true });
  const lines = 3,
    lineHeight = 30,
    captionBottom = sprites.elena.back.meta.body[1] * 2 - 4;
  const caption = new Caption({
    x: glassText.x + Math.round(glassText.w * 0.08),
    y: captionBottom - lines * lineHeight,
    w: Math.round(glassText.w * 0.84),
    h: lines * lineHeight,
    size: 24,
    lines,
  });
  const main = {
    x: Math.round(TEXT.w * 0.2),
    y: 34,
    w: Math.round(TEXT.w * 0.6),
    h: Math.round(TEXT.h * 0.55),
  };
  // a title could have a smaller place of its own; here it gets the monitor's
  const monitor = new Monitor(main, main, sprites.turn);
  const bomb = new Bomb({ place: BOMB, flash: allowFlash, sfx: (role) => options.sfx(role) });
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

/** The HTML laid over the frame at the places of the pictures (SD-W13): the four console buttons
 * (the missile; the play icon, the lever and the pause bomb, from top to bottom) and the list's
 * place over the main monitor. Positions are fractions of the frame. */
function placeHtml() {
  const pct = (value, whole) => `${(value / whole) * 100}%`;
  /** Lay the element over a rectangle of a layer (the world's pixels, or the text layer's). */
  const lay = (id, x, y, width, height, layer = WORLD) =>
    Object.assign(document.getElementById(id).style, {
      left: pct(x, layer.w),
      top: pct(y, layer.h),
      width: pct(width, layer.w),
      height: pct(height, layer.h),
    });
  lay("fire", MISSILE.x - 6, MISSILE.y - 8, 52, 34);
  // the play icon's button: the strip above the lever (D-152)
  lay("go", LEVER.x - 16, LEVER.y - 8 - GO_HEIGHT, 32, GO_HEIGHT);
  lay("gear", LEVER.x - 16, LEVER.y - 8, 32, 38);
  // the bomb's button: from under the lever to the bottom edge (the bomb grows upward from BOMB.y)
  lay("bomb", LEVER.x - 20, LEVER.y + 30, 40, WORLD.h - LEVER.y - 30);
  const main = pieces.main;
  lay("list", main.x + 8, main.y + 8, main.w - 16, main.h - 16, TEXT);
}

/** Fit the frame to the browser's window, keeping 426 : 240 (ED D-162: one frame, scaled as a
 * whole). `--px`, the size of one text-layer pixel, is written on the page's root: everything in
 * the frame is measured in it, and the drawers and boxes outside it too. */
function fit() {
  const scale = Math.min(innerWidth / WORLD.w, innerHeight / WORLD.h);
  frame.style.width = Math.floor(WORLD.w * scale) + "px";
  frame.style.height = Math.floor(WORLD.h * scale) + "px";
  document.documentElement.style.setProperty("--px", `${scale / 2}px`);
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
/** The book list (V-06, ST-24): the list's scene is on (no cockpit, no road), the list is on the
 * main monitor, the pixel Elena runs toward M.E.O.W. The road, the robots and the caption are
 * left as they are and are not drawn while the list is up, so that hideList() gives the cockpit
 * back as it was (D-147); a book chosen from the list clears them by its own opening. */
export function showList() {
  scene.list = true;
  scene.card = null;
  pieces.monitor.showList(tickNow);
  clock.resume();
}
/** Leave the list's scene without a boarding (Esc on the list, D-147; the gallery): the cockpit
 * as it was, with the main monitor dark. */
export function hideList() {
  scene.list = false;
  pieces.monitor.hide();
}
/** Elena boards (ST-25): resolves when the boarding has played (1.5 s: drawListScene ends it
 * at its 45th tick). */
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
  pieces.caption.set(
    display,
    targets.map((t) => ({ start: t.start, end: t.end, color: "#4aa8ff" })),
    lang,
  );
}
/** The light: `n` displayed characters are lit (ST-04). */
export function light(n, position = n) {
  pieces.caption.light(n);
  pieces.caption.setProgress(position); // the progress bars (D-132)
}
/** Take the caption's sentence away. */
export function clearCaption() {
  pieces.caption.clear();
}
/** Whether the song runs: Elena's hands type while it does. */
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
/** A jump: everything is taken off the road at once (§6.2). */
export function clearRoad() {
  pieces.battle.reset();
  scene.queue = [];
  scene.hit = new Set();
  scene.bossBlock = false;
}

/** A figure of the book on the main monitor (ST-19). `fig` is the figure of the book model
 * ({ kind: "table", table }, { kind: "canvas", canvas }, or a picture with `src`); `line` is the
 * label and page line. */
export async function figure(fig, line) {
  pieces.caption.clear();
  if (fig.kind === "table") pieces.monitor.showTable(fig.table, line, tickNow);
  else if (fig.kind === "canvas") pieces.monitor.showCanvas(fig.canvas, line, tickNow);
  else
    await pieces.monitor
      .showFigure(fig.src, line, () => tickNow)
      .catch(() => {
        // an image that cannot be read for the pass is skipped (G-W2, A-37)
      });
}
/** The main monitor shows nothing. */
export function hideMonitor() {
  pieces.monitor.hide();
}

/** A card over the cockpit: the clear (V-04) or the book's end. Resolves after `seconds` or a
 * click. `lines` are [text, big] pairs: a big line is the headline (24 px, gold, Misaki Mincho),
 * the others are 16 px, white, DotGothic16. */
export function card(lines, seconds) {
  scene.card = {
    t0: tickNow,
    lines: lines.map(([text, big]) =>
      textSprite(
        text,
        big ? 24 : 16,
        big ? "Misaki Mincho" : "DotGothic16",
        big ? "#ffcf3f" : "#ffffff",
      ),
    ),
  };
  return waitOrClick(Math.round(seconds * 30), () => (scene.card = null));
}

let endTheWait = null; // ends the wait of the launch or the card that is up, or null
/** Resolves after `ticks` of the cockpit's clock, at a click on the card, or at endWait(),
 * whichever comes first; `done()` is called then, once. A timer looks at the clock every 50 ms,
 * so a held clock holds the wait too. One wait at a time: a new one ends the one before. */
function waitOrClick(ticks, done) {
  endWait();
  return new Promise((resolve) => {
    const skip = document.getElementById("card-skip");
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      endTheWait = null;
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
    endTheWait = finish;
  });
}
/** End the launch or the card that is up at once (a jump, another book: D-151); nothing when
 * none is up. */
export function endWait() {
  if (endTheWait) endTheWait();
}

/** Hold the cockpit still (⏸, a drawer) or let it go on (ST-18). */
export function hold(on) {
  if (on) clock.pause();
  else clock.resume();
}

// ---------------------------------------------------------------- firing and the bomb
/** A press on 「発射」 or on the stage (D-61, D-83, D-100). `eventMs` is the event's timeStamp.
 * Nothing happens on the list, during the boarding, a launch or a card. Inside an open window the
 * target's robot is shot (and the boss with it in a boss block); outside every window one missile
 * misses (ST-29). */
export function press(eventMs) {
  if (scene.list || scene.card || scene.boarding || pieces.monitor.kind === "launch") return;
  const audio = options.audio();
  const heard = audio
    ? heardAt(audio.getOutputTimestamp ? audio.getOutputTimestamp() : null, eventMs, audio)
    : 0;
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
    const index = scene.queue.findIndex((target) => target.id === id);
    const target =
      index >= 0
        ? scene.queue.splice(index, 1)[0]
        : { id, label: (windows.find((one) => one.id === id) || {}).label };
    makeRoom();
    battle.send(target, tickNow, 8);
  }
  const shot = windows.find((one) => one.id === id) || {};
  battle.say(shoutFor(shot.label || "", shot.lang), tickNow); // ST-05
  battle.shoot(id, tickNow, countOne);
  if (scene.bossBlock) battle.bossHit(tickNow, countOne);
}

/** One more enemy is shot (a robot when its missile arrives, the boss when it falls): the bomb
 * counts it, at `tick` for its pulse, and the reader is told the count. */
function countOne(tick = tickNow) {
  pieces.bomb.add(1, tick);
  options.onCount(pieces.bomb.count);
}

/** The explosion of the count (ST-32). Returns { tier, level, seconds } or null. With
 * `road`, the lever's explosion also reaches the robots on the road (D-128). */
export function explode({ road = false } = {}) {
  const reached = level(pieces.bomb.count);
  const done = pieces.bomb.explode(tickNow);
  options.onCount(0);
  // the robots on the road are done for this block: none of them can be shot any more
  if (road) for (const id of pieces.battle.blastRoad(reached, tickNow)) scene.hit.add(id);
  return done;
}
/** The road stands still (the lever is down): no robot is sent and none rushes through its
 * window, while the explosion plays and the robots already out keep coming. This is the state;
 * setLever() is only the lever's picture and sound, and the reader calls both. */
export function setStopped(on) {
  scene.stopped = on;
}
/** The chapter-end explosion, which also strikes a boss still standing (D-102). Returns
 * { blast, bossLeft } with bossLeft the hit points left on a boss that did not fall (null when
 * it fell, when there was none, and in the last chapter, where the boss spins away). */
export function chapterBlast(lastChapter) {
  // the level is read first: explode() empties the count
  const reached = level(pieces.bomb.count),
    battle = pieces.battle,
    boss = battle.boss;
  const blast = explode();
  let bossLeft = null;
  if (boss && boss.alive && !boss.gone) {
    battle.bossBlast(reached, tickNow, countOne);
    if (boss.alive) {
      bossLeft = lastChapter ? null : boss.hp;
      battle.bossLeaves(tickNow + 20, lastChapter);
    }
  }
  return { blast, bossLeft };
}
/** Whether an explosion is still playing. */
export const blastBusy = () => pieces.bomb.busy(tickNow);
/** Cut the playing explosion short: it ends within 6 ticks. */
export const shortenBlast = () => pieces.bomb.shorten(tickNow);
/** Set the count of enemies shot without any sign (on opening the site). */
export function setCount(shot) {
  pieces.bomb.set(shot);
}

/** Make a place on the road: when 6 stand, the oldest whose window has closed leaves (G-W1);
 * when there is none, the oldest that was not shot; when all six were shot, none: they are
 * about to explode (D-149). */
function makeRoom() {
  const battle = pieces.battle,
    standing = battle.standing();
  if (standing.length < MAX_STANDING) return;
  const now = songNow(),
    windows = options.windows();
  const passed = standing.filter((enemy) => {
    const own = windows.find((each) => each.id === enemy.id);
    return scene.hit.has(enemy.id) ? false : !own || own.to < now;
  });
  const free = standing.filter((enemy) => !enemy.aimed);
  const oldest = (passed.length ? passed : free).sort((one, other) => one.born - other.born)[0];
  if (oldest) battle.leave([oldest.id], tickNow);
}

/** The song time that is being heard now (0 without a song). */
const songNow = () => {
  const audio = options.audio();
  return audio ? audio.currentTime - (audio.outputLatency || audio.baseLatency || 0) : 0;
};

/** When a robot comes (§6.4, D-140): a target's robot is sent from the far end only when its
 * window is NEAR seconds away, fast enough to reach shooting distance as the window opens. Robots
 * are not sent ahead to wait; at most 6 are on the road. */
function stream() {
  const battle = pieces.battle;
  if (!scene.queue.length) return;
  const windows = options.windows(),
    now = songNow();
  for (let index = 0; index < scene.queue.length; index++) {
    const own = windows.find((each) => each.id === scene.queue[index].id);
    if (!own || own.from - now >= NEAR) continue; // not yet: it appears when its time nears
    // the road is full: it comes when one is gone
    if (battle.standing().length >= MAX_STANDING) return;
    const [target] = scene.queue.splice(index, 1);
    battle.send(target, tickNow, Math.max(8, Math.round((own.from - now) * 30)));
    scene.sentAt = tickNow;
    return; // one a tick
  }
}

// ---------------------------------------------------------------- the 30-tick clock
/** One tick of the clock: everything moves on, then the five layers are painted. */
function tick(tickNumber) {
  tickNow = tickNumber;
  draw(tickNumber, update(tickNumber));
  for (const drawn of drawWaiters.splice(0)) drawn();
}

const drawWaiters = [];
/** Resolves when the next tick has been drawn: what the scene is now is then on the canvases
 * (the page waits for this before it takes the loading words away, ED D-164). */
export const afterNextDraw = () => new Promise((resolve) => drawWaiters.push(resolve));

/** Move on by one tick: the road and the battle, the next robot sent, and the robots and the
 * caption told which windows are open. Returns those windows. */
function update(tickNumber) {
  const { road, battle, caption } = pieces;
  const moving = !scene.list && !scene.boarding && !scene.stopped;
  road.move(moving ? 1 : 0);
  battle.tick(tickNumber);
  if (moving) stream();

  // the nouns in their window flash white, and their enemies wear brackets (ST-28); the robots
  // rush toward the cockpit through their window and are past Elena when it closes (D-125)
  const windows = options.windows ? options.windows() : [],
    heard = songNow(),
    open = openAt(windows, heard, scene.hit);
  for (const each of windows) knownWindows.set(each.id, { from: each.from, to: each.to });
  scene.canShoot = open.length > 0; // the missile button flashes (D-135)
  if (moving) {
    const progress = new Map();
    for (const [id, each] of knownWindows)
      progress.set(
        id,
        heard < each.from ? -1 : (heard - each.from) / Math.max(0.05, each.to - each.from),
      );
    battle.setRush(progress);
  }
  caption.setFlash(
    open.map((each) => each.display).filter(Boolean),
    Math.floor(tickNumber / 4) % 2 === 0,
  );
  return open;
}

/** Paint the five layers, back to front: the sky and the road; the robots and the explosion;
 * the cockpit and its console; then, on the text layer, the monitor, the signs, the caption,
 * the shout, the bomb, a card and the flash. `open`: the windows open now. */
function draw(tickNumber, open) {
  const { road, battle, caption, monitor, bomb, sky, sprites } = pieces;
  const shake = bomb.shake(tickNumber);
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
  if (inList) drawListScene(middle, tickNumber, sprites);
  else battle.drawWorld(middle, tickNumber);
  bomb.drawBlast(middle, tickNumber, road);
  middle.restore();

  const front = layer["w-front"];
  front.clearRect(0, 0, WORLD.w, WORLD.h);
  front.save();
  front.translate(shake.x, shake.y);
  if (!inList) {
    battle.drawCockpit(front, tickNumber, scene.singing);
    drawConsole(front, tickNumber);
  }
  front.restore();

  const words = layer["t-front"];
  words.clearRect(0, 0, TEXT.w, TEXT.h);
  monitor.draw(words, tickNumber);
  if (!inList) {
    // what belongs to the reading is kept and not drawn while the list is up (D-147)
    battle.drawSigns(words, new Set(open.map((each) => each.id)), tickNumber);
    caption.draw(words);
    battle.drawShouts(words, tickNumber);
  }
  if (!scene.list) bomb.drawIndicator(words, tickNumber);
  if (scene.card) drawCard(words, tickNumber);
  bomb.drawFlash(words, tickNumber, TEXT.w, TEXT.h);
}

// the lever (down: stop and bomb), the tick at which it last moved, and the tick at which the
// missile button was last lit
let leverDown = false,
  leverMovedAt = -99,
  missileLitAt = -99;
/** The console's controls (D-126, D-145): the blue missile of the launch button at the lower
 * right, which lights when lightMissile() is called (main.js, at a press), and the gear lever at
 * the lower left, up (going) or down (stop and bomb), above the bomb's picture. Drawn from simple
 * shapes in world pixels. */
function drawConsole(ctx, tickNumber) {
  // the missile: a blue body, a red nose, two fins, on a dark plate
  const missileX = MISSILE.x,
    missileY = MISSILE.y,
    lit = tickNumber - missileLitAt < 2,
    // a robot can be shot now (D-135)
    flash = scene.canShoot && Math.floor(tickNumber / 2) % 2 === 0;
  if (scene.canShoot) {
    // a ring of light around the plate while a window is open
    ctx.fillStyle = flash ? "#ffffff" : "#7fc4ff";
    ctx.fillRect(missileX - 4, missileY - 4, 44, 22);
  }
  ctx.fillStyle = "#14202c";
  ctx.fillRect(missileX - 2, missileY - 2, 40, 18);
  ctx.fillStyle = lit || flash ? "#ffffff" : scene.canShoot ? "#8fd0ff" : "#2f7fe0";
  ctx.fillRect(missileX + 6, missileY + 4, 24, 6);
  ctx.fillStyle = lit || flash ? "#ffffff" : "#7fc4ff";
  ctx.fillRect(missileX + 6, missileY + 4, 24, 2);
  ctx.fillStyle = "#e0402a";
  ctx.fillRect(missileX + 30, missileY + 5, 4, 4);
  ctx.fillStyle = "#1f5aa8";
  ctx.fillRect(missileX + 4, missileY + 1, 4, 3);
  ctx.fillRect(missileX + 4, missileY + 10, 4, 3);
  ctx.fillStyle = "#ffcf3f";
  if (Math.floor(tickNumber / 3) % 2) ctx.fillRect(missileX + 2, missileY + 6, 3, 2); // the flame
  // the gear lever: a slot, a stick and a knob; up is going, down is stop and bomb (D-145).
  // The slot's ends are marked: green at the top, red at the bottom, above the bomb.
  const leverX = LEVER.x,
    leverY = LEVER.y,
    slide = Math.min(1, (tickNumber - leverMovedAt) / 4),
    down = leverDown ? slide : 1 - slide,
    knobY = Math.round(leverY + 6 + down * 16);
  ctx.fillStyle = "#14202c";
  ctx.fillRect(leverX - 7, leverY - 4, 14, 34);
  ctx.fillStyle = "#3a4a58";
  ctx.fillRect(leverX - 2, leverY, 4, 26);
  ctx.fillStyle = "#3fe0a0";
  ctx.fillRect(leverX - 5, leverY - 3, 10, 2);
  ctx.fillStyle = "#e0402a";
  ctx.fillRect(leverX - 5, leverY + 27, 10, 2);
  // the play icon above the slot (D-152, A-40): a green triangle with a dark edge, bright while
  // the lever is up (going) and dim while it is down
  const playLeft = leverX - 4,
    playTop = leverY - 21;
  ctx.fillStyle = "#14202c";
  PLAY_ROWS.forEach((length, row) => ctx.fillRect(playLeft - 1, playTop + row - 1, length + 2, 3));
  ctx.fillStyle = leverDown ? "#1f7a5a" : "#3fe0a0";
  PLAY_ROWS.forEach((length, row) => ctx.fillRect(playLeft, playTop + row, length, 1));
  // a dotted red line from the slot's bottom end down to the bomb: down is the bomb (D-145)
  ctx.fillStyle = "#b02a3a";
  for (let y = leverY + 32; y < WORLD.h - 14; y += 4) ctx.fillRect(leverX - 1, y, 2, 2);
  ctx.fillStyle = "#8a96a0";
  // the stick, from the slot's middle
  ctx.fillRect(leverX - 1, Math.min(knobY, leverY + 13), 2, Math.abs(knobY - (leverY + 13)) + 1);
  ctx.fillStyle = leverDown ? "#e0402a" : "#3fe0a0";
  ctx.fillRect(leverX - 5, knobY - 5, 10, 8);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(leverX - 4, knobY - 4, 3, 2);
}
/** Move the lever: true is down (stop and bomb), false is up (going on). */
export function setLever(isDown) {
  if (leverDown === isDown) return;
  leverDown = isDown;
  leverMovedAt = tickNow;
  options.sfx("lever");
  const gear = document.getElementById("gear");
  if (gear) gear.setAttribute("aria-pressed", String(isDown));
}
/** Whether the lever is down (stop and bomb). */
export const lever = () => leverDown;
/** The enemies shot since the last explosion. */
export const count = () => pieces.bomb.count;
/** The missile button lights at a press. */
export function lightMissile() {
  missileLitAt = tickNow;
}

const particles = []; // of the list's scene: { a (its direction), r (how far out), v (its speed) }
/** The book list's scene (ST-24, ST-25; D-122): no cockpit, a black background, M.E.O.W far
 * ahead in the middle, turning, and the cheap pixel Elena running in place in the lower middle,
 * while particles spring from the middle and fly outward to show her speed. When a book is
 * chosen the particles rush, M.E.O.W grows as she reaches it, and she leaps aboard. At the 45th
 * tick of a boarding this also ends it: the list's scene is over and board()'s promise resolves. */
function drawListScene(ctx, tickNumber, sprites) {
  const { img, meta } = sprites.turn;
  const boarding = scene.boarding,
    age = boarding ? tickNumber - boarding.t0 : 0;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, WORLD.w, WORLD.h);
  // particles: born near the middle, flying outward, faster and larger as they go
  const speed = boarding ? 2 : 1,
    centerX = WORLD.w / 2,
    centerY = VANISH_Y;
  for (let k = 0; k < 3 * speed; k++)
    particles.push({
      a: Math.random() * Math.PI * 2,
      r: 2 + Math.random() * 8,
      v: 0.6 + Math.random() * 0.8,
    });
  for (const particle of particles) {
    particle.r += particle.v * speed * (1 + particle.r / 40);
    const x = centerX + Math.cos(particle.a) * particle.r,
      y = centerY + Math.sin(particle.a) * particle.r * 0.75,
      size = particle.r > 120 ? 3 : particle.r > 50 ? 2 : 1;
    ctx.fillStyle = particle.r > 90 ? "#c8f0ff" : "#6a8aa8";
    ctx.fillRect(Math.round(x), Math.round(y), size, size);
  }
  for (let k = particles.length - 1; k >= 0; k--) if (particles[k].r > 300) particles.splice(k, 1);
  // M.E.O.W far ahead; it grows as Elena reaches it
  let scale = 0.45 + 0.03 * Math.sin(tickNumber / 45),
    frameIndex = Math.floor(tickNumber / 2) % meta.frames;
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
  const width = Math.round(meta.w * scale),
    height = Math.round(meta.h * scale);
  ctx.drawImage(
    img,
    (frameIndex % meta.cols) * meta.w,
    Math.floor(frameIndex / meta.cols) * meta.h,
    meta.w,
    meta.h,
    centerX - Math.round(width / 2),
    MEOW_FEET - height,
    width,
    height,
  );
  // Elena, in place, running; she leaps up into the robot at the end of the boarding
  if (boarding && age > 30) {
    const leap = Math.min(1, (age - 30) / 10);
    if (leap < 1)
      drawRunner(
        ctx,
        centerX,
        Math.round(RUN_Y - leap * (RUN_Y - MEOW_FEET + 20)),
        Math.floor(tickNumber / 2) % 2,
        1 - leap * 0.5,
      );
    return;
  }
  drawRunner(ctx, centerX, RUN_Y, Math.floor(tickNumber / 4) % 2, 1);
}

/** A cheap pixel Elena, about 24 pixels tall, seen from behind as she runs toward M.E.O.W
 * (§8.1): long dusty-pink hair, pointed ears, a white lab coat. Drawn from rectangles. */
function drawRunner(ctx, x, y, step, scale) {
  const rect = (dx, dy, w, h, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(
      Math.round(x + dx * scale),
      Math.round(y + dy * scale),
      Math.max(1, Math.round(w * scale)),
      Math.max(1, Math.round(h * scale)),
    );
  };
  rect(-4, -24, 8, 4, "#d8879a"); // hair on top
  rect(-5, -21, 10, 9, "#d8879a"); // long hair down the back
  rect(-6, -20, 2, 2, "#f4c9a8"); // the pointed ears
  rect(4, -20, 2, 2, "#f4c9a8");
  rect(-4, -12, 8, 7, "#f4f1ff"); // the lab coat
  rect(-5, -6, 10, 2, "#e0dcf0");
  rect(step ? -6 : 4, -11, 2, 4, "#f4c9a8"); // the swinging arms
  rect(step ? 4 : -6, -10, 2, 3, "#f4c9a8");
  rect(-3, -4, 2, step ? 4 : 2, "#3a3040"); // the legs, in turn
  rect(1, -4, 2, step ? 2 : 4, "#3a3040");
}

/** The card: a dark panel in the middle that opens in 6 ticks, then its lines, centered. */
function drawCard(ctx, tickNumber) {
  const card = scene.card,
    open = Math.min(1, (tickNumber - card.t0) / 6),
    width = 520,
    lineHeight = 34,
    height = Math.round((card.lines.length * lineHeight + 40) * open),
    left = (TEXT.w - width) / 2,
    top = 150 + Math.round((card.lines.length * lineHeight + 40 - height) / 2);
  ctx.fillStyle = "#0b1a16";
  ctx.fillRect(left, top, width, height);
  ctx.fillStyle = "#3fe0a0";
  ctx.fillRect(left, top, width, 2);
  ctx.fillRect(left, top + height - 2, width, 2);
  if (open < 1) return;
  card.lines.forEach((line, index) =>
    drawOutlined(
      ctx,
      line.fill,
      line.ink,
      Math.round((TEXT.w - line.w) / 2),
      top + 20 + index * lineHeight,
    ),
  );
}

/** The gallery (?gallery=1, Q-21): set the count, or set off one tier at once. */
export const gallery = {
  count(n) {
    hideList();
    pieces.bomb.set(n);
  },
  blast(levelOfTier) {
    hideList();
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
    rushing: battle.enemies
      .filter((enemy) => enemy.rush > 0 && enemy.alive)
      .map((enemy) => [enemy.id, Math.round(enemy.rush * 100) / 100]),
    passed: battle.enemies.filter((enemy) => enemy.passed).length,
    canShoot: !!scene.canShoot,
    lever: leverDown ? "down" : "up",
    missileSides: battle.missiles.list.map((missile) =>
      Math.sign(missile.start ? missile.start.X : missile.p.X),
    ),
    leaving: battle.enemies.filter((enemy) => enemy.leftAt).length,
    queue: scene.queue.length,
    hit: [...scene.hit],
    boss: battle.boss
      ? { hp: battle.boss.hp, alive: battle.boss.alive, gone: !!battle.boss.gone }
      : null,
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
