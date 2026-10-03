// The song clock of sung reading: the Day Life score, played from its notes, and the sung clips of
// each sentence on its bars (SPEC_dopa v3.9 §6.11; ED D-139; SPEC_sing §6.5, §6.8; 歌 ED D-24,
// D-25, D-33, ST-03 to ST-09). A slot is an eighth note of the score, so its length follows the
// score's tempo map; a bar of the song is a bar of the score; after its last bar the score starts
// again.
import * as bank from "./bank.js";
import { chordAt, chordName, tones } from "./harmony.js";
import * as instruments from "./instruments.js";
import { kindAt } from "./melody.js";
import { planBars, positionAfter, SLOTS_PER_BAR, withSlots } from "./plan.js";
import { notesBySlot } from "./score.js";
import { sentenceSlots, slotLengths } from "./tempo.js";

export const SLOT = 0.15; // seconds per slot at 200 BPM and the speed 1.0 (D-139)
const ATTACK = 0.005,
  RELEASE = 0.015,
  HOLD_RELEASE = 0.06;
const LOOKAHEAD = 0.3,
  EVERY = 25; // festap's scheduler (SD-S10)

// A gain whose level is `level` from the first sample on. A gain is 1 until its first scheduled
// value takes hold, and a source that starts at the same time can be one sample ahead of it: that
// sample would pass at full level, as a click.
function gainFrom(ctx, level) {
  const g = ctx.createGain();
  g.gain.value = level;
  return g;
}

// How each part of the score is played. level: the gain of a note of velocity 127 (the notes of
// every sheet are stored equally loud, and the drum kit keeps its own balance; a note's gain is
// level × velocity / 127). The levels set the mix under the voice: each part's usual level (the
// median of its 50 ms frames over bars 49 to 72) is the number of dB under the voice's written
// beside it, measured on offline renders (tests/site/render_daylife.mjs, check_daylife_render.py). attack and release: the fades of a note, in
// seconds; a note rings on for its release after its written end. A drum hit sounds to its end.
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

// One source through its own gain: it sounds from `from` to `to`, with short fades.
function play(ctx, out, buffer, offset, from, to, release, gain = 1, attack = ATTACK) {
  if (to - from < 0.01) return null;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const g = gainFrom(ctx, 0);
  g.gain.setValueAtTime(0, from);
  g.gain.linearRampToValueAtTime(gain, from + attack);
  g.gain.setValueAtTime(gain, Math.max(from + attack, to - release));
  g.gain.linearRampToValueAtTime(0, to);
  src.connect(g).connect(out);
  src.start(from, Math.max(0, offset), to - from + 0.02);
  return src;
}

// Schedule bars on given pitches. `notes[b][i]` is the MIDI pitch of sung slot i of bar b.
// Options: slot (seconds), tail "inside" | "after" for an ん ending (D-31, Q-14), hold (Q-18).
// Returns the light events {t, start, end}, the end time, and the sources (to stop them on a jump).
export function singBars(ctx, out, bars, notes, t0, opt = {}) {
  const slot = opt.slot || SLOT,
    tailMode = opt.tail || "inside",
    hold = opt.hold !== false;
  const maxLead = 0.35 * slot; // a consonant made for slow singing is cut to fit a fast slot
  const events = [],
    sources = [];
  const keep = (s) => {
    if (s) sources.push(s);
  };
  bars.forEach((bar, b) => {
    const barTime = t0 + b * 8 * slot,
      barEnd = barTime + 8 * slot;
    bar.forEach((mora, i) => {
      const t = barTime + i * slot,
        slotEnd = t + slot,
        midi = notes[b][i];
      events.push({ t, start: mora.start, end: mora.end });
      const c = bank.clip(mora.k, midi);
      if (!c) return; // ッ, or a sound the bank cannot give: a silent slot
      const lead = Math.min(c.lead, maxLead);
      const from = t - lead - ATTACK;
      const next = bar[i + 1];
      // an ん that gave up its slot (D-31) is the ン of the slot's pitch, short, at the end of the slot
      const tails = mora.tails.map((kind) => ({ kind, len: Math.min(0.09, 0.4 * slot) }));
      const tailsLen = tails.reduce((a, x) => a + x.len, 0);
      let tailAt = tailMode === "inside" ? slotEnd - Math.min(tailsLen, 0.6 * slot) : slotEnd;
      let to,
        release = RELEASE;
      if (tails.length) to = tailAt + 0.005;
      else if (next) {
        const n = bank.clip(next.k, notes[b][i + 1]);
        to = n ? slotEnd - Math.min(n.lead, maxLead) : slotEnd;
      } else if (hold) {
        to = Math.min(t + 2 * slot, barEnd);
        release = HOLD_RELEASE;
      } // the end of a phrase is held (Q-18)
      else to = slotEnd;
      to = Math.min(to, from + c.length - (c.onset - lead) - 0.01);
      keep(play(ctx, out, c.buffer, c.window + c.onset - lead - ATTACK, from, to, release));
      for (const x of tails) {
        const n = bank.clip("ン", midi);
        if (n)
          keep(play(ctx, out, n.buffer, n.window + n.onset + 0.03, tailAt, tailAt + x.len, 0.01));
        tailAt += x.len;
      }
    });
  });
  return { events, end: t0 + bars.length * 8 * slot, sources };
}

