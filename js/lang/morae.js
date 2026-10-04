// Morae: kana cut into what the song sings, one slot each (SPEC_dopa v3 §5.5 steps 3 and 6, which
// keep SPEC_sing §6.1 steps 3 to 6). This is the JavaScript copy of the mora rules of
// `dbr/sing.py`, which the server used until the site (SD-W05): a small kana joins the kana
// before it, 「ー」 is sung as the vowel before it, and 「ス」 and 「ン」 are morae like any other
// (歌 ED D-30), except that in a 文節 too long for one bar a ン joins the mora before it (D-31).
// No browser globals: tested with node.

export const SLOTS_PER_BAR = 8;
export const SMALL_KANA = "ャュョァィゥェォヮ";
// 「ニャン」 for a word that cannot be read (D-86, D-116) is one sung unit with a sheet of its own
// in the voice bank, not ニャ and ン. A pronunciation writes it as this one private-use character,
// so that a katakana word the dictionary knows (ニャンコ) keeps its own morae.
export const NYAN = "ニャン";
export const NYAN_MARK = "\uE000";
const KANA = /[ァ-ヴー]/;
const SAME_SOUND = { ヲ: "オ", ヂ: "ジ", ヅ: "ズ" }; // written differently, sung the same

// The vowel each kana ends in. ン counts as its own vowel: a long ン is hummed on.
const VOWEL_OF_KANA = {};
for (const [row, vowel] of [
  ["アカサタナハマヤラワガザダバパァャヮ", "ア"],
  ["イキシチニヒミリギジヂビピィ", "イ"],
  ["ウクスツヌフムユルグズヅブプゥュヴ", "ウ"],
  ["エケセテネヘメレゲゼデベペェ", "エ"],
  ["オコソトノホモヨロヲゴゾドボポォョ", "オ"],
  ["ン", "ン"],
]) {
  for (const kana of row) {
    VOWEL_OF_KANA[kana] = vowel;
  }
}

/** The vowel kana a mora ends in (ン for ン); null for ッ, which has no sound to prolong, and for
 * a kana the table does not hold (ヰ, ヱ). */
export function vowelOf(mora) {
  const lastKana = mora[mora.length - 1];
  return VOWEL_OF_KANA[lastKana] ?? null;
}

/** Katakana with each 「ニャン」 unit spelled out, for showing a pronunciation. */
export function spelledOut(pron) {
  const written = pron ?? "";
  return written.replaceAll(NYAN_MARK, NYAN);
}

/**
 * The morae of a pronunciation in katakana, as [{ k, long }].
 *
 * A small kana joins the kana before it (キャ). The long mark ー is a mora of its own, sung as the
 * vowel of the mora before it; `before` is the kana of the last mora of the word before, for a
 * word that starts with the mark. A mark with no vowel to prolong is sung ア. NYAN_MARK is the one
 * mora ニャン. Anything else that is not kana is
 * dropped, such as ’, which marks an unvoiced vowel.
 *
 *     moraeOf("ショーヒン") -> ショ, オ (long), ヒ, ン
 */
export function moraeOf(pron, kanaBefore = null) {
  const morae = [];

  for (const char of pron ?? "") {
    if (char === NYAN_MARK) {
      const nyan = {
        k: NYAN,
        long: false,
      };
      morae.push(nyan);
      continue;
    }

    if (!KANA.test(char)) {
      continue;
    }

    let lastMora = null;
    if (morae.length > 0) {
      lastMora = morae[morae.length - 1];
    }

    let previousIsPlainKana = false;
    if (lastMora) {
      previousIsPlainKana = !lastMora.long && lastMora.k !== NYAN;
    }

    if (SMALL_KANA.includes(char) && previousIsPlainKana) {
      lastMora.k += char;
    } else if (char === "ー") {
      let prolonged = kanaBefore;
      if (lastMora) {
        prolonged = lastMora.k;
      }

      let vowel = "ア";
      if (prolonged) {
        vowel = vowelOf(prolonged) || "ア";
      }

      const longMora = {
        k: vowel,
        long: true,
      };
      morae.push(longMora);
    } else {
      const sound = SAME_SOUND[char] ?? char;

      const mora = {
        k: sound,
        long: false,
      };
      morae.push(mora);
    }
  }

  return morae;
}

/**
 * The morae of one word, each with the characters of the text that light when it is sung:
 * [{ k, start, end, tails: [], long }]. The word's characters are shared evenly among its morae.
 * A character lights when the first of its morae is sung, so the end is rounded up: 本 (ホ, ン)
 * lights on ホ.
 */
export function spreadOverCharacters(sounds, wordStart, wordEnd) {
  const length = wordEnd - wordStart;

  return sounds.map(({ k, long }, n) => {
    // how many of the word's characters lie before this mora, and before the next one
    const charactersBefore = (length * n) / sounds.length;
    const charactersBeforeNext = (length * (n + 1)) / sounds.length;

    return {
      k,
      start: wordStart + Math.floor(charactersBefore),
      end: wordStart + Math.ceil(charactersBeforeNext),
      tails: [],
      long,
    };
  });
}

/**
 * Make a 文節 of more than 8 morae fit one bar by joining ン to the mora before it (歌 ED D-31).
 *
 * From the start of the 文節, as many ン as needed join the mora before them into one closed
 * syllable sung in one slot from its own sound in the bank (サ + ン -> サン; ED D-118: every
 * 「mora + ン」 was sung by VOICEVOX as one sound). They take no slot of their own. If the 文節
 * has too few ン to get down to 8, none is changed, since it needs a second bar anyway. A ン
 * stays a mora when it opens the 文節, when it is a long vowel's sound, or when the mora before
 * it is ッ or ends in ン (ン, or the unit ニャン). The unit ニャン is never a ン here.
 *
 *     セ エ サ ン ヨ オ シ キ ガ (9) -> セ エ サン ヨ オ シ キ ガ (8)
 */
export function fit(morae) {
  const canBecomeEnding = (mora, previous) => {
    const isPlainN = mora.k === "ン" && !mora.long;
    if (!isPlainN || !previous) {
      return false;
    }
    return previous.k !== "ッ" && !previous.k.endsWith("ン");
  };

  let tooMany = morae.length - SLOTS_PER_BAR;

  const candidates = morae.filter((mora, i) => {
    let previous = null;
    if (i) {
      previous = morae[i - 1];
    }
    return canBecomeEnding(mora, previous);
  });

  if (tooMany <= 0 || candidates.length < tooMany) {
    return morae;
  }

  const fitted = [];
  for (const mora of morae) {
    let previous = null;
    if (fitted.length) {
      previous = fitted[fitted.length - 1];
    }

    let joinsPrevious = false;
    if (tooMany > 0 && canBecomeEnding(mora, previous)) {
      joinsPrevious = !previous.tails.length;
    }

    if (joinsPrevious) {
      previous.k += "ン"; // one sound: the closed syllable of the bank (D-118)
      previous.end = mora.end; // the ン's character lights with the mora before it
      tooMany -= 1;
    } else {
      fitted.push(mora);
    }
  }

  return fitted;
}

/** Hiragana as katakana (ぁ to ゖ, and ゝ ゞ), anything else unchanged. */
export function toKatakana(text) {
  return text.replace(/[ぁ-ゖゝゞ]/g, (char) => {
    const katakanaCode = char.charCodeAt(0) + 0x60;
    return String.fromCharCode(katakanaCode);
  });
}
