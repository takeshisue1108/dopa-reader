// The instrument notes of the accompaniment in the browser: the General MIDI sounds of the Day Life
// score, one sheet per program and one for the drum kit, fetched from this machine, decoded and
// kept (SPEC_dopa v3.9 §6.11; SPEC_sing §5.6, §7.2; 歌 ED D-37). A program's sheet is one audio
// file with every pitch from the program's `lo` to its `hi`, each in a window of its own, `window`
// seconds long, one after another; the kit's sheet has one window for each hit.
import * as progress from "../loading.js";

const BASE = "data/sing/instruments/";
const INDEX = "daylife.json"; // made by tools/sing/build_instruments.py

// the AudioContext that decodes the sheets
let context = null;

// daylife.json: for each program its sheet, its range of pitches and its window; the drum kit
let index = null;

const sheets = new Map(); // program number as a string ("30"), or "drums" -> AudioBuffer
const loading = new Map(); // the same -> Promise
let settled = 0; // the sheets that have arrived or failed

/** Tell the charging display (SPEC_dopa v3.15 §6.2a): the index is one file, and each sheet one. */
function tellProgress() {
  let asked = 0;
  if (index) {
    const programSheets = Object.keys(index.programs).length;
    const drumSheets = index.drums ? 1 : 0;
    asked = programSheets + drumSheets;
  }

  const arrivedFiles = 1 + settled;
  const askedFiles = 1 + asked;
  progress.count("instruments", arrivedFiles, askedFiles);
}

/** Take the AudioContext and load the index (once). Returns the index, or null when this machine
 * has no instrument files: the song is then sung without accompaniment. */
export async function init(audioContext) {
  context = audioContext;

  if (!index) {
    progress.count("instruments", 0, 1);

    const indexUrl = BASE + INDEX;
    const response = await fetch(indexUrl).catch(() => null);

    if (response && response.ok) {
      index = await response.json();
    } else {
      index = null;
    }

    tellProgress();
  }

  return index;
}

/** Have every sheet loaded; resolves when all are. A sheet that cannot be fetched stays silent. */
export function ensure() {
  if (!index) {
    return Promise.resolve();
  }

  const entries = Object.entries(index.programs);
  if (index.drums) {
    const drumsEntry = ["drums", index.drums];
    entries.push(drumsEntry);
  }

  const jobs = [];
  for (const [name, entry] of entries) {
    if (sheets.has(name)) {
      continue;
    }

    if (!loading.has(name)) {
      const sheetUrl = BASE + entry.file;

      const job = fetch(sheetUrl)
        .then((response) => {
          if (!response.ok) {
            throw new Error(`instruments: ${entry.file} ${response.status}`);
          }
          return response.arrayBuffer();
        })
        .then((data) => context.decodeAudioData(data))
        .then((buffer) => sheets.set(name, buffer))
        .catch((error) => {
          const message = String(error);
          return console.warn(message);
        })
        .finally(() => {
          loading.delete(name);
          settled++;
          tellProgress();
        });
      loading.set(name, job);
    }

    const pendingJob = loading.get(name);
    jobs.push(pendingJob);
  }

  return Promise.all(jobs);
}

/**
 * The note of a General MIDI program at a pitch: its sheet, the start of its window in the sheet,
 * where in the window the sound starts, the window's length (all in seconds), and the pitch
 * played. A pitch outside the sheet's range is moved into it by octaves; that needs a range of an
 * octave or more. null when the program has no sheet in memory.
 */
export function note(program, midi) {
  const entry = index?.programs[String(program)];
  const buffer = sheets.get(String(program));
  if (!entry || !buffer) {
    return null;
  }

  let pitch = midi;
  while (pitch < entry.lo) {
    pitch += 12;
  }
  while (pitch > entry.hi) {
    pitch -= 12;
  }

  // which window of the sheet, counted from 0
  const windowNumber = pitch - entry.lo;

  return {
    buffer,
    window: windowNumber * entry.window,
    start: index.start,
    length: entry.window,
    midi: pitch,
  };
}

/** A drum hit by its name in the score ("kick", "snare", ...): `buffer`, `window` and `start` as
 * in note(), and `length`: how long the hit sounds (not the window's length; kept inside the
 * window). null for a name the kit does not have, or without the kit's sheet. */
export function hit(name) {
  const kit = index?.drums;
  const buffer = sheets.get("drums");

  let place = -1;
  if (kit) {
    place = kit.hits.indexOf(name);
  }
  if (!buffer || place < 0) {
    return null;
  }

  let hitSeconds = kit.window;
  if (kit.lengths) {
    hitSeconds = kit.lengths[place];
  }
  const roomSeconds = kit.window - index.start - 0.03;
  const soundingSeconds = Math.min(hitSeconds, roomSeconds);

  return {
    buffer,
    window: place * kit.window,
    start: index.start,
    length: soundingSeconds,
  };
}

/** The index of the instruments (null when there is none). */
export const info = () => index;

/** How many sheets are in memory. */
export const loaded = () => sheets.size;

/** How many bytes the sheets in memory take, decoded (4 bytes a sample). */
export function bytes() {
  let sum = 0;
  for (const sheet of sheets.values()) {
    sum += sheet.length * 4;
  }
  return sum;
}
