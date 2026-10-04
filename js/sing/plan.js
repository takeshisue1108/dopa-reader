// The plan of a sentence over the song: for each of its bars, the kind of melody, the fragment,
// the pitch of every sung slot and the chords it passes (SPEC_sing §6.5; 歌 ED D-14, D-25, D-27).
// No browser dependency: the conductor asks for a plan and then only has to keep time.
//
// A place in the song is (progression, slot): the index of the progression in the list, and the
// slot counted from its start (8 slots to a bar). The progressions follow one another, and after
// the last comes the first (D-27).
import { SLOTS_PER_BAR } from "./bars.js";
import { chordAt, chordName, noteOf, slotsOf } from "./harmony.js";
import { kindAt, pick, stepsFor } from "./melody.js";

const ROOT_STEP = 1; // the step of a chord's root (harmony.js, noteOf)

/** The progressions, each with `slots`: how many slots it lasts, filled to a whole bar. */
export function withSlots(progressions) {
  return progressions.map((progression) => {
    const slots = slotsOf(progression.data);
    return {
      ...progression,
      slots,
    };
  });
}

/** The place `count` slots after (progression, slot), as [progression, slot]. */
export function positionAfter(progressions, progressionIndex, slot, count) {
  slot += count;

  while (slot >= progressions[progressionIndex].slots) {
    slot -= progressions[progressionIndex].slots;
    progressionIndex = (progressionIndex + 1) % progressions.length;
  }

  return [progressionIndex, slot];
}

/**
 * Plan the bars of a sentence that starts at the bar line `at` = {progression, bar} (both from 0).
 *
 * Each bar takes the kind of melody that the form gives its place (or `kind`, when one is
 * fixed), and one fragment of that kind, never the fragment of the bar before (`previous` is the
 * last fragment of the sentence before). Each sung slot takes the fragment's step over the chord
 * of that very slot, so a chord change inside a bar changes the notes after it.
 *
 * `options.scorePitches` is the song's second mode (SPEC_dopa v3.16 §6.12): a pitch for each slot
 * of the progression, or null (score.js, singablePitches). A sung slot then takes that pitch, and
 * where there is none the root of its chord (ED D-159); the fragment's steps are not sung. The
 * fragments are picked all the same, so the kinds, the fragments used and the chord names do not
 * depend on the mode.
 *
 * Returns, with one entry per bar: `kinds`, `used` (the fragments), `notes` (MIDI pitches, one
 * for each mora), `chords` (the names of the chords the bar's sung slots pass, with equal
 * neighbours as one: C, G, C is three names); and `last`, the fragment to pass as `previous` for
 * the next sentence. `progressions` must come from withSlots().
 */
export function planBars(progressions, fragments, at, bars, options = {}) {
  const { kind = null, random = Math.random, scorePitches = null } = options;
  let previous = options.previous || null;

  const plan = {
    kinds: [],
    used: [],
    notes: [],
    chords: [],
    last: previous,
  };

  bars.forEach((bar, barIndex) => {
    // where the bar starts in the song
    const sentenceStart = at.bar * SLOTS_PER_BAR;
    const slotsIntoSentence = barIndex * SLOTS_PER_BAR;
    const [progressionIndex, barStart] = positionAfter(
      progressions,
      at.progression,
      sentenceStart,
      slotsIntoSentence,
    );

    let barKind = kind;
    if (!barKind) {
      const form = progressions[progressionIndex].form;
      const barInProgression = barStart / SLOTS_PER_BAR;
      barKind = kindAt(form, barInProgression);
    }

    const fragment = pick(fragments, barKind, previous, random);
    previous = fragment;

    const chordNames = [];
    const steps = stepsFor(fragment, bar.length);
    const notes = steps.map((step, slotInBar) => {
      const [slotProgressionIndex, slot] = positionAfter(
        progressions,
        progressionIndex,
        barStart,
        slotInBar,
      );
      const slotProgression = progressions[slotProgressionIndex];
      const { chord, key } = chordAt(slotProgression.data, slot);

      const name = chordName(chord, key);
      const lastName = chordNames[chordNames.length - 1];
      if (lastName !== name) {
        chordNames.push(name);
      }

      if (!scorePitches) {
        return noteOf(chord, key, step);
      }

      const scorePitch = scorePitches[slot];
      if (scorePitch === null || scorePitch === undefined) {
        return noteOf(chord, key, ROOT_STEP);
      }
      return scorePitch;
    });

    plan.kinds.push(barKind);
    plan.used.push(fragment);
    plan.notes.push(notes);
    plan.chords.push(chordNames);
  });

  plan.last = previous;
  return plan;
}
