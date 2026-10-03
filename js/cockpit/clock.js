// One clock for ドパドパ (SPEC_dopa SD-D04; ドパ ED D-15, D-20): everything updates and draws
// only when floor(t * 30) changes. It stops while paused or while the tab is hidden.

export const FPS = 30;
let fn = null,
  last = -1,
  running = false,
  t0 = 0,
  pausedAt = 0,
  pausedTotal = 0;
const times = [];
let perf = false;

export function start(tick, { measure = false } = {}) {
  fn = tick;
  perf = measure;
  running = true;
  t0 = performance.now();
  last = -1;
  requestAnimationFrame(loop);
}
/** Whether start() has been called. */
export function started() {
  return fn !== null;
}
export function pause() {
  if (running) {
    running = false;
    pausedAt = performance.now();
  }
}
export function resume() {
  if (!running && fn) {
    pausedTotal += performance.now() - pausedAt;
    running = true;
    requestAnimationFrame(loop);
  }
}
export function now() {
  return ((running ? performance.now() : pausedAt) - t0 - pausedTotal) / 1000;
}
export function tickTimes() {
  return times.slice();
}

function loop() {
  if (!running) return;
  const n = Math.floor(now() * FPS);
  if (n !== last && !document.hidden) {
    last = n;
    const a = performance.now();
    fn(n);
    if (perf) {
      times.push(performance.now() - a);
      if (times.length > 3000) times.shift();
    }
  }
  requestAnimationFrame(loop);
}
