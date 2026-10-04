// The target nouns of a sentence: the words the enemies carry (SPEC_dopa v3 §5.6; ED D-60, D-62,
// D-64, D-79). Every noun is a target except pronouns, formal nouns, numerals and suffixes;
// nothing ranks the words. Also left out: a special or adverbial noun of one kana; こと, もの and
// ため however the dictionary tags them; 月 after a number; and a noun with no kana and no kanji
// (a symbol, and so far also a word in Latin letters). A run of nouns is one target (経済政策).
// No browser globals: tested with node.

const NON_TARGET_KINDS = new Set(["代名詞", "非自立", "数", "接尾"]); // D-62, D-64
const LEFT_OUT_WHEN_ONE_KANA = new Set(["特殊", "副詞可能"]);
// D-64 names こと, もの and ため as formal nouns. The dictionary tags もの as 一般 in some places
// (「もののために」), so these three are left out by how they are written, too.
const FORMAL_NOUNS = new Set(["こと", "もの", "ため"]);
const KANA = /[ぁ-ゖァ-ヺー]/;
const KANJI = /\p{Script=Han}/u;
const ONE_KANA = /^[ぁ-ゖァ-ヺ]$/;

/** Whether a kuromoji token is a target word on its own (§5.6 step 1). */
export function isTargetWord(token) {
  if (token.pos !== "名詞") {
    return false;
  }

  const pos1 = token.pos_detail_1;
  const surface = token.surface_form;

  if (NON_TARGET_KINDS.has(pos1)) {
    return false;
  }

  const kindLeftOutWhenOneKana = LEFT_OUT_WHEN_ONE_KANA.has(pos1);
  if (kindLeftOutWhenOneKana && ONE_KANA.test(surface)) {
    return false;
  }

  if (FORMAL_NOUNS.has(surface)) {
    return false;
  }

  return KANA.test(surface) || KANJI.test(surface); // not a symbol read as a noun
}

const isSuffix = (token) => token.pos === "名詞" && token.pos_detail_1 === "接尾";
const isPrefix = (token) => token.pos === "接頭詞";
const isNumber = (token) => token.pos === "名詞" && token.pos_detail_1 === "数";

// After a number, 月 is the counter of §5.5 step 5 (9月 ガツ), though the dictionary tags it 一般
// there: it is a suffix, not a target (D-64).
function isCounterMonth(tokens, i) {
  const isMonth = tokens[i].surface_form === "月";
  const hasTokenBefore = i > 0;
  if (!isMonth || !hasTokenBefore) {
    return false;
  }

  const tokenBefore = tokens[i - 1];
  return isNumber(tokenBefore);
}

/** The tokens with 月 after a number tagged as the suffix it is there (see isCounterMonth). */
function withCounterMonths(tokens) {
  return tokens.map((token, i) => {
    if (!isCounterMonth(tokens, i)) {
      return token;
    }

    const asSuffix = {
      ...token,
      pos_detail_1: "接尾",
    };
    return asSuffix;
  });
}

/**
 * The targets among tokens whose tags are final: target words next to each other are one target
 * (D-79). A prefix right before them joins it (お茶); suffixes between two target words join it
 * (経済的政策); suffixes at the end stay out (田中さん -> 田中, D-64).
 */
function targetsAmong(speech, tokens, spans) {
  const targets = [];
  let i = 0;

  while (i < tokens.length) {
    if (!isTargetWord(tokens[i])) {
      i += 1;
      continue;
    }

    let firstToken = i;
    const prefixBefore = i > 0 && isPrefix(tokens[i - 1]);
    if (prefixBefore) {
      firstToken = i - 1;
    }

    let lastToken = i;
    let afterTarget = i + 1;

    for (;;) {
      let afterSuffixes = afterTarget;
      // step over the suffixes: they join the target only when a target word follows them
      while (afterSuffixes < tokens.length && isSuffix(tokens[afterSuffixes])) {
        afterSuffixes += 1;
      }

      const targetWordFollows =
        afterSuffixes < tokens.length && isTargetWord(tokens[afterSuffixes]);
      if (!targetWordFollows) {
        break;
      }

      lastToken = afterSuffixes;
      afterTarget = afterSuffixes + 1;
    }

    const start = spans[firstToken][0];
    const end = spans[lastToken][1];

    const target = {
      start,
      end,
      text: speech.slice(start, end),
    };
    targets.push(target);

    i = afterTarget;
  }

  return targets;
}

/**
 * The targets of a sentence, in order, as [{ start, end, text }]: character offsets in `speech`.
 * `tokens` are kuromoji's tokens of `speech`, and `spans` their [start, end) in it. 月 after a
 * number is first tagged as a suffix; then the targets are found by the rules of targetsAmong.
 */
export function targetsOf(speech, tokens, spans) {
  const tagged = withCounterMonths(tokens);
  return targetsAmong(speech, tagged, spans);
}
