// The English sound bank in the browser (SPEC_dopa §6.13; ED D-168, D-169, A-45): the owner's
// four kinds of clip, sung beforehand by Kokoro-82M (tools/site/build_en_bank.py) and fetched
// from this machine, one sheet per unit. A sheet holds its unit at each stored pitch, one window
// after another; a note between two stored pitches is the nearest one played faster or slower.
//
// The units, by their keys in the index:
//   f:C+V  the first half of a syllable: one consonant and the start of the vowel
//   v:V    a vowel alone: the first half of a syllable that begins with its vowel
//   s:V+C  the second half: the end of the vowel and one consonant
//   e:V    the ending of a diphthong that closes a syllable by itself
//   o:C    a consonant alone, as before a vowel       c:C  a consonant alone, as after a vowel

const BASE = "data/sing/bank/en/";
const MAX_SHEETS = 600; // 0.27 MB each, decoded, at 24 kHz

const DIPHTHONGS = new Set(["aɪ", "eɪ", "oʊ", "aʊ", "ɔɪ"]);

// The pitches that the English voice sings: F3 to A4. Its model sings no higher (above B4 its
// clips come out more than an octave low), so the bank stores nothing above A4.
export const RANGE = { lo: 53, hi: 69 };

/** The note that the English voice sings for a note of the song: itself in the voice's range,
 * and otherwise the same note an octave or two lower or higher. */
export function inRange(midi) {
  let note = midi;
  while (note > RANGE.hi) {
    note -= 12;
  }
  while (note < RANGE.lo) {
    note += 12;
  }
  return note;
}

// the AudioContext that decodes the sheets
let context = null;

// index.json: the sheet of each unit and the places of its sounds at each stored pitch
let index = null;
let starting = null; // the Promise of the index, asked for once

// key -> AudioBuffer, in the order in which ensure() last asked for them
const sheets = new Map();

const loading = new Map(); // key -> Promise

let missing = false;

/** Take the AudioContext and load the bank's index (once); resolves to whether the bank is
 * there. After a failure the bank stays missing for the life of the page: English is then sung
 * in katakana (ED A-47). */
export function init(audioContext) {
  context = audioContext;

  if (!starting) {
    const fetched = async () => {
      try {
        const response = await fetch(BASE + "index.json");
        if (!response.ok) {
          throw new Error(`English bank index ${response.status}`);
        }
        index = await response.json();
      } catch {
        missing = true;
      }
      return !missing;
    };
    starting = fetched();
  }

  return starting;
}

/** Whether the English voice cannot be used. */
export const isMissing = () => missing;

/** The bank's index, or null before init() has resolved. */
export const info = () => index;

/** For the tests: forget everything, and take an index without fetching it (null: none). */
export function reset(testIndex = null, audioContext = null) {
  context = audioContext;
  index = testIndex;
  starting = testIndex ? Promise.resolve(true) : null;
  sheets.clear();
  loading.clear();
  missing = false;
}

/**
 * The units that sing a syllable { onset, nucleus, coda } (lists of consonants in IPA, and the
 * vowel), by the bank's keys: { pre, head, tail, post, diphthong }. `head` is the first half with
 * the consonant next to the vowel, `tail` the second half with the consonant next to the vowel
 * (or the ending of a diphthong that closes the syllable by itself, or null), `pre` and `post`
 * the other consonants. A half that the bank does not hold is sung from its pieces: the
 * consonant alone and the vowel alone.
 */
export function unitsOf(syllable) {
  const { onset, nucleus, coda } = syllable;
  const has = (key) => Boolean(index && index.units[key]);
  const diphthong = DIPHTHONGS.has(nucleus);

  const pre = onset.slice(0, -1).map((consonant) => "o:" + consonant);
  let head = "v:" + nucleus;
  if (onset.length) {
    const nearest = onset[onset.length - 1];
    const half = `f:${nearest}+${nucleus}`;
    if (has(half)) {
      head = half;
    } else {
      pre.push("o:" + nearest);
    }
  }

  const post = coda.slice(1).map((consonant) => "c:" + consonant);
  let tail = null;
  if (coda.length) {
    const half = `s:${nucleus}+${coda[0]}`;
    if (has(half)) {
      tail = half;
    } else {
      post.unshift("c:" + coda[0]);
    }
  }
  if (!tail && !post.length && diphthong) {
    tail = "e:" + nucleus;
  }

  return {
    pre,
    head,
    tail,
    post,
    diphthong,
  };
}

