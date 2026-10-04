// What a song is made of, fetched from the site: the Day Life score (its notes, its chords as found
// by analyzing it, its form and its tempo map) and the melody fragments (SPEC_dopa v3.9 §6.11; ED
// D-139; SPEC_sing §5.3). The score of a sentence is made in the browser (SPEC_dopa v3 §5.5) and
// given to index.js by the reader.
import * as progress from "../loading.js";
import { parseFragments } from "./melody.js";

const DAYLIFE_DIR = "data/sing/daylife/";
const SCORE_FILES = 5; // the fragments and the four files of the score

const fetchText = async (path) => {
  const response = await fetch(path);
  return response.text();
};

const fetchJson = async (path) => {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`${path}: ${response.status}`);
  }
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
    ++arrived;
    progress.count("score", arrived, SCORE_FILES);
    return got;
  };
  progress.count("score", 0, SCORE_FILES);

  const fragmentsFile = fetchText("data/sing/fragments.txt");
  const fragmentsText = await counted(fragmentsFile);
  const fragments = parseFragments(fragmentsText);

  for (const line of fragments.skipped) {
    console.warn(`fragments.txt: not understood: ${line}`);
  }

  // each file of the score is asked for when the one before it has arrived
  const chordsFile = fetchJson(DAYLIFE_DIR + "chords.json");
  const chords = await counted(chordsFile);

  const formFile = fetchJson(DAYLIFE_DIR + "form.json");
  const form = await counted(formFile);

  const tempoFile = fetchJson(DAYLIFE_DIR + "tempo.json");
  const tempo = await counted(tempoFile);

  const notesFile = fetchJson(DAYLIFE_DIR + "notes.json");
  const notes = await counted(notesFile);

  const scoreFiles = {
    chords,
    form,
    tempo,
    notes,
  };
  return songOf(scoreFiles, fragments.fragments);
}

/** The song from the four files of the Day Life data (as loadSong fetches them) and the parsed
 * fragments. */
export function songOf({ chords, form, tempo, notes }, fragments) {
  const daylife = {
    name: "daylife",
    data: chords,
    form,
  };

  return {
    progressions: [daylife],
    fragments,
    notes,
    tempo,
  };
}
