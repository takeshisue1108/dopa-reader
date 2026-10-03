// Numbers read aloud for the song (SPEC_dopa v3 §5.5 step 5; ED A-29: 2022 is sung ニセンニジュウニ).
// The dictionary has no reading for a number written in digits, so the digits are read here, in
// groups of 万, with the sound changes of the rule: 三百 サンビャク, 六百 ロッピャク, 八百 ハッピャク,
// 三千 サンゼン, 八千 ハッセン; 一千 is セン and 一万 イチマン. Readings are katakana. No browser
// globals: tested with node.

const DIGIT_READINGS = [
  "ゼロ",
  "イチ",
  "ニ",
  "サン",
  "ヨン",
  "ゴ",
  "ロク",
  "ナナ",
  "ハチ",
  "キュウ",
];
const HUNDREDS = { 1: "ヒャク", 3: "サンビャク", 6: "ロッピャク", 8: "ハッピャク" };
const THOUSANDS = { 1: "セン", 3: "サンゼン", 8: "ハッセン" };
const GROUP_UNITS = ["", "マン", "オク", "チョウ"]; // every 4 places
const MAX_PLACES = 16; // more than this is read digit by digit

/** Each digit on its own: "305" -> サンゼロゴ (decimals, and numbers of more than 16 places). */
export const readDigits = (digits) => [...digits].map((d) => DIGIT_READINGS[+d]).join("");

/** A group of up to four digits, 1 to 9999, without its 万 or 億. */
function readGroup(value) {
  const [thousands, hundreds, tens, ones] = String(value).padStart(4, "0").split("").map(Number);
  let reading = "";
  if (thousands) reading += THOUSANDS[thousands] ?? DIGIT_READINGS[thousands] + "セン";
  if (hundreds) reading += HUNDREDS[hundreds] ?? DIGIT_READINGS[hundreds] + "ヒャク";
  if (tens) reading += (tens === 1 ? "" : DIGIT_READINGS[tens]) + "ジュウ";
  if (ones) reading += DIGIT_READINGS[ones];
  return reading;
}

/**
 * The reading of a number written in ASCII digits, with thousands separators already removed
 * and an optional decimal part: "2022" -> ニセンニジュウニ, "1.5" -> イチテンゴ, "0" -> ゼロ.
 */
export function readNumber(number) {
  const [whole, decimals] = number.split(".");
  let reading;
  const digits = whole.replace(/^0+(?=\d)/, "");
  if (digits.length > MAX_PLACES) reading = readDigits(whole);
  else if (/^0*$/.test(digits)) reading = DIGIT_READINGS[0];
  else {
    reading = "";
    const groups = [];
    for (let end = digits.length; end > 0; end -= 4)
      groups.unshift(digits.slice(Math.max(0, end - 4), end));
    groups.forEach((group, i) => {
      const value = Number(group);
      if (value) reading += readGroup(value) + GROUP_UNITS[groups.length - 1 - i];
    });
  }
  return decimals === undefined ? reading : reading + "テン" + readDigits(decimals);
}

// The few numbers whose counter changes the whole reading (§5.5 step 5): number + counter ->
// reading.
const NUMBER_WITH_COUNTER = { "1日": "ツイタチ", "20日": "ハツカ", "4月": "シガツ" };

/** The reading of a number and the counter after it when the pair has a reading of its own
 * (1日 ツイタチ, 20日 ハツカ, 4月 シガツ), else null. `number` is in ASCII digits. */
export const readSpecial = (number, counter) =>
  NUMBER_WITH_COUNTER[`${number.replace(/^0+(?=\d)/, "")}${counter}`] ?? null;

/** Full-width digits, commas and full stops as ASCII ("２０２２" -> "2022"); else unchanged. */
export const asciiDigits = (text) =>
  text.replace(/[０-９，．]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));

/**
 * The numbers written in digits in a run of digit characters, as [{ start, end, number }] with
 * `number` in plain ASCII digits (separators removed). A comma counts when three digits follow
 * it (1,000,000; what follows those three is not looked at, so "1,0000" is 1000 and then 0), a
 * full stop only between digits (3.14); any other comma or full stop is left out, and is a mark.
 */
export function numbersIn(run) {
  const ascii = asciiDigits(run);
  const found = [];
  for (const match of ascii.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g))
    found.push({
      start: match.index,
      end: match.index + match[0].length,
      number: match[0].replaceAll(",", ""),
    });
  return found;
}

const KANJI_DIGIT = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const KANJI_SMALL_UNIT = { 十: 10, 百: 100, 千: 1000 };
const KANJI_LARGE_UNIT = { 万: 1e4, 億: 1e8, 兆: 1e12 };
export const KANJI_NUMERAL = /^[〇一二三四五六七八九十百千万億兆]+$/;

/**
 * A number written in kanji numerals as ASCII digits, or null when it is not one number (the
 * order of its units is not checked: 十百 gives "110").
 * 三百 -> "300", 二千二十二 -> "2022", 二〇二二 -> "2022" (place by place, when it has 〇).
 * Numerals side by side without a unit between them (二三日: two or three days) are not one
 * number, and give null.
 */
export function kanjiNumber(text) {
  if (!KANJI_NUMERAL.test(text)) return null;
  const hasUnit = /[十百千万億兆]/.test(text);
  if (!hasUnit) return text.includes("〇") ? [...text].map((c) => KANJI_DIGIT[c]).join("") : null;
  let total = 0n, // what the large units (万, 億, 兆) have closed
    section = 0n, // below the next large unit
    digit = null; // a numeral still waiting for its unit
  for (const char of text) {
    if (char in KANJI_DIGIT) {
      if (digit !== null) return null; // two numerals in a row
      digit = BigInt(KANJI_DIGIT[char]);
    } else if (char in KANJI_SMALL_UNIT) {
      section += (digit ?? 1n) * BigInt(KANJI_SMALL_UNIT[char]);
      digit = null;
    } else {
      // a large unit with nothing before it counts one of it: 万 alone is 一万
      total += (section + (digit ?? 0n) || 1n) * BigInt(KANJI_LARGE_UNIT[char]);
      section = 0n;
      digit = null;
    }
  }
  return String(total + section + (digit ?? 0n));
}
