// The sound bank in the browser: one sheet per mora, fetched from this machine, decoded and kept
// (SPEC_sing §5.5, §6.6; 歌 ED D-28, ST-10, ST-12).
const BASE = "data/sing/bank/no7/";
const MAX_SHEETS = 100; // 1.44 MB each at 24 kHz (SD-S08)
const VOWEL = {}; // kana -> the vowel it ends in (ン for ン)
for (const [row, vowel] of [
  ["アカサタナハマヤラワガザダバパァャヮ", "ア"],
  ["イキシチニヒミリギジヂビピィ", "イ"],
  ["ウクスツヌフムユルグズヅブプゥュヴ", "ウ"],
  ["エケセテネヘメレゲゼデベペェ", "エ"],
  ["オコソトノホモヨロヲゴゾドボポォョ", "オ"],
  ["ン", "ン"],
])
  for (const kana of row) VOWEL[kana] = vowel;

let context = null, // the AudioContext that decodes the sheets
  index = null; // index.json: the sheet of each mora, the range of pitches, the window and the leads
const sheets = new Map(); // mora -> AudioBuffer, in order of last use
const loading = new Map(); // mora -> Promise

// The index of an empty bank: every slot is a rest, but the song's clock and its light go on
// (ED D-87: when the song's voice files cannot be loaded, reading goes on without a voice).
const EMPTY = { morae: {}, lead: {}, late: {}, frequent: [], lo: 53, hi: 77, window: 0.6, onset: 0.12 };
let missing = false;

/** Take the AudioContext and load the bank's index (once); returns the index. Without the index
 * the bank is empty and `missing()` is true. */
export async function init(audioContext) {
  context = audioContext;
  if (!index)
    try {
      const response = await fetch(BASE + "index.json");
      if (!response.ok) throw new Error(`bank index ${response.status}`);
      index = await response.json();
    } catch {
      index = EMPTY;
      missing = true;
    }
  return index;
}
/** Whether the voice files could not be loaded (D-87). */
export const isMissing = () => missing;

/** Fetch a sheet and decode it. */
async function decode(file) {
  const response = await fetch(BASE + file);
  if (!response.ok) throw new Error(`bank: ${file} ${response.status}`);
  return context.decodeAudioData(await response.arrayBuffer());
}

// The mora whose sheet is used: itself, or its vowel when the bank has no sheet for it (Q-21); null = a rest.
export function sound(mora) {
  if (mora === "ッ") return null;
  if (index.morae[mora]) return mora;
  const vowel = VOWEL[mora[mora.length - 1]];
  return vowel && index.morae[vowel] ? vowel : null;
}

/** Have the sheets of these morae loaded; resolves when all are. At most 100 sheets are kept:
 * the one unused for longest goes first. */
export function ensure(morae) {
  const jobs = [];
  for (const name of new Set(morae.map(sound).filter(Boolean))) {
    if (sheets.has(name)) {
      const buffer = sheets.get(name);
      sheets.delete(name);
      sheets.set(name, buffer);
      continue;
    }
    if (!loading.has(name)) {
      loading.set(
        name,
        decode(index.morae[name]).then(
          (buffer) => {
            sheets.set(name, buffer);
            loading.delete(name);
            while (sheets.size > MAX_SHEETS) sheets.delete(sheets.keys().next().value);
          },
          () => {
            // a sheet that cannot be loaded leaves its morae silent (D-87); the song goes on
            loading.delete(name);
            missing = true;
          },
        ),
      );
    }
    jobs.push(loading.get(name));
  }
  return Promise.all(jobs);
}

// The clip of a mora at a pitch: its sheet, the start of its window, where in the window its vowel
// starts, and the consonant's length. The vowel starts at the index's mark; a sound without a
// consonant may rise some milliseconds after the mark at some pitches, and `late` holds by how
// much (measured by tools/sing/bank_sound.py), so that it still starts on its slot (SC-S05).
export function clip(mora, midi) {
  const sheetName = sound(mora);
  const buffer = sheetName && sheets.get(sheetName);
  if (!buffer) return null;
  const pitch = Math.max(index.lo, Math.min(index.hi, midi));
  const late = index.late?.[sheetName]?.[pitch - index.lo] || 0;
  return {
    buffer,
    window: (pitch - index.lo) * index.window,
    onset: index.onset + late,
    lead: sheetName === mora ? index.lead[sheetName] || 0 : 0,
    length: index.window,
  };
}

/** The bank's index. */
export const info = () => index;
/** How many sheets are in memory. */
export const loaded = () => sheets.size;
/** How many bytes the sheets in memory take, decoded (4 bytes a sample). */
export const bytes = () => [...sheets.values()].reduce((sum, sheet) => sum + sheet.length * 4, 0);
