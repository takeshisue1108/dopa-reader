// Firing on the song's clock (SPEC_dopa v3 §5.6 step 4, §6.4, SD-W10; ED D-61, D-83, D-133,
// ST-28, ST-29). Pure: no browser at import time. The reader gives the windows of a sentence's
// target nouns, from the times at which the song sings their morae; a press is judged against the
// song time the user was hearing when they pressed.

export const BEFORE = 0.4, // a window opens this long before the progress bar reaches the noun (D-133)
  AFTER = 0.4; // and stays open this long after it leaves it

/**
 * The windows of a sentence's targets. `targets` are [{id, start, end}] in the sentence's speech
 * offsets; `events` are the sung morae [{t, start, end}] with `t` on the song's clock; `slot` is
 * the length of a slot in seconds. A window runs from BEFORE ahead of the first overlapping mora's
 * start to AFTER past the end of the last one's slot: while the progress bar is on the word,
 * ± 0.4 s. A target with no sung mora has no window.
 */
export function windowsOf(targets, events, slot) {
  const windows = [];
  for (const target of targets) {
    const sung = events.filter((mora) => mora.start < target.end && mora.end > target.start);
    if (!sung.length) continue;
    const first = Math.min(...sung.map((mora) => mora.t)),
      last = Math.max(...sung.map((mora) => mora.t));
    windows.push({ id: target.id, from: first - BEFORE, to: last + slot + AFTER });
  }
  return windows;
}

/** Which target a press at song time `heard` hits: among the open windows not yet hit, the one
 * that opened first (D-82: when windows overlap, the earliest noun). Null when none is open. */
export function judge(windows, heard, hit = new Set()) {
  let best = null;
  for (const window of windows)
    if (!hit.has(window.id) && heard >= window.from && heard <= window.to)
      if (!best || window.from < best.from) best = window;
  return best ? best.id : null;
}

/**
 * The song time that the user was hearing when an input event happened (SD-W10).
 * `stamp` is AudioContext.getOutputTimestamp(): the context time being heard at a performance
 * time. `eventMs` is the event's timeStamp (performance time, ms). Without a usable stamp, the
 * context's current time minus its output latency is used.
 */
export function heardAt(stamp, eventMs, fallback) {
  if (stamp && stamp.performanceTime > 0 && Number.isFinite(stamp.contextTime))
    return stamp.contextTime + (eventMs - stamp.performanceTime) / 1000;
  return fallback.currentTime - (fallback.outputLatency || fallback.baseLatency || 0);
}

/** Whether any window of the list is open at song time `t` (for the white flash, ST-28). */
export const openAt = (windows, t, hit = new Set()) =>
  windows.filter((window) => !hit.has(window.id) && t >= window.from && t <= window.to);
