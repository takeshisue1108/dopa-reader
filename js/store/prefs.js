// What the site remembers in the user's own browser (SPEC_dopa v3 §5.4; ED D-76, D-88, D-102,
// D-105, D-157; base D-29, D-40): settings, the place in each book, the one explosion count, and the boss
// carried to the next chapter. One localStorage key; a browser that refuses storage still reads,
// it only forgets.

const KEY = "ddr.v1";
// melody: the song's mode, "fragments" or "score" (SPEC_dopa v3.21 §6.12; "score" when the user
// has chosen none, ED D-166)
const DEFAULTS = { speed: 1.0, voice: 1.0, music: 0.35, sfx: 0.8, melody: "score" };

// what is kept, read once: { settings, positions, count, lastBook }; lastBook is written and
// nothing reads it
let state = null;

/** What is kept, read from the browser's storage at the first call; anything missing or
 * unreadable there is its default. */
function load() {
  if (state) return state;
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {
    saved = null;
  }
  state = {
    settings: { ...DEFAULTS, ...(saved && saved.settings) },
    positions: (saved && saved.positions) || {},
    count: (saved && Number.isFinite(saved.count) && saved.count) || 0,
    lastBook: (saved && saved.lastBook) || null,
  };
  // a mode that is neither of the two (a damaged entry) is the default
  if (!["fragments", "score"].includes(state.settings.melody))
    state.settings.melody = DEFAULTS.melody;
  return state;
}

/** Write everything to the browser's storage; a browser that refuses is ignored. */
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // private browsing or a full disk: reading goes on, nothing is kept (§5.4)
  }
}

/** The settings: { speed, voice, music, sfx }. */
export const settings = () => load().settings;
/** Change one setting and write it at once. */
export function setSetting(name, value) {
  load().settings[name] = value;
  save();
}

/** The one explosion count of the user (D-105). Written at once, so a closed tab keeps it
 * (D-88). */
export const count = () => load().count;
export function setCount(shot) {
  load().count = shot;
  save();
}

/** The place in a book: { block, sentence, bossHp, chars, sentences, blocks, title, at } or
 * null. `at` is when it was last written (an ISO time). */
export const position = (key) => load().positions[key] || null;
/** Write some fields of a book's place; the fields not given stay as they are kept. */
export function setPosition(key, place) {
  const kept = load();
  kept.positions[key] = { ...(kept.positions[key] || {}), ...place, at: new Date().toISOString() };
  kept.lastBook = key;
  save();
}
/** Forget a book's place (「一覧から消す」). */
export function forget(key) {
  delete load().positions[key];
  save();
}

/** The books read before, the latest first: [{ key, ...position }] (「続きから」). */
export function recent() {
  return Object.entries(load().positions)
    .map(([key, place]) => ({ key, ...place }))
    .sort((one, other) => String(other.at).localeCompare(String(one.at)));
}
