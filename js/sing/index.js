// The song of the site: the one voice (ED D-65) and the sentences the reader hands to it
// (SPEC_sing §6.7, replaced by SPEC_dopa v3 §6.2; 歌 ED D-33). From here the reader gets, for each
// sung sentence, the spans that light its characters and the times of its slots. The accompaniment
// is the Day Life score (SPEC_dopa v3.9 §6.11; ED D-139), so a slot is an eighth note at the
// score's tempo. A sentence has a "score" of its own in the names here (scoreOf, setScorer,
// prepared.score): that is its analysis, { phrases, ... }, not the Day Life score. It comes from
// the browser's analysis (SPEC_dopa v3 §5.5), given by setScorer().
import * as bank from "./bank.js";
import { barsOf } from "./bars.js";
import { create, SLOT } from "./conductor.js";
import * as progress from "../loading.js";
import * as instruments from "./instruments.js";
import { loadSong } from "./song.js";

// The 「音楽」 setting at which the accompaniment plays at the gain 1: the mix of PARTS
// (conductor.js).
const DEFAULT_MUSIC = 0.35;
// The highest gain of the accompaniment. Every setting from 0.525 (0.35 × 1.5) up sounds the same.
const LOUDEST_BAND = 1.5;
const KEPT_SENTENCES = 60; // how many prepared sentences are kept

let context = null, // the AudioContext of the song: its own, at the bank's rate (SD-S07)
  conductor = null, // the song clock, while 「歌う」 runs
  starting = null, // the promise of start(), while it is under way
  held = false, // paused by the reader: the song stands still
  musicSetting = DEFAULT_MUSIC,
  // A spoken paragraph is being read over the song (`underSpeech` in bandLevels and setMusic). In
  // the site nothing sets it: main.js calls setMusic with the setting alone.
  quiet = false;
const prepared = new Map(); // the text of a sentence -> Promise of { text, bars, score }
const MOST_SUNG_MORAE = 60; // of the bank's list of morae by how often they are sung
// The most sung morae, whose sheets are fetched ahead so that later sentences do not wait.
// They are fetched only when the first sentence has its own sheets: fetched at the start, they
// took the network from it and the first wait was several times as long (ED W-07).
let mostSung = null;
let scoreOf = null; // text -> Promise of { phrases, ... }, from the reader

/** Where scores come from: `fn(text)` resolves to { phrases } (SPEC_sing §5.2) and may carry more
 * (the targets of SPEC_dopa v3 §5.6), which prepare() passes on. */
export function setScorer(fn) {
  scoreOf = fn;
  prepared.clear();
}

/** Each sung sentence as it starts: { text, t0, bars (how many), slot (the length of a slot then,
 * in seconds) } and, once it has ended, its `end` and its `spans` (lightSpans). For the checks of
 * SC-S05 and SC-S10; the last 200 are kept. */
export const trace = [];

/** The level of the accompaniment (every part of the score, the drums too) for a 「音楽」 setting
 * (0 to 1): its own level at the setting's default, in proportion below it, at most 1.5 above;
 * half of that while a spoken paragraph is read over the song (Q-22). */
export function bandLevels(setting, underSpeech = false) {
  const level = Math.min(LOUDEST_BAND, setting / DEFAULT_MUSIC) * (underSpeech ? 0.5 : 1);
  return { band: level };
}

/**
 * The spans that light a sung sentence, as the reader's light takes them from a spoken clip:
 * { t, dur, start, end } for each sung mora, `t` in seconds from the sentence's bar line and
 * `start`, `end` the mora's characters in the sentence's speech string. The bars of a sentence
 * are scheduled one by one; while some are still to come, a last span that never starts keeps
 * the light from taking the sentence for finished.
 */
export function lightSpans(job) {
  if (job.t0 === undefined) return [];
  const spans = job.events.map((sung) => ({
    t: sung.t - job.t0,
    dur: 0,
    start: sung.start,
    end: sung.end,
  }));
  if (job.next < job.bars.length) spans.push({ t: Infinity, dur: 0, start: 0, end: 0 });
  return spans;
}

/** Whether the voice files could not be loaded, so the song goes on without a voice (D-87). */
export const voiceMissing = () => bank.isMissing();

/** Whether the song is running. */
export const running = () => !!conductor;

