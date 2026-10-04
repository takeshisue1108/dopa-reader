// The sound bank in the browser: one sheet per mora, fetched from this machine, decoded and kept
// (SPEC_sing §5.5, §6.6; 歌 ED D-28, ST-10, ST-12). A sheet is one audio file that holds one mora
// sung at every pitch from the index's `lo` to its `hi`, each pitch in a window of its own,
// `window` seconds long, one window after another.
import { vowelOf } from "../lang/morae.js";

const BASE = "data/sing/bank/no7/";
const MAX_SHEETS = 100; // 1.44 MB each at 24 kHz (SD-S08)

// the AudioContext that decodes the sheets
let context = null;

// index.json: the sheet of each mora, the range of pitches, the window and the leads
let index = null;

// mora -> AudioBuffer, in the order in which ensure() last asked for them
const sheets = new Map();

const loading = new Map(); // mora -> Promise

// The index of an empty bank: every slot is a rest, but the song's clock and its light go on
// (ED D-87: when the song's voice files cannot be loaded, reading goes on without a voice).
const EMPTY = {
  morae: {},
  lead: {},
  late: {},
  frequent: [],
  lo: 53,
  hi: 77,
  window: 0.6,
  onset: 0.12,
};
let missing = false;

/** Take the AudioContext and load the bank's index (once); returns the index. Without the index
 * the bank is empty and `isMissing()` is true. The index is asked for once only: after a failure
 * the bank stays empty for the life of the page. */
export async function init(audioContext) {
  context = audioContext;

  if (!index) {
    try {
      const indexUrl = BASE + "index.json";
      const response = await fetch(indexUrl);
      if (!response.ok) {
        throw new Error(`bank index ${response.status}`);
      }

      index = await response.json();
    } catch {
      index = EMPTY;
      missing = true;
    }
  }

  return index;
}

/** Whether the voice files could not be loaded (D-87). */
export const isMissing = () => missing;

/** Fetch a sheet and decode it. */
async function fetchSheet(file) {
  const sheetUrl = BASE + file;
  const response = await fetch(sheetUrl);
  if (!response.ok) {
    throw new Error(`bank: ${file} ${response.status}`);
  }

  // the context as it is before the file's bytes are waited for
  const decoder = context;
  const encoded = await response.arrayBuffer();
  return decoder.decodeAudioData(encoded);
}

// The mora whose sheet is used: itself, or its vowel when the bank has no sheet for it (Q-21);
// null = a rest.
export function sound(mora) {
  if (mora === "ッ") {
    return null;
  }
  if (index.morae[mora]) {
    return mora;
  }

  const vowel = vowelOf(mora);
  if (vowel && index.morae[vowel]) {
    return vowel;
  }
  return null;
}

/** Have the sheets of these morae loaded; resolves when each is loaded or has failed (a failed
 * sheet leaves its morae silent and makes `isMissing()` true). At most 100 sheets are kept: the
 * one that ensure() was asked for longest ago goes first (clip() does not count as use).
 * `onProgress(arrived, of)` is told how many of this call's sheets are there: at once those in
 * memory, then one more as each of the others arrives or fails. */
export function ensure(morae, onProgress = null) {
  const jobs = [];

  // each sheet once; a rest has none
  const sheetNames = morae.map(sound);
  const sounding = sheetNames.filter(Boolean);
  const names = new Set(sounding);

  for (const name of names) {
    if (sheets.has(name)) {
      // asked for again: the sheet goes to the end of the order
      const buffer = sheets.get(name);
      sheets.delete(name);
      sheets.set(name, buffer);
      continue;
    }

    if (!loading.has(name)) {
      const file = index.morae[name];
      const fetching = fetchSheet(file);

      const job = fetching.then(
        (buffer) => {
          sheets.set(name, buffer);
          loading.delete(name);

          while (sheets.size > MAX_SHEETS) {
            const askedLongestAgo = sheets.keys().next().value;
            sheets.delete(askedLongestAgo);
          }
        },
        () => {
          // a sheet that cannot be loaded leaves its morae silent (D-87); the song goes on
          loading.delete(name);
          missing = true;
        },
      );
      loading.set(name, job);
    }

    const pendingJob = loading.get(name);
    jobs.push(pendingJob);
  }

  if (onProgress) {
    // the sheets already in memory have arrived
    let arrived = names.size - jobs.length;
    onProgress(arrived, names.size);

    for (const job of jobs) {
      job.then(() => {
        ++arrived;
        return onProgress(arrived, names.size);
      });
    }
  }

  return Promise.all(jobs);
}

// The clip of a mora at a pitch: { buffer (its sheet), window (where the pitch's window starts in
// the sheet), onset (where in the window its vowel starts), lead (the consonant's length), length
// (the window's length) }, all in seconds. A pitch outside the bank's range is sung at the lowest
// or the highest pitch. A mora sung on its vowel's sheet has no consonant: its lead is 0. null
// for a rest or a sheet not in memory. The vowel starts at the index's mark; a sound without a
// consonant may rise some milliseconds after the mark at some pitches, and `late` holds by how
// much (measured by tools/sing/bank_sound.py), so that it still starts on its slot (SC-S05).
export function clip(mora, midi) {
  const sheetName = sound(mora);
  if (!sheetName) {
    return null;
  }
  const buffer = sheets.get(sheetName);
  if (!buffer) {
    return null;
  }

  const pitchAtMost = Math.min(index.hi, midi);
  const pitch = Math.max(index.lo, pitchAtMost);

  // which window of the sheet, counted from 0
  const windowNumber = pitch - index.lo;
  const windowSeconds = windowNumber * index.window;

  const late = index.late?.[sheetName]?.[windowNumber] || 0;
  const onsetSeconds = index.onset + late;

  let lead = 0;
  if (sheetName === mora) {
    lead = index.lead[sheetName] || 0;
  }

  return {
    buffer,
    window: windowSeconds,
    onset: onsetSeconds,
    lead,
    length: index.window,
  };
}

/** The bank's index. */
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
