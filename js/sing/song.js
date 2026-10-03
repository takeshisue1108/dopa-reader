// What a song is made of, fetched from the site: the Day Life score (its notes, its chords as found
// by analyzing it, its form and its tempo map) and the melody fragments (SPEC_dopa v3.9 §6.11; ED
// D-139; SPEC_sing §5.3). The score of a sentence is made in the browser (SPEC_dopa v3 §5.5) and
// given to index.js by the reader.
import * as progress from "../loading.js";
import { parseFragments } from "./melody.js";

const DAYLIFE_DIR = "data/sing/daylife/";
const SCORE_FILES = 5; // the fragments and the four files of the score

const fetchText = async (path) => (await fetch(path)).text();
const fetchJson = async (path) => {
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
  // the 5 files are counted as they arrive, for the charging display (SPEC_dopa v3.15 §6.2a)
  let arrived = 0;
  const counted = async (file) => {
    const got = await file;
    progress.count("score", ++arrived, SCORE_FILES);
    return got;
  };
  progress.count("score", 0, SCORE_FILES);
  const fragments = parseFragments(await counted(fetchText("data/sing/fragments.txt")));
  for (const line of fragments.skipped) console.warn(`fragments.txt: not understood: ${line}`);
  return songOf(
    {
      chords: await counted(fetchJson(DAYLIFE_DIR + "chords.json")),
      form: await counted(fetchJson(DAYLIFE_DIR + "form.json")),
      tempo: await counted(fetchJson(DAYLIFE_DIR + "tempo.json")),
      notes: await counted(fetchJson(DAYLIFE_DIR + "notes.json")),
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