/** Start the song (once): load what it is made of and the sounds, and start the clock. `settings`
 * are the reader's ({ speed, music, voice }). Rejects when a file of the Day Life score cannot be
 * fetched (song.js). Without the voice bank or the instruments the song still starts (D-87). */
export function start(settings) {
  if (conductor) return Promise.resolve();
  if (!starting) {
    starting = (async () => {
      if (!context) context = new AudioContext({ sampleRate: 24000 });
      const song = await loadSong();
      const index = await bank.init(context);
      await instruments.init(context);
      await instruments.ensure();
      musicSetting = settings.music;
      conductor = create(context, context.destination, song, {
        speed: settings.speed,
        voice: settings.voice ?? 1,
        ...bandLevels(musicSetting, quiet),
      });
      conductor.start();
      if (new URLSearchParams(globalThis.location?.search || "").has("singPerf")) showPerf();
      // fetched once the first sentence has its own sheets
      mostSung = index.frequent.slice(0, MOST_SUNG_MORAE);
    })().finally(() => (starting = null));
  }
  return starting;
}

/** Stop the song: voice and accompaniment. */
export function stop() {
  if (!conductor) return;
  conductor.stop();
  conductor = null;
}

/** Whether the browser lets the song sound (before the user's first click it may not). When the
 * context is not running and the song is not held, this first asks it to resume and waits up to
 * 300 ms for that. */
export async function unlocked() {
  if (!context) return false;
  if (context.state !== "running" && !held)
    await Promise.race([context.resume(), new Promise((resolve) => setTimeout(resolve, 300))]);
  return context.state === "running";
}

/** Have a sentence ready to be sung: its bars, and the sheets of its morae in memory. A sentence
 * is prepared once while it is among the 60 prepared last: asked for again, it is answered from
 * those, and its sheets are not asked of the bank again. The sheets asked for are counted as the
 * group "voice" for the charging display (SPEC_dopa §6.2a). Call after start(). */
export function prepare(text) {
  if (!prepared.has(text)) {
    const request = scoreOf(text).then(async (score) => {
      const bars = barsOf(score.phrases);
      await bank.ensure(
        bars
          .flat()
          .map((mora) => mora.k)
          .concat("ン"), // ン: the ん tails (歌 ED D-31), which the site's analysis no longer sends
        (arrived, of) => progress.count("voice", arrived, of),
      );
      if (mostSung) {
        bank.ensure(mostSung).catch(() => {});
        mostSung = null;
      }
      return { text, bars, score };
    });
    request.catch(() => prepared.delete(text));
    prepared.set(text, request);
    if (prepared.size > KEPT_SENTENCES) prepared.delete(prepared.keys().next().value);
  }
  return prepared.get(text);
}

/**
 * Hand a prepared sentence to the song (call after start()): it starts at the next free bar line,
 * after the sentences handed over before it. `onStart(job)` is called at its bar line and
 * `onEnd(job)` at the end of its last bar; for a sentence with nothing to sing, both at its bar
 * line; for one that the song had to drop, `onEnd` alone can come. Neither comes after clear()
 * or stop() took the sentence back. Returns the job; `lightSpans(job)` and `secondsInto(job)`
 * follow it.
 */
export function enqueue(sentence, { onStart, onEnd } = {}) {
  const job = {
    text: sentence.text,
    bars: sentence.bars,
    score: sentence.score,
    onStart: (started) => {
      trace.push({
        text: started.text,
        t0: started.t0,
        bars: started.bars.length,
        slot: conductor ? conductor.slotSeconds() : null,
      });
      if (trace.length > 200) trace.shift();
      onStart && onStart(started);
    },
    onEnd: (ended) => {
      const noted = trace.findLast((entry) => entry.t0 === ended.t0);
      if (noted) Object.assign(noted, { end: ended.end, spans: lightSpans(ended) });
      onEnd && onEnd(ended);
    },
  };
  conductor.enqueue(job);
  return job;
}

/** How long a sentence has been sung, in seconds from its bar line; negative before it starts
 * (-1 while the song has not yet placed it). */
export const secondsInto = (job) => (job.t0 === undefined ? -1 : context.currentTime - job.t0);

/** Take back every sentence handed over: the one being sung stops, the song goes on (ST-09). */
export function clear() {
  if (conductor) conductor.clear();
}

/** Hold the song still (a pause, an open drawer), or let it go on from the same point (ST-08). */
export function hold(on) {
  held = on;
  if (!context) return;
  if (on) context.suspend();
  else context.resume();
}

