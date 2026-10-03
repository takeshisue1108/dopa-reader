// The song clock of sung reading: the Day Life score, played from its notes, and the sung clips of
// each sentence on its bars (SPEC_dopa v3.9 §6.11; ED D-139; SPEC_sing §6.5, §6.8; 歌 ED D-24,
// D-25, D-33, ST-03 to ST-09). A slot is an eighth note of the score, so its length follows the
// score's tempo map; a bar of the song is a bar of the score; after its last bar the score starts
// again.
import * as bank from "./bank.js";
import { chordAt, chordName, tones } from "./harmony.js";
import * as instruments from "./instruments.js";
import { kindAt } from "./melody.js";
import { SLOTS_PER_BAR } from "./bars.js";
import { planBars, positionAfter, withSlots } from "./plan.js";
import { notesBySlot } from "./score.js";
import { sentenceSlots, slotLengths } from "./tempo.js";

export const SLOT = 0.15; // seconds per slot at 200 BPM and the speed 1.0 (D-139)
// The fades of a sung clip, in seconds: in, out, and out for the last mora of a bar.
const ATTACK = 0.005,
  RELEASE = 0.015,
  HOLD_RELEASE = 0.06;
// The scheduler, as in festap (SD-S10): every EVERY milliseconds a timer schedules the slots that
// start within the next LOOKAHEAD seconds of the audio clock.
const LOOKAHEAD = 0.3,
  EVERY = 25;

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
// seconds ends at `to`. A sound of less than 10 ms is not started (null).
function play(ctx, out, buffer, offset, from, to, release, gain = 1, attack = ATTACK) {
  if (to - from < 0.01) return null;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const envelope = gainFrom(ctx, 0);
  envelope.gain.setValueAtTime(0, from);
  envelope.gain.linearRampToValueAtTime(gain, from + attack);
  envelope.gain.setValueAtTime(gain, Math.max(from + attack, to - release));
  envelope.gain.linearRampToValueAtTime(0, to);
  source.connect(envelope).connect(out);
  source.start(from, Math.max(0, offset), to - from + 0.02);
  return source;
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
  const slotLength = opt.slot || SLOT,
    tailMode = opt.tail || "inside",
    hold = opt.hold !== false;
  const maxLead = 0.35 * slotLength; // a consonant made for slow singing is cut to fit a fast slot
  const events = [],
    sources = [];
  const keep = (source) => {
    if (source) sources.push(source);
  };
  bars.forEach((bar, barIndex) => {
    const barTime = t0 + barIndex * SLOTS_PER_BAR * slotLength,
      barEnd = barTime + SLOTS_PER_BAR * slotLength;
    bar.forEach((mora, slotInBar) => {
      const slotStart = barTime + slotInBar * slotLength,
        slotEnd = slotStart + slotLength,
        midi = notes[barIndex][slotInBar];
      events.push({ t: slotStart, start: mora.start, end: mora.end });
      const clip = bank.clip(mora.k, midi);
      if (!clip) return; // ッ, or a sound the bank cannot give: a silent slot
      const lead = Math.min(clip.lead, maxLead);
      const from = slotStart - lead - ATTACK;
      const next = bar[slotInBar + 1];
      // an ん that gave up its slot (D-31) is the ン of the slot's pitch, short, at the slot's end
      const tails = mora.tails.map((kind) => ({ kind, len: Math.min(0.09, 0.4 * slotLength) }));
      const tailsLen = tails.reduce((total, tail) => total + tail.len, 0);
      let tailAt = tailMode === "inside" ? slotEnd - Math.min(tailsLen, 0.6 * slotLength) : slotEnd;
      let to,
        release = RELEASE;
      if (tails.length) to = tailAt + 0.005;
      else if (next) {
        const nextClip = bank.clip(next.k, notes[barIndex][slotInBar + 1]);
        to = nextClip ? slotEnd - Math.min(nextClip.lead, maxLead) : slotEnd;
      } else if (hold) {
        // the last mora of a bar is held (Q-18): one slot more at most, and never past the bar
        to = Math.min(slotStart + 2 * slotLength, barEnd);
        release = HOLD_RELEASE;
      } else to = slotEnd;
      // a clip ends 10 ms or more before its window in the sheet does
      to = Math.min(to, from + clip.length - (clip.onset - lead) - 0.01);
      keep(
        play(ctx, out, clip.buffer, clip.window + clip.onset - lead - ATTACK, from, to, release),
      );
      for (const tail of tails) {
        const tailClip = bank.clip("ン", midi);
        if (tailClip)
          keep(
            play(
              ctx,
              out,
              tailClip.buffer,
              tailClip.window + tailClip.onset + 0.03,
              tailAt,
              tailAt + tail.len,
              0.01,
            ),
          );
        tailAt += tail.len;
      }
    });
  });
  return { events, end: t0 + bars.length * SLOTS_PER_BAR * slotLength, sources };
}

