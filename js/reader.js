// The reading loop of the site (SPEC_dopa v3 §6.2; ED D-52, D-102, D-103, D-107, ST-13, ST-14,
// ST-18, ST-19, ST-32, ST-35). It replaces the sung path of the old player: the next sentence is
// handed to the song while the current one is sung, and the song calls takeOver() at its bar line,
// so that no bar of waiting falls between sentences (sing D-33). A figure stands for 2 bars of
// accompaniment; a chapter ends with the boss, the explosion of the count and the clear card; the
// next chapter starts with the launch.
import * as sing from "./sing/index.js";
import * as cockpit from "./cockpit/cockpit.js";
import { windowsOf } from "./cockpit/fire.js";
import * as prefs from "./store/prefs.js";
import { fill, S } from "./strings.js";

const BOSS_HP = 5; // D-102
const FIGURE_BARS = 2; // sing ST-11

let book = null,
  analyzer = null,
  hooks = {},
  token = 0,
  playing = false,
  at = { block: 0, sentence: 0 },
  current = null, // { place, job, sentence, targets } being sung
  next = null, // the same, handed over ahead
  previous = null, // the sentence before, for the 0.4 s after its last noun
  stats = { chars: 0, sentences: 0, blocks: 0 },
  chapterOf = [],
  lastBlockOf = [], // the last text block of each chapter
  blockTargets = new Map(), // block index -> Promise of [{ id, label, sentence, start, end, display }]
  busy = false; // a launch, a clear card or a figure is on: presses do not fire

/** `opts`: { analyzer, onBookEnd(), onState({ playing }), onNotice(text) }. */
export function init(opts) {
  analyzer = opts.analyzer;
  hooks = opts;
  sing.setScorer((text) => scoreOf(text));
  cockpit.init({
    windows,
    audio: () => sing.audioContext(),
    onCount: (count) => prefs.setCount(count),
    sfx: opts.sfx,
    onStageTap: (event) => press(event),
  });
  requestAnimationFrame(lightLoop);
}

/** The score of a sentence for the song. English (and any text without Japanese) is not voiced
 * yet (ED ST-34): its characters go over silent slots (「ッ」) at the song's pace. */
async function scoreOf(text) {
  if (!/[぀-ヿ㐀-鿿]/.test(text) && /[A-Za-z]/.test(text)) {
    const morae = [];
    for (let i = 0; i < text.length; i += 4) morae.push({ k: "ッ", start: i, end: Math.min(text.length, i + 4), tails: [] });
    return { phrases: [{ pause: true, morae }], targets: [] };
  }
  return analyzer.analyze(text);
}

// ---------------------------------------------------------------- opening and moving
/** Open a book at its kept place (or the start) and read: the launch of its chapter first. */
export async function open(opened) {
  book = opened;
  token++;
  sing.clear();
  blockTargets.clear();
  current = next = previous = null;
  chapterOf = [];
  lastBlockOf = [];
  book.chapters.forEach((chapter, c) => {
    const end = c + 1 < book.chapters.length ? book.chapters[c + 1].firstBlock : book.blocks.length;
    for (let b = chapter.firstBlock; b < end; b++) chapterOf[b] = c;
    let last = -1;
    for (let b = chapter.firstBlock; b < end; b++) if (book.blocks[b].kind !== "figure") last = b;
    lastBlockOf[c] = last;
  });
  for (let b = 0; b < book.blocks.length; b++) if (chapterOf[b] === undefined) chapterOf[b] = 0;
  const kept = prefs.position(book.key);
  at = kept && kept.block < book.blocks.length ? { block: kept.block, sentence: kept.sentence || 0 } : { block: 0, sentence: 0 };
  stats = { chars: (kept && kept.chars) || 0, sentences: (kept && kept.sentences) || 0, blocks: (kept && kept.blocks) || 0 };
  hooks.onChars && hooks.onChars(stats.chars);
  cockpit.clearRoad();
  await startChapter(chapterOf[at.block]);
}