/** Every key that the syllables need, each once. */
export function keysOf(syllables) {
  const keys = new Set();
  for (const syllable of syllables) {
    const { pre, head, tail, post } = unitsOf(syllable);
    for (const key of [...pre, head, tail, ...post]) {
      if (key && index && index.units[key]) {
        keys.add(key);
      }
    }
  }
  return [...keys];
}

async function fetchSheet(file) {
  const response = await fetch(BASE + file);
  if (!response.ok) {
    throw new Error(`English bank: ${file} ${response.status}`);
  }

  // the context as it is before the file's bytes are waited for
  const decoder = context;
  const encoded = await response.arrayBuffer();
  return decoder.decodeAudioData(encoded);
}

/** Have the sheets of these syllables in memory; resolves when each is loaded or has failed (a
 * failed sheet makes `isMissing()` true). At most MAX_SHEETS are kept: the one asked for longest
 * ago goes first. `onProgress(arrived, of)` counts this call's sheets as bank.js does. */
export function ensure(syllables, onProgress = null) {
  const jobs = [];
  const names = keysOf(syllables);

  for (const name of names) {
    if (sheets.has(name)) {
      // asked for again: the sheet goes to the end of the order
      const buffer = sheets.get(name);
      sheets.delete(name);
      sheets.set(name, buffer);
      continue;
    }

    if (!loading.has(name)) {
      const fetching = fetchSheet(index.units[name].file);

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
          loading.delete(name);
          missing = true;
        },
      );
      loading.set(name, job);
    }

    jobs.push(loading.get(name));
  }

  if (onProgress) {
    let arrived = names.length - jobs.length;
    onProgress(arrived, names.length);

    for (const job of jobs) {
      job.then(() => {
        ++arrived;
        return onProgress(arrived, names.length);
      });
    }
  }

  return Promise.all(jobs);
}

const frequencyOf = (midi) => 440 * 2 ** ((midi - 69) / 12);

/**
 * The clip of a unit for a note, or null for a unit that the bank does not hold or whose sheet
 * is not in memory: { buffer, at, rate, period, o, v, ve, e, room }. `at` is where the window of
 * the nearest stored pitch starts in the sheet and `room` the window's length, in seconds of the
 * sheet; `rate` is how much faster the sheet is played to reach the note; `period` is one period
 * of the stored pitch; o, v, ve and e are places in the window (the first sound, the vowel's
 * start, its end, the last sound's end), absent where the unit has none.
 */
export function clip(key, midi) {
  if (!index || !key) {
    return null;
  }
  const unit = index.units[key];
  const buffer = sheets.get(key);
  if (!unit || !buffer) {
    return null;
  }

  // the nearest stored pitch; of two equally near, the lower (the sheet is then played faster)
  let nearest = 0;
  index.pitches.forEach((pitch, number) => {
    if (Math.abs(pitch - midi) < Math.abs(index.pitches[nearest] - midi)) {
      nearest = number;
    }
  });
  const stored = index.pitches[nearest];

  const place = (name) => (unit[name] ? unit[name][nearest] : undefined);

  return {
    buffer,
    at: nearest * index.window,
    rate: 2 ** ((midi - stored) / 12),
    period: 1 / frequencyOf(stored),
    o: place("o"),
    v: place("v"),
    ve: place("ve"),
    e: place("e"),
    room: index.window,
  };
}

/**
 * The clips that sing a syllable on a note (syllable.js): { pre, head, tail, post, diphthong },
 * or null when the first half's sheet is not in memory (the syllable is then silent). A
 * consonant whose sheet is not in memory is left out.
 */
export function partsOf(syllable, midi) {
  const units = unitsOf(syllable);
  const head = clip(units.head, midi);
  if (!head) {
    return null;
  }

  const clipsOf = (keys) => keys.map((key) => clip(key, midi)).filter(Boolean);

  return {
    pre: clipsOf(units.pre),
    head,
    tail: clip(units.tail, midi),
    post: clipsOf(units.post),
    diphthong: units.diphthong,
  };
}

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
