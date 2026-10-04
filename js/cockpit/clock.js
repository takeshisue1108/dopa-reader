// One clock for ドパドパ (SPEC_dopa SD-D04; ドパ ED D-15, D-20): everything updates and draws
// only when floor(t * 30) changes, t being the clock's time in seconds. The time stands still
// while paused; while the tab is hidden the time goes on but nothing ticks.

// ticks a second
export const FPS = 30;

let onTick = null;
let lastTick = -1;
let running = false;
let startedAt = 0;
let pausedAt = 0;
let pausedTotal = 0;

const tickCosts = [];
let measuring = false;

/** Start the clock at 0 (call it once: a second start would not clear the paused time):
 * `tick(n)` is called once for each thirtieth of a second in which a frame
 * comes, with the number of that thirtieth (a number is skipped when no frame came in it). With
 * `measure`, how long each call took is kept (tickTimes). */
export function start(tick, { measure = false } = {}) {
  onTick = tick;
  measuring = measure;
  running = true;
  startedAt = performance.now();
  lastTick = -1;

  requestAnimationFrame(loop);
}

/** Whether start() has been called. */
export function started() {
  return onTick !== null;
}

/** Stop the clock's time and its ticks until resume(). */
export function pause() {
  if (running) {
    running = false;
    pausedAt = performance.now();
  }
}

/** Go on from the time at which pause() stopped the clock. */
export function resume() {
  if (!running && onTick) {
    const pausedMs = performance.now() - pausedAt;
    pausedTotal += pausedMs;

    running = true;
    requestAnimationFrame(loop);
  }
}

/** The clock's time in seconds: since start(), less the time spent paused. */
export function now() {
  // while paused, the time stands at the moment of the pause
  let readAt = pausedAt;
  if (running) {
    readAt = performance.now();
  }

  const sinceStartMs = readAt - startedAt;
  const runningMs = sinceStartMs - pausedTotal;
  return runningMs / 1000;
}

/** With `measure`: how long each of the last 3000 ticks took, in milliseconds. */
export function tickTimes() {
  return tickCosts.slice();
}

function loop() {
  if (!running) {
    return;
  }

  const seconds = now();
  const tickNumber = Math.floor(seconds * FPS);

  const isNewTick = tickNumber !== lastTick;
  if (isNewTick && !document.hidden) {
    lastTick = tickNumber;

    const before = performance.now();
    onTick(tickNumber);

    if (measuring) {
      const costMs = performance.now() - before;
      tickCosts.push(costMs);

      if (tickCosts.length > 3000) {
        tickCosts.shift();
      }
    }
  }

  requestAnimationFrame(loop);
}
