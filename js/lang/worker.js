// The analysis worker (SPEC_dopa v3 SD-W04, SD-W06): kuromoji.js with its dictionary, off the
// page's thread, so that the 30-tick clock never waits for a sentence. It is a module worker
// (`new Worker(url, { type: "module" })`), so that it imports analyze.js as the page and the tests
// do. kuromoji.js is a plain script that sets `self.kuromoji`; a module worker has no
// importScripts, so the script is fetched and run once.
//
// What English needs is loaded only when it comes (§5.7; ED D-116, D-160, D-167), so a book
// without Latin letters fetches none of it: the dictionary of pronunciations in IPA, with the
// list of words that have two, at the first sentence with a Latin letter; the model that writes
// a pronunciation from a spelling (g2p.js), at the first word that the dictionary cannot give;
// the tagger that finds the target nouns of an English sentence (§5.6 step 6), at the first
// English sentence. Without the dictionary every Latin word that is not all capitals is one
// ニャン; without the model, only the words the dictionary lacks; without the tagger an English
// sentence has no targets. The reader sings in every case.
//
// Messages in:  { id, text }
// Messages out: { id: 0, loaded, of } as each file of the dictionary arrives (for the charging
//               display, §6.2a); { id: 0, ready: true } once the dictionary is loaded, or
//               { id: 0, error } when it cannot be; { id, phrases, targets, ipa, englishPhrases,
//               ms } for each text (ipa: the IPA of its words of Latin letters, when it has any;
//               englishPhrases: the English score of an English sentence), or
//               { id, error }.
// Before the dictionary is loaded, texts wait; if it cannot be loaded, every text gets an error
// and the reader goes on without a voice (SD-W09).
import { analyze, isEnglishSentence } from "./analyze.js";
import { termsOf } from "./english.js";
import { createG2p } from "./g2p.js";
import { createEnglish } from "./pronounce.js";

// Paths from this file's own place, so the site works under any folder of any server.
const KUROMOJI_SCRIPT_URL = new URL("../../vendor/kuromoji/build/kuromoji.js", import.meta.url);
// kuromoji joins the dictionary's path with `path.join`, which spoils "http://"; the path from the
// server's root is enough, since the dictionary is on the same server.
const DICTIONARY_PATH = new URL("../../vendor/kuromoji/dict/", import.meta.url).pathname;
const ENGLISH_IPA_URL = new URL("../../data/lang/en_ipa.json", import.meta.url);
const ENGLISH_HOMOGRAPHS_URL = new URL("../../data/lang/en_homographs.json", import.meta.url);
const ENGLISH_MODEL_URL = new URL("../../data/lang/en_g2p.bin", import.meta.url);
// the English part-of-speech tagger, compromise (§5.6 step 6, SD-W17)
const ENGLISH_TAGGER_URL = new URL("../../vendor/compromise/compromise-two.mjs", import.meta.url);

// kuromoji fetches its dictionary's 12 files with XMLHttpRequest, and nothing else here does: each
// request that ends (loaded or failed) is one file more for the charging display. The page counts
// 0 of the same 12 before the first message (client.js).
const DICTIONARY_FILES = 12;
let dictionaryArrived = 0;
const NativeRequest = self.XMLHttpRequest;
self.XMLHttpRequest = class extends NativeRequest {
  constructor() {
    super();

    this.addEventListener("loadend", () => {
      dictionaryArrived += 1;

      const oneMoreFile = {
        id: 0,
        loaded: dictionaryArrived,
        of: DICTIONARY_FILES,
      };
      self.postMessage(oneMoreFile);
    });
  }
};

async function loadTokenizer() {
  const response = await fetch(KUROMOJI_SCRIPT_URL);
  if (!response.ok) {
    throw new Error(`kuromoji.js: ${response.status}`);
  }

  const script = await response.text();
  const runScript = new Function(script);
  runScript(); // sets self.kuromoji

  return new Promise((resolve, reject) => {
    const builder = self.kuromoji.builder({ dicPath: DICTIONARY_PATH });

    builder.build((error, built) => {
      if (error) {
        reject(error);
      } else {
        resolve(built);
      }
    });
  });
}

const fetched = async (url) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url.pathname}: ${response.status}`);
  }
  return response;
};

/** A loader that fetches once, at its first call, and gives null (with a line in the console)
 * when what it fetches cannot be had. */
const once = (what, load) => {
  let loading = null;

  return () => {
    if (loading === null) {
      const attempt = load();

      loading = attempt.catch((error) => {
        console.warn(`${what} did not load: ${error}`);
        return null;
      });
    }
    return loading;
  };
};

// The English pronunciations (pronounce.js): the dictionary in IPA and the words with two.
const loadEnglish = once("the English dictionary", async () => {
  // the two files are asked for together
  const tableComing = fetched(ENGLISH_IPA_URL).then((response) => response.json());
  const homographsComing = fetched(ENGLISH_HOMOGRAPHS_URL).then((response) => response.json());
  const [table, homographs] = await Promise.all([tableComing, homographsComing]);

  return createEnglish({ table, homographs });
});

// The model for the words outside the dictionary (g2p.js): its weights, 32-bit floats.
const loadModel = once("the English spelling model", async () => {
  const response = await fetched(ENGLISH_MODEL_URL);
  const bytes = await response.arrayBuffer();
  const weights = new Float32Array(bytes);
  return createG2p(weights);
});

/** The English pronunciations ready for a text: loaded, and with the model's answer for each of
 * its words that the dictionary cannot give. null when the text has no Latin letter, or when
 * the dictionary cannot be loaded. */
async function englishFor(text) {
  const hasLatinLetter = /[A-Za-zＡ-Ｚａ-ｚ]/.test(text);
  if (!hasLatinLetter) {
    return null;
  }

  const english = await loadEnglish();
  if (!english) {
    return null;
  }

  const unknown = english.unknownWords(text);
  if (unknown.length) {
    const predict = await loadModel();
    if (predict) {
      for (const word of unknown) {
        const arpabet = predict(word);
        english.learn(word, arpabet);
      }
    }
  }

  return english;
}

// The tagger of English sentences (compromise).
const loadTagger = once("the English tagger", async () => {
  const taggerModule = await import(ENGLISH_TAGGER_URL);
  return taggerModule.default;
});

const loaded = loadTokenizer();
loaded.then(
  () => {
    const dictionaryReady = {
      id: 0,
      ready: true,
    };
    self.postMessage(dictionaryReady);
  },
  (error) => {
    const dictionaryFailed = {
      id: 0,
      error: `the dictionary did not load: ${error}`,
    };
    self.postMessage(dictionaryFailed);
  },
);

self.onmessage = async ({ data: { id, text } }) => {
  try {
    const tokenizer = await loaded;
    const english = await englishFor(text);

    let tagger = null;
    if (isEnglishSentence(text)) {
      tagger = await loadTagger();
    }

    const started = performance.now();

    const tokens = tokenizer.tokenize(text);

    let englishTerms = null;
    if (tagger) {
      englishTerms = termsOf(tagger, text);
    }

    const analysis = analyze(text, tokens, { english, englishTerms });
    const { phrases, targets, ipa, englishPhrases } = analysis;

    const ms = performance.now() - started;
    const answer = {
      id,
      phrases,
      targets,
      ipa,
      englishPhrases,
      ms,
    };
    self.postMessage(answer);
  } catch (error) {
    const reason = String(error?.message ?? error);
    const failed = {
      id,
      error: reason,
    };
    self.postMessage(failed);
  }
};