async function startChapter(c) {
  const mine = ++token;
  busy = true;
  cockpit.setSinging(false);
  const chapter = book.chapters[c] || { title: book.title };
  sing
    .start(prefs.settings())
    .then(() => sing.voiceMissing() && hooks.onNotice && hooks.onNotice(S.songFailed)) // ST-33, D-87
    .catch(() => hooks.onNotice && hooks.onNotice(S.songFailed));
  hooks.onAnnounce && hooks.onAnnounce(chapter.title || book.title); // titles are announced (ED-10)
  await cockpit.launch(chapter.title || book.title, S.launch); // ST-13, D-103
  if (mine !== token) return;
  busy = false;
  playing = true;
  hooks.onState && hooks.onState({ playing });
  startAt(at);
}

/** Jump to a block (「ブロックを指定」, 「目次」): what was handed to the song is taken back, the
 * road is cleared, and reading starts there at the next bar line. */
export function jump(blockIndex) {
  token++;
  sing.clear();
  cockpit.clearRoad();
  cockpit.hideMonitor();
  current = next = previous = null;
  at = { block: Math.max(0, Math.min(book.blocks.length - 1, blockIndex)), sentence: 0 };
  save();
  if (playing) startAt(at, { jumped: true });
}

// ---------------------------------------------------------------- playing and holding
/** 「▶ 再生」, or the gear lever pulled forward (ST-37, D-127): go on from the same point. */
export function play() {
  if (!book) return;
  if (cockpit.blastBusy()) cockpit.shortenBlast(); // ST-32
  cockpit.setLever(false);
  cockpit.setStopped(false);
  playing = true;
  sing.hold(false);
  cockpit.hold(false);
  cockpit.setSinging(true);
  hooks.onState && hooks.onState({ playing });
  if (!current && !busy) startAt(at);
}
/** 「⏸ 一時停止」: everything stops where it is, the count is kept, nothing explodes (ST-18). */
export function pause() {
  playing = false;
  sing.hold(true);
  cockpit.hold(true); // the battle freezes where it is (ST-18)
  cockpit.setSinging(false);
  hooks.onState && hooks.onState({ playing });
}
/** A drawer or the book list holds the song too; the cockpit's clock stops for a drawer. */
export function hold(on) {
  if (on) {
    sing.hold(true);
    cockpit.hold(true);
    save();
  } else if (playing) {
    sing.hold(false);
    cockpit.hold(false);
  } else cockpit.hold(false);
}
/** The gear lever pushed back (ST-32, D-127, D-128): the song stops within 0.1 s, the road
 * stops, and the explosion of the count plays and reaches the robots on the road. */
export function explode() {
  if (!book || busy) return null;
  playing = false;
  sing.hold(true);
  cockpit.hold(false); // the explosion and the robots keep moving
  cockpit.setSinging(false);
  cockpit.setStopped(true);
  cockpit.setLever(true);
  hooks.onState && hooks.onState({ playing });
  return cockpit.explode({ road: true });
}
/** A tap on the gear lever: back sets the explosion off, forward goes on (D-126, D-127). */
export function toggleLever() {
  if (!book || busy) return;
  if (cockpit.lever()) play();
  else explode();
}
export const isPlaying = () => playing;

/** A press of 「発射」 or of the stage (D-61, D-100). */
export function press(event) {
  if (!book || busy) return;
  // a tap while stopped starts the song again, with the lever forward (ST-37, D-134); it does not fire
  if (!playing) return play();
  cockpit.press(event.timeStamp);
}

// ---------------------------------------------------------------- the chain of sung sentences
/** Start reading at a place: a figure stands, a heading is sung with the section opener, a text
 * sentence is sung from the next bar line. */
async function startAt(place, { jumped = false } = {}) {
  const mine = ++token;
  const blockIndex = place.block,
    block = book.blocks[blockIndex];
  if (!block) return bookEnd();
  if (block.kind === "figure") return showFigure(blockIndex, mine);
  if (!block.sentences.length) return advanceFrom({ block: blockIndex, sentence: 0 }, mine, true);
  let prepared;
  try {
    await sing.start(prefs.settings());
    if (!(await sing.unlocked())) await sing.unlocked();
    prepared = await prepare(place);
  } catch (error) {
    console.warn(`the song cannot start: ${error}`);
    hooks.onNotice && hooks.onNotice(S.songFailed);
    return;
  }
  if (mine !== token || !prepared) return;
  const entry = { place, sentence: prepared.sentence, targets: prepared.targets, jumped };
  entry.job = sing.enqueue(prepared.sung, {
    onStart: () => takeOver(mine, entry),
    onEnd: () => ended(mine, entry),
  });
}