export function stop(sources, ctx) {
  for (const s of sources) {
    try {
      s.stop(ctx.currentTime + 0.02);
    } catch {
      /* already ended */
    }
  }
}

// song: { progressions: [{ name, data, form }] (the score's chords and form, as one progression
// that starts again after its last bar), fragments: the parsed fragments file, notes: notes.json
// (every note of the score), tempo: tempo.json } (song.js).
// options: speed; band (the level of the score's parts, 0 = off); parts (the level of each part
// inside the band, by its name in the score, for checking one alone); mute (the voice is silent:
// for checking the accompaniment alone); record (keep each note played in `played`, for the
// checks); tail, hold; kind (a fixed kind for every bar, for tests); startAt { progression, bar }
// (0-based); random.
export function create(ctx, out, song, options = {}) {
  const { progressions, fragments } = song;
  const opt = {
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
  const progs = withSlots(progressions);
  const total = progs[0].slots; // the song is one progression: the score
  const lengths = slotLengths(song.tempo); // the length of each slot at the speed 1.0
  const bySlot = song.notes ? notesBySlot(song.notes) : [];
  const voiceBus = ctx.createGain(),
    bandBus = ctx.createGain();
  const partBus = {};
  const busOf = (part) => {
    if (!partBus[part]) {
      partBus[part] = gainFrom(ctx, opt.parts[part] ?? 1);
      partBus[part].connect(bandBus);
    }
    return partBus[part];
  };
  bandBus.connect(out);
  voiceBus.connect(out);
  voiceBus.gain.value = opt.mute ? 0 : (opt.voice ?? 1);
  bandBus.gain.value = opt.band;

  let pi = opt.startAt ? opt.startAt.progression : 0,
    slot = opt.startAt ? opt.startAt.bar * SLOTS_PER_BAR : 0;
  let time = 0,
    slotDur = lengths[slot] / opt.speed,
    started = false,
    timer = null;
  let chordNow = null, // the chord sounding, to log each change once
    lastFragment = null;
  const queue = [],
    callbacks = [],
    log = [], // each chord as it starts: { t, chord (its name), midis (its bass note, then its tones) }; the last 500
    played = []; // with `record`: each note of the score as played, with t and seconds: when it sounds
  let bandSources = []; // the score's notes that may still sound: { source, end }
  let job = null; // the sentence being sung: { bars, next, notes, kinds, used, events, sources, at, lines }
  const voiceSources = [];

  // the position n slots later (the score starts again after its last slot)
  const after = (p, s, n) => positionAfter(progs, p, s, n);
  const lengthAt = (s) => lengths[((s % total) + total) % total] / opt.speed;

  function plan(j) {
    // a fragment for each bar, by the form at its place (D-25), and its pitches (plan.js)
    const planned = planBars(progs, fragments, { progression: pi, bar: slot / 8 }, j.bars, {
      kind: opt.kind,
      random: opt.random,
      previous: lastFragment,
    });
    Object.assign(j, {
      notes: planned.notes,
      kinds: planned.kinds,
      used: planned.used,
      chords: planned.chords,
    });
    lastFragment = planned.last;
  }

  function barLine() {
    if (opt.pendingSpeed) {
      opt.speed = opt.pendingSpeed;
      opt.pendingSpeed = 0;
    }
    slotDur = lengthAt(slot); // the score's tempo is the same through a bar
    if (!job && queue.length) {
      job = queue.shift();
      job.next = 0;
      job.events = [];
      job.sources = [];
      job.lines = []; // the time and the slot length of each bar, as it is scheduled
      job.t0 = time;
      job.at = slot; // the score's slot at the sentence's bar line
      plan(job);
      const j = job;
      callbacks.push({ t: time, fn: () => j.onStart && j.onStart(j) });
    }
    if (job) {
      const b = job.next++;
      job.lines[b] = { t: time, slot: slotDur };
      const run = singBars(ctx, voiceBus, [job.bars[b]], [job.notes[b]], time, {
        slot: slotDur,
        tail: opt.tail,
        hold: opt.hold,
      });
      job.events.push(...run.events);
      job.sources.push(...run.sources);
      voiceSources.push(...run.sources);
      if (job.onBar) {
        const j = job,
          t = time;
        callbacks.push({ t, fn: () => j.onBar(j, b) });
      }
      if (job.next >= job.bars.length) {
        const j = job;
        j.end = time + 8 * slotDur;
        job = null;
        callbacks.push({ t: j.end, fn: () => j.onEnd && j.onEnd(j) });
      }
    }
  }

  // The score: slot by slot, every note of every part that starts in the slot, at its place in
  // the slot, from the sheet of its program or the drum kit (instruments.js). They are scheduled
  // slot by slot and not a bar at a time, so that no call of the scheduler has much to do.
  function bandSlot() {
    if (slot % 8 === 0) bandSources = bandSources.filter((sounding) => sounding.end > time);
    for (const note of bySlot[slot] || []) {
      const stored = note.drum
        ? instruments.hit(note.pitch)
        : instruments.note(note.program, note.pitch);
      if (!stored) continue; // a part without its sheet is silent
      const playing = PARTS[note.part] || OTHER_PART;
      const at = time + note.offset * slotDur;
      const to = note.drum
        ? at + stored.length
        : Math.min(at + note.slots * slotDur + playing.release, at + stored.length - 0.05);
      const source = play(
        ctx,
        busOf(note.part),
        stored.buffer,
        stored.window,
        at - stored.start,
        to,
        playing.release,
        (playing.level * note.velocity) / 127,
        playing.attack,
      );
      if (source) bandSources.push({ source, end: to });
      if (opt.record) played.push({ ...note, t: at, seconds: to - at });
    }
  }

  // Note each chord as it starts (for the display and the checks).
  function chordStep() {
    const { chord, key, rest } = chordAt(progs[pi].data, slot);
    const sounding = rest ? null : chord;
    if (chordNow === sounding) return;
    chordNow = sounding;
    if (!sounding) return;
    const { bass, pcs } = tones(chord, key);
    log.push({
      t: time,
      chord: chordName(chord, key),
      midis: [36 + bass, ...pcs.map((pc) => 48 + pc)],
    });
    if (log.length > 500) log.shift();
  }

  function advanceTo(until) {
    // schedule every slot that starts before `until`
    while (time < until) {
      if (slot % 8 === 0) barLine();
      slotDur = lengthAt(slot);
      bandSlot();
      chordStep();
      time += slotDur;
      [pi, slot] = after(pi, slot, 1);
    }
  }

  // What the scheduler cost, for SC-S07: how many times it ran, how long its work took (ms; and how
  // often more than 5), and how many times it found itself behind the clock (a slot to schedule already in the past).
  const work = { calls: 0, totalMs: 0, worstMs: 0, over5ms: 0, behind: 0 };

  function tick() {
    const startedAt = performance.now();
    if (time < ctx.currentTime) work.behind++;
    advanceTo(ctx.currentTime + LOOKAHEAD);
    work.calls++;
    const spent = performance.now() - startedAt;
    work.totalMs += spent;
    work.worstMs = Math.max(work.worstMs, spent);
    if (spent > 5) work.over5ms++;
    const now = ctx.currentTime;
    for (let i = 0; i < callbacks.length;) {
      if (callbacks[i].t <= now) callbacks.splice(i, 1)[0].fn();
      else i++;
    }
  }

  // The times of the slot lines of a sentence: entry k is when its slot k starts (8 to a bar),
  // and the last entry is the end of its last bar. The bars already scheduled have their real
  // times; the others follow the score's tempo at the speed now. A sentence not yet started
  // starts where `before` (the sentence before it, started) ends. null when neither has started.
  function slotTimes(j, before = null) {
    let from, t;
    if (j.t0 !== undefined) {
      from = j.at;
      t = j.t0;
    } else if (before && before.t0 !== undefined) {
      const prior = slotTimes(before);
      from = (before.at + before.bars.length * SLOTS_PER_BAR) % total;
      t = prior[prior.length - 1];
    } else return null;
    const speed = opt.pendingSpeed || opt.speed;
    return sentenceSlots(lengths, from, t, j.bars.length, speed, j.lines || []);
  }

  return {
    start(at = ctx.currentTime + 0.35) {
      if (started) return;
      started = true;
      time = at;
      if (ctx.constructor.name !== "OfflineAudioContext") timer = setInterval(tick, EVERY);
    },
    enqueue(j) {
      queue.push(j);
    }, // { bars, onStart, onBar, onEnd }; it starts at the next free bar line
    advanceTo,
    setSpeed(x) {
      opt.pendingSpeed = x;
    }, // at the next bar line
    setLevels({ band, voice }) {
      if (band !== undefined) bandBus.gain.value = band;
      if (voice !== undefined) {
        opt.voice = voice; // the 「歌」 setting (ED D-114); kept for clear()
        voiceBus.gain.value = opt.mute ? 0 : voice;
      }
    },
    setOptions(o) {
      Object.assign(opt, o);
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
      voiceBus.gain.setValueAtTime(opt.mute ? 0 : (opt.voice ?? 1), now + 0.03);
      stop(voiceSources, ctx);
      voiceSources.length = 0;
    },
    stop() {
      clearInterval(timer);
      timer = null;
      started = false;
      queue.length = 0;
      job = null;
      callbacks.length = 0;
      stop(voiceSources, ctx);
      voiceSources.length = 0;
      // the accompaniment fades out rather than stopping on a sample
      const t = ctx.currentTime;
      bandBus.gain.setValueAtTime(bandBus.gain.value, t);
      bandBus.gain.linearRampToValueAtTime(0, t + 0.1);
      bandBus.gain.setValueAtTime(opt.band, t + 0.2);
      for (const { source } of bandSources) {
        try {
          source.stop(t + 0.15);
        } catch {
          /* already ended */
        }
      }
      bandSources = [];
      chordNow = null;
    },
    position() {
      // what is sounding now, for the display
      let s = slot,
        t = time;
      for (let n = 0; n < total && t > ctx.currentTime; n++) {
        s = (s - 1 + total) % total;
        t -= lengthAt(s);
      }
      const { chord, key, rest } = chordAt(progs[0].data, s);
      return {
        progression: progs[0].name,
        bar: Math.floor(s / 8) + 1,
        bars: total / 8,
        kind: opt.kind || kindAt(progs[0].form, Math.floor(s / 8)),
        chord: rest ? "—" : chordName(chord, key),
        key: `${key.tonic} ${key.scale}`,
      };
    },
    // The time of the bar line `bars` bars after the one that sounded last (at the speed of now).
    barLine(bars) {
      let s = slot - (slot % 8),
        t = time - (slot % 8) * lengthAt(s); // the bar line of the bar being scheduled
      for (let n = 0; n < total / 8 && t > ctx.currentTime; n++) {
        s = (s - 8 + total) % total;
        t -= 8 * lengthAt(s);
      }
      for (let n = 0; n < bars; n++) {
        t += 8 * lengthAt(s);
        s = (s + 8) % total;
      }
      return t;
    },
    slotTimes,
    busy: () => !!job || queue.length > 0,
    log,
    played,
    work,
    slotSeconds: () => slotDur,
  };
}
