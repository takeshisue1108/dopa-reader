// The clock of the Day Life score (SPEC_dopa v3.9 §6.11; ED D-139): a slot is an eighth note of
// the score, so its length follows the score's tempo map (0.15 s at 200 BPM), and 「速さ」 divides
// it. No browser dependency.
import { SLOTS_PER_BAR } from "./bars.js";

/** The length of each slot of the score at the speed 1.0, in seconds: an eighth note at the tempo
 * of its bar. `tempo` is tempo.json: { bars, tempo: [{ bar (from 1), bpm }] }. */
export function slotLengths(tempoMap) {
  const slotCount = tempoMap.bars * SLOTS_PER_BAR;
  const lengths = new Float64Array(slotCount);

  const changes = [...tempoMap.tempo];
  changes.sort((a, b) => a.bar - b.bar);

  for (let bar = 0; bar < tempoMap.bars; bar++) {
    // the tempo in force in the bar: that of the last change at or before it
    let bpm = changes[0].bpm;
    for (const entry of changes) {
      const changeBar = entry.bar - 1;
      if (changeBar <= bar) {
        bpm = entry.bpm;
      }
    }

    const slotSeconds = 30 / bpm;
    const firstSlot = bar * SLOTS_PER_BAR;
    const slotAfterLast = (bar + 1) * SLOTS_PER_BAR;
    lengths.fill(slotSeconds, firstSlot, slotAfterLast);
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
  const slotCount = barCount * SLOTS_PER_BAR;
  const times = new Float64Array(slotCount + 1);

  let nextBarAt = startTime;
  for (let barIndex = 0; barIndex < barCount; barIndex++) {
    const line = scheduledBars[barIndex];

    let start;
    let slotLength;
    if (line) {
      start = line.t;
      slotLength = line.slot;
    } else {
      const scoreSlot = (startSlot + barIndex * SLOTS_PER_BAR) % lengths.length;
      start = nextBarAt;
      slotLength = lengths[scoreSlot] / speed;
    }

    const firstEntry = barIndex * SLOTS_PER_BAR;
    for (let slotInBar = 0; slotInBar < SLOTS_PER_BAR; slotInBar++) {
      times[firstEntry + slotInBar] = start + slotInBar * slotLength;
    }

    nextBarAt = start + SLOTS_PER_BAR * slotLength;
  }

  times[slotCount] = nextBarAt;
  return times;
}