async function prepare(place) {
  const block = book.blocks[place.block],
    sentence = block.sentences[place.sentence];
  if (!sentence) return null;
  const notice = setTimeout(() => hooks.onNotice && hooks.onNotice(S.songLoading), 600); // D-113
  try {
    const sung = await sing.prepare(sentence.speech);
    const all = await targetsOf(place.block);
    return { sung, sentence, targets: all.filter((target) => target.sentence === place.sentence) };
  } finally {
    clearTimeout(notice);
    hooks.onNotice && hooks.onNotice(null, S.songLoading);
  }
}

/** The targets of a block (§5.6), with ids, their sentence, their speech span and their display
 * span and text (the shout and the sign use the display text, §5.6 step 3). */
function targetsOf(blockIndex) {
  if (!blockTargets.has(blockIndex)) {
    const block = book.blocks[blockIndex];
    const request = Promise.all(
      block.sentences.map(async (sentence, s) => {
        let analysis;
        try {
          analysis = await scoreOf(sentence.speech);
        } catch {
          return [];
        }
        return (analysis.targets || []).map((target, k) => {
          const display = toDisplay(sentence, target.start, target.end);
          return {
            id: `${blockIndex}:${s}:${k}`,
            sentence: s,
            start: target.start,
            end: target.end,
            display,
            label: sentence.display.slice(display.start, display.end) || target.text,
          };
        });
      }),
    ).then((lists) => lists.flat());
    blockTargets.set(blockIndex, request);
    if (blockTargets.size > 8) blockTargets.delete(blockTargets.keys().next().value);
  }
  return blockTargets.get(blockIndex);
}

const speechToDisplay = (sentence, i) => (sentence.map ? (i >= sentence.map.length ? sentence.display.length : sentence.map[i]) : Math.min(i, sentence.display.length));
function toDisplay(sentence, start, end) {
  const from = speechToDisplay(sentence, start),
    to = end > 0 ? speechToDisplay(sentence, end - 1) + 1 : from;
  return { start: from, end: Math.max(from, to) };
}

/** The song reached the bar line of a sentence: reading moves to it. */
async function takeOver(mine, entry) {
  if (mine !== token && entry !== next) return;
  const newBlock = !current || current.place.block !== entry.place.block;
  previous = current;
  current = entry;
  next = null;
  at = { ...entry.place };
  cockpit.setSinging(playing);
  // the words that can be targets are blue from the start (D-124)
  cockpit.sentence(entry.sentence.display, book.blocks[at.block].lang, entry.targets.map((t) => t.display));
  // without a voice the caption is the live text, one sentence at a time (PR-02, PR-12)
  if (sing.voiceMissing() && hooks.onLive) hooks.onLive(entry.sentence.display);
  if (newBlock) {
    const block = book.blocks[at.block];
    if (block.kind === "heading") cockpit.section(entry.sentence.display, S.launch); // ST-12
    const targets = await targetsOf(at.block);
    if (current !== entry) return;
    const c = chapterOf[at.block],
      bossBlock = at.block === lastBlockOf[c] && !entry.jumped;
    let bossHp = null;
    if (bossBlock && targets.length) {
      const kept = prefs.position(book.key);
      bossHp = kept && kept.bossHp ? kept.bossHp : Math.min(BOSS_HP, targets.length);
    }
    cockpit.block(targets.map(({ id, label }) => ({ id, label })), bossHp);
  }
  save();
  queueNext(token);
}

/** Hand the following sentence to the song now, if the song can go straight on into it: the
 * next sentence of the block, or the first of the next text block of the same chapter. */
