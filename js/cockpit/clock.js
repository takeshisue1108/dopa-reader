// One clock for ドパドパ (SPEC_dopa SD-D04; ドパ ED D-15, D-20): everything updates and draws
// only when floor(t * 30) changes, t being the clock's time in seconds. The time stands still
// while paused; while the tab is hidden the time goes on but nothing ticks.

export const FPS = 30; // ticks a second
let onTick = null,
  lastTick = -1,
  running = false,
  startedAt = 0,
  pausedAt = 0,
  pausedTotal = 0;
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
    pausedTotal += performance.now() - pausedAt;
    running = true;
    requestAnimationFrame(loop);
  }
}
/** The clock's time in seconds: since start(), less the time spent paused. */
export function now() {
  return ((running ? performance.now() : pausedAt) - startedAt - pausedTotal) / 1000;
}
/** With `measure`: how long each of the last 3000 ticks took, in milliseconds. */
export function tickTimes() {
  return tickCosts.slice();
}

function loop() {
  if (!running) return;
  const tickNumber = Math.floor(now() * FPS);
  if (tickNumber !== lastTick && !document.hidden) {
    lastTick = tickNumber;
    const before = performance.now();
    onTick(tickNumber);
    if (measuring) {
      tickCosts.push(performance.now() - before);
      if (tickCosts.length > 3000) tickCosts.shift();
    }
  }
  requestAnimationFrame(loop);
}
