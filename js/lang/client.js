// The page's side of the analysis worker (SPEC_dopa v3 SD-W04, SD-W06). The reader asks for a
// sentence's score and targets ahead of the song; a sentence asked for twice (a jump back, the
// next block's first sentences asked early) is answered from a small cache.
//
//     const analyzer = createAnalyzer();
//     await analyzer.ready;                       // rejects if the dictionary cannot be loaded
//     const { phrases, targets } = await analyzer.analyze("これは本です。");

const KEPT = 400; // sentences kept in the cache, the oldest dropped first

/** Start the worker. `ready` resolves when its dictionary is loaded; `analyze(text)` resolves to
 * { phrases, targets } (§5.5, §5.6), or rejects when the text cannot be analyzed. `timings` holds
 * the worker's time for each analysis in milliseconds, for SC-W07. */
export function createAnalyzer({ workerUrl = new URL("./worker.js", import.meta.url) } = {}) {
  const worker = new Worker(workerUrl, { type: "module" });
  const waiting = new Map(); // id -> { resolve, reject }
  const cache = new Map(); // text -> Promise of { phrases, targets }
  const timings = [];
  let nextId = 1;
  let readyDone;
  const ready = new Promise((resolve, reject) => (readyDone = { resolve, reject }));
  ready.catch(() => {}); // a caller that never waits for it must not see an unhandled rejection

  worker.onmessage = ({ data }) => {
    if (data.id === 0) {
      if (data.ready) readyDone.resolve();
      else readyDone.reject(new Error(data.error));
      return;
    }
    const pending = waiting.get(data.id);
    if (!pending) return;
    waiting.delete(data.id);
    if (data.error) pending.reject(new Error(data.error));
    else {
      timings.push(data.ms);
      if (timings.length > 1000) timings.shift();
      pending.resolve({ phrases: data.phrases, targets: data.targets });
    }
  };
  worker.onerror = (event) => {
    const error = new Error(`analysis worker: ${event.message ?? "failed"}`);
    readyDone.reject(error);
    for (const pending of waiting.values()) pending.reject(error);
    waiting.clear();
  };

  function analyze(text) {
    const kept = cache.get(text);
    if (kept) {
      cache.delete(text); // to the newest end
      cache.set(text, kept);
      return kept;
    }
    const id = nextId++;
    const answer = new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
    worker.postMessage({ id, text });
    cache.set(text, answer);
    answer.catch(() => cache.delete(text)); // a failure is not kept
    while (cache.size > KEPT) cache.delete(cache.keys().next().value);
    return answer;
  }

  return { ready, analyze, timings, terminate: () => worker.terminate() };
}