async function queueNext(mine) {
  const place = nextPlace(current.place);
  if (!place) return;
  let prepared;
  try {
    prepared = await prepare(place);
  } catch {
    return;
  }
  if (!prepared || !current || nextPlace(current.place)?.block !== place.block || nextPlace(current.place)?.sentence !== place.sentence) return;
  const entry = { place, sentence: prepared.sentence, targets: prepared.targets };
  next = entry;
  const turn = token;
  entry.job = sing.enqueue(prepared.sung, {
    onStart: () => takeOver(turn, entry),
    onEnd: () => ended(turn, entry),
  });
}

function nextPlace(place) {
  const block = book.blocks[place.block];
  if (place.sentence + 1 < block.sentences.length) return { block: place.block, sentence: place.sentence + 1 };
  const following = book.blocks[place.block + 1];
  if (!following || chapterOf[place.block + 1] !== chapterOf[place.block]) return null;
  if (following.kind === "figure" || !following.sentences.length) return null;
  return { block: place.block + 1, sentence: 0 };
}

/** The end of a sentence's last bar: it counts as read; a block that ends sends its enemies away. */
function ended(mine, entry) {
  stats.chars += entry.sentence.display.length;
  stats.sentences += 1;
  hooks.onChars && hooks.onChars(stats.chars);
  const block = book.blocks[entry.place.block],
    lastInBlock = entry.place.sentence === block.sentences.length - 1;
  if (lastInBlock) {
    stats.blocks += 1;
    if (!isBossBlockEnd(entry.place.block)) cockpit.blockEnd(); // ST-30
  }
  save();
  if (next || entry !== current) return; // the song goes straight on
  advanceFrom(entry.place, token);
}

const isBossBlockEnd = (blockIndex) => blockIndex === lastBlockOf[chapterOf[blockIndex]];

/** Nothing was handed over ahead: a figure, a chapter's end or the book's end comes next. */
function advanceFrom(place, mine, skipEmpty = false) {
  const block = book.blocks[place.block];
  if (!skipEmpty && place.sentence + 1 < block.sentences.length) return startAt({ block: place.block, sentence: place.sentence + 1 });
  const following = place.block + 1;
  if (following >= book.blocks.length) return chapterEnd(chapterOf[place.block], true);
  if (chapterOf[following] !== chapterOf[place.block]) return chapterEnd(chapterOf[place.block], false);
  at = { block: following, sentence: 0 };
  current = null;
  if (playing) startAt(at);
}

/** A figure block (ST-19): it stands for 2 bars of accompaniment, then reading goes on. */
async function showFigure(blockIndex, mine) {
  const fig = book.blocks[blockIndex].figure;
  busy = true;
  cockpit.clearCaption();
  const label = fig.label || "";
  const line = fig.page ? fill(S.figureLine, { label, page: fig.page }) : fill(S.figureLineNoPage, { label });
  if (fig.kind === "pdfPage" && hooks.renderPdfPage) {
    const rendered = await hooks.renderPdfPage(book, fig.page).catch(() => null);
    if (rendered) await cockpit.figure({ kind: "canvas", canvas: rendered }, line);
  } else await cockpit.figure(fig, line);
  const wait = sing.running() ? Math.max(1, sing.secondsToBarLine(FIGURE_BARS) - 0.6) : 4;
  await new Promise((resolve) => setTimeout(resolve, wait * 1000));
  if (mine !== token) return;
  cockpit.hideMonitor();
  busy = false;
  current = null;
  advanceFrom({ block: blockIndex, sentence: 0 }, mine, true);
}

/** The chapter's end (ST-14, D-102, D-103): the explosion of the count, which also strikes a boss
 * still standing; the clear card; then the next chapter's launch, or the book's end. */