// Stop these sources `after` seconds from now.
export function stopSources(sources, ctx, after = 0.02) {
  for (const source of sources) {
    try {
      source.stop(ctx.currentTime + after);
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
// (0-based); random (the chance that picks a bar's fragment; Math.random when not given).
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
    ...options,
  };
  const progressionsWithSlots = withSlots(progressions);
  // Three files give the song's length: the chords (totalSlots), the tempo map (lengths) and the
  // notes (bySlot). Nothing here checks that they agree.
  const totalSlots = progressionsWithSlots[0].slots; // the song is one progression: the score
  const lengths = slotLengths(song.tempo); // the length of each slot at the speed 1.0
  const bySlot = song.notes ? notesBySlot(song.notes) : [];
  const voiceBus = ctx.createGain(),
    bandBus = ctx.createGain();
  const partBus = {};
  const busOf = (part) => {
    if (!partBus[part]) {
      partBus[part] = gainFrom(ctx, settings.parts[part] ?? 1);
      partBus[part].connect(bandBus);
    }
    return partBus[part];
  };
  // the level of the voice: its setting (full when none was given), or silence when muted
  const voiceLevel = () => (settings.mute ? 0 : (settings.voice ?? 1));
  bandBus.connect(out);
  voiceBus.connect(out);
  voiceBus.gain.value = voiceLevel();
  bandBus.gain.value = settings.band;

  // The place up to which the song is scheduled: the next slot of the score (an index) and the
  // time at which it starts, up to LOOKAHEAD ahead of what sounds.
  let progressionIndex = settings.startAt ? settings.startAt.progression : 0,
    nextSlot = settings.startAt ? settings.startAt.bar * SLOTS_PER_BAR : 0;
  let nextSlotTime = 0,
    slotLength = lengths[nextSlot] / settings.speed, // of the slot scheduled last, in seconds
    started = false,
    timer = null;
  let chordNow = null, // the chord sounding, to log each change once
    lastFragment = null;
  const queue = [],
    callbacks = [],
    // each chord as it starts: { t, chord (its name), midis (its bass note, then its tones) };
    // the last 500
    chordLog = [],
    // with `record`: each note of the score as played, with t (when it sounds) and seconds
    played = [];
  let bandSources = []; // the score's notes that may still sound: { source, end }
  // The sentence being sung: what enqueue() was given ({ bars, onStart, onBar, onEnd } and
  // whatever else the caller put on it), and, added here: next (the bar to schedule next), events,
  // sources, lines, t0 (the time of its bar line), at (the score's slot there), notes, kinds, used,
  // chords (planSentence) and, once its last bar is scheduled, end.
  let job = null;
  const voiceSources = [];

  // the position n slots later (the score starts again after its last slot)
  const placeAfter = (p, s, n) => positionAfter(progressionsWithSlots, p, s, n);
  const lengthAt = (s) => lengths[((s % totalSlots) + totalSlots) % totalSlots] / settings.speed;

  function planSentence(sentence) {
    // a fragment for each bar, by the form at its place (D-25), and its pitches (plan.js)
    const planned = planBars(
      progressionsWithSlots,
      fragments,
      { progression: progressionIndex, bar: nextSlot / SLOTS_PER_BAR },
      sentence.bars,
      {
        kind: settings.kind,
        random: settings.random,
        previous: lastFragment,
      },
    );
    Object.assign(sentence, {
      notes: planned.notes,
      kinds: planned.kinds,
      used: planned.used,
      chords: planned.chords,
    });
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
      if (!job.bars.length) endSentence(nextSlotTime);
    }
    if (!job) return;
    try {
      scheduleSungBar();
    } catch (error) {
      dropSentence(error, nextSlotTime + SLOTS_PER_BAR * slotLength);
    }
  }

  // The sentence is done at `end`: its onEnd is called then, and the next one can start.
  function endSentence(end) {
    const sentence = job;
    sentence.end = end;
    job = null;
    callbacks.push({ t: end, fn: () => sentence.onEnd && sentence.onEnd(sentence) });
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
    callbacks.push({ t: nextSlotTime, fn: () => sentence.onStart && sentence.onStart(sentence) });
  }

  // Schedule the sentence's next bar at this bar line, with its onBar; after its last bar, its
  // onEnd, and the sentence is done.
  function scheduleSungBar() {
    const barIndex = job.next++;
    job.lines[barIndex] = { t: nextSlotTime, slot: slotLength };
    const run = singBars(ctx, voiceBus, [job.bars[barIndex]], [job.notes[barIndex]], nextSlotTime, {
      slot: slotLength,
      tail: settings.tail,
      hold: settings.hold,
    });
    job.events.push(...run.events);
    job.sources.push(...run.sources);
    voiceSources.push(...run.sources);
    if (job.onBar) {
      const sentence = job,
        barTime = nextSlotTime;
      callbacks.push({ t: barTime, fn: () => sentence.onBar(sentence, barIndex) });
    }
    if (job.next >= job.bars.length) endSentence(nextSlotTime + SLOTS_PER_BAR * slotLength);
  }

  // The score: slot by slot, every note of every part that starts in the slot, at its place in
  // the slot, from the sheet of its program or the drum kit (instruments.js). They are scheduled
  // slot by slot and not a bar at a time, so that no call of the scheduler has much to do.
  function bandSlot() {
    if (nextSlot % SLOTS_PER_BAR === 0)
      bandSources = bandSources.filter((sounding) => sounding.end > nextSlotTime);
    for (const note of bySlot[nextSlot] || []) {
      const sample = note.drum
        ? instruments.hit(note.pitch)
        : instruments.note(note.program, note.pitch);
      if (!sample) continue; // a part without its sheet is silent
      const partSettings = PARTS[note.part] || OTHER_PART;
      const at = nextSlotTime + note.offset * slotLength;
      const to = note.drum
        ? at + sample.length
        : // a note stops 50 ms before the end of its window in the sheet
          Math.min(at + note.slots * slotLength + partSettings.release, at + sample.length - 0.05);
      const source = play(
        ctx,
        busOf(note.part),
        sample.buffer,
        sample.window,
        at - sample.start,
        to,
        partSettings.release,
        (partSettings.level * note.velocity) / 127,
        partSettings.attack,
      );
      if (source) bandSources.push({ source, end: to });
      if (settings.record) played.push({ ...note, t: at, seconds: to - at });
    }
  }

  // Note each chord as it starts: its bass note in the octave from MIDI 36, its tones in the
  // octave from 48. Only the checks read this log; the display's chord comes from position().
  function chordStep() {
    const { chord, key, rest } = chordAt(progressionsWithSlots[progressionIndex].data, nextSlot);
    const sounding = rest ? null : chord;
    if (chordNow === sounding) return;
    chordNow = sounding;
    if (!sounding) return;
    const { bass, pcs } = tones(chord, key);
    chordLog.push({
      t: nextSlotTime,
      chord: chordName(chord, key),
      midis: [36 + bass, ...pcs.map((pc) => 48 + pc)],
    });
    if (chordLog.length > 500) chordLog.shift();
  }

  function advanceTo(until) {
    // schedule every slot that starts before `until`
    while (nextSlotTime < until) {
      if (nextSlot % SLOTS_PER_BAR === 0) scheduleBarLine();
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
    if (nextSlotTime < ctx.currentTime) schedulerCost.behind++;
    advanceTo(ctx.currentTime + LOOKAHEAD);
    schedulerCost.calls++;
    const spent = performance.now() - startedAt;
    schedulerCost.totalMs += spent;
    schedulerCost.worstMs = Math.max(schedulerCost.worstMs, spent);
    if (spent > 5) schedulerCost.over5ms++;
    callDue(ctx.currentTime);
  }

  // Make the calls (onStart, onBar, onEnd) whose time the audio clock has reached, each once.
  function callDue(now) {
    for (let i = 0; i < callbacks.length;) {
      if (callbacks[i].t <= now) callbacks.splice(i, 1)[0].fn();
      else i++;
    }
  }

  // The times of the slot lines of a sentence: entry k is when its slot k starts (8 to a bar),
  // and the last entry is the end of its last bar. The bars already scheduled have their real
  // times; the others follow the score's tempo at the speed now, or at the speed that waits for
  // the next bar line. A sentence not yet started
  // starts where `before` (the sentence before it, started) ends. null when neither has started.
  function slotTimes(sentence, before = null) {
    let startSlot, t;
    if (sentence.t0 !== undefined) {
      startSlot = sentence.at;
      t = sentence.t0;
    } else if (before && before.t0 !== undefined) {
      const prior = slotTimes(before);
      startSlot = (before.at + before.bars.length * SLOTS_PER_BAR) % totalSlots;
      t = prior[prior.length - 1];
    } else return null;
    const speed = settings.pendingSpeed || settings.speed;
    return sentenceSlots(lengths, startSlot, t, sentence.bars.length, speed, sentence.lines || []);
  }

  return {
    start(at = ctx.currentTime + 0.35) {
      if (started) return;
      started = true;
      nextSlotTime = at;
      // an offline render has no timer: its caller schedules with advanceTo() itself
      if (ctx.constructor.name !== "OfflineAudioContext") timer = setInterval(tick, EVERY);
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
      if (band !== undefined) bandBus.gain.value = band;
      if (voice !== undefined) {
        settings.voice = voice; // the 「歌」 setting (ED D-114); kept for clear()
        voiceBus.gain.value = settings.mute ? 0 : voice;
      }
    },
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
      voiceBus.gain.setValueAtTime(voiceBus.gain.value, now);
      voiceBus.gain.linearRampToValueAtTime(0, now + 0.015);
      voiceBus.gain.setValueAtTime(voiceLevel(), now + 0.03);
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
      bandBus.gain.setValueAtTime(bandBus.gain.value, now);
      bandBus.gain.linearRampToValueAtTime(0, now + 0.1);
      bandBus.gain.setValueAtTime(settings.band, now + 0.2);
      stopSources(
        bandSources.map(({ source }) => source),
        ctx,
        0.15,
      );
      bandSources = [];
      chordNow = null;
    },
    position() {
      // what is sounding now, for the display
      let slotThen = nextSlot,
        timeThen = nextSlotTime;
      for (let stepsBack = 0; stepsBack < totalSlots && timeThen > ctx.currentTime; stepsBack++) {
        slotThen = (slotThen - 1 + totalSlots) % totalSlots;
        timeThen -= lengthAt(slotThen);
      }
      const { chord, key, rest } = chordAt(progressionsWithSlots[0].data, slotThen);
      return {
        progression: progressionsWithSlots[0].name,
        bar: Math.floor(slotThen / SLOTS_PER_BAR) + 1,
        bars: totalSlots / SLOTS_PER_BAR,
        kind:
          settings.kind ||
          kindAt(progressionsWithSlots[0].form, Math.floor(slotThen / SLOTS_PER_BAR)),
        chord: rest ? "—" : chordName(chord, key),
        key: `${key.tonic} ${key.scale}`,
      };
    },
    // The time of the bar line `bars` bars after the one that sounded last, at the speed of now (a
    // speed that waits for the next bar line is not counted).
    barLine(bars) {
      // the bar line of the bar being scheduled
      let barSlot = nextSlot - (nextSlot % SLOTS_PER_BAR),
        lineTime = nextSlotTime - (nextSlot % SLOTS_PER_BAR) * lengthAt(barSlot);
      for (
        let count = 0;
        count < totalSlots / SLOTS_PER_BAR && lineTime > ctx.currentTime;
        count++
      ) {
        barSlot = (barSlot - SLOTS_PER_BAR + totalSlots) % totalSlots;
        lineTime -= SLOTS_PER_BAR * lengthAt(barSlot);
      }
      for (let count = 0; count < bars; count++) {
        lineTime += SLOTS_PER_BAR * lengthAt(barSlot);
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
