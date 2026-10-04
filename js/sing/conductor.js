// The song clock of sung reading: the Day Life score, played from its notes, and the sung clips of
// each sentence on its bars (SPEC_dopa v3.9 §6.11; ED D-139; SPEC_sing §6.5, §6.8; 歌 ED D-24,
// D-25, D-33, ST-03 to ST-09). A slot is an eighth note of the score, so its length follows the
// score's tempo map; a bar of the song is a bar of the score; after its last bar the score starts
// again.
import * as bank from "./bank.js";
import * as bankEn from "./bank_en.js";
import { chordAt, chordName, tones } from "./harmony.js";
import * as instruments from "./instruments.js";
import { kindAt } from "./melody.js";
import { SLOTS_PER_BAR } from "./bars.js";
import { planBars, positionAfter, withSlots } from "./plan.js";
import { notesBySlot, singablePitches } from "./score.js";
import { leadOf, syllablePieces } from "./syllable.js";
import { sentenceSlots, slotLengths } from "./tempo.js";

export const SLOT = 0.15; // seconds per slot at 200 BPM and the speed 1.0 (D-139)

// The fades of a sung clip, in seconds: in, out, and out for the last mora of a bar.
const ATTACK = 0.005;
const RELEASE = 0.015;
const HOLD_RELEASE = 0.06;

// The scheduler, as in festap (SD-S10): every EVERY milliseconds a timer schedules the slots that
// start within the next LOOKAHEAD seconds of the audio clock.
const LOOKAHEAD = 0.3;
const EVERY = 25;

// A gain whose level is `level` from the first sample on. A gain is 1 until its first scheduled
// value takes hold, and a source that starts at the same time can be one sample ahead of it: that
// sample would pass at full level, as a click.
function gainFrom(ctx, level) {
  const g = ctx.createGain();
  g.gain.value = level;
  return g;
}

// How each part of the score is played. `level` is the gain of a note of velocity 127, and a
// note's gain is level × velocity / 127. (The notes of every sheet are stored equally loud, and
// the drum kit keeps its own balance.) The levels set the mix under the voice. The number beside
// each level is how many dB under the voice that part sits: the part's usual level is the median
// of its 50 ms frames over bars 49 to 72, measured on offline renders
// (tests/site/render_daylife.mjs, check_daylife_render.py). `attack` and `release` are the fades
// of a note, in seconds. A note rings on for its release after its written end. A drum hit sounds
// for its own length, and its release is the fade at that end.
export const PARTS = {
  Melody: { level: 0.18, attack: 0.002, release: 0.06 }, // 16 dB under the voice
  Harmony: { level: 0.155, attack: 0.002, release: 0.06 }, // 19
  Accomp: { level: 0.27, attack: 0.002, release: 0.05 }, // 17
  Counter: { level: 0.17, attack: 0.01, release: 0.1 }, // 19
  Bass: { level: 0.235, attack: 0.003, release: 0.05 }, // 15
  Sparkle: { level: 0.24, attack: 0.001, release: 0.6 }, // 20
  Keys: { level: 0.25, attack: 0.12, release: 0.3 }, // 21
  Drums: { level: 0.27, attack: 0.001, release: 0.02 }, // 14; all parts together about 8 dB under
};
const OTHER_PART = { level: 0.08, attack: 0.005, release: 0.05 }; // a part the table does not name

