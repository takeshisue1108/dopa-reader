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
const WORLD = { w: 426, h: 240 };
const TEXT = { w: 852, h: 480 };

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
const MISSILE = { x: 336, y: 192 };
const LEVER = { x: 44, y: 164 };
const BOMB = { x: 88, y: 472 };
const GO_HEIGHT = 22; // the play icon's button above the lever, in world pixels (D-152)

// the play icon: a triangle that points right, as the length of each of its 9 rows
const PLAY_ROWS = [1, 3, 5, 7, 9, 7, 5, 3, 1];

// the book list's scene (ST-24, D-122)
const RUN_Y = 234; // the pixel Elena's feet, at the bottom middle, in front
const MEOW_FEET = 196; // M.E.O.W far ahead, just under the list
const VANISH_Y = 176; // where the particles spring from: M.E.O.W

let frame = null; // the element #stage, which holds the canvases and the HTML over them
let layer = null; // the 2D context of each canvas, by its name in LAYERS
let pieces = null; // { road, battle, caption, monitor, bomb, sky, sprites, main }, made by build()
let loading = null; // the promise of load()
let tickNow = 0; // the number of the clock's last tick
let options = null; // what init() was given

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

const json = async (url) => {
  const response = await fetch(url);
  return response.json();
};

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
  if (!loading) {
    const spritesLoaded = loadSprites();
    loading = spritesLoaded.then(build);
  }
  return loading;
}

/** Fetch the two faces and every sprite. All are asked for at once, so their number is known
 * before the first arrives; each is counted in the group "page" as it arrives or fails, for the
 * bar of the loading words (ED D-163). Elena's poses, the relief turn and the boss may be
 * missing (null); any other file that is missing fails the load. */
