// The instrument notes of the accompaniment in the browser: the General MIDI sounds of the Day Life
// score, one sheet per program and one for the drum kit, fetched from this machine, decoded and
// kept (SPEC_dopa v3.9 §6.11; SPEC_sing §5.6, §7.2; 歌 ED D-37).
const BASE = "data/sing/instruments/";
const INDEX = "daylife.json"; // made by tools/sing/build_instruments.py

let context = null, // the AudioContext that decodes the sheets
  index = null; // daylife.json: for each program its sheet, its range of pitches and its window; the drum kit
const sheets = new Map(); // program number, or "drums" -> AudioBuffer
const loading = new Map(); // the same -> Promise

/** Take the AudioContext and load the index (once). Returns the index, or null when this machine
 * has no instrument files: the song is then sung without accompaniment. */
export async function init(audioContext) {
  context = audioContext;
  if (!index) {
    const response = await fetch(BASE + INDEX).catch(() => null);
    index = response && response.ok ? await response.json() : null;
  }
  return index;
}

/** Have every sheet loaded; resolves when all are. A sheet that cannot be fetched stays silent. */
export function ensure() {
  if (!index) return Promise.resolve();
  const entries = Object.entries(index.programs);
  if (index.drums) entries.push(["drums", index.drums]);
  const jobs = [];
  for (const [name, entry] of entries) {
    if (sheets.has(name)) continue;
    if (!loading.has(name)) {
      loading.set(
        name,
        fetch(BASE + entry.file)
          .then((response) => {
            if (!response.ok) throw new Error(`instruments: ${entry.file} ${response.status}`);
            return response.arrayBuffer();
          })
          .then((data) => context.decodeAudioData(data))
          .then((buffer) => sheets.set(name, buffer))
          .catch((error) => console.warn(String(error)))
          .finally(() => loading.delete(name)),
      );
    }
    jobs.push(loading.get(name));
  }
  return Promise.all(jobs);
}

/**
 * The note of a General MIDI program at a pitch: its sheet, the start of its window in the sheet,
 * where in the window the sound starts, the window's length (all in seconds), and the pitch
 * played. A pitch outside the sheet's range is played in the nearest octave inside it. null when
 * the program has no sheet in memory.
 */
export function note(program, midi) {
  const entry = index?.programs[String(program)];
  const buffer = sheets.get(String(program));
  if (!entry || !buffer) return null;
  let pitch = midi;
  while (pitch < entry.lo) pitch += 12;
  while (pitch > entry.hi) pitch -= 12;
  return {
    buffer,
    window: (pitch - entry.lo) * entry.window,
    start: index.start,
    length: entry.window,
    midi: pitch,
  };
}

/** A drum hit by its name in the score ("kick", "snare", ...): as note(), with `length` how long
 * the hit sounds (kept inside its window). null for a name the kit does not have, or without the
 * kit's sheet. */
export function hit(name) {
  const kit = index?.drums;
  const buffer = sheets.get("drums");
  const place = kit ? kit.hits.indexOf(name) : -1;
  if (!buffer || place < 0) return null;
  return {
    buffer,
    window: place * kit.window,
    start: index.start,
    length: Math.min(kit.lengths ? kit.lengths[place] : kit.window, kit.window - index.start - 0.03),
  };
}

/** The index of the instruments (null when there is none). */
export const info = () => index;
/** How many sheets are in memory. */
export const loaded = () => sheets.size;
/** How many bytes the sheets in memory take, decoded (4 bytes a sample). */
export const bytes = () => [...sheets.values()].reduce((sum, sheet) => sum + sheet.length * 4, 0);
