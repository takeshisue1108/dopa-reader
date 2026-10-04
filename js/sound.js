// Sound effects (SPEC_dopa v3 §6.8, SD-W12; ED AS-01, A-33, D-81, D-92, D-111, D-131). The files
// are 効果音ラボ's, the ones the reader used before (D-131 returned to them from the synthesized
// sounds of D-112), by role, listed in data/sounds/index.json. Effects play in their own
// AudioContext, not the song's: the gear lever pushed back holds the song's context, and its
// explosion must still be heard. At most 3 ordinary effects sound at once, and a fourth replaces
// the oldest (D-81); explosions, the boss's fall and the fanfare have a louder bus of their own
// and are not limited (D-92).

const BASE = "data/sounds/";
const MAX_EFFECTS_AT_ONCE = 3;

const EFFECT_LEVEL = 0.5; // under the song (§6.8)
const LOUD_LEVEL = 1.0;

const LOUD = new Set(["boom_s", "boom_m", "boom_l", "boom_xl", "boom_max", "boss_fall", "fanfare"]);

// the effects' own AudioContext
let context = null;

// the bus of the ordinary effects
let effectBus = null;

// the louder bus of the explosions, the boss's fall and the fanfare
let loudBus = null;

// the promise of load()
let loading = null;

// the 「効果音」 setting, 0 to 1
let level = 0.8;

// role -> AudioBuffer
const buffers = new Map();

// the effects sounding now, oldest first
const sounding = [];

/** Make the context (inside a user's gesture on a phone) and load the effects (once). It may be
 * called at every gesture: a context that the browser has stopped is asked to run again. Returns
 * the promise of the load. */
export function init(setting = 0.8) {
  level = setting;

  if (!context) {
    context = new AudioContext();

    effectBus = context.createGain();
    loudBus = context.createGain();
    effectBus.connect(context.destination);
    loudBus.connect(context.destination);
    setLevel(level);

    loading = load();
  }

  if (context.state !== "running") {
    const resuming = context.resume();
    resuming.catch(() => {});
  }

  return loading;
}

/** Fetch and decode the sound of every role of index.json. Without the list no effect plays;
 * a file that cannot be loaded leaves its role silent. */
async function load() {
  let roles = {};
  try {
    const listUrl = BASE + "index.json";
    const response = await fetch(listUrl);
    const list = await response.json();
    roles = list.roles;
  } catch {
    return; // no effects: reading goes on silently
  }

  const loads = Object.entries(roles).map(async ([role, file]) => {
    try {
      const fileUrl = BASE + file;
      const response = await fetch(fileUrl);
      const data = await response.arrayBuffer();

      const buffer = await context.decodeAudioData(data);
      buffers.set(role, buffer);
    } catch {
      // a missing effect is silent
    }
  });

  await Promise.all(loads);
}

/** The 「効果音」 setting, 0 to 1: the ordinary effects follow it; the louder bus never goes
 * under 0.6 of its level, so that an explosion is heard at any setting. */
export function setLevel(setting) {
  level = setting;

  if (effectBus) {
    effectBus.gain.value = EFFECT_LEVEL * level;
  }

  if (loudBus) {
    const levelAtLeast = Math.max(level, 0.6);
    loudBus.gain.value = LOUD_LEVEL * levelAtLeast;
  }
}

/** Play the sound of a role; a role without a loaded sound is silent. A loud role is not
 * limited; of the others at most 3 sound at once, and one more stops the oldest. */
export function play(role) {
  if (!context) {
    return;
  }
  if (!buffers.has(role)) {
    return;
  }

  if (context.state !== "running") {
    const resuming = context.resume();
    resuming.catch(() => {});
  }

  const loud = LOUD.has(role);
  const bus = loud ? loudBus : effectBus;

  const source = context.createBufferSource();
  source.buffer = buffers.get(role);
  source.connect(bus);

  if (!loud) {
    while (sounding.length >= MAX_EFFECTS_AT_ONCE) {
      const oldest = sounding.shift();
      try {
        oldest.stop();
      } catch {
        // already ended
      }
    }

    sounding.push(source);

    source.onended = () => {
      const place = sounding.indexOf(source);
      if (place >= 0) {
        sounding.splice(place, 1);
      }
    };
  }

  source.start();
}
