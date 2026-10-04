// What the reader is fetching before it can sing, counted (SPEC_dopa v3.15 §6.2a; ED D-153,
// A-41). Each group says how many of its files have arrived and how many it asked for; the
// charging display shows the share, as the number that chargePercent() makes of it. Pure: no
// browser. The groups are "dictionary" (lang/client.js),
// "score" (sing/song.js), "instruments" (sing/instruments.js) and "voice" (sing/index.js: the
// sheets of the newest sentence). One more group, "page" (cockpit/cockpit.js: its faces and
// pictures), is for the bar of the loading words (pagePercent).

// The table of the counts. Its key is a group's name; its value is { arrived, of }: how many
// files of the group have arrived, and how many the group asked for.
const groups = new Map();

// The functions to call at every count: the ones that draw a bar again.
const watchers = new Set();

/** Say that `arrived` of the `asked` files of a group have arrived. A group counted again takes the new
 * numbers. */
export function count(group, arrived, asked) {
  // never more than was asked for, so that no bar passes its end
  const arrivedAtMost = Math.min(arrived, asked);

  const counted = {
    arrived: arrivedAtMost,
    of: asked,
  };
  groups.set(group, counted);

  // A watcher may stop its own watch while it is called, so the calls go over a copy of the set.
  const watchersNow = [...watchers];
  for (const watcher of watchersNow) {
    watcher();
  }
}

/** The groups that still wait for a file. */
export function pending() {
  const waiting = [];

  for (const [group, counted] of groups) {
    const allArrived = counted.arrived >= counted.of;
    if (!allArrived) {
      waiting.push(group);
    }
  }

  return waiting;
}

/** The share, 0 to 1, of the files of these groups that have arrived (of every group, when none
 * is named); 1 when they asked for nothing. */
export function share(names) {
  let chosen = names;
  if (chosen === undefined) {
    chosen = [...groups.keys()];
  }

  let arrived = 0;
  let asked = 0;

  for (const name of chosen) {
    const counted = groups.get(name);
    if (!counted) {
      continue; // a group that has not been counted yet adds nothing
    }
    arrived += counted.arrived;
    asked += counted.of;
  }

  if (asked === 0) {
    return 1;
  }
  return arrived / asked;
}

// What the song itself needs, once; the voice sheets of each sentence are the group "voice".
const SONG_GROUPS = ["dictionary", "score", "instruments"];

// the part of the charging bar that the song's own files take
const SONG_PART = 70;

/** Whether one of the song's own groups still waits for a file. */
export function songPending() {
  for (const group of pending()) {
    if (SONG_GROUPS.includes(group)) {
      return true;
    }
  }
  return false;
}

/** The number of the charging bar, 0 to 100, not rounded (SPEC §6.2a). `songWaited`: the song's
 * own files were still coming when the wait began; they then fill the first 70 of the bar and
 * the voice sheets the rest. Otherwise the voice sheets fill the whole bar. `voiceCounts` is
 * false until the voice sheets were asked for during this wait: their part is 0 till then. */
export function chargePercent(songWaited, voiceCounts) {
  let voiceShare = 0;
  if (voiceCounts) {
    voiceShare = share(["voice"]);
  }

  if (!songWaited) {
    return 100 * voiceShare;
  }

  const songShare = share(SONG_GROUPS);
  const songPoints = SONG_PART * songShare;
  const voicePoints = (100 - SONG_PART) * voiceShare;
  return songPoints + voicePoints;
}

// The bar of the loading words (SPEC §6.1; ED D-163): 20 once the scripts run, 75 more as the
// cockpit's faces and pictures (the group "page") arrive, and 100 when the list of the bundled
// books has come too. (5 stands in the page itself, before any script.)
const SCRIPTS_PART = 20;
const PICTURES_PART = 75;

/** The number of the loading words' bar, 0 to 100, once the scripts run. `booksListed`: the list
 * of the bundled books has arrived, the last thing waited for. Before the group "page" is
 * counted, its share is 0. */
export function pagePercent(booksListed) {
  if (booksListed) {
    return 100;
  }

  let pageShare = 0;
  if (groups.has("page")) {
    pageShare = share(["page"]);
  }

  return SCRIPTS_PART + PICTURES_PART * pageShare;
}

/** Call `watcher()` at every count; returns the function that stops it. */
export function watch(watcher) {
  watchers.add(watcher);

  function stop() {
    return watchers.delete(watcher);
  }
  return stop;
}
