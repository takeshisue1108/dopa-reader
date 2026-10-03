// The clock of the Day Life score (SPEC_dopa v3.9 §6.11; ED D-139): a slot is an eighth note of
// the score, so its length follows the score's tempo map (0.15 s at 200 BPM), and 「速さ」 divides
// it. No browser dependency.
import { SLOTS_PER_BAR } from "./plan.js";

/** The length of each slot of the score at the speed 1.0, in seconds: an eighth note at the tempo
 * of its bar. `tempo` is tempo.json: { bars, tempo: [{ bar (from 1), bpm }] }. */
export function slotLengths(tempo) {
  const lengths = new Float64Array(tempo.bars * SLOTS_PER_BAR);
  const map = [...tempo.tempo].sort((a, b) => a.bar - b.bar);
  for (let bar = 0; bar < tempo.bars; bar++) {
    let bpm = map[0].bpm;
    for (const entry of map) if (entry.bar - 1 <= bar) bpm = entry.bpm;
    lengths.fill(30 / bpm, bar * SLOTS_PER_BAR, (bar + 1) * SLOTS_PER_BAR);
  }
  return lengths;
}

/**
 * The times of the slot lines of a sentence of `bars` bars that starts at score slot `from` (a bar
 * line) at time `t0`: entry k is when its slot k starts, and the last entry is the end of its
 * last bar. The score's tempo is the same through a bar, and the score starts again after its
 * last slot. `speed` is 「速さ」. `lines[b]`, where given, is { t, slot }: the time and the slot
 * length of a bar already scheduled, which win over the prediction (the speed may have changed).
 */
export function sentenceSlots(lengths, from, t0, bars, speed = 1, lines = []) {
  const times = new Float64Array(bars * SLOTS_PER_BAR + 1);
  let t = t0;
  for (let b = 0; b < bars; b++) {
    const line = lines[b];
    const start = line ? line.t : t;
    const slot = line ? line.slot : lengths[(from + b * SLOTS_PER_BAR) % lengths.length] / speed;
    for (let k = 0; k < SLOTS_PER_BAR; k++) times[b * SLOTS_PER_BAR + k] = start + k * slot;
    t = start + SLOTS_PER_BAR * slot;
  }
  times[bars * SLOTS_PER_BAR] = t;
  return times;
}
