// What the reader is fetching before it can sing, counted (SPEC_dopa v3.15 §6.2a; ED D-153,
// A-41). Each group says how many of its files have arrived and how many it asked for; the
// charging display shows the share. Pure: no browser. The groups are "dictionary" (lang/client.js),
// "score" (sing/song.js), "instruments" (sing/instruments.js) and "voice" (sing/index.js: the
// sheets of the newest sentence).

const groups = new Map(); // group -> { arrived, of }
const watchers = new Set();

/** Say that `arrived` of a group's `of` files have arrived. A group counted again takes the new
 * numbers. */
export function count(group, arrived, of) {
  groups.set(group, { arrived: Math.min(arrived, of), of });
  for (const watcher of [...watchers]) watcher();
}

/** The groups that still wait for a file. */
export const pending = () =>
  [...groups].filter(([, counted]) => counted.arrived < counted.of).map(([group]) => group);

/** The share, 0 to 1, of the files of these groups that have arrived (of every group, when none
 * is named); 1 when they asked for nothing. */
export function share(names = [...groups.keys()]) {
  let arrived = 0,
    of = 0;
  for (const name of names) {
    const counted = groups.get(name);
    if (!counted) continue;
    arrived += counted.arrived;
    of += counted.of;
  }
  return of ? arrived / of : 1;
}

/** Call `watcher()` at every count; returns the function that stops it. */
export function watch(watcher) {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}
