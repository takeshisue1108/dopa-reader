// The plan of a sentence over the song: for each of its bars, the kind of melody, the fragment,
// the pitch of every sung slot and the chords it passes (SPEC_sing §6.5; 歌 ED D-14, D-25, D-27).
// No browser dependency: the conductor asks for a plan and then only has to keep time.
//
// A place in the song is (progression, slot): the index of the progression in the list, and the
// slot counted from its start (8 slots to a bar). The progressions follow one another, and after
// the last comes the first (D-27).
import { chordAt, chordName, noteOf, slotsOf } from "./harmony.js";
import { kindAt, pick, stepsFor } from "./melody.js";

export const SLOTS_PER_BAR = 8;

/** The progressions, each with `slots`: how many slots it lasts, filled to a whole bar. */
export const withSlots = (progressions) =>
  progressions.map((progression) => ({ ...progression, slots: slotsOf(progression.data) }));

/** The place `count` slots after (progression, slot), as [progression, slot]. */
export function positionAfter(progressions, progression, slot, count) {
  slot += count;
  while (slot >= progressions[progression].slots) {
    slot -= progressions[progression].slots;
    progression = (progression + 1) % progressions.length;
  }
  return [progression, slot];
}

/**
 * Plan the bars of a sentence that starts at the bar line `at` = {progression, bar} (both from 0).
 *
 * Each bar takes the kind of melody that the form gives its place (or `kind`, when one is
 * fixed), and one fragment of that kind, never the fragment of the bar before (`previous` is the
 * last fragment of the sentence before). Each sung slot takes the fragment's step over the chord
 * of that very slot, so a chord change inside a bar changes the notes after it.
 *
 * Returns, with one entry per bar: `kinds`, `used` (the fragments), `notes` (MIDI pitches, one
 * for each mora), `chords` (the names of the chords the bar's sung slots pass, each once); and
 * `last`, the fragment to pass as `previous` for the next sentence.
 */
export function planBars(progressions, fragments, at, bars, options = {}) {
  const { kind = null, random = Math.random } = options;
  let previous = options.previous || null;
  const plan = { kinds: [], used: [], notes: [], chords: [], last: previous };
  bars.forEach((bar, barIndex) => {
    const [progression, barStart] = positionAfter(
      progressions,
      at.progression,
      at.bar * SLOTS_PER_BAR,
      barIndex * SLOTS_PER_BAR,
    );
    const barKind = kind || kindAt(progressions[progression].form, barStart / SLOTS_PER_BAR);
    const fragment = pick(fragments, barKind, previous, random);
    previous = fragment;

    const chordNames = [];
    const notes = stepsFor(fragment, bar.length).map((step, slotInBar) => {
      const [slotProgression, slot] = positionAfter(progressions, progression, barStart, slotInBar);
      const { chord, key } = chordAt(progressions[slotProgression].data, slot);
      const name = chordName(chord, key);
      if (chordNames[chordNames.length - 1] !== name) chordNames.push(name);
      return noteOf(chord, key, step);
    });
    plan.kinds.push(barKind);
    plan.used.push(fragment);
    plan.notes.push(notes);
    plan.chords.push(chordNames);
  });
  plan.last = previous;
  return plan;
}
