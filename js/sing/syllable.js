// How one English syllable is sung from the bank's clips (SPEC_dopa §6.13; ED D-169, A-45): which
// piece of which clip sounds from when to when. Pure: the conductor plays the pieces.
//
// The parts of a syllable (bank_en.js, partsOf) are its clips for one note: { pre, head, tail,
// post, diphthong }. `head` holds the consonant next to the vowel and the vowel's start, `tail`
// the vowel's end and the consonant next to it; `pre` and `post` are the other consonants. The
// vowel starts on the slot, the consonants before it sound before the slot, and the syllable
// ends where the next one's first sound starts.
//
// The head and the tail are joined inside the vowel by a crossfade. In every window of the bank
// the vowel's wave is lined up with one clock (build_en_bank.py), so two places of clips of one
// stored pitch are in step when they differ by a whole number of periods: the incoming clip is
// read from the place nearest the wanted one that is in step. A note longer than the head's
// vowel is held by reading a steady piece of that vowel again and again, each time in step.

const CROSSFADE = 0.03; // seconds, inside a vowel
const EARLY = 0.01; // the first clip is read from this much before its first sound, in the sheet
const AFTER = 0.01; // and the last until this much after its last sound
const PRE_MOST = 0.07; // of a consonant before the head, only its end is sung: this much at most
const HEAD_MOST = 0.1; // and of the head's own consonant this much at most
const CODA_MOST = 0.09; // a consonant after the vowel is cut to this when another syllable follows
const MIN_VOWEL = 0.05; // a vowel is at least this long; its coda then runs under the next onset
const HEAD_END = 0.04; // the last part of the head's vowel is not used: it bends to what follows

// Holding a long note: where the head's own run stops and which piece of its vowel is repeated
// (all in seconds of the sheet, from the vowel's start). A diphthong repeats an earlier and
// shorter piece, so that it stays on its first sound.
const HOLD = { runs: 0.09, from: 0.04, piece: 0.045 };
const HOLD_DIPHTHONG = { runs: 0.06, from: 0.03, piece: 0.03 };

// How much of a consonant before the head is sung, in seconds of the sheet: its end.
const preLength = (consonant) => Math.min(consonant.v - consonant.o, PRE_MOST);

// How much of a consonant after the vowel is sung, in seconds of the sheet: all of it before a
// silence (`closing`), and its start when another syllable follows.
function codaLength(clip, closing) {
  const whole = clip.e - clip.ve;
  if (closing) {
    return whole;
  }
  return Math.min(whole, CODA_MOST);
}

// How much of the head's consonant is sung, in seconds of the sheet (0 for a vowel alone).
const headLength = (head) => Math.min(head.v - head.o, HEAD_MOST);

/** How long before its slot a syllable's first sound starts, in seconds. */
export function leadOf(parts) {
  const { head } = parts;
  let lead = headLength(head) / head.rate;
  for (const consonant of parts.pre) {
    lead += preLength(consonant) / consonant.rate;
  }
  return lead;
}

/** How long a syllable's consonants after its vowel sound, in seconds; `closing` when silence
 * follows the syllable. */
export function codaOf(parts, closing = false) {
  let coda = 0;
  if (parts.tail) {
    coda += codaLength(parts.tail, closing) / parts.tail.rate;
  }
  for (const consonant of parts.post) {
    coda += codaLength(consonant, closing) / consonant.rate;
  }
  return coda;
}

/** The place nearest `wanted` that is in step with `place`: a whole number of periods from it. */
export function inStep(place, wanted, period) {
  const periods = Math.round((place - wanted) / period);
  return place - periods * period;
}

/**
 * The pieces that sing a syllable: [{ buffer, offset, from, to, attack, release, rate }], as the
 * conductor's play() takes them: the piece sounds from `from` to `to` on the song's clock,
 * starting `offset` seconds into the sheet, fading in over `attack` from `from` and out over
 * `release` up to `to`, the sheet played `rate` times faster.
 *
 * `T` is when the vowel starts (the slot), `E` when the syllable must be over (the next
 * syllable's first sound, or the end of a held note), `closing` whether silence follows.
 */
