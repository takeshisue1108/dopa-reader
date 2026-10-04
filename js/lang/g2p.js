// The pronunciation of an English word that the dictionary does not have, from its spelling
// (SPEC_dopa v3.23 §5.7, SD-W18; ED D-167). It is the model of g2p_en (Kyubyong Park and
// Jongseok Kim, Apache License 2.0): a small network trained on CMUdict that reads the word's
// letters (an encoder) and then writes phonemes one after another (a decoder) until it writes
// "the end". This file is the same arithmetic as g2p_en's own NumPy code, in JavaScript; the
// numbers it needs (the "weights") come from g2p_en's file, as site/data/lang/en_g2p.bin. Pure:
// the weights are passed in, and no browser is asked for anything.

const LETTERS = ["<pad>", "<unk>", "</s>", ..."abcdefghijklmnopqrstuvwxyz"];
// prettier-ignore
const PHONEMES = ["<pad>", "<unk>", "<s>", "</s>",
  "AA0", "AA1", "AA2", "AE0", "AE1", "AE2", "AH0", "AH1", "AH2", "AO0", "AO1", "AO2", "AW0", "AW1",
  "AW2", "AY0", "AY1", "AY2", "B", "CH", "D", "DH", "EH0", "EH1", "EH2", "ER0", "ER1", "ER2", "EY0",
  "EY1", "EY2", "F", "G", "HH", "IH0", "IH1", "IH2", "IY0", "IY1", "IY2", "JH", "K", "L", "M", "N",
  "NG", "OW0", "OW1", "OW2", "OY0", "OY1", "OY2", "P", "R", "S", "SH", "T", "TH", "UH0", "UH1", "UH2",
  "UW", "UW0", "UW1", "UW2", "V", "W", "Y", "Z", "ZH"];
const START = PHONEMES.indexOf("<s>"),
  END = PHONEMES.indexOf("</s>");
const MOST_PHONEMES = 20; // the decoder writes at most this many, as g2p_en does

/** The parts of the model, in the order they lie in the weights file, with their shapes
 * [rows, columns]; a list of numbers has one row. `hidden` is 256. */
export const PARTS = [
  ["enc_emb", [LETTERS.length, 256]],
  ["enc_w_ih", [768, 256]],
  ["enc_w_hh", [768, 256]],
  ["enc_b_ih", [1, 768]],
  ["enc_b_hh", [1, 768]],
  ["dec_emb", [PHONEMES.length, 256]],
  ["dec_w_ih", [768, 256]],
  ["dec_w_hh", [768, 256]],
  ["dec_b_ih", [1, 768]],
  ["dec_b_hh", [1, 768]],
  ["fc_w", [PHONEMES.length, 256]],
  ["fc_b", [1, PHONEMES.length]],
];
/** How many numbers the weights file holds. */
export const WEIGHT_COUNT = PARTS.reduce((sum, [, [rows, columns]]) => sum + rows * columns, 0);

/** matrix (rows × columns, row after row) times vector, plus bias: one number for each row. */
function affine(matrix, rows, columns, vector, bias) {
  const out = new Float32Array(rows);
  for (let row = 0; row < rows; row++) {
    let sum = bias[row];
    const at = row * columns;
    for (let column = 0; column < columns; column++) sum += matrix[at + column] * vector[column];
    out[row] = sum;
  }
  return out;
}

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/** One step of a GRU: the new hidden state from the input `x` and the state `h` (both 256
 * numbers). The 768 rows of the matrices are three gates of 256: reset, update, and the new
 * value. */
function gruStep(x, h, wIh, wHh, bIh, bHh) {
  const hidden = h.length;
  const fromInput = affine(wIh, 3 * hidden, x.length, x, bIh),
    fromState = affine(wHh, 3 * hidden, hidden, h, bHh);
  const next = new Float32Array(hidden);
  for (let i = 0; i < hidden; i++) {
    const reset = sigmoid(fromInput[i] + fromState[i]),
      update = sigmoid(fromInput[hidden + i] + fromState[hidden + i]),
      fresh = Math.tanh(fromInput[2 * hidden + i] + reset * fromState[2 * hidden + i]);
    next[i] = (1 - update) * fresh + update * h[i];
  }
  return next;
}

/**
 * The model from its weights: `weights` is a Float32Array of WEIGHT_COUNT numbers, the parts of
 * PARTS one after another. Returns `predict(word)`: the word's phonemes in ARPAbet, as a list
 * (["AE1", "K", "T", …]). The word is read in lower case; a character that is not a letter a to
 * z is read as an unknown letter, as g2p_en reads it.
 */
export function createG2p(weights) {
  if (weights.length !== WEIGHT_COUNT)
    throw new Error(`g2p: ${weights.length} weights, not ${WEIGHT_COUNT}`);
  const part = {};
  let at = 0;
  for (const [name, [rows, columns]] of PARTS) {
    part[name] = weights.subarray(at, at + rows * columns);
    at += rows * columns;
  }
  const row = (matrix, index, columns = 256) =>
    matrix.subarray(index * columns, (index + 1) * columns);

  return function predict(word) {
    // the encoder: letter after letter, then the end mark; its last state is what the decoder
    // starts from
    let state = new Float32Array(256);
    for (const letter of [...word.toLowerCase(), "</s>"]) {
      const index = LETTERS.indexOf(letter);
      const input = row(part.enc_emb, index < 0 ? LETTERS.indexOf("<unk>") : index);
      state = gruStep(input, state, part.enc_w_ih, part.enc_w_hh, part.enc_b_ih, part.enc_b_hh);
    }
    // the decoder: from the start mark, the likeliest phoneme at each step, until the end mark
    const phonemes = [];
    let input = row(part.dec_emb, START);
    for (let step = 0; step < MOST_PHONEMES; step++) {
      state = gruStep(input, state, part.dec_w_ih, part.dec_w_hh, part.dec_b_ih, part.dec_b_hh);
      const scores = affine(part.fc_w, PHONEMES.length, 256, state, part.fc_b);
      let best = 0;
      for (let index = 1; index < scores.length; index++)
        if (scores[index] > scores[best]) best = index;
      if (best === END) break;
      phonemes.push(PHONEMES[best]);
      input = row(part.dec_emb, best);
    }
    return phonemes;
  };
}
