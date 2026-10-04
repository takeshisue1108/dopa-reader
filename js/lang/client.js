// The page's side of the analysis worker (SPEC_dopa v3 SD-W04, SD-W06). The reader asks for a
// sentence's score and targets ahead of the song; a sentence asked for twice (a jump back, the
// next block's first sentences asked early) is answered from a small cache.
//
//     const analyzer = createAnalyzer();
//     await analyzer.ready;                       // rejects if the dictionary cannot be loaded
//     const { phrases, targets } = await analyzer.analyze("これは本です。");

import * as progress from "../loading.js";

// sentences kept in the cache; the one asked for longest ago is dropped first
const MAX_CACHED_SENTENCES = 400;
// The files of kuromoji's dictionary, for the charging display before the worker has said
// anything; the worker counts them itself as they arrive and says the same number (worker.js).
const DICTIONARY_FILES = 12;

/** Start the worker. `ready` resolves when its dictionary is loaded; `analyze(text)` resolves to
 * { phrases, targets } (§5.5, §5.6; with `ipa`, the IPA of its English words, when it has any, and
 * `englishPhrases`, the English score of an English sentence, §5.8),
 * or rejects when the text cannot be analyzed (also at once,
 * for every text, after the worker itself has failed). `timings` holds the worker's time in
 * milliseconds for each of the last 1000 analyses it made (an answer from the cache is not one),
 * for SC-W07. */
export function createAnalyzer({ workerUrl = new URL("./worker.js", import.meta.url) } = {}) {
  const worker = new Worker(workerUrl, { type: "module" });
  const pendingById = new Map(); // id -> { resolve, reject }
  const cache = new Map(); // text -> Promise of { phrases, targets }
  const timings = [];
  let nextId = 1;
  // the worker's error, once it has failed: nothing more is asked of it
  let broken = null;

  let settleReady;
  const ready = new Promise((resolve, reject) => {
    settleReady = {
      resolve,
      reject,
    };
  });
  // a caller that never waits for it must not see an unhandled rejection
  ready.catch(() => {});

  // The dictionary's files for the charging display (§6.2a): counted as the worker reports them,
  // and all counted once it is ready or has failed (nothing more is waited for then).
  progress.count("dictionary", 0, DICTIONARY_FILES);
  const dictionaryDone = () => progress.count("dictionary", DICTIONARY_FILES, DICTIONARY_FILES);

  worker.onmessage = ({ data }) => {
    if (data.id === 0) {
      if ("loaded" in data) {
        return progress.count("dictionary", data.loaded, data.of);
      }

      dictionaryDone();

      if (data.ready) {
        settleReady.resolve();
      } else {
        const error = new Error(data.error);
        settleReady.reject(error);
      }
      return;
    }

    const pending = pendingById.get(data.id);
    if (!pending) {
      return;
    }
    pendingById.delete(data.id);

    if (data.error) {
      const error = new Error(data.error);
      pending.reject(error);
    } else {
      timings.push(data.ms);
      if (timings.length > 1000) {
        timings.shift();
      }

      const { phrases, targets, ipa, englishPhrases } = data;

      let analysis;
      if (ipa) {
        analysis = {
          phrases,
          targets,
          ipa,
        };
        if (englishPhrases) {
          analysis.englishPhrases = englishPhrases;
        }
      } else {
        analysis = {
          phrases,
          targets,
        };
      }
      pending.resolve(analysis);
    }
  };

  worker.onerror = (event) => {
    const reason = event.message ?? "failed";
    const error = new Error(`analysis worker: ${reason}`);

    broken = error;
    dictionaryDone();
    settleReady.reject(error);

    for (const pending of pendingById.values()) {
      pending.reject(error);
    }
    pendingById.clear();
  };

  function analyze(text) {
    // a worker that failed answers no more: refuse at once, so that the reader goes on without a
    // voice instead of waiting for ever (SD-W09)
    if (broken) {
      return Promise.reject(broken);
    }

    const cached = cache.get(text);
    if (cached) {
      cache.delete(text); // to the newest end
      cache.set(text, cached);
      return cached;
    }

    const id = nextId++;
    const answer = new Promise((resolve, reject) => {
      const pending = {
        resolve,
        reject,
      };
      pendingById.set(id, pending);
    });

    const question = {
      id,
      text,
    };
    worker.postMessage(question);

    cache.set(text, answer);
    answer.catch(() => cache.delete(text)); // a failure is not kept

    while (cache.size > MAX_CACHED_SENTENCES) {
      const oldestText = cache.keys().next().value;
      cache.delete(oldestText);
    }

    return answer;
  }

  return {
    ready,
    analyze,
    timings,
    terminate: () => worker.terminate(),
  };
}
