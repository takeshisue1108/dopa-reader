// The clock of the Day Life score (SPEC_dopa v3.9 §6.11; ED D-139): a slot is an eighth note of
// the score, so its length follows the score's tempo map (0.15 s at 200 BPM), and 「速さ」 divides
// it. No browser dependency.
import { SLOTS_PER_BAR } from "./bars.js";

/** The length of each slot of the score at the speed 1.0, in seconds: an eighth note at the tempo
 * of its bar. `tempo` is tempo.json: { bars, tempo: [{ bar (from 1), bpm }] }. */
export function slotLengths(tempoMap) {
  const lengths = new Float64Array(tempoMap.bars * SLOTS_PER_BAR);
  const changes = [...tempoMap.tempo].sort((a, b) => a.bar - b.bar);
  for (let bar = 0; bar < tempoMap.bars; bar++) {
    let bpm = changes[0].bpm;
    for (const entry of changes) if (entry.bar - 1 <= bar) bpm = entry.bpm;
    lengths.fill(30 / bpm, bar * SLOTS_PER_BAR, (bar + 1) * SLOTS_PER_BAR);
  }
  return lengths;
}

/**
 * The times of the slot lines of a sentence of `barCount` bars that starts at score slot
 * `startSlot` (a bar line) at time `startTime` (seconds): entry k is when its slot k starts, and
 * the last entry is the end of its last bar. The score's tempo is the same through a bar, and the
 * score starts again after its last slot. `speed` is the reader's 「速さ」 setting.
 * `scheduledBars[b]`, where given, is { t, slot }: the time (seconds) and the length of a slot
 * (seconds) of a bar already scheduled, which win over the prediction (the speed may have
 * changed).
 */
export function sentenceSlots(
  lengths,
  startSlot,
  startTime,
  barCount,
  speed = 1,
  scheduledBars = [],
) {
  const times = new Float64Array(barCount * SLOTS_PER_BAR + 1);
  let nextBarAt = startTime;
  for (let barIndex = 0; barIndex < barCount; barIndex++) {
    const line = scheduledBars[barIndex];
    const start = line ? line.t : nextBarAt;
    const slotLength = line
      ? line.slot
      : lengths[(startSlot + barIndex * SLOTS_PER_BAR) % lengths.length] / speed;
    for (let slotInBar = 0; slotInBar < SLOTS_PER_BAR; slotInBar++)
      times[barIndex * SLOTS_PER_BAR + slotInBar] = start + slotInBar * slotLength;
    nextBarAt = start + SLOTS_PER_BAR * slotLength;
  }
  times[barCount * SLOTS_PER_BAR] = nextBarAt;
  return times;
}