async function chapterEnd(c, lastChapter) {
  const mine = ++token;
  busy = true;
  current = next = previous = null;
  cockpit.setSinging(false);
  const { blast, bossLeft } = cockpit.chapterBlast(lastChapter);
  prefs.setPosition(book.key, { bossHp: bossLeft });
  await new Promise((resolve) => setTimeout(resolve, ((blast ? blast.seconds : 0) + 0.8) * 1000));
  cockpit.blockEnd();
  if (mine !== token) return;
  const chapter = book.chapters[c] || {},
    title = chapter.title ? fill(S.clearNamed, { name: chapter.title }) : fill(S.clearNumbered, { n: c + 1 });
  hooks.sfx && hooks.sfx("fanfare");
  hooks.onAnnounce && hooks.onAnnounce(title);
  await cockpit.card([[title, true], [fill(S.totals, { c: stats.chars, s: stats.sentences, p: stats.blocks }), false]], 5);
  if (mine !== token) return;
  busy = false;
  if (lastChapter || c + 1 >= book.chapters.length) return bookEnd();
  at = { block: book.chapters[c + 1].firstBlock, sentence: 0 };
  save();
  await startChapter(c + 1);
}

/** The book's end (A-38): 「読了！」 with the totals and the fanfare, then the book list. */
async function bookEnd() {
  busy = true;
  playing = false;
  hooks.sfx && hooks.sfx("fanfare");
  hooks.onAnnounce && hooks.onAnnounce(S.bookEnd);
  await cockpit.card([[S.bookEnd, true], [fill(S.totals, { c: stats.chars, s: stats.sentences, p: stats.blocks }), false]], 6);
  busy = false;
  at = { block: 0, sentence: 0 };
  save();
  hooks.onBookEnd && hooks.onBookEnd();
}

function save() {
  if (!book) return;
  prefs.setPosition(book.key, { block: at.block, sentence: at.sentence, chars: stats.chars, sentences: stats.sentences, blocks: stats.blocks });
}

// ---------------------------------------------------------------- the light and the windows
/** The sung morae of an entry, on the song's clock: slot k of bar b is the sentence's slot 8b + k
 * (sing D-20: the sung slots of a bar come first), at the time the song gives it (the score's tempo
 * changes between bars, SPEC_dopa v3.9 §6.11). `dur` is the slot's length. A sentence handed over
 * ahead starts where the one before it ends (sing D-33). [] while it cannot be placed. */
function moraTimes(entry) {
  const times = slotTimesOf(entry),
    list = [];
  if (!times) return list;
  entry.job.bars.forEach((bar, b) =>
    bar.forEach((mora, k) => {
      const at = 8 * b + k;
      list.push({ t: times[at], dur: times[at + 1] - times[at], start: mora.start, end: mora.end });
    }),
  );
  return list;
}
function slotTimesOf(entry) {
  if (entry.job.t0 !== undefined) return sing.slotTimes(entry.job);
  if (entry === next && current && current.job.t0 !== undefined) return sing.slotTimes(entry.job, current.job);
  return null;
}

/** The windows of the sentences that can be hit now: the one before (its last 0.4 s), the one
 * being sung and the one handed over ahead (§5.6 step 4). */
function windows() {
  const list = [];
  for (const entry of [previous, current, next]) {
    if (!entry || !entry.targets.length) continue;
    const morae = moraTimes(entry);
    if (!morae.length) continue;
    const found = windowsOf(entry.targets, morae, sing.slotSeconds());
    for (const window of found) {
      const target = entry.targets.find((one) => one.id === window.id);
      list.push({ ...window, label: target.label, display: entry === current ? target.display : null });
    }
  }
  return list;
}

/** The light of the caption follows the sung morae (ST-04). */
function lightLoop() {
  requestAnimationFrame(lightLoop);
  if (!current || current.job.t0 === undefined) return;
  const now = sing.now() - ((sing.audioContext() && sing.audioContext().outputLatency) || 0),
    sentence = current.sentence;
  let lit = 0,
    position = 0; // where the song is, in display characters, fractional (D-132)
  for (const mora of moraTimes(current))
    if (mora.t <= now) {
      lit = Math.max(lit, speechToDisplay(sentence, mora.end));
      const from = speechToDisplay(sentence, mora.start),
        to = speechToDisplay(sentence, mora.end);
      position = Math.max(position, from + (to - from) * Math.min(1, (now - mora.t) / mora.dur));
    }
  if (current.job.end !== undefined && now >= current.job.end) lit = position = sentence.display.length;
  cockpit.light(lit, position);
}

/** For checks. */
export const debug = () => ({ at, playing, busy, stats: { ...stats }, current: current && current.place, next: next && next.place, windows: windows() });
