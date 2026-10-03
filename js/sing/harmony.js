// Hooktheory chords and keys -> the chord and its scale at each slot; fragment steps -> pitches
// (SPEC_sing §6.3, §6.4; 歌 ED D-13, D-14, D-15). No browser dependency.
const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }; // semitones above C
// For each scale, the semitones of its seven degrees above its tonic.
export const MODES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
};
export const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const LO = 53,
  HI = 77; // the range of the voice bank's recordings (bank.js), F3 to F5 (SD-S04)

/** A note name as a pitch class, 0 (C) to 11 (B): "F#" -> 6, "Bb" -> 10. */
export const pitchClass = (name) =>
  (NOTE[name[0]] + (name.match(/#/g) || []).length - (name.match(/b/g) || []).length + 12) % 12;

/** The key in force at a beat: the last entry of the list at or before it; the first entry when
 * none is. */
export function keyAt(keys, beat) {
  let key = keys[0];
  for (const candidate of keys) if (candidate.beat <= beat) key = candidate;
  return key;
}

/** The chord of a slot, as { chord, key, rest }: slot k of a progression is at beat 1 + k / 2.
 * During a rest chord the melody keeps the chord before it (or, before any chord has sounded, the
 * first that will), and `rest` is true. A chord lasts until the next entry (its `duration` is not
 * read); `key` is the key in force where the chosen chord starts, the key its degrees are written
 * in. The chords must be in order. */
export function chordAt(progression, slot) {
  const beat = 1 + slot / 2;
  let current = null,
    lastSounding = null;
  for (const candidate of progression.chords) {
    if (candidate.beat > beat) break;
    if (!candidate.isRest) lastSounding = candidate;
    current = candidate;
  }
  const chord =
    current && !current.isRest
      ? current
      : lastSounding || progression.chords.find((candidate) => !candidate.isRest);
  return { chord, key: keyAt(progression.keys, chord.beat), rest: !current || current.isRest };
}

/** How many slots a progression lasts (2 to a beat), filled up to a whole bar of 8. */
export const slotsOf = (progression) => {
  // the number of the last beat (beats are counted from 1), which is the count of beats
  const end = Math.max(...progression.chords.map((chord) => chord.beat + chord.duration - 1));
  return Math.ceil(end / 4) * 8; // filled to a whole bar
};

/** The scale a chord is read in, as { tonic, scale, degree }: the key's, or the mode named by
 * `borrowed` on the same tonic; with `applied` = n the chord is degree n of the major scale built
 * on degree `root` of that scale. */
export function local(chord, key) {
  const tonic = pitchClass(key.tonic);
  let scale = MODES[key.scale] || MODES.major;
  if (typeof chord.borrowed === "string" && MODES[chord.borrowed]) scale = MODES[chord.borrowed];
  if (chord.applied)
    return {
      tonic: (tonic + scale[chord.root - 1]) % 12,
      scale: MODES.major,
      degree: chord.applied,
    };
  return { tonic, scale, degree: chord.root };
}

/** Semitones from the chord's root up to its scale step: 1 is the root, 2 the next scale note, 8
 * the octave, 0 the note below. */
export function semis(scale, rootDegree, stepFromRoot) {
  const index = rootDegree - 1 + stepFromRoot - 1;
  return scale[((index % 7) + 7) % 7] + 12 * Math.floor(index / 7) - scale[(rootDegree - 1) % 7];
}

/** A chord's notes as pitch classes: {root, bass, pcs}, with the scale and the degree it is
 * read in. Sevenths and ninths, suspensions, added and omitted notes and inversions are applied
 * (a type above 9 adds no more than the seventh and the ninth; `alterations`, `pedal` and
 * `substitutions` are not read). `pcs` are the chord's tones without the bass. */
export function tones(chord, key) {
  const { tonic, scale, degree } = local(chord, key);
  const root = (tonic + scale[degree - 1]) % 12;
  let steps = [1, 3, 5];
  if (chord.type >= 7) steps.push(7);
  if (chord.type >= 9) steps.push(9);
  for (const suspension of chord.suspensions || [])
    steps = steps.filter((step) => step !== 3).concat(suspension);
  steps = steps.concat(chord.adds || []).filter((step) => !(chord.omits || []).includes(step));
  const pitchClassOf = (step) => (root + semis(scale, degree, step) + 120) % 12;
  const bass = pitchClassOf([1, 3, 5, 7][chord.inversion || 0]);
  return { root, bass, pcs: steps.map(pitchClassOf), scale, degree };
}

/** The MIDI pitch of a fragment step over a chord (§6.4.4): the root sits from LO+2 to LO+13, and
 * a step that would go above HI is sung an octave lower. (The last loop, for a pitch below `lo`,
 * can only matter for a range other than the default one.) */
export function noteOf(chord, key, step, lo = LO, hi = HI) {
  const { root, scale, degree } = tones(chord, key);
  let rootPitch = root + 48;
  while (rootPitch < lo + 2) rootPitch += 12;
  let pitch = rootPitch + semis(scale, degree, step);
  while (pitch > hi) pitch -= 12;
  while (pitch < lo) pitch += 12;
  return pitch;
}

/** A chord's name ("D#m7", "rest"): for the plan's chord names, the conductor's chord log, the
 * tests and the test page. Sharps only. */
export function chordName(chord, key) {
  if (chord.isRest) return "rest";
  const { root, bass, scale, degree } = tones(chord, key);
  const interval = (step) => ((semis(scale, degree, step) % 12) + 12) % 12;
  const suspended = (chord.suspensions || []).includes(4)
    ? "sus4"
    : (chord.suspensions || []).includes(2)
      ? "sus2"
      : "";
  const quality = suspended ? "" : interval(3) === 4 ? "" : "m";
  const major7 = interval(7) === 11 ? "maj" : "";
  const extension = chord.type === 5 ? "" : major7 + chord.type;
  return (
    NAMES[root] +
    quality +
    extension +
    suspended +
    (chord.adds || []).map((added) => `(add${added})`).join("") +
    (bass !== root ? "/" + NAMES[bass] : "")
  );
}

/** A MIDI pitch as a name: 60 -> "C4". */
export const noteName = (midi) => NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
