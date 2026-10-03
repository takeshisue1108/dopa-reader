// Sound effects (SPEC_dopa v3 §6.8, SD-W12; ED AS-01, A-33, D-81, D-92, D-111, D-131). The files
// are 効果音ラボ's, the ones the reader used before (D-131 returned to them from the synthesized
// sounds of D-112), by role, listed in data/sounds/index.json. Effects play in their own
// AudioContext, not the song's: the gear lever pushed back holds the song's context, and its
// explosion must still be heard. At most 3 effects sound at once, and a fourth replaces the
// oldest (D-81); explosions, the boss's fall and the fanfare have a louder bus of their own (D-92).

const BASE = "data/sounds/";
const VOICES = 3;
const EFFECT_LEVEL = 0.5, // under the song (§6.8)
  BLAST_LEVEL = 1.0;
const LOUD = new Set(["boom_s", "boom_m", "boom_l", "boom_xl", "boom_max", "boss_fall", "fanfare"]);

let context = null,
  effects = null,
  blasts = null,
  loading = null,
  level = 0.8;
const buffers = new Map(); // role -> AudioBuffer
const playing = []; // the effects sounding now, oldest first

/** Make the context (inside a user's gesture on a phone) and load the effects (once). */
export function init(setting = 0.8) {
  level = setting;
  if (!context) {
    context = new AudioContext();
    effects = context.createGain();
    blasts = context.createGain();
    effects.connect(context.destination);
    blasts.connect(context.destination);
    setLevel(level);
    loading = load();
  }
  if (context.state !== "running") context.resume().catch(() => {});
  return loading;
}

async function load() {
  let roles = {};
  try {
    roles = (await (await fetch(BASE + "index.json")).json()).roles;
  } catch {
    return; // no effects: reading goes on silently
  }
  await Promise.all(
    Object.entries(roles).map(async ([role, file]) => {
      try {
        const data = await (await fetch(BASE + file)).arrayBuffer();
        buffers.set(role, await context.decodeAudioData(data));
      } catch {
        // a missing effect is silent
      }
    }),
  );
}

/** The 「効果音」 setting, 0 to 1. */
export function setLevel(setting) {
  level = setting;
  if (effects) effects.gain.value = EFFECT_LEVEL * level;
  if (blasts) blasts.gain.value = BLAST_LEVEL * Math.max(level, 0.6);
}

/** Play the sound of a role. */
export function play(role) {
  if (!context || !buffers.has(role)) return;
  if (context.state !== "running") context.resume().catch(() => {});
  const loud = LOUD.has(role);
  const source = context.createBufferSource();
  source.buffer = buffers.get(role);
  source.connect(loud ? blasts : effects);
  if (!loud) {
    while (playing.length >= VOICES) {
      const oldest = playing.shift();
      try {
        oldest.stop();
      } catch {
        // already ended
      }
    }
    playing.push(source);
    source.onended = () => {
      const at = playing.indexOf(source);
      if (at >= 0) playing.splice(at, 1);
    };
  }
  source.start();
}
