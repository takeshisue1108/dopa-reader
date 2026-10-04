// What the reader is fetching before it can sing, counted (SPEC_dopa v3.15 §6.2a; ED D-153,
// A-41). Each group says how many of its files have arrived and how many it asked for; the
// charging display shows the share, as the number that chargePercent() makes of it. Pure: no
// browser. The groups are "dictionary" (lang/client.js),
// "score" (sing/song.js), "instruments" (sing/instruments.js) and "voice" (sing/index.js: the
// sheets of the newest sentence). One more group, "page" (cockpit/cockpit.js: its faces and
// pictures), is for the bar of the loading words (pagePercent).

const groups = new Map(); // group -> { arrived, of }
const watchers = new Set();

/** Say that `arrived` of the `asked` files of a group have arrived. A group counted again takes the new
 * numbers. */
export function count(group, arrived, asked) {
  groups.set(group, { arrived: Math.min(arrived, asked), of: asked });
  for (const watcher of [...watchers]) watcher();
}

/** The groups that still wait for a file. */
export const pending = () =>
  [...groups].filter(([, counted]) => counted.arrived < counted.of).map(([group]) => group);

/** The share, 0 to 1, of the files of these groups that have arrived (of every group, when none
 * is named); 1 when they asked for nothing. */
export function share(names = [...groups.keys()]) {
  let arrived = 0,
    asked = 0;
  for (const name of names) {
    const counted = groups.get(name);
    if (!counted) continue;
    arrived += counted.arrived;
    asked += counted.of;
  }
  return asked ? arrived / asked : 1;
}

// What the song itself needs, once; the voice sheets of each sentence are the group "voice".
const SONG_GROUPS = ["dictionary", "score", "instruments"];
const SONG_PART = 70; // the part of the charging bar that the song's own files take

/** Whether one of the song's own groups still waits for a file. */
export const songPending = () => pending().some((group) => SONG_GROUPS.includes(group));

/** The number of the charging bar, 0 to 100, not rounded (SPEC §6.2a). `songWaited`: the song's
 * own files were still coming when the wait began; they then fill the first 70 of the bar and
 * the voice sheets the rest. Otherwise the voice sheets fill the whole bar. `voiceCounts` is
 * false until the voice sheets were asked for during this wait: their part is 0 till then. */
export function chargePercent(songWaited, voiceCounts) {
  const voice = voiceCounts ? share(["voice"]) : 0;
  return songWaited ? SONG_PART * share(SONG_GROUPS) + (100 - SONG_PART) * voice : 100 * voice;
}

// The bar of the loading words (SPEC §6.1; ED D-163): 20 once the scripts run, 75 more as the
// cockpit's faces and pictures (the group "page") arrive, and 100 when the list of the bundled
// books has come too. (5 stands in the page itself, before any script.)
const SCRIPTS_PART = 20,
  PICTURES_PART = 75;

/** The number of the loading words' bar, 0 to 100, once the scripts run. `booksListed`: the list
 * of the bundled books has arrived, the last thing waited for. Before the group "page" is
 * counted, its share is 0. */
export function pagePercent(booksListed) {
  if (booksListed) return 100;
  return SCRIPTS_PART + PICTURES_PART * (groups.has("page") ? share(["page"]) : 0);
}

/** Call `watcher()` at every count; returns the function that stops it. */
export function watch(watcher) {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}