async function loadSprites() {
  let asked = 0;
  let arrived = 0;

  const counted = (file) => {
    asked++;

    const settle = () => {
      arrived++;
      return progress.count("page", arrived, asked);
    };
    file.then(settle, settle);

    return file;
  };

  const image = (path) => {
    const loaded = loadImage(SPRITES + path);
    return counted(loaded);
  };
  const data = (path) => {
    const fetched = json(SPRITES + path);
    return counted(fetched);
  };

  /** A sprite sheet: its picture and what the picture holds. */
  const sheet = (name) => {
    const picture = image(`${name}.png`);
    const description = data(`${name}.json`);
    const both = Promise.all([picture, description]);
    return both.then(([img, meta]) => ({ img, meta }));
  };

  const gothicFace = document.fonts.load('16px "DotGothic16"');
  const gothicCounted = counted(gothicFace);
  const minchoFace = document.fonts.load('16px "Misaki Mincho"');
  const minchoCounted = counted(minchoFace);
  const fonts = [gothicCounted, minchoCounted];

  const pose = (name) => {
    const description = data(`elena/elena_${name}.json`);
    const bodyPicture = image(`elena/elena_${name}_body.png`);
    const leftHandPicture = image(`elena/elena_${name}_hand_l.png`);
    const rightHandPicture = image(`elena/elena_${name}_hand_r.png`);
    const all = Promise.all([description, bodyPicture, leftHandPicture, rightHandPicture]);

    const named = all.then(([meta, body, l, r]) => ({ meta, body, l, r }));
    return named.catch(() => null);
  };

  const optional = (sprite) => sprite.catch(() => null);

  const asking = {
    cockpit: image("cockpit.png"),
    elena: {
      back: pose("back"),
      fist: pose("fist"),
      button: pose("button"),
    },
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

  // everything is asked for: the whole count
  progress.count("page", arrived, asked);

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
  const whole = canvas(WORLD.w, WORLD.h);
  const ctx = ctx2d(whole);
  ctx.drawImage(cockpit, 0, 0);

  const pixels = ctx.getImageData(0, 0, WORLD.w, WORLD.h);
  const alpha = pixels.data;

  let left = WORLD.w;
  let top = WORLD.h;
  let right = 0;
  let bottom = 0;

  for (let y = 0; y < WORLD.h; y++) {
    for (let x = 0; x < WORLD.w; x++) {
      const pixel = y * WORLD.w + x;
      const alphaAt = pixel * 4 + 3;

      if (alpha[alphaAt] === 0) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  }

  const width = right - left + 1;
  const height = bottom - top + 1;
  return {
    x: left,
    y: top,
    w: width,
    h: height,
  };
}

/** Make the frame: the five canvases under the HTML of #stage, and the pieces at their places
 * (the caption just above Elena's picture, the main monitor in the upper middle); then start the
 * clock. */
function build(sprites) {
  frame = document.getElementById("stage");
  layer = {};

  for (const name of LAYERS) {
    const isWorldLayer = name.startsWith("w-");
    const size = isWorldLayer ? WORLD : TEXT;

    const element = canvas(size.w, size.h);
    element.dataset.layer = name;
    frame.prepend(element);

    layer[name] = ctx2d(element);
  }

  // the layers in order, back to front, under the HTML of the frame
  const frontToBack = [...LAYERS].reverse();
  for (const name of frontToBack) {
    const element = frame.querySelector(`canvas[data-layer="${name}"]`);
    frame.prepend(element);
  }

  frame.addEventListener("pointerdown", (event) => {
    const onControl = event.target.closest("button, .list, .card-skip, #gear, #controls");
    if (onControl) {
      return;
    }

    if (options.onStageTap) {
      options.onStageTap(event);
    }
  });

  addEventListener("resize", fit);
  // a tablet's browser shows and hides its bars without a resize of the window
  globalThis.visualViewport?.addEventListener("resize", fit);
  fit();

  const glass = glassOf(sprites.cockpit);
  const glassText = {
    x: glass.x * 2,
    y: glass.y * 2,
    w: glass.w * 2,
    h: glass.h * 2,
  };

  const road = new Road(glass, sprites.buildings);

  // the missiles' smoke is always full: there is no effect level (ED D-120)
  const battle = new Battle({
    road,
    sprites,
    sfx: (role) => options.sfx(role),
    smoke: () => true,
  });

  const lines = 3;
  const lineHeight = 30;
  const elenaTop = sprites.elena.back.meta.body[1];
  const captionBottom = elenaTop * 2 - 4;
  const captionHeight = lines * lineHeight;
  const captionInset = Math.round(glassText.w * 0.08);
  const captionWidth = Math.round(glassText.w * 0.84);

  const caption = new Caption({
    x: glassText.x + captionInset,
    y: captionBottom - captionHeight,
    w: captionWidth,
    h: captionHeight,
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

  const bomb = new Bomb({
    place: BOMB,
    flash: allowFlash,
    sfx: (role) => options.sfx(role),
  });

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
  const pct = (value, whole) => {
    const percent = (value / whole) * 100;
    return `${percent}%`;
  };

  /** Lay the element over a rectangle of a layer (the world's pixels, or the text layer's). */
  const lay = (id, x, y, width, height, layer = WORLD) => {
    const style = document.getElementById(id).style;

    const place = {
      left: pct(x, layer.w),
      top: pct(y, layer.h),
      width: pct(width, layer.w),
      height: pct(height, layer.h),
    };
    return Object.assign(style, place);
  };

  lay("fire", MISSILE.x - 6, MISSILE.y - 8, 52, 34);

  // the play icon's button: the strip above the lever (D-152)
  const goTop = LEVER.y - 8 - GO_HEIGHT;
  lay("go", LEVER.x - 16, goTop, 32, GO_HEIGHT);

  lay("gear", LEVER.x - 16, LEVER.y - 8, 32, 38);

  // the bomb's button: from under the lever to the bottom edge (the bomb grows upward from BOMB.y)
  const bombButtonHeight = WORLD.h - LEVER.y - 30;
  lay("bomb", LEVER.x - 20, LEVER.y + 30, 40, bombButtonHeight);

  const main = pieces.main;
  lay("list", main.x + 8, main.y + 8, main.w - 16, main.h - 16, TEXT);
}

/** Fit the frame to the browser's window, keeping 426 : 240 (ED D-162: one frame, scaled as a
 * whole). `--px`, the size of one text-layer pixel, is written on the page's root: everything in
 * the frame is measured in it, and the drawers and boxes outside it too. */
function fit() {
  const scaleOfWidth = innerWidth / WORLD.w;
  const scaleOfHeight = innerHeight / WORLD.h;
  const scale = Math.min(scaleOfWidth, scaleOfHeight);

  const frameWidthPx = Math.floor(WORLD.w * scale);
  frame.style.width = frameWidthPx + "px";

  const frameHeightPx = Math.floor(WORLD.h * scale);
  frame.style.height = frameHeightPx + "px";

  const textPixelPx = scale / 2;
  document.documentElement.style.setProperty("--px", `${textPixelPx}px`);
}

/** At most 2 large flashes a second, across everything (ED-10, SC-W08). */
function allowFlash() {
  const now = performance.now();

  // forget the flashes of more than a second ago
  while (flashTimes.length && now - flashTimes[0] > 1000) {
    flashTimes.shift();
  }
  if (flashTimes.length >= 2) {
    return false;
  }

  flashTimes.push(now);

  flashLog.push(now);
  if (flashLog.length > 200) {
    flashLog.shift();
  }

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

  return new Promise((resolve) => {
    scene.boarding = {
      t0: tickNow,
      resolve,
    };
  });
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

  const hideTheHeading = () => {
    if (pieces.monitor.kind === "quote") {
      pieces.monitor.hide();
    }
  };
  setTimeout(hideTheHeading, 1500);
}

/** A new sentence on the caption (ST-03); `targets` are display spans shown blue (D-124). */
export function sentence(display, lang, targets = []) {
  const blueSpans = targets.map((t) => ({
    start: t.start,
    end: t.end,
    color: "#4aa8ff",
  }));

  pieces.caption.set(display, blueSpans, lang);
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

  const hasBoss = boss !== null && boss > 0;
  if (hasBoss && targets.length) {
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

  if (fig.kind === "table") {
    pieces.monitor.showTable(fig.table, line, tickNow);
  } else if (fig.kind === "canvas") {
    pieces.monitor.showCanvas(fig.canvas, line, tickNow);
  } else {
    const shown = pieces.monitor.showFigure(fig.src, line, () => tickNow);

    await shown.catch(() => {
      // an image that cannot be read for the pass is skipped (G-W2, A-37)
    });
  }
}

/** The main monitor shows nothing. */
export function hideMonitor() {
  pieces.monitor.hide();
}

/** A card over the cockpit: the clear (V-04) or the book's end. Resolves after `seconds` or a
 * click. `lines` are [text, big] pairs: a big line is the headline (24 px, gold, Misaki Mincho),
 * the others are 16 px, white, DotGothic16. */
export function card(lines, seconds) {
  const lineSprites = lines.map(([text, big]) => {
    const size = big ? 24 : 16;
    const font = big ? "Misaki Mincho" : "DotGothic16";
    const color = big ? "#ffcf3f" : "#ffffff";
    return textSprite(text, size, font, color);
  });

  scene.card = {
    t0: tickNow,
    lines: lineSprites,
  };

  const ticks = Math.round(seconds * 30);
  return waitOrClick(ticks, () => {
    scene.card = null;
  });
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
      if (finished) {
        return;
      }
      finished = true;

      endTheWait = null;
      skip.hidden = true;
      skip.onclick = null;
      clearInterval(timer);

      done();
      resolve();
    };

    const t0 = tickNow;
    const timer = setInterval(() => {
      const waitedTicks = tickNow - t0;
      if (waitedTicks >= ticks) {
        finish();
      }
    }, 50);

    skip.hidden = false;
    skip.onclick = finish;
    endTheWait = finish;
  });
}

/** End the launch or the card that is up at once (a jump, another book: D-151); nothing when
 * none is up. */
export function endWait() {
  if (endTheWait) {
    endTheWait();
  }
}

/** Hold the cockpit still (⏸, a drawer) or let it go on (ST-18). */
export function hold(on) {
  if (on) {
    clock.pause();
  } else {
    clock.resume();
  }
}

// ---------------------------------------------------------------- firing and the bomb
/** A press on 「発射」 or on the stage (D-61, D-83, D-100). `eventMs` is the event's timeStamp.
 * Nothing happens on the list, during the boarding, a launch or a card. Inside an open window the
 * target's robot is shot (and the boss with it in a boss block); outside every window one missile
 * misses (ST-29). */
export function press(eventMs) {
  const somethingElseIsUp = scene.list || scene.card || scene.boarding;
  if (somethingElseIsUp) {
    return;
  }
  if (pieces.monitor.kind === "launch") {
    return;
  }

  const audio = options.audio();
  let heard = 0;
  if (audio) {
    let stamp = null;
    if (audio.getOutputTimestamp) {
      stamp = audio.getOutputTimestamp();
    }
    heard = heardAt(stamp, eventMs, audio);
  }

  const windows = options.windows();
  const id = judge(windows, heard, scene.hit);

  const battle = pieces.battle;
  if (!id) {
    battle.miss(tickNow); // ST-29
    return;
  }

  scene.hit.add(id);

  if (!battle.enemyOf(id)) {
    // its enemy has not come yet (a crowded block): it comes now and is hit at once
    const index = scene.queue.findIndex((target) => target.id === id);

    let target;
    if (index >= 0) {
      const taken = scene.queue.splice(index, 1);
      target = taken[0];
    } else {
      const own = windows.find((one) => one.id === id) || {};
      target = {
        id,
        label: own.label,
      };
    }

    makeRoom();
    battle.send(target, tickNow, 8);
  }

  const shot = windows.find((one) => one.id === id) || {};
  const label = shot.label || "";
  const shout = shoutFor(label, shot.lang);
  battle.say(shout, tickNow); // ST-05

  battle.shoot(id, tickNow, countOne);
  if (scene.bossBlock) {
    battle.bossHit(tickNow, countOne);
  }
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
  if (road) {
    const blasted = pieces.battle.blastRoad(reached, tickNow);
    for (const id of blasted) {
      scene.hit.add(id);
    }
  }

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
  const reached = level(pieces.bomb.count);
  const battle = pieces.battle;
  const boss = battle.boss;

  const blast = explode();

  let bossLeft = null;
  const bossStillStands = boss && boss.alive && !boss.gone;
  if (bossStillStands) {
    battle.bossBlast(reached, tickNow, countOne);

    if (boss.alive) {
      if (lastChapter) {
        bossLeft = null;
      } else {
        bossLeft = boss.hp;
      }
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
  const battle = pieces.battle;
  const standing = battle.standing();
  if (standing.length < MAX_STANDING) {
    return;
  }

  const now = songNow();
  const windows = options.windows();

  const passed = standing.filter((enemy) => {
    const own = windows.find((each) => each.id === enemy.id);

    if (scene.hit.has(enemy.id)) {
      return false;
    }
    return !own || own.to < now;
  });

  const free = standing.filter((enemy) => !enemy.aimed);

  const candidates = passed.length ? passed : free;
  const oldestFirst = candidates.sort((one, other) => one.born - other.born);
  const oldest = oldestFirst[0];

  if (oldest) {
    battle.leave([oldest.id], tickNow);
  }
}

/** The song time that is being heard now (0 without a song). */
const songNow = () => {
  const audio = options.audio();
  if (!audio) {
    return 0;
  }

  const contextSeconds = audio.currentTime;
  const latencySeconds = audio.outputLatency || audio.baseLatency || 0;
  return contextSeconds - latencySeconds;
};

/** When a robot comes (§6.4, D-140): a target's robot is sent from the far end only when its
 * window is NEAR seconds away, fast enough to reach shooting distance as the window opens. Robots
 * are not sent ahead to wait; at most 6 are on the road. */
function stream() {
  const battle = pieces.battle;
  if (!scene.queue.length) {
    return;
  }

  const windows = options.windows();
  const now = songNow();

  for (let index = 0; index < scene.queue.length; index++) {
    const queued = scene.queue[index];
    const own = windows.find((each) => each.id === queued.id);

    // not yet: it appears when its time nears
    if (!own) {
      continue;
    }
    const secondsToWindow = own.from - now;
    if (secondsToWindow >= NEAR) {
      continue;
    }

    // the road is full: it comes when one is gone
    if (battle.standing().length >= MAX_STANDING) {
      return;
    }

    const [target] = scene.queue.splice(index, 1);

    const ticksToWindow = Math.round(secondsToWindow * 30);
    const travelTicks = Math.max(8, ticksToWindow);
    battle.send(target, tickNow, travelTicks);

    scene.sentAt = tickNow;
    return; // one a tick
  }
}

// ---------------------------------------------------------------- the 30-tick clock
/** One tick of the clock: everything moves on, then the five layers are painted. */
function tick(tickNumber) {
  tickNow = tickNumber;

  const open = update(tickNumber);
  draw(tickNumber, open);

  const waiters = drawWaiters.splice(0);
  for (const drawn of waiters) {
    drawn();
  }
}

const drawWaiters = [];

/** Resolves when the next tick has been drawn: what the scene is now is then on the canvases
 * (the page waits for this before it takes the loading words away, ED D-164). */
export const afterNextDraw = () => {
  return new Promise((resolve) => {
    drawWaiters.push(resolve);
  });
};

/** Move on by one tick: the road and the battle, the next robot sent, and the robots and the
 * caption told which windows are open. Returns those windows. */
function update(tickNumber) {
  const { road, battle, caption } = pieces;
  const moving = !scene.list && !scene.boarding && !scene.stopped;

  const speedFactor = moving ? 1 : 0;
  road.move(speedFactor);
  battle.tick(tickNumber);
  if (moving) {
    stream();
  }

  // the nouns in their window flash white, and their enemies wear brackets (ST-28); the robots
  // rush toward the cockpit through their window and are past Elena when it closes (D-125)
  let windows = [];
  if (options.windows) {
    windows = options.windows();
  }
  const heard = songNow();
  const open = openAt(windows, heard, scene.hit);

  for (const each of windows) {
    const span = {
      from: each.from,
      to: each.to,
    };
    knownWindows.set(each.id, span);
  }

  scene.canShoot = open.length > 0; // the missile button flashes (D-135)

  if (moving) {
    const progress = new Map();

    for (const [id, each] of knownWindows) {
      // how far the song is through the window: -1 before it opens, 0 to 1 inside, more after
      let through;
      if (heard < each.from) {
        through = -1;
      } else {
        const sinceOpened = heard - each.from;
        const windowSeconds = Math.max(0.05, each.to - each.from);
        through = sinceOpened / windowSeconds;
      }
      progress.set(id, through);
    }

    battle.setRush(progress);
  }

  const openDisplays = open.map((each) => each.display);
  const flashing = openDisplays.filter(Boolean);
  const flashIsOn = Math.floor(tickNumber / 4) % 2 === 0;
  caption.setFlash(flashing, flashIsOn);

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
  if (inList) {
    drawListScene(middle, tickNumber, sprites);
  } else {
    battle.drawWorld(middle, tickNumber);
  }
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
    const openIds = open.map((each) => each.id);
    const openIdSet = new Set(openIds);
    battle.drawSigns(words, openIdSet, tickNumber);

    caption.draw(words);
    battle.drawShouts(words, tickNumber);
  }
  if (!scene.list) {
    bomb.drawIndicator(words, tickNumber);
  }
  if (scene.card) {
    drawCard(words, tickNumber);
  }
  bomb.drawFlash(words, tickNumber, TEXT.w, TEXT.h);
}

// the lever (down: stop and bomb), the tick at which it last moved, and the tick at which the
// missile button was last lit
let leverDown = false;
let leverMovedAt = -99;
let missileLitAt = -99;

/** The console's controls (D-126, D-145): the blue missile of the launch button at the lower
 * right, which lights when lightMissile() is called (main.js, at a press), and the gear lever at
 * the lower left, up (going) or down (stop and bomb), above the bomb's picture. Drawn from simple
 * shapes in world pixels. */
function drawConsole(ctx, tickNumber) {
  // the missile: a blue body, a red nose, two fins, on a dark plate
  const missileX = MISSILE.x;
  const missileY = MISSILE.y;
  const lit = tickNumber - missileLitAt < 2;

  // a robot can be shot now (D-135)
  const blinkIsOn = Math.floor(tickNumber / 2) % 2 === 0;
  const flash = scene.canShoot && blinkIsOn;

  if (scene.canShoot) {
    // a ring of light around the plate while a window is open
    ctx.fillStyle = flash ? "#ffffff" : "#7fc4ff";
    ctx.fillRect(missileX - 4, missileY - 4, 44, 22);
  }

  ctx.fillStyle = "#14202c";
  ctx.fillRect(missileX - 2, missileY - 2, 40, 18);

  const isWhite = lit || flash;

  let bodyColor;
  if (isWhite) {
    bodyColor = "#ffffff";
  } else if (scene.canShoot) {
    bodyColor = "#8fd0ff";
  } else {
    bodyColor = "#2f7fe0";
  }
  ctx.fillStyle = bodyColor;
  ctx.fillRect(missileX + 6, missileY + 4, 24, 6);

  ctx.fillStyle = isWhite ? "#ffffff" : "#7fc4ff";
  ctx.fillRect(missileX + 6, missileY + 4, 24, 2);

  ctx.fillStyle = "#e0402a";
  ctx.fillRect(missileX + 30, missileY + 5, 4, 4);

  ctx.fillStyle = "#1f5aa8";
  ctx.fillRect(missileX + 4, missileY + 1, 4, 3);
  ctx.fillRect(missileX + 4, missileY + 10, 4, 3);

  // the flame
  ctx.fillStyle = "#ffcf3f";
  const flameIsOut = Math.floor(tickNumber / 3) % 2;
  if (flameIsOut) {
    ctx.fillRect(missileX + 2, missileY + 6, 3, 2);
  }

  // the gear lever: a slot, a stick and a knob; up is going, down is stop and bomb (D-145).
  // The slot's ends are marked: green at the top, red at the bottom, above the bomb.
  const leverX = LEVER.x;
  const leverY = LEVER.y;

  const ticksSinceMoved = tickNumber - leverMovedAt;
  const slide = Math.min(1, ticksSinceMoved / 4);

  let down;
  if (leverDown) {
    down = slide;
  } else {
    down = 1 - slide;
  }

  const knobTravel = down * 16;
  const knobY = Math.round(leverY + 6 + knobTravel);

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
  const playLeft = leverX - 4;
  const playTop = leverY - 21;

  ctx.fillStyle = "#14202c";
  PLAY_ROWS.forEach((length, row) => {
    ctx.fillRect(playLeft - 1, playTop + row - 1, length + 2, 3);
  });

  ctx.fillStyle = leverDown ? "#1f7a5a" : "#3fe0a0";
  PLAY_ROWS.forEach((length, row) => {
    ctx.fillRect(playLeft, playTop + row, length, 1);
  });

  // a dotted red line from the slot's bottom end down to the bomb: down is the bomb (D-145)
  ctx.fillStyle = "#b02a3a";
  for (let y = leverY + 32; y < WORLD.h - 14; y += 4) {
    ctx.fillRect(leverX - 1, y, 2, 2);
  }

  ctx.fillStyle = "#8a96a0";
  // the stick, from the slot's middle
  const slotMiddleY = leverY + 13;
  const stickTop = Math.min(knobY, slotMiddleY);
  const stickLength = Math.abs(knobY - slotMiddleY) + 1;
  ctx.fillRect(leverX - 1, stickTop, 2, stickLength);

  ctx.fillStyle = leverDown ? "#e0402a" : "#3fe0a0";
  ctx.fillRect(leverX - 5, knobY - 5, 10, 8);

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(leverX - 4, knobY - 4, 3, 2);
}

/** Move the lever: true is down (stop and bomb), false is up (going on). */
export function setLever(isDown) {
  if (leverDown === isDown) {
    return;
  }

  leverDown = isDown;
  leverMovedAt = tickNow;
  options.sfx("lever");

  const gear = document.getElementById("gear");
  if (gear) {
    gear.setAttribute("aria-pressed", String(isDown));
  }
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
  const boarding = scene.boarding;

  let age = 0;
  if (boarding) {
    age = tickNumber - boarding.t0;
  }

  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, WORLD.w, WORLD.h);

  // particles: born near the middle, flying outward, faster and larger as they go
  const speed = boarding ? 2 : 1;
  const centerX = WORLD.w / 2;
  const centerY = VANISH_Y;

  for (let k = 0; k < 3 * speed; k++) {
    const direction = Math.random() * Math.PI * 2;
    const distance = 2 + Math.random() * 8;
    const ownSpeed = 0.6 + Math.random() * 0.8;

    particles.push({
      a: direction,
      r: distance,
      v: ownSpeed,
    });
  }

  for (const particle of particles) {
    const stepOutward = particle.v * speed * (1 + particle.r / 40);
    particle.r += stepOutward;

    const x = centerX + Math.cos(particle.a) * particle.r;
    const y = centerY + Math.sin(particle.a) * particle.r * 0.75;

    let size;
    if (particle.r > 120) {
      size = 3;
    } else if (particle.r > 50) {
      size = 2;
    } else {
      size = 1;
    }

    const pixelX = Math.round(x);
    const pixelY = Math.round(y);
    ctx.fillStyle = particle.r > 90 ? "#c8f0ff" : "#6a8aa8";
    ctx.fillRect(pixelX, pixelY, size, size);
  }

  for (let k = particles.length - 1; k >= 0; k--) {
    if (particles[k].r > 300) {
      particles.splice(k, 1);
    }
  }

  // M.E.O.W far ahead; it grows as Elena reaches it
  let scale = 0.45 + 0.03 * Math.sin(tickNumber / 45);
  let frameIndex = Math.floor(tickNumber / 2) % meta.frames;

  if (boarding) {
    const approach = Math.min(1, age / 30);
    scale = 0.48 + approach * 1.2;

    if (age >= 45) {
      const done = scene.boarding;
      scene.boarding = null;
      scene.list = false;
      particles.length = 0;
      done.resolve();
    }
  }

  const width = Math.round(meta.w * scale);
  const height = Math.round(meta.h * scale);

  const sheetColumn = frameIndex % meta.cols;
  const sheetRow = Math.floor(frameIndex / meta.cols);
  const sheetX = sheetColumn * meta.w;
  const sheetY = sheetRow * meta.h;

  const meowLeft = centerX - Math.round(width / 2);
  const meowTop = MEOW_FEET - height;
  ctx.drawImage(img, sheetX, sheetY, meta.w, meta.h, meowLeft, meowTop, width, height);

  // Elena, in place, running; she leaps up into the robot at the end of the boarding
  if (boarding && age > 30) {
    const leap = Math.min(1, (age - 30) / 10);

    if (leap < 1) {
      const leapHeight = leap * (RUN_Y - MEOW_FEET + 20);
      const runnerY = Math.round(RUN_Y - leapHeight);
      const step = Math.floor(tickNumber / 2) % 2;
      const runnerScale = 1 - leap * 0.5;
      drawRunner(ctx, centerX, runnerY, step, runnerScale);
    }
    return;
  }

  const step = Math.floor(tickNumber / 4) % 2;
  drawRunner(ctx, centerX, RUN_Y, step, 1);
}

/** A cheap pixel Elena, about 24 pixels tall, seen from behind as she runs toward M.E.O.W
 * (§8.1): long dusty-pink hair, pointed ears, a white lab coat. Drawn from rectangles. */
function drawRunner(ctx, x, y, step, scale) {
  const rect = (dx, dy, w, h, color) => {
    ctx.fillStyle = color;

    const left = Math.round(x + dx * scale);
    const top = Math.round(y + dy * scale);
    const scaledWidth = Math.round(w * scale);
    const scaledHeight = Math.round(h * scale);
    // never thinner than one pixel
    const width = Math.max(1, scaledWidth);
    const height = Math.max(1, scaledHeight);

    ctx.fillRect(left, top, width, height);
  };

  rect(-4, -24, 8, 4, "#d8879a"); // hair on top
  rect(-5, -21, 10, 9, "#d8879a"); // long hair down the back
  rect(-6, -20, 2, 2, "#f4c9a8"); // the pointed ears
  rect(4, -20, 2, 2, "#f4c9a8");
  rect(-4, -12, 8, 7, "#f4f1ff"); // the lab coat
  rect(-5, -6, 10, 2, "#e0dcf0");

  // the swinging arms
  const firstArmX = step ? -6 : 4;
  const secondArmX = step ? 4 : -6;
  rect(firstArmX, -11, 2, 4, "#f4c9a8");
  rect(secondArmX, -10, 2, 3, "#f4c9a8");

  // the legs, in turn
  const leftLegHeight = step ? 4 : 2;
  const rightLegHeight = step ? 2 : 4;
  rect(-3, -4, 2, leftLegHeight, "#3a3040");
  rect(1, -4, 2, rightLegHeight, "#3a3040");
}

/** The card: a dark panel in the middle that opens in 6 ticks, then its lines, centered. */
function drawCard(ctx, tickNumber) {
  const card = scene.card;

  const ticksUp = tickNumber - card.t0;
  const open = Math.min(1, ticksUp / 6);

  const width = 520;
  const lineHeight = 34;
  const fullHeight = card.lines.length * lineHeight + 40;
  const height = Math.round(fullHeight * open);

  const left = (TEXT.w - width) / 2;
  const aboveAndBelow = fullHeight - height;
  const top = 150 + Math.round(aboveAndBelow / 2);

  ctx.fillStyle = "#0b1a16";
  ctx.fillRect(left, top, width, height);

  ctx.fillStyle = "#3fe0a0";
  ctx.fillRect(left, top, width, 2);
  ctx.fillRect(left, top + height - 2, width, 2);

  if (open < 1) {
    return;
  }

  card.lines.forEach((line, index) => {
    const lineLeft = Math.round((TEXT.w - line.w) / 2);
    const lineTop = top + 20 + index * lineHeight;
    return drawOutlined(ctx, line.fill, line.ink, lineLeft, lineTop);
  });
}

/** The gallery (?gallery=1, Q-21): set the count, or set off one tier at once. */
export const gallery = {
  count(n) {
    hideList();
    pieces.bomb.set(n);
  },

  blast(levelOfTier) {
    hideList();

    const firstCount = levelStartOf(levelOfTier);
    pieces.bomb.set(firstCount);

    return pieces.bomb.explode(tickNow);
  },

  leaveSpin() {
    const sample = {
      id: "g" + tickNow,
      label: "見本",
    };
    pieces.battle.send(sample, tickNow, 20);

    setTimeout(() => pieces.battle.leave(null, tickNow), 1200);
  },
};

/** For checks: what the cockpit shows. */
export function debug() {
  if (!pieces) {
    return null;
  }
  const battle = pieces.battle;

  const standingEnemies = battle.standing();
  const standingIds = standingEnemies.map((enemy) => enemy.id);

  const rushingEnemies = battle.enemies.filter((enemy) => enemy.rush > 0 && enemy.alive);
  const rushing = rushingEnemies.map((enemy) => {
    const toHundredths = Math.round(enemy.rush * 100) / 100;
    return [enemy.id, toHundredths];
  });

  const passedEnemies = battle.enemies.filter((enemy) => enemy.passed);

  const missileSides = battle.missiles.list.map((missile) => {
    let sideX;
    if (missile.start) {
      sideX = missile.start.X;
    } else {
      sideX = missile.p.X;
    }
    return Math.sign(sideX);
  });

  const leavingEnemies = battle.enemies.filter((enemy) => enemy.leftAt);

  let boss = null;
  if (battle.boss) {
    boss = {
      hp: battle.boss.hp,
      alive: battle.boss.alive,
      gone: !!battle.boss.gone,
    };
  }

  let blast = null;
  if (pieces.bomb.blast) {
    blast = pieces.bomb.blast.tier;
  }

  return {
    tick: tickNow,
    list: scene.list,
    card: !!scene.card,
    monitor: pieces.monitor.kind,
    standing: standingIds,
    rushing,
    passed: passedEnemies.length,
    canShoot: !!scene.canShoot,
    lever: leverDown ? "down" : "up",
    missileSides,
    leaving: leavingEnemies.length,
    queue: scene.queue.length,
    hit: [...scene.hit],
    boss,
    count: pieces.bomb.count,
    blast,
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