// One source through its own gain. It sounds from `from` to `to` on the context's clock, starting
// `offset` seconds into the buffer. It fades in over `attack`, and its fade-out of `release`
// seconds ends at `to`. A sound of less than 10 ms is not started (null). `rate` is how many
// times faster than recorded the buffer is played (the English bank's notes between its stored
// pitches).
function play(ctx, out, buffer, offset, from, to, release, gain = 1, attack = ATTACK, rate = 1) {
  const soundingSeconds = to - from;
  if (soundingSeconds < 0.01) {
    return null;
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  if (rate !== 1) {
    source.playbackRate.value = rate;
  }

  // the fade in, the full level, and the fade out; a sound shorter than its two fades starts its
  // fade out where its fade in ends
  const envelope = gainFrom(ctx, 0);
  const attackEnd = from + attack;
  const releaseStart = Math.max(attackEnd, to - release);
  envelope.gain.setValueAtTime(0, from);
  envelope.gain.linearRampToValueAtTime(gain, attackEnd);
  envelope.gain.setValueAtTime(gain, releaseStart);
  envelope.gain.linearRampToValueAtTime(0, to);

  source.connect(envelope).connect(out);

  const offsetInBuffer = Math.max(0, offset);
  const sourceSeconds = (soundingSeconds + 0.02) * rate; // seconds of the buffer
  source.start(from, offsetInBuffer, sourceSeconds);

  return source;
}

// Schedule one bar of an English sentence (SPEC_dopa §6.13). An entry of the bar is a syllable
// ({ syllable, start, end }) or the second slot of a strong one ({ held }, which sings nothing).
// A syllable's vowel starts on its slot and it ends where the next syllable's first sound starts;
// the last of the bar is held for one slot more at most, and never past the bar. A note outside
// the English voice's range is sung an octave lower or higher. Every entry gives a light event,
// as a mora does.
function singEnglishBar(ctx, out, bar, barNotes, barTime, slotLength, hold, events, keep) {
  const barEnd = barTime + SLOTS_PER_BAR * slotLength;

  const sung = [];
  bar.forEach((entry, slotInBar) => {
    const slotStart = barTime + slotInBar * slotLength;
    const lightEvent = {
      t: slotStart,
      start: entry.start,
      end: entry.end,
    };
    events.push(lightEvent);

    if (!entry.syllable) {
      return;
    }

    const after = bar[slotInBar + 1];
    const slots = after && after.held ? 2 : 1;
    const syllable = {
      T: slotStart,
      ownEnd: slotStart + slots * slotLength,
      parts: bankEn.partsOf(entry.syllable, bankEn.inRange(barNotes[slotInBar])),
    };
    sung.push(syllable);
  });

  sung.forEach((syllable, number) => {
    if (!syllable.parts) {
      return; // its sheet is not in memory: a silent slot
    }

    const next = sung[number + 1];
    const timing = {
      T: syllable.T,
      E: syllable.ownEnd,
      closing: !next,
    };
    if (next) {
      const nextLead = next.parts ? leadOf(next.parts) : 0;
      timing.E = next.T - nextLead;
    } else if (hold) {
      timing.E = Math.min(syllable.ownEnd + slotLength, barEnd);
    }

    for (const piece of syllablePieces(syllable.parts, timing)) {
      const { buffer, offset, from, to, attack, release, rate } = piece;
      const source = play(ctx, out, buffer, offset, from, to, release, 1, attack, rate);
      keep(source);
    }
  });
}

// Schedule bars on given pitches. `notes[b][i]` is the MIDI pitch of sung slot i of bar b.
// Options: slot (the length of a slot, in seconds); hold (the last mora of a bar sounds on into
// the slot after it, Q-18; on unless false); tail ("inside" | "after": where the ン of a mora's
// `tails` sounds, inside the end of its slot or after it; D-31, Q-14). The site's analysis has
// sent no tails since D-118 (lang/analyze.js), so the tails are sung only in the tests.
// Returns the light events { t, start, end } (t: when the mora's slot starts; start, end: the
// mora's characters in the sentence's speech string), the end time, and the sources (to stop
// them on a jump).
export function singBars(ctx, out, bars, notes, t0, opt = {}) {
  const slotLength = opt.slot || SLOT;
  const tailMode = opt.tail || "inside";
  const hold = opt.hold !== false;

  // a consonant made for slow singing is cut to fit a fast slot
  const maxLead = 0.35 * slotLength;

  const events = [];
  const sources = [];
  const keep = (source) => {
    if (source) {
      sources.push(source);
    }
  };

  bars.forEach((bar, barIndex) => {
    const barTime = t0 + barIndex * SLOTS_PER_BAR * slotLength;
    const barEnd = barTime + SLOTS_PER_BAR * slotLength;

    // a bar of an English sentence is sung by the English voice
    const inEnglish = bar.some((entry) => entry.syllable);
    if (inEnglish) {
      singEnglishBar(ctx, out, bar, notes[barIndex], barTime, slotLength, hold, events, keep);
      return;
    }

    bar.forEach((mora, slotInBar) => {
      const slotStart = barTime + slotInBar * slotLength;
      const slotEnd = slotStart + slotLength;
      const midi = notes[barIndex][slotInBar];

      const lightEvent = {
        t: slotStart,
        start: mora.start,
        end: mora.end,
      };
      events.push(lightEvent);

      const clip = bank.clip(mora.k, midi);
      if (!clip) {
        return; // ッ, or a sound the bank cannot give: a silent slot
      }

      // the consonant sounds before the slot, so that the vowel starts on it
      const lead = Math.min(clip.lead, maxLead);
      const from = slotStart - lead - ATTACK;
      const next = bar[slotInBar + 1];

      // an ん that gave up its slot (D-31) is the ン of the slot's pitch, short, at the slot's end
      const tails = mora.tails.map((kind) => {
        const partOfSlot = 0.4 * slotLength;
        const len = Math.min(0.09, partOfSlot);
        return {
          kind,
          len,
        };
      });

      let tailsLen = 0;
      for (const tail of tails) {
        tailsLen += tail.len;
      }

      let tailAt = slotEnd;
      if (tailMode === "inside") {
        const mostOfSlot = 0.6 * slotLength;
        const tailsInSlot = Math.min(tailsLen, mostOfSlot);
        tailAt = slotEnd - tailsInSlot;
      }

      // where the mora's own clip ends, and how long its fade out is
      let to;
      let release = RELEASE;
      if (tails.length) {
        to = tailAt + 0.005;
      } else if (next) {
        const nextMidi = notes[barIndex][slotInBar + 1];
        const nextClip = bank.clip(next.k, nextMidi);

        if (nextClip) {
          const nextLead = Math.min(nextClip.lead, maxLead);
          to = slotEnd - nextLead;
        } else {
          to = slotEnd;
        }
      } else if (hold) {
        // the last mora of a bar is held (Q-18): one slot more at most, and never past the bar
        const oneSlotMore = slotStart + 2 * slotLength;
        to = Math.min(oneSlotMore, barEnd);
        release = HOLD_RELEASE;
      } else {
        to = slotEnd;
      }

      // a clip ends 10 ms or more before its window in the sheet does
      const startInWindow = clip.onset - lead;
      const latestEnd = from + clip.length - startInWindow - 0.01;
      to = Math.min(to, latestEnd);

      const offsetInSheet = clip.window + clip.onset - lead - ATTACK;
      const source = play(ctx, out, clip.buffer, offsetInSheet, from, to, release);
      keep(source);

      for (const tail of tails) {
        const tailClip = bank.clip("ン", midi);

        if (tailClip) {
          const tailOffset = tailClip.window + tailClip.onset + 0.03;
          const tailEnd = tailAt + tail.len;
          const tailSource = play(ctx, out, tailClip.buffer, tailOffset, tailAt, tailEnd, 0.01);
          keep(tailSource);
        }

        tailAt += tail.len;
      }
    });
  });

  const end = t0 + bars.length * SLOTS_PER_BAR * slotLength;
  return {
    events,
    end,
    sources,
  };
}

// Stop these sources `after` seconds from now.
export function stopSources(sources, ctx, after = 0.02) {
  for (const source of sources) {
    try {
      const stopAt = ctx.currentTime + after;
      source.stop(stopAt);
    } catch {
      /* already ended */
    }
  }
}

// song: { progressions: [{ name, data, form }], fragments: the parsed fragments file, notes:
// notes.json (every note of the score), tempo: tempo.json } (song.js). In the site the song is one
// progression, the score's chords and form, which starts again after its last bar. The lengths of
// the slots, the notes and position() read progression 0 only; `progressionIndex` is kept because
// plan.js takes a list of progressions.
// options: speed; voice (the level of the voice, 0 to 1; 1 when not given); band (the level of
// the score's parts, 0 = off); parts (the level of each part inside the band, by its name in the
// score, for checking one alone); mute (the voice is silent: for checking the accompaniment
// alone); record (keep each note played in `played`, for the checks); tail, hold (as in
// singBars); kind (a fixed kind for every bar, for tests); startAt { progression, bar }
// (0-based); random (the chance that picks a bar's fragment; Math.random when not given); melody
// (the song's mode, SPEC_dopa §6.12: "fragments", or "score" for the voice to take its pitches
// from the score's notes; setMelody changes it).
export function create(ctx, out, song, options = {}) {
  const { progressions, fragments } = song;
  const settings = {
    speed: 1,
    band: 1,
    parts: {},
    mute: false,
    record: false,
    tail: "inside",
    hold: true,
    kind: null,
    random: Math.random,
    melody: "fragments",
    ...options,
  };
  const progressionsWithSlots = withSlots(progressions);

  // Three files give the song's length: the chords (totalSlots), the tempo map (lengths) and the
  // notes (bySlot). Nothing here checks that they agree.
  const totalSlots = progressionsWithSlots[0].slots; // the song is one progression: the score
  const lengths = slotLengths(song.tempo); // the length of each slot at the speed 1.0
  let bySlot = [];
  if (song.notes) {
    bySlot = notesBySlot(song.notes);
  }

  // For the mode "score": the pitch the voice takes in each slot of the score, the highest note
  // sounding there within the bank's range (null where there is none: the chord's root is sung
  // then, plan.js). Without a score or a bank the table is empty, and every slot is a root.
  const voiceRange = bank.info();
  let scorePitches = [];
  let scorePitchesInEnglish = []; // the same for the English voice, whose range ends lower
  if (song.notes && voiceRange) {
    scorePitchesInEnglish = singablePitches(song.notes, bankEn.RANGE.lo, bankEn.RANGE.hi);
    scorePitches = singablePitches(song.notes, voiceRange.lo, voiceRange.hi);
  }

  const voiceBus = ctx.createGain();
  const bandBus = ctx.createGain();
  const partBus = {};
  const busOf = (part) => {
    if (!partBus[part]) {
      const partLevel = settings.parts[part] ?? 1;
      partBus[part] = gainFrom(ctx, partLevel);
      partBus[part].connect(bandBus);
    }
    return partBus[part];
  };

  // the level of the voice: its setting (full when none was given), or silence when muted
  const voiceLevel = () => {
    if (settings.mute) {
      return 0;
    }
    return settings.voice ?? 1;
  };

  bandBus.connect(out);
  voiceBus.connect(out);
  voiceBus.gain.value = voiceLevel();
  bandBus.gain.value = settings.band;

  // The place up to which the song is scheduled: the next slot of the score (an index) and the
  // time at which it starts, up to LOOKAHEAD ahead of what sounds.
  let progressionIndex = 0;
  let nextSlot = 0;
  if (settings.startAt) {
    progressionIndex = settings.startAt.progression;
    nextSlot = settings.startAt.bar * SLOTS_PER_BAR;
  }
  let nextSlotTime = 0;

  // of the slot scheduled last, in seconds
  let slotLength = lengths[nextSlot] / settings.speed;

  let started = false;
  let timer = null;

  // the chord sounding, to log each change once
  let chordNow = null;

  let lastFragment = null;
  const queue = [];
  const callbacks = [];

  // each chord as it starts: { t, chord (its name), midis (its bass note, then its tones) };
  // the last 500
  const chordLog = [];

  // with `record`: each note of the score as played, with t (when it sounds) and seconds
  const played = [];

  // The score's notes, for stop(): { source, end }. At each bar line those that end before the
  // time scheduled up to are dropped from the list; that time is up to LOOKAHEAD ahead of what
  // sounds, so a note dropped here may still be sounding.
  let bandSources = [];

  // The sentence being sung: what enqueue() was given ({ bars, onStart, onBar, onEnd } and
  // whatever else the caller put on it), and, added here: next (the bar to schedule next), events,
  // sources, lines, t0 (the time of its bar line), at (the score's slot there), notes, kinds, used,
  // chords (planSentence) and, once its last bar is scheduled, end.
  let job = null;
  const voiceSources = [];

  // the position n slots later (the score starts again after its last slot)
  const placeAfter = (p, s, n) => positionAfter(progressionsWithSlots, p, s, n);

  const lengthAt = (s) => {
    const scoreSlot = ((s % totalSlots) + totalSlots) % totalSlots;
    return lengths[scoreSlot] / settings.speed;
  };

  function planSentence(sentence) {
    // a fragment for each bar, by the form at its place (D-25), and its pitches (plan.js): the
    // fragment's over the chords, or in the mode "score" those of the score's notes
    const sentenceStart = {
      progression: progressionIndex,
      bar: nextSlot / SLOTS_PER_BAR,
    };
    // an English sentence takes the score's notes that the English voice can sing
    const inEnglish = sentence.bars.some((bar) => bar.some((entry) => entry.syllable));
    const pitchesForVoice = inEnglish ? scorePitchesInEnglish : scorePitches;
    const pitchesOfScore = settings.melody === "score" ? pitchesForVoice : null;
    const planOptions = {
      kind: settings.kind,
      random: settings.random,
      previous: lastFragment,
      scorePitches: pitchesOfScore,
    };
    const planned = planBars(
      progressionsWithSlots,
      fragments,
      sentenceStart,
      sentence.bars,
      planOptions,
    );

    sentence.notes = planned.notes;
    sentence.kinds = planned.kinds;
    sentence.used = planned.used;
    sentence.chords = planned.chords;

    lastFragment = planned.last;
  }

  // At a bar line: take the speed that waits, start the next sentence of the queue when none is
  // being sung, and schedule one bar of the sentence. onStart, onBar and onEnd are not called
  // here: tick() calls them when the audio clock reaches their time (so up to EVERY ms late, and
  // not at all for a caller that drives advanceTo() itself, without the timer).
  function scheduleBarLine() {
    if (settings.pendingSpeed) {
      settings.speed = settings.pendingSpeed;
      settings.pendingSpeed = 0;
    }
    slotLength = lengthAt(nextSlot); // the score's tempo is the same through a bar

    // A sentence with nothing to sing (only marks, such as a 「。」 alone) has no bar: it starts
    // and ends at this bar line, and the one after it starts here too (歌 ED D-33: no bar of
    // waiting). A sentence that cannot be scheduled is dropped: one odd sentence must not stop
    // the song for good.
    while (!job && queue.length) {
      try {
        beginSentence();
      } catch (error) {
        dropSentence(error, nextSlotTime);
        continue;
      }

      if (!job.bars.length) {
        endSentence(nextSlotTime);
      }
    }
    if (!job) {
      return;
    }

    try {
      scheduleSungBar();
    } catch (error) {
      const barEnd = nextSlotTime + SLOTS_PER_BAR * slotLength;
      dropSentence(error, barEnd);
    }
  }

  // The sentence is done at `end`: its onEnd is called then, and the next one can start.
  function endSentence(end) {
    const sentence = job;
    sentence.end = end;
    job = null;

    const tellEnd = () => {
      if (sentence.onEnd) {
        sentence.onEnd(sentence);
      }
    };
    const callback = {
      t: end,
      fn: tellEnd,
    };
    callbacks.push(callback);
  }

  // Give a sentence up, saying so in the console; its end is told at `end`, so the reader goes on.
  function dropSentence(error, end) {
    console.warn(`the song drops a sentence that it cannot schedule: ${error}`);
    endSentence(end);
  }

  // The next sentence of the queue starts at this bar line: its place, its pitches, its onStart.
  function beginSentence() {
    job = queue.shift();
    job.next = 0;
    job.events = [];
    job.sources = [];
    job.lines = []; // the time and the slot length of each bar, as it is scheduled
    job.t0 = nextSlotTime;
    job.at = nextSlot; // the score's slot at the sentence's bar line
    planSentence(job);

    const sentence = job; // `job` may be another sentence, or none, when the callback runs
    const tellStart = () => {
      if (sentence.onStart) {
        sentence.onStart(sentence);
      }
    };
    const callback = {
      t: nextSlotTime,
      fn: tellStart,
    };
    callbacks.push(callback);
  }

  // Schedule the sentence's next bar at this bar line, with its onBar; after its last bar, its
  // onEnd, and the sentence is done.
  function scheduleSungBar() {
    const barIndex = job.next;
    job.next++;

    job.lines[barIndex] = {
      t: nextSlotTime,
      slot: slotLength,
    };

    const oneBar = [job.bars[barIndex]];
    const itsNotes = [job.notes[barIndex]];
    const singOptions = {
      slot: slotLength,
      tail: settings.tail,
      hold: settings.hold,
    };
    const run = singBars(ctx, voiceBus, oneBar, itsNotes, nextSlotTime, singOptions);

    job.events.push(...run.events);
    job.sources.push(...run.sources);
    voiceSources.push(...run.sources);

    if (job.onBar) {
      const sentence = job;
      const barTime = nextSlotTime;
      const tellBar = () => sentence.onBar(sentence, barIndex);
      const callback = {
        t: barTime,
        fn: tellBar,
      };
      callbacks.push(callback);
    }

    if (job.next >= job.bars.length) {
      const barEnd = nextSlotTime + SLOTS_PER_BAR * slotLength;
      endSentence(barEnd);
    }
  }

  // The score: slot by slot, every note of every part that starts in the slot, at its place in
  // the slot, from the sheet of its program or the drum kit (instruments.js). They are scheduled
  // slot by slot and not a bar at a time, so that no call of the scheduler has much to do.
  function bandSlot() {
    if (nextSlot % SLOTS_PER_BAR === 0) {
      bandSources = bandSources.filter((sounding) => sounding.end > nextSlotTime);
    }

    const notesOfSlot = bySlot[nextSlot] || [];
    for (const note of notesOfSlot) {
      let sample;
      if (note.drum) {
        sample = instruments.hit(note.pitch);
      } else {
        sample = instruments.note(note.program, note.pitch);
      }
      if (!sample) {
        continue; // a part without its sheet is silent
      }

      const partSettings = PARTS[note.part] || OTHER_PART;
      const at = nextSlotTime + note.offset * slotLength;

      let to;
      if (note.drum) {
        to = at + sample.length;
      } else {
        // a note stops 50 ms before the end of its window in the sheet
        const ringEnd = at + note.slots * slotLength + partSettings.release;
        const latestEnd = at + sample.length - 0.05;
        to = Math.min(ringEnd, latestEnd);
      }

      const bus = busOf(note.part);

      // the sound starts `start` seconds into its window, so the source starts that much early
      const from = at - sample.start;
      const gain = (partSettings.level * note.velocity) / 127;

      const source = play(
        ctx,
        bus,
        sample.buffer,
        sample.window,
        from,
        to,
        partSettings.release,
        gain,
        partSettings.attack,
      );

      if (source) {
        const sounding = {
          source,
          end: to,
        };
        bandSources.push(sounding);
      }

      if (settings.record) {
        const playedNote = {
          ...note,
          t: at,
          seconds: to - at,
        };
        played.push(playedNote);
      }
    }
  }

  // Note each chord as it starts: its bass note in the octave from MIDI 36, its tones in the
  // octave from 48. Only the checks read this log; the display's chord comes from position().
  function chordStep() {
    const progression = progressionsWithSlots[progressionIndex];
    const { chord, key, rest } = chordAt(progression.data, nextSlot);

    const sounding = rest ? null : chord;
    if (chordNow === sounding) {
      return;
    }
    chordNow = sounding;
    if (!sounding) {
      return;
    }

    const { bass, pcs } = tones(chord, key);
    const name = chordName(chord, key);
    const bassMidi = 36 + bass;
    const toneMidis = pcs.map((pc) => 48 + pc);

    const logged = {
      t: nextSlotTime,
      chord: name,
      midis: [bassMidi, ...toneMidis],
    };
    chordLog.push(logged);

    if (chordLog.length > 500) {
      chordLog.shift();
    }
  }

  function advanceTo(until) {
    // schedule every slot that starts before `until`
    while (nextSlotTime < until) {
      if (nextSlot % SLOTS_PER_BAR === 0) {
        scheduleBarLine();
      }

      slotLength = lengthAt(nextSlot);
      bandSlot();
      chordStep();

      nextSlotTime += slotLength;
      [progressionIndex, nextSlot] = placeAfter(progressionIndex, nextSlot, 1);
    }
  }

  // What the scheduler cost, for SC-S07: how many times it ran, how long its work took (ms; and
  // how often more than 5), and how many times it found itself behind the clock (a slot to
  // schedule already in the past).
  const schedulerCost = { calls: 0, totalMs: 0, worstMs: 0, over5ms: 0, behind: 0 };

  // The timer's work: schedule what starts within the lookahead, counting what that cost, then
  // make the calls that are due.
  function tick() {
    const startedAt = performance.now();

    if (nextSlotTime < ctx.currentTime) {
      schedulerCost.behind++;
    }

    const until = ctx.currentTime + LOOKAHEAD;
    advanceTo(until);
    schedulerCost.calls++;

    const spent = performance.now() - startedAt;
    schedulerCost.totalMs += spent;
    schedulerCost.worstMs = Math.max(schedulerCost.worstMs, spent);
    if (spent > 5) {
      schedulerCost.over5ms++;
    }

    const now = ctx.currentTime;
    callDue(now);
  }

  // Make the calls (onStart, onBar, onEnd) whose time the audio clock has reached, each once.
  function callDue(now) {
    for (let i = 0; i < callbacks.length;) {
      if (callbacks[i].t <= now) {
        const [due] = callbacks.splice(i, 1);
        due.fn();
      } else {
        i++;
      }
    }
  }

  // The times of the slot lines of a sentence: entry k is when its slot k starts (8 to a bar),
  // and the last entry is the end of its last bar. The bars already scheduled have their real
  // times; the others follow the score's tempo at the speed now, or at the speed that waits for
  // the next bar line. A sentence not yet started starts where `before` (the sentence before it,
  // started) ends. null when neither has started.
  function slotTimes(sentence, before = null) {
    let startSlot;
    let t;
    if (sentence.t0 !== undefined) {
      startSlot = sentence.at;
      t = sentence.t0;
    } else if (before && before.t0 !== undefined) {
      const prior = slotTimes(before);
      const slotsOfBefore = before.bars.length * SLOTS_PER_BAR;
      startSlot = (before.at + slotsOfBefore) % totalSlots;
      t = prior[prior.length - 1];
    } else {
      return null;
    }

    const speed = settings.pendingSpeed || settings.speed;
    const scheduledBars = sentence.lines || [];
    return sentenceSlots(lengths, startSlot, t, sentence.bars.length, speed, scheduledBars);
  }

  return {
    start(at = ctx.currentTime + 0.35) {
      if (started) {
        return;
      }
      started = true;
      nextSlotTime = at;

      // an offline render has no timer: its caller schedules with advanceTo() itself
      if (ctx.constructor.name !== "OfflineAudioContext") {
        timer = setInterval(tick, EVERY);
      }
    },

    // sentence: { bars, onStart, onBar, onEnd }; it starts at the next free bar line
    enqueue(sentence) {
      queue.push(sentence);
    },

    advanceTo,

    // The speed changes at the next bar line.
    setSpeed(speed) {
      settings.pendingSpeed = speed;
    },

    setLevels({ band, voice }) {
      if (band !== undefined) {
        bandBus.gain.value = band;
      }
      if (voice !== undefined) {
        settings.voice = voice; // the 「歌」 setting (ED D-114); kept for clear()
        voiceBus.gain.value = settings.mute ? 0 : voice;
      }
    },

    // The song's mode: "score", or anything else for "fragments". A sentence is planned at its
    // bar line, so the mode holds from the next sentence that starts.
    setMelody(mode) {
      settings.melody = mode === "score" ? "score" : "fragments";
    },

    melody: () => settings.melody,

    // Change options given to create(). Nothing in the site calls this.
    setOptions(changes) {
      Object.assign(settings, changes);
    },

    // A jump or a click: the sentence stops, with a fade of 15 ms, and the song goes on (ST-09).
    // Nothing of the sentences taken back is reported any more.
    clear() {
      queue.length = 0;
      job = null;
      callbacks.length = 0;

      const now = ctx.currentTime;
      const fadeEnd = now + 0.015;
      const backAt = now + 0.03;

      const levelNow = voiceBus.gain.value;
      voiceBus.gain.setValueAtTime(levelNow, now);
      voiceBus.gain.linearRampToValueAtTime(0, fadeEnd);

      const levelAfter = voiceLevel();
      voiceBus.gain.setValueAtTime(levelAfter, backAt);

      stopSources(voiceSources, ctx);
      voiceSources.length = 0;
    },

    stop() {
      clearInterval(timer);
      timer = null;
      started = false;

      queue.length = 0;
      job = null;
      callbacks.length = 0;

      stopSources(voiceSources, ctx);
      voiceSources.length = 0;

      // the accompaniment fades out rather than stopping on a sample
      const now = ctx.currentTime;
      const fadeEnd = now + 0.1;
      const backAt = now + 0.2;

      const levelNow = bandBus.gain.value;
      bandBus.gain.setValueAtTime(levelNow, now);
      bandBus.gain.linearRampToValueAtTime(0, fadeEnd);
      bandBus.gain.setValueAtTime(settings.band, backAt);

      const sourcesOfBand = bandSources.map(({ source }) => source);
      stopSources(sourcesOfBand, ctx, 0.15);
      bandSources = [];

      chordNow = null;
    },

    position() {
      // what is sounding now, for the display
      let slotThen = nextSlot;
      let timeThen = nextSlotTime;

      // back, slot by slot, while the slot starts after now; once round the score at most
      for (let stepsBack = 0; stepsBack < totalSlots; stepsBack++) {
        const startsAfterNow = timeThen > ctx.currentTime;
        if (!startsAfterNow) {
          break;
        }

        slotThen = (slotThen - 1 + totalSlots) % totalSlots;
        timeThen -= lengthAt(slotThen);
      }

      const score = progressionsWithSlots[0];
      const { chord, key, rest } = chordAt(score.data, slotThen);
      const barIndex = Math.floor(slotThen / SLOTS_PER_BAR);

      let kind = settings.kind;
      if (!kind) {
        kind = kindAt(score.form, barIndex);
      }

      let chordShown = "—";
      if (!rest) {
        chordShown = chordName(chord, key);
      }

      return {
        progression: score.name,
        bar: barIndex + 1,
        bars: totalSlots / SLOTS_PER_BAR,
        kind,
        chord: chordShown,
        key: `${key.tonic} ${key.scale}`,
      };
    },

    // The time of the bar line `bars` bars after the one that sounded last, at the speed of now (a
    // speed that waits for the next bar line is not counted).
    barLine(bars) {
      // the bar line of the bar being scheduled
      const slotsIntoBar = nextSlot % SLOTS_PER_BAR;
      let barSlot = nextSlot - slotsIntoBar;
      let lineTime = nextSlotTime - slotsIntoBar * lengthAt(barSlot);

      // back, bar by bar, while the line comes after now; once round the score at most
      const barsInScore = totalSlots / SLOTS_PER_BAR;
      for (let count = 0; count < barsInScore; count++) {
        const comesAfterNow = lineTime > ctx.currentTime;
        if (!comesAfterNow) {
          break;
        }

        barSlot = (barSlot - SLOTS_PER_BAR + totalSlots) % totalSlots;
        const barSeconds = SLOTS_PER_BAR * lengthAt(barSlot);
        lineTime -= barSeconds;
      }

      // forward, by the bars asked for
      for (let count = 0; count < bars; count++) {
        const barSeconds = SLOTS_PER_BAR * lengthAt(barSlot);
        lineTime += barSeconds;
        barSlot = (barSlot + SLOTS_PER_BAR) % totalSlots;
      }

      return lineTime;
    },

    slotTimes,
    busy: () => !!job || queue.length > 0,
    log: chordLog,
    played,
    work: schedulerCost,

    // of the slot scheduled last, up to LOOKAHEAD ahead of what sounds
    slotSeconds: () => slotLength,
  };
}