/** The user moved 「歌」: the level of the voice alone, 0 to 1 (ED D-114). */
export function setVoice(level) {
  if (conductor) conductor.setLevels({ voice: level });
}

/** The owner moved 「速さ」: the tempo follows at the next bar line (D-23). */
export function setSpeed(speed) {
  if (conductor) conductor.setSpeed(speed);
}

/** The owner moved 「音楽」, or a spoken paragraph starts or ends over the song. */
export function setMusic(setting, underSpeech = quiet) {
  musicSetting = setting;
  quiet = underSpeech;
  if (conductor) conductor.setLevels(bandLevels(musicSetting, quiet));
}

/**
 * What the song costs this machine (SC-S07): the scheduler's calls, its mean and worst work in
 * ms, how often it was behind the clock, the decoded sheets in megabytes, and, where the browser
 * tells it, for how many seconds the sound card was fed silence because the page was late.
 */
export function perf() {
  const work = conductor
    ? conductor.work
    : { calls: 0, totalMs: 0, worstMs: 0, over5ms: 0, behind: 0 };
  const megabytes = (bytes) => Math.round(bytes / 1e5) / 10;
  return {
    calls: work.calls,
    meanMs: work.calls ? work.totalMs / work.calls : 0,
    worstMs: work.worstMs,
    over5ms: work.over5ms,
    behind: work.behind,
    voiceSheets: bank.loaded(),
    voiceMegabytes: megabytes(bank.bytes()),
    instrumentMegabytes: megabytes(instruments.bytes()),
    underrunSeconds: context?.playoutStats
      ? context.playoutStats.fallbackFramesDuration / 1000
      : null,
  };
}

/** With ?singPerf=1 in the address: the numbers of perf() in a corner of the page, once a second. */
function showPerf() {
  const corner = Object.assign(document.createElement("pre"), { id: "sing-perf" });
  corner.style.cssText =
    "position:fixed;left:8px;bottom:8px;z-index:99;margin:0;font:12px/1.4 monospace;color:#fff;background:rgba(0,0,0,.6);padding:4px 8px;pointer-events:none";
  document.body.append(corner);
  setInterval(() => {
    const stats = perf();
    corner.textContent =
      `scheduler ${stats.calls} calls, mean ${stats.meanMs.toFixed(2)} ms, worst ${stats.worstMs.toFixed(1)} ms, ${stats.over5ms} over 5 ms, behind ${stats.behind}\n` +
      `sheets ${stats.voiceSheets} = ${stats.voiceMegabytes} MB, instruments ${stats.instrumentMegabytes} MB` +
      (stats.underrunSeconds === null ? "" : `, underrun ${stats.underrunSeconds.toFixed(2)} s`);
  }, 1000);
}

/** Seconds from now to the bar line `bars` bars after the one that sounded last. Call after
 * start(). */
export const secondsToBarLine = (bars) => conductor.barLine(bars) - context.currentTime;

/** What the song is doing, for checks: { running, held, quiet, state }, `state` being the
 * AudioContext's ("running", "suspended") or null before there is one. */
export const condition = () => ({
  running: !!conductor,
  held,
  quiet,
  state: context ? context.state : null,
});

/** The song's clock, in seconds. */
export const now = () => (context ? context.currentTime : 0);

/** The song's AudioContext (for the time the user hears, SD-W10, and for the effects, SD-W12). */
export const audioContext = () => context;

/** The length, in seconds, of the slot scheduled last: up to 0.3 s ahead of what sounds. It
 * follows the score's tempo map. */
export const slotSeconds = () => (conductor ? conductor.slotSeconds() : SLOT);

/**
 * The times of the slots of a sentence handed to the song, on the song's clock: entry k is when
 * its slot k starts (slot k of bar b is entry 8b + k) and the last entry is the end of its last
 * bar. The score's tempo changes between bars, so these are not t0 + k × slot. A sentence not
 * yet started is placed after `before`, the started sentence it follows. null when the song is not
 * running or the sentence cannot be placed yet.
 */
export const slotTimes = (job, before = null) =>
  conductor ? conductor.slotTimes(job, before) : null;

/** The AudioContext, made at once (a phone needs it made and resumed inside a tap). */
export function ensureContext() {
  if (!context) context = new AudioContext({ sampleRate: 24000 });
  return context;
}
