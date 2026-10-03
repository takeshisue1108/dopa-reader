// The analysis worker (SPEC_dopa v3 SD-W04, SD-W06): kuromoji.js with its dictionary, off the
// page's thread, so that the 30-tick clock never waits for a sentence. It is a module worker
// (`new Worker(url, { type: "module" })`), so that it imports analyze.js as the page and the tests
// do. kuromoji.js is a plain script that sets `self.kuromoji`; a module worker has no
// importScripts, so the script is fetched and run once.
//
// The English katakana table (§5.7, D-116) is loaded with the dictionary. If it cannot be loaded,
// the reader still sings: every Latin word that is not all capitals is then one ニャン.
//
// Messages in:  { id, text }
// Messages out: { id: 0, ready: true } once the dictionary is loaded,
//               { id, phrases, targets, ms } for each text, or { id, error }.
// Before the dictionary is loaded, texts wait; if it cannot be loaded, every text gets an error
// and the reader goes on without a voice (SD-W09).
import { analyze } from "./analyze.js";

// Paths from this file's own place, so the site works under any folder of any server.
const SCRIPT = new URL("../../vendor/kuromoji/build/kuromoji.js", import.meta.url);
// kuromoji joins the dictionary's path with `path.join`, which spoils "http://"; the path from the
// server's root is enough, since the dictionary is on the same server.
const DICTIONARY = new URL("../../vendor/kuromoji/dict/", import.meta.url).pathname;
const ENGLISH = new URL("../../data/lang/en_kana.json", import.meta.url);

async function build() {
  const response = await fetch(SCRIPT);
  if (!response.ok) throw new Error(`kuromoji.js: ${response.status}`);
  new Function(await response.text())(); // sets self.kuromoji
  return new Promise((resolve, reject) =>
    self.kuromoji
      .builder({ dicPath: DICTIONARY })
      .build((error, tokenizer) => (error ? reject(error) : resolve(tokenizer))),
  );
}

async function loadEnglish() {
  try {
    const response = await fetch(ENGLISH);
    if (!response.ok) throw new Error(`${response.status}`);
    return await response.json();
  } catch (error) {
    console.warn(`en_kana.json did not load: ${error}`);
    return null;
  }
}

const english = loadEnglish();
const tokenizer = build();
const loaded = Promise.all([tokenizer, english]);
loaded.then(
  () => self.postMessage({ id: 0, ready: true }),
  (error) => self.postMessage({ id: 0, error: `the dictionary did not load: ${error}` }),
);

self.onmessage = async ({ data: { id, text } }) => {
  try {
    const [ready, table] = await loaded;
    const started = performance.now();
    const { phrases, targets } = analyze(text, ready.tokenize(text), { english: table });
    self.postMessage({ id, phrases, targets, ms: performance.now() - started });
  } catch (error) {
    self.postMessage({ id, error: String(error?.message ?? error) });
  }
};