export function syllablePieces(parts, { T, E, closing = false }) {
  const { pre, head, tail, post } = parts;
  const rate = head.rate;
  const period = head.period;
  const pieces = [];

  const add = (clip, place, from, to, attack, release) => {
    // never past the clip's window in the sheet
    const most = from + (clip.room - 0.005 - place) / clip.rate;
    const piece = {
      buffer: clip.buffer,
      offset: clip.at + place,
      from,
      to: Math.min(to, most),
      attack,
      release,
      rate: clip.rate,
    };
    pieces.push(piece);
  };

  // the consonants before the head
  let cursor = T - leadOf(parts);
  pre.forEach((consonant, number) => {
    const sung = preLength(consonant);
    const length = sung / consonant.rate;
    const first = number === 0;
    const early = first ? Math.min(EARLY, consonant.v - sung) : 0;
    const from = cursor - early / consonant.rate;
    add(consonant, consonant.v - sung - early, from, cursor + length, 0.008, 0.006);
    cursor += length;
  });

  // the vowel: from the slot to where the consonants after it begin
  const coda = codaOf(parts, closing);
  const vowelEnd = Math.max(E - coda, T + MIN_VOWEL);
  const span = vowelEnd - T;

  // how much of the tail's own vowel is sung, and where the tail takes over
  let tailVowel = 0;
  if (tail) {
    const stored = (tail.ve - tail.v) / rate - 0.06;
    tailVowel = Math.max(0, Math.min(0.1, stored, 0.7 * span));
  }
  const join = vowelEnd - tailVowel;

  // the run of the vowel: each entry is read from `place` of its clip at `start`, until `end`
  const run = [];
  const headFrom = head.v - headLength(head); // where its consonant is read from
  const headEarly = pre.length ? 0 : Math.min(EARLY, headFrom);
  const headStart = cursor - headEarly / rate;
  const headPlace = headFrom - headEarly;
  const placeAt = (time) => head.v + (time - T) * rate; // where the head's own run is at a time

  const usable = (head.ve - head.v - HEAD_END) / rate;
  if (join - T > usable) {
    const hold = parts.diphthong ? HOLD_DIPHTHONG : HOLD;
    const runsUntil = T + hold.runs / rate;
    run.push({ clip: head, place: headPlace, start: headStart, end: runsUntil });

    // whole periods, so that a piece ends in step with its own start
    const periods = Math.max(1, Math.round(hold.piece / period));
    const pieceSeconds = (periods * period) / rate;
    const count = Math.ceil((join - runsUntil) / pieceSeconds);

    let before = placeAt(runsUntil); // where the sound is when the next piece takes over
    for (let number = 0; number < count; number += 1) {
      const start = runsUntil + ((join - runsUntil) * number) / count;
      const end = runsUntil + ((join - runsUntil) * (number + 1)) / count;
      const place = inStep(before, head.v + hold.from, period);
      run.push({ clip: head, place, start, end });
      before = place + (end - start) * rate;
    }
  } else {
    run.push({ clip: head, place: headPlace, start: headStart, end: join });
  }

  let lastFade = closing ? 0.06 : 0.012;
  if (tail) {
    const lastOfSyllable = !post.length;
    const before = run[run.length - 1];
    const soundAtJoin = before.place + (join - before.start) * rate;
    const wanted = tail.ve - tailVowel * rate;
    const place = tailVowel > 0 ? inStep(soundAtJoin, wanted, period) : wanted;
    const end = vowelEnd + codaLength(tail, closing) / rate + (lastOfSyllable ? AFTER / rate : 0);
    run.push({ clip: tail, place, start: join, end });
    lastFade = lastOfSyllable ? 0.02 : 0.006;
  }

  run.forEach((entry, number) => {
    const before = run[number - 1];
    const after = run[number + 1];
    const length = entry.end - entry.start;

    let fadeIn = 0;
    if (before) {
      fadeIn = Math.min(CROSSFADE, length, before.end - before.start);
    }
    let fadeOut = 0;
    if (after) {
      fadeOut = Math.min(CROSSFADE, length, after.end - after.start);
    }

    const from = entry.start - fadeIn / 2;
    const to = entry.end + fadeOut / 2;
    const place = entry.place - (fadeIn / 2) * rate;
    const firstFade = pre.length ? 0.004 : 0.01;
    add(entry.clip, place, from, to, before ? fadeIn : firstFade, after ? fadeOut : lastFade);
  });

  // the consonants after the tail
  cursor = vowelEnd;
  if (tail) {
    cursor += codaLength(tail, closing) / rate;
  }
  post.forEach((consonant, number) => {
    const length = codaLength(consonant, closing) / consonant.rate;
    const last = number === post.length - 1;
    const to = cursor + length + (last ? AFTER / consonant.rate : 0);
    add(consonant, consonant.ve, cursor, to, 0.006, last ? 0.02 : 0.006);
    cursor += length;
  });

  return pieces;
}
