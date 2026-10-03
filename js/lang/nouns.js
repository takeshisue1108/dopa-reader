// The target nouns of a sentence: the words the enemies carry (SPEC_dopa v3 §5.6; ED D-60, D-62,
// D-64, D-79). Every noun is a target except pronouns, formal nouns, numerals and suffixes;
// nothing ranks the words. A run of nouns is one target (経済政策). No browser globals: tested with
// node.

const LEFT_OUT = new Set(["代名詞", "非自立", "数", "接尾"]); // D-62, D-64
const LEFT_OUT_WHEN_ONE_KANA = new Set(["特殊", "副詞可能"]);
// D-64 names こと, もの and ため as formal nouns. The dictionary tags もの as 一般 in some places
// (「もののために」), so these three are left out by how they are written, too.
const FORMAL_NOUNS = new Set(["こと", "もの", "ため"]);
const KANA = /[ぁ-ゖァ-ヺー]/;
const KANJI = /\p{Script=Han}/u;
const ONE_KANA = /^[ぁ-ゖァ-ヺ]$/;

/** Whether a kuromoji token is a target word on its own (§5.6 step 1). */
export function isTargetWord(token) {
  if (token.pos !== "名詞") return false;
  const kind = token.pos_detail_1;
  const surface = token.surface_form;
  if (LEFT_OUT.has(kind)) return false;
  if (LEFT_OUT_WHEN_ONE_KANA.has(kind) && ONE_KANA.test(surface)) return false;
  if (FORMAL_NOUNS.has(surface)) return false;
  return KANA.test(surface) || KANJI.test(surface); // not a symbol read as a noun
}

const isSuffix = (token) => token.pos === "名詞" && token.pos_detail_1 === "接尾";
const isPrefix = (token) => token.pos === "接頭詞";
const isNumber = (token) => token.pos === "名詞" && token.pos_detail_1 === "数";
// After a number, 月 is the counter of §5.5 step 5 (9月 ガツ), though the dictionary tags it 一般
// there: it is a suffix, not a target (D-64).
const isCounterMonth = (tokens, i) => tokens[i].surface_form === "月" && i > 0 && isNumber(tokens[i - 1]);

/**
 * The targets of a sentence, in order, as [{ start, end, text }]: character offsets in `speech`.
 * `tokens` are kuromoji's tokens of `speech`, and `spans` their [start, end) in it.
 *
 * Target words next to each other are one target (D-79). A prefix right before them joins it
 * (お茶); suffixes between two target words join it (経済的政策); suffixes at the end stay out
 * (田中さん -> 田中, D-64).
 */
export function targetsOf(speech, tokens, spans) {
  tokens = tokens.map((token, i) =>
    isCounterMonth(tokens, i) ? { ...token, pos_detail_1: "接尾" } : token,
  );
  const targets = [];
  let i = 0;
  while (i < tokens.length) {
    if (!isTargetWord(tokens[i])) {
      i += 1;
      continue;
    }
    const first = i > 0 && isPrefix(tokens[i - 1]) ? i - 1 : i;
    let last = i;
    let next = i + 1;
    for (;;) {
      let after = next;
      while (after < tokens.length && isSuffix(tokens[after])) after += 1; // suffixes between words
      if (after < tokens.length && isTargetWord(tokens[after])) {
        last = after;
        next = after + 1;
      } else break;
    }
    const start = spans[first][0];
    const end = spans[last][1];
    targets.push({ start, end, text: speech.slice(start, end) });
    i = next;
  }
  return targets;
}
