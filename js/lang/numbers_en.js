// Numbers read aloud in English, for an English sentence (SPEC_dopa §5.8; ED A-46: 1848 is sung
// "eighteen forty-eight"). The words are looked up in the English dictionary by the caller. Pure.

const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const GROUPS = ["", "thousand", "million", "billion", "trillion"];
const MAX_PLACES = 15; // more than this is read digit by digit

/** Each digit on its own: "305" -> three zero five. */
function digitWords(digits) {
  return [...digits].map((digit) => ONES[+digit]);
}

/** 0 to 99, as words; nothing for 0. */
function underHundred(number) {
  if (number === 0) {
    return [];
  }
  if (number < 20) {
    return [ONES[number]];
  }

  const words = [TENS[Math.floor(number / 10)]];
  if (number % 10) {
    words.push(ONES[number % 10]);
  }
  return words;
}

/** 0 to 999, as words; nothing for 0. */
function underThousand(number) {
  const words = [];
  const hundreds = Math.floor(number / 100);
  if (hundreds) {
    words.push(ONES[hundreds], "hundred");
  }
  return words.concat(underHundred(number % 100));
}

/** A whole number written in digits, as words. */
function cardinalWords(digits) {
  const withoutZeros = digits.replace(/^0+(?=\d)/, "");
  if (withoutZeros.length > MAX_PLACES) {
    return digitWords(digits);
  }
  if (/^0+$/.test(withoutZeros)) {
    return ["zero"];
  }

  // groups of three places, the last group first
  const groups = [];
  for (let end = withoutZeros.length; end > 0; end -= 3) {
    const group = withoutZeros.slice(Math.max(0, end - 3), end);
    groups.push(Number(group));
  }

  const words = [];
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const groupWords = underThousand(groups[index]);
    if (!groupWords.length) {
      continue;
    }
    words.push(...groupWords);
    if (GROUPS[index]) {
      words.push(GROUPS[index]);
    }
  }
  return words;
}

/** Four digits from 1100 to 2099 written without a comma, read as a year: 1848 -> eighteen
 * forty-eight, 1905 -> nineteen oh five, 1900 -> nineteen hundred, 2005 -> two thousand five. */
function yearWords(digits) {
  const number = Number(digits);
  if (number >= 2000 && number <= 2009) {
    return cardinalWords(digits);
  }

  const first = underHundred(Math.floor(number / 100));
  const rest = number % 100;
  if (rest === 0) {
    return first.concat("hundred");
  }
  if (rest < 10) {
    return first.concat("oh", ONES[rest]);
  }
  return first.concat(underHundred(rest));
}

/**
 * A number as it is written in a text, as English words, or null when it is no number.
 *
 *     numberWords("1848") -> eighteen forty-eight      numberWords("1,848") -> one thousand eight hundred forty-eight
 *     numberWords("3.5")  -> three point five          numberWords("42")    -> forty-two (as two words)
 */
export function numberWords(written) {
  const text = written.normalize("NFKC");

  if (/^\d{4}$/.test(text)) {
    const number = Number(text);
    if (number >= 1100 && number <= 2099) {
      return yearWords(text);
    }
  }

  if (/^\d+$/.test(text)) {
    return cardinalWords(text);
  }

  // 1,848 and 12,000,000
  if (/^\d{1,3}(,\d{3})+$/.test(text)) {
    return cardinalWords(text.replaceAll(",", ""));
  }

  // 3.5 and 1,000.25: the places after the point are read one by one
  const decimal = /^(\d{1,3}(?:,\d{3})+|\d+)\.(\d+)$/.exec(text);
  if (decimal) {
    const whole = cardinalWords(decimal[1].replaceAll(",", ""));
    return whole.concat("point", digitWords(decimal[2]));
  }

  return null;
}
