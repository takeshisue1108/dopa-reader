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

// the range of the voice bank's recordings (bank.js), F3 to F5 (SD-S04)
export const LO = 53;
export const HI = 77;

/** A note name as a pitch class, 0 (C) to 11 (B): "F#" -> 6, "Bb" -> 10. */
export function pitchClass(name) {
  const letter = name[0];
  const natural = NOTE[letter];

  const sharps = name.match(/#/g) || [];
  const flats = name.match(/b/g) || [];

  return (natural + sharps.length - flats.length + 12) % 12;
}

/** The key in force at a beat: the last entry of the list at or before it; the first entry when
 * none is. */
export function keyAt(keys, beat) {
  let key = keys[0];

  for (const candidate of keys) {
    if (candidate.beat <= beat) {
      key = candidate;
    }
  }

  return key;
}

/** The chord of a slot, as { chord, key, rest }: slot k of a progression is at beat 1 + k / 2.
 * During a rest chord the melody keeps the chord before it (or, before any chord has sounded, the
 * first that will), and `rest` is true. A chord lasts until the next entry (its `duration` is not
 * read); `key` is the key in force where the chosen chord starts, the key its degrees are written
 * in. The chords must be in order. */
export function chordAt(progression, slot) {
  const beat = 1 + slot / 2;

  // the last entry at or before the beat, and the last of them that is not a rest
  let current = null;
  let lastSounding = null;
  for (const candidate of progression.chords) {
    if (candidate.beat > beat) {
      break;
    }
    if (!candidate.isRest) {
      lastSounding = candidate;
    }
    current = candidate;
  }

  const rest = !current || current.isRest;

  let chord;
  if (!rest) {
    chord = current;
  } else if (lastSounding) {
    chord = lastSounding;
  } else {
    chord = progression.chords.find((candidate) => !candidate.isRest);
  }

  const key = keyAt(progression.keys, chord.beat);
  return {
    chord,
    key,
    rest,
  };
}

/** How many slots a progression lasts (2 to a beat), filled up to a whole bar of 8. */
export function slotsOf(progression) {
  // the number of the last beat (beats are counted from 1), which is the count of beats
  const lastBeats = progression.chords.map((chord) => chord.beat + chord.duration - 1);
  const end = Math.max(...lastBeats);

  // filled to a whole bar
  const bars = Math.ceil(end / 4);
  return bars * 8;
}

/** The scale a chord is read in, as { tonic, scale, degree }: the key's, or the mode named by
 * `borrowed` on the same tonic; with `applied` = n the chord is degree n of the major scale built
 * on degree `root` of that scale. */
export function local(chord, key) {
  const tonic = pitchClass(key.tonic);

  let scale = MODES[key.scale] || MODES.major;
  if (typeof chord.borrowed === "string") {
    const borrowedScale = MODES[chord.borrowed];
    if (borrowedScale) {
      scale = borrowedScale;
    }
  }

  if (chord.applied) {
    const appliedTonic = (tonic + scale[chord.root - 1]) % 12;
    return {
      tonic: appliedTonic,
      scale: MODES.major,
      degree: chord.applied,
    };
  }

  return {
    tonic,
    scale,
    degree: chord.root,
  };
}

/** Semitones from the chord's root up to its scale step: 1 is the root, 2 the next scale note, 8
 * the octave, 0 the note below. */
export function semis(scale, rootDegree, stepFromRoot) {
  // the step's place in the scale, from 0; 7 and more are in the octaves above, less than 0 below
  const index = rootDegree - 1 + stepFromRoot - 1;

  const placeInOctave = ((index % 7) + 7) % 7;
  const octaves = Math.floor(index / 7);
  const stepAboveTonic = scale[placeInOctave] + 12 * octaves;

  const rootAboveTonic = scale[(rootDegree - 1) % 7];
  return stepAboveTonic - rootAboveTonic;
}

/** A chord's notes as pitch classes: {root, bass, pcs}, with the scale and the degree it is
 * read in. Sevenths and ninths, suspensions, added and omitted notes and inversions are applied
 * (a type above 9 adds no more than the seventh and the ninth; `alterations`, `pedal` and
 * `substitutions` are not read). `pcs` are the chord's tones without the bass. */
export function tones(chord, key) {
  const { tonic, scale, degree } = local(chord, key);
  const root = (tonic + scale[degree - 1]) % 12;

  let steps = [1, 3, 5];
  if (chord.type >= 7) {
    steps.push(7);
  }
  if (chord.type >= 9) {
    steps.push(9);
  }

  // a suspension takes the place of the third
  const suspensions = chord.suspensions || [];
  for (const suspension of suspensions) {
    const withoutThird = steps.filter((step) => step !== 3);
    steps = withoutThird.concat(suspension);
  }

  const adds = chord.adds || [];
  const omits = chord.omits || [];
  const withAdds = steps.concat(adds);
  steps = withAdds.filter((step) => !omits.includes(step));

  const pitchClassOf = (step) => {
    const aboveRoot = semis(scale, degree, step);
    return (root + aboveRoot + 120) % 12;
  };

  const inversion = chord.inversion || 0;
  const bassStep = [1, 3, 5, 7][inversion];
  const bass = pitchClassOf(bassStep);

  const pcs = steps.map(pitchClassOf);
  return {
    root,
    bass,
    pcs,
    scale,
    degree,
  };
}

/** The MIDI pitch of a fragment step over a chord (§6.4.4): the root sits from LO+2 to LO+13, and
 * a step that would go above HI is sung an octave lower. (The last loop, for a pitch below `lo`,
 * can only matter for a range other than the default one.) */
export function noteOf(chord, key, step, lo = LO, hi = HI) {
  const { root, scale, degree } = tones(chord, key);

  let rootPitch = root + 48;
  while (rootPitch < lo + 2) {
    rootPitch += 12;
  }

  const aboveRoot = semis(scale, degree, step);
  let pitch = rootPitch + aboveRoot;
  while (pitch > hi) {
    pitch -= 12;
  }
  while (pitch < lo) {
    pitch += 12;
  }

  return pitch;
}

/** A chord's name ("D#m7", "rest"): for the plan's chord names, the conductor's chord log, the
 * tests and the test page. Sharps only. */
export function chordName(chord, key) {
  if (chord.isRest) {
    return "rest";
  }

  const { root, bass, scale, degree } = tones(chord, key);

  const interval = (step) => {
    const aboveRoot = semis(scale, degree, step);
    return ((aboveRoot % 12) + 12) % 12;
  };

  let suspended = "";
  if ((chord.suspensions || []).includes(4)) {
    suspended = "sus4";
  } else if ((chord.suspensions || []).includes(2)) {
    suspended = "sus2";
  }

  // a suspended chord has no third to name; a third of 4 semitones is major, and has no letter
  let quality = "";
  if (!suspended) {
    const third = interval(3);
    if (third !== 4) {
      quality = "m";
    }
  }

  const seventh = interval(7);
  const major7 = seventh === 11 ? "maj" : "";

  let extension = "";
  if (chord.type !== 5) {
    extension = major7 + chord.type;
  }

  let addedNames = "";
  for (const added of chord.adds || []) {
    addedNames += `(add${added})`;
  }

  let slashBass = "";
  if (bass !== root) {
    slashBass = "/" + NAMES[bass];
  }

  return NAMES[root] + quality + extension + suspended + addedNames + slashBass;
}

/** A MIDI pitch as a name: 60 -> "C4". */
export function noteName(midi) {
  const name = NAMES[midi % 12];
  const octave = Math.floor(midi / 12) - 1;
  return name + octave;
}
