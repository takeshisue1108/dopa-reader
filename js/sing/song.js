// What a song is made of, fetched from the site: the Day Life score (its notes, its chords as found
// by analyzing it, its form and its tempo map) and the melody fragments (SPEC_dopa v3.9 §6.11; ED
// D-139; SPEC_sing §5.3). The score of a sentence is made in the browser (SPEC_dopa v3 §5.5) and
// given to index.js by the reader.
import { parseFragments } from "./melody.js";

const DAYLIFE = "data/sing/daylife/";

const text = async (path) => (await fetch(path)).text();
const json = async (path) => {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
};

/**
 * { progressions, fragments, notes, tempo }, as the conductor takes it. The song is one
 * "progression", the Day Life arrangement: `data` is its chords (chords.json, in the Hooktheory
 * form that harmony.js reads), `form` its sections (form.json), and it starts again after its
 * last bar. `notes` is notes.json and `tempo` tempo.json. A line of the fragments file that is
 * not understood is named in the console and skipped.
 */
export async function loadSong() {
  const fragments = parseFragments(await text("data/sing/fragments.txt"));
  for (const line of fragments.skipped) console.warn(`fragments.txt: not understood: ${line}`);
  return songOf(
    {
      chords: await json(DAYLIFE + "chords.json"),
      form: await json(DAYLIFE + "form.json"),
      tempo: await json(DAYLIFE + "tempo.json"),
      notes: await json(DAYLIFE + "notes.json"),
    },
    fragments.fragments,
  );
}

/** The song from the four files of the Day Life data (as loadSong fetches them) and the parsed
 * fragments. */
export function songOf({ chords, form, tempo, notes }, fragments) {
  return {
    progressions: [{ name: "daylife", data: chords, form }],
    fragments,
    notes,
    tempo,
  };
}
