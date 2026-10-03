// What the site remembers in the user's own browser (SPEC_dopa v3 §5.4; ED D-76, D-88, D-102,
// D-105; base D-29, D-40): settings, the place in each book, the one explosion count, and the boss
// carried to the next chapter. One localStorage key; a browser that refuses storage still reads,
// it only forgets.

const KEY = "ddr.v1";
const DEFAULTS = { speed: 1.0, voice: 1.0, music: 0.35, sfx: 0.8 };

let state = null;

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
  return state;
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // private browsing or a full disk: reading goes on, nothing is kept (§5.4)
  }
}

/** The settings: { speed, music, sfx, level }. */
export const settings = () => load().settings;
export function setSetting(name, value) {
  load().settings[name] = value;
  save();
}

/** The one explosion count of the user (D-105). Written at once, so a closed tab keeps it (D-88). */
export const count = () => load().count;
export function setCount(n) {
  load().count = n;
  save();
}

/** The place in a book: { block, sentence, bossHp, chars, sentences, blocks, at } or null. */
export const position = (key) => load().positions[key] || null;
export function setPosition(key, place) {
  const s = load();
  s.positions[key] = { ...(s.positions[key] || {}), ...place, at: new Date().toISOString() };
  s.lastBook = key;
  save();
}
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
