// The notes of the Day Life score, ready for the conductor (SPEC_dopa v3.9 §6.11; ED D-139). The
// score's notes are written in bars and beats (site/data/sing/daylife/notes.json); the conductor
// schedules them slot by slot, so here each note is filed under the slot it starts in. No
// browser dependency.
import { SLOTS_PER_BAR } from "./bars.js";

/**
 * The notes of every part filed by the score slot they start in (a slot is an eighth note, two to
 * a beat). A note is { part, program, drum, pitch, offset, slots, velocity }: `program` is its
 * General MIDI program (null for a drum hit), `pitch` a MIDI pitch or a drum hit's name,
 * `offset` how far into its slot it starts (0 to 1, in slots: a sixteenth note on the second
 * half of a slot starts at 0.5), `slots` how long it is written, in slots. A row of the file is
 * [bar (from 1), beat in the bar (from 0), length in beats, pitch, velocity]. A beat that a
 * rounding error puts just before a slot line (1.4999999999999998) starts on that slot.
 */
export function notesBySlot(score) {
  const bySlot = Array.from({ length: score.bars * SLOTS_PER_BAR }, () => []);
  for (const [part, { program, drum, notes: partNotes }] of Object.entries(score.parts)) {
    for (const [bar, beatInBar, lengthInBeats, pitch, velocity] of partNotes) {
      // in slots from the score's start
      const position = ((bar - 1) * score.beatsPerBar + beatInBar) * 2;
      const slot = Math.floor(position + 1e-9);
      if (slot < 0 || slot >= bySlot.length) continue;
      bySlot[slot].push({
        part,
        program: drum ? null : program,
        drum: !!drum,
        pitch,
        offset: Math.max(0, position - slot),
        slots: lengthInBeats * 2,
        velocity,
      });
    }
  }
  return bySlot;
}
