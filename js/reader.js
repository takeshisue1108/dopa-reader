// The reading loop of the site (SPEC_dopa v3 §6.2; ED D-52, D-102, D-103, D-107, ST-13, ST-14,
// ST-18, ST-19, ST-32, ST-35). It replaces the sung path of the old player: the next sentence is
// handed to the song while the current one is sung, and the song calls takeOver() at its bar line,
// so that no bar of waiting falls between sentences (sing D-33). A figure stands for 2 bars of
// accompaniment; a chapter ends with the boss, the explosion of the count and the clear card; the
// next chapter starts with the launch.
import * as sing from "./sing/index.js";
import * as cockpit from "./cockpit/cockpit.js";
import { windowsOf } from "./cockpit/fire.js";
import { indexChapters, nextPlace, speechToDisplay, toDisplay } from "./places.js";
import * as prefs from "./store/prefs.js";
import { fill, S } from "./strings.js";

const BOSS_HP = 5; // D-102
const FIGURE_BARS = 2; // sing ST-11

let book = null,
  analyzer = null,
  hooks = {},
  turn = 0, // a start, a jump or a chapter's end begins a new turn; work of an earlier turn that
  // comes back late (a prepared sentence, a figure's wait) finds turn changed and is dropped
  playing = false,
  readingAt = { block: 0, sentence: 0 }, // the place being read; it is what save() keeps
  current = null, // { place, job, sentence, targets } being sung
  next = null, // the same, handed over ahead
  previous = null, // the sentence before, for the 0.4 s after its last noun
  stats = { chars: 0, sentences: 0, blocks: 0 },
  chapterOf = [],
  lastBlockOf = [], // the last text block of each chapter
  blockTargets = new Map(), // block index -> Promise of [{ id, label, sentence, start, end, display }]
  frozen = false, // stopped by ⏸: the battle stays frozen when a drawer closes (D-143)
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
    for (let i = 0; i < text.length; i += 4)
      morae.push({ k: "ッ", start: i, end: Math.min(text.length, i + 4), tails: [] });
    return { phrases: [{ pause: true, morae }], targets: [] };
  }
  return analyzer.analyze(text);
}

// ---------------------------------------------------------------- opening and moving
/** Open a book at its kept place (or the start) and read: the launch of its chapter first. */
export async function open(opened) {
  book = opened;
  turn++;
  sing.clear();
  blockTargets.clear();
  current = next = previous = null;
  // a new book starts going: every hold of the book before is released, the lever is up (D-143)
  frozen = false;
  sing.hold(false);
  cockpit.hold(false);
  cockpit.setStopped(false);
  cockpit.setLever(false);
  ({ chapterOf, lastBlockOf } = indexChapters(book));
  const kept = prefs.position(book.key);
  readingAt =
    kept && kept.block < book.blocks.length
      ? { block: kept.block, sentence: kept.sentence || 0 }
      : { block: 0, sentence: 0 };
  stats = {
    chars: (kept && kept.chars) || 0,
    sentences: (kept && kept.sentences) || 0,
    blocks: (kept && kept.blocks) || 0,
  };
  hooks.onChars && hooks.onChars(stats.chars);
  cockpit.clearRoad();
  await startChapter(chapterOf[readingAt.block]);
}

async function startChapter(chapterIndex) {
  const myTurn = ++turn;
  busy = true;
  cockpit.setSinging(false);
  const chapter = book.chapters[chapterIndex] || { title: book.title };
  sing
    .start(prefs.settings())
    .then(() => sing.voiceMissing() && hooks.onNotice && hooks.onNotice(S.songFailed)) // ST-33, D-87
    .catch(() => hooks.onNotice && hooks.onNotice(S.songFailed));
  hooks.onAnnounce && hooks.onAnnounce(chapter.title || book.title); // titles are announced (ED-10)
  await cockpit.launch(chapter.title || book.title, S.launch); // ST-13, D-103
  if (myTurn !== turn) return;
  busy = false;
  playing = true;
  hooks.onState && hooks.onState({ playing });
  startAt(readingAt);
}

/** Jump to a block (「ブロックを指定」, 「目次」): what was handed to the song is taken back, the
 * road is cleared, and reading starts there at the next bar line. */
export function jump(blockIndex) {
  turn++;
  sing.clear();
  cockpit.clearRoad();
  cockpit.hideMonitor();
  current = next = previous = null;
  readingAt = { block: Math.max(0, Math.min(book.blocks.length - 1, blockIndex)), sentence: 0 };
  save();
  if (playing) startAt(readingAt, { jumped: true });
}

// ---------------------------------------------------------------- playing and holding
/** 「▶ 再生」, or the gear lever moved up (ST-37, D-145): go on from the same point. Nothing else
 * starts a stopped song (D-143). */
export function play() {
  if (!book) return;
  frozen = false;
  if (cockpit.blastBusy()) cockpit.shortenBlast(); // ST-32
  cockpit.setLever(false);
  cockpit.setStopped(false);
  playing = true;
  sing.hold(false);
  cockpit.hold(false);
  cockpit.setSinging(true);
  hooks.onState && hooks.onState({ playing });
  if (!current && !busy) startAt(readingAt);
}
/** 「⏸ 一時停止」: everything stops where it is, the count is kept, nothing explodes (ST-18). */
export function pause() {
  playing = false;
  frozen = true;
  sing.hold(true);
  cockpit.hold(true); // the battle freezes where it is (ST-18)
  cockpit.setSinging(false);
  hooks.onState && hooks.onState({ playing });
}
/** A drawer or the book list holds the song and the cockpit's clock while it is open. Closing it
 * goes on only if the reader was running: a stopped song stays stopped (D-143), and after ⏸ the
 * battle stays frozen too. With the lever down the cockpit's clock runs (its robots still move). */
export function hold(on) {
  if (on) {
    sing.hold(true);
    cockpit.hold(true);
    save();
  } else if (playing) {
    sing.hold(false);
    cockpit.hold(false);
  } else cockpit.hold(frozen);
}
/** The gear lever moved down, or the bomb pressed (ST-32, D-144, D-145, D-128): the song stops
 * within 0.1 s, the road stops, the lever goes down, and the explosion of the count plays and
 * reaches the robots on the road. */
export function explode() {
  if (!book || busy) return null;
  playing = false;
  frozen = false;
  sing.hold(true);
  cockpit.hold(false); // the explosion and the robots keep moving
  cockpit.setSinging(false);
  cockpit.setStopped(true);
  cockpit.setLever(true);
  hooks.onState && hooks.onState({ playing });
  return cockpit.explode({ road: true });
}
/** A tap on the gear lever: down sets the explosion off, up goes on (D-126, D-145). */
export function toggleLever() {
  if (!book || busy) return;
  if (cockpit.lever()) play();
  else explode();
}
/** A press of the bomb's picture (D-144): what the lever moved down does. With the lever down
 * already and nothing counted there is nothing to set off, and nothing happens. */
export function pressBomb() {
  if (!book || busy) return;
  if (cockpit.lever() && cockpit.count() === 0) return;
  explode();
}
export const isPlaying = () => playing;

/** A press of 「発射」 or of the stage (D-61, D-100). While the reader is stopped it does nothing:
 * it does not fire, and it does not start the song (D-143). */
export function press(event) {
  if (!book || busy || !playing) return;
  cockpit.press(event.timeStamp);
}

// ---------------------------------------------------------------- the chain of sung sentences
/** Start reading at a place: a figure stands, a heading is sung with the section opener, a text
 * sentence is sung from the next bar line. */
async function startAt(place, { jumped = false } = {}) {
  const myTurn = ++turn;
  const blockIndex = place.block,
    block = book.blocks[blockIndex];
  if (!block) return bookEnd();
  if (block.kind === "figure") return showFigure(blockIndex, myTurn);
  if (!block.sentences.length) return advanceFrom({ block: blockIndex, sentence: 0 }, myTurn, true);
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
  if (myTurn !== turn || !prepared) return;
  const entry = { place, sentence: prepared.sentence, targets: prepared.targets, jumped };
  entry.job = sing.enqueue(prepared.sung, {
    onStart: () => takeOver(myTurn, entry),
    onEnd: () => ended(myTurn, entry),
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
      block.sentences.map(async (sentence, sentenceIndex) => {
        let analysis;
        try {
          analysis = await scoreOf(sentence.speech);
        } catch {
          return [];
        }
        return (analysis.targets || []).map((target, targetIndex) => {
          const display = toDisplay(sentence, target.start, target.end);
          return {
            id: `${blockIndex}:${sentenceIndex}:${targetIndex}`,
            sentence: sentenceIndex,
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

/** The song reached the bar line of a sentence: reading moves to it. */
async function takeOver(myTurn, entry) {
  if (myTurn !== turn && entry !== next) return;
  const newBlock = !current || current.place.block !== entry.place.block;
  previous = current;
  current = entry;
  next = null;
  readingAt = { ...entry.place };
  cockpit.setSinging(playing);
  // the words that can be targets are blue from the start (D-124)
  cockpit.sentence(
    entry.sentence.display,
    book.blocks[readingAt.block].lang,
    entry.targets.map((target) => target.display),
  );
  // without a voice the caption is the live text, one sentence at a time (PR-02, PR-12)
  if (sing.voiceMissing() && hooks.onLive) hooks.onLive(entry.sentence.display);
  if (newBlock) {
    const block = book.blocks[readingAt.block];
    if (block.kind === "heading") cockpit.section(entry.sentence.display, S.launch); // ST-12
    const targets = await targetsOf(readingAt.block);
    if (current !== entry) return;
    const chapterIndex = chapterOf[readingAt.block],
      isBossBlock = readingAt.block === lastBlockOf[chapterIndex] && !entry.jumped;
    let bossHp = null;
    if (isBossBlock && targets.length) {
      const kept = prefs.position(book.key);
      bossHp = kept && kept.bossHp ? kept.bossHp : Math.min(BOSS_HP, targets.length);
    }
    cockpit.block(
      targets.map(({ id, label }) => ({ id, label })),
      bossHp,
    );
  }
  save();
  queueNext(turn);
}

/** Hand the following sentence to the song now, if the song can go straight on into it: the
 * next sentence of the block, or the first of the next text block of the same chapter. */
async function queueNext(myTurn) {
  const place = nextPlace(book, chapterOf, current.place);
  if (!place) return;
  let prepared;
  try {
    prepared = await prepare(place);
  } catch {
    return;
  }
  // The sentence being sung may have ended while this one was being prepared (a slow network):
  // ended() has then started a new turn, and startAt() hands this same sentence to the song.
  // Handing it over here too would sing it twice, and every sentence after it.
  if (myTurn !== turn) return;
  if (
    !prepared ||
    !current ||
    nextPlace(book, chapterOf, current.place)?.block !== place.block ||
    nextPlace(book, chapterOf, current.place)?.sentence !== place.sentence
  )
    return;
  const entry = { place, sentence: prepared.sentence, targets: prepared.targets };
  next = entry;
  entry.job = sing.enqueue(prepared.sung, {
    onStart: () => takeOver(myTurn, entry),
    onEnd: () => ended(myTurn, entry),
  });
}

/** The end of a sentence's last bar: it counts as read; a block that ends sends its enemies away. */
function ended(myTurn, entry) {
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
  advanceFrom(entry.place, turn);
}

const isBossBlockEnd = (blockIndex) => blockIndex === lastBlockOf[chapterOf[blockIndex]];

/** Nothing was handed over ahead: a figure, a chapter's end or the book's end comes next. */
function advanceFrom(place, myTurn, skipEmpty = false) {
  const block = book.blocks[place.block];
  if (!skipEmpty && place.sentence + 1 < block.sentences.length)
    return startAt({ block: place.block, sentence: place.sentence + 1 });
  const following = place.block + 1;
  if (following >= book.blocks.length) return chapterEnd(chapterOf[place.block], true);
  if (chapterOf[following] !== chapterOf[place.block])
    return chapterEnd(chapterOf[place.block], false);
  readingAt = { block: following, sentence: 0 };
  current = null;
  if (playing) startAt(readingAt);
}

/** A figure block (ST-19): it stands for 2 bars of accompaniment, then reading goes on. */
async function showFigure(blockIndex, myTurn) {
  const figure = book.blocks[blockIndex].figure;
  busy = true;
  cockpit.clearCaption();
  const label = figure.label || "";
  const line = figure.page
    ? fill(S.figureLine, { label, page: figure.page })
    : fill(S.figureLineNoPage, { label });
  if (figure.kind === "pdfPage" && hooks.renderPdfPage) {
    const rendered = await hooks.renderPdfPage(book, figure.page).catch(() => null);
    if (rendered) await cockpit.figure({ kind: "canvas", canvas: rendered }, line);
  } else await cockpit.figure(figure, line);
  const waitSeconds = sing.running() ? Math.max(1, sing.secondsToBarLine(FIGURE_BARS) - 0.6) : 4;
  await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
  if (myTurn !== turn) return;
  cockpit.hideMonitor();
  busy = false;
  current = null;
  advanceFrom({ block: blockIndex, sentence: 0 }, myTurn, true);
}

/** The chapter's end (ST-14, D-102, D-103): the explosion of the count, which also strikes a boss
 * still standing; the clear card; then the next chapter's launch, or the book's end. */
async function chapterEnd(chapterIndex, isLastChapter) {
  const myTurn = ++turn;
  busy = true;
  current = next = previous = null;
  cockpit.setSinging(false);
  const { blast, bossLeft } = cockpit.chapterBlast(isLastChapter);
  prefs.setPosition(book.key, { bossHp: bossLeft });
  await new Promise((resolve) => setTimeout(resolve, ((blast ? blast.seconds : 0) + 0.8) * 1000));
  cockpit.blockEnd();
  if (myTurn !== turn) return;
  const chapter = book.chapters[chapterIndex] || {},
    title = chapter.title
      ? fill(S.clearNamed, { name: chapter.title })
      : fill(S.clearNumbered, { n: chapterIndex + 1 });
  hooks.sfx && hooks.sfx("fanfare");
  hooks.onAnnounce && hooks.onAnnounce(title);
  await cockpit.card(
    [
      [title, true],
      [fill(S.totals, { c: stats.chars, s: stats.sentences, p: stats.blocks }), false],
    ],
    5,
  );
  if (myTurn !== turn) return;
  busy = false;
  if (isLastChapter || chapterIndex + 1 >= book.chapters.length) return bookEnd();
  readingAt = { block: book.chapters[chapterIndex + 1].firstBlock, sentence: 0 };
  save();
  await startChapter(chapterIndex + 1);
}

/** The book's end (A-38): 「読了！」 with the totals and the fanfare, then the book list. */
async function bookEnd() {
  busy = true;
  playing = false;
  hooks.sfx && hooks.sfx("fanfare");
  hooks.onAnnounce && hooks.onAnnounce(S.bookEnd);
  await cockpit.card(
    [
      [S.bookEnd, true],
      [fill(S.totals, { c: stats.chars, s: stats.sentences, p: stats.blocks }), false],
    ],
    6,
  );
  busy = false;
  readingAt = { block: 0, sentence: 0 };
  save();
  hooks.onBookEnd && hooks.onBookEnd();
}

function save() {
  if (!book) return;
  prefs.setPosition(book.key, {
    block: readingAt.block,
    sentence: readingAt.sentence,
    chars: stats.chars,
    sentences: stats.sentences,
    blocks: stats.blocks,
  });
}

// ---------------------------------------------------------------- the light and the windows
/** The sung morae of an entry, on the song's clock: slot k of bar b is the sentence's slot 8b + k
 * (sing D-20: the sung slots of a bar come first), at the time the song gives it (the score's tempo
 * changes between bars, SPEC_dopa v3.9 §6.11). `dur` is the slot's length. A sentence handed over
 * ahead starts where the one before it ends (sing D-33). [] while it cannot be placed. */
function moraTimes(entry) {
  const times = slotTimesOf(entry),
    morae = [];
  if (!times) return morae;
  entry.job.bars.forEach((bar, barIndex) =>
    bar.forEach((mora, slotInBar) => {
      const slot = 8 * barIndex + slotInBar;
      morae.push({
        t: times[slot],
        dur: times[slot + 1] - times[slot],
        start: mora.start,
        end: mora.end,
      });
    }),
  );
  return morae;
}
function slotTimesOf(entry) {
  if (entry.job.t0 !== undefined) return sing.slotTimes(entry.job);
  if (entry === next && current && current.job.t0 !== undefined)
    return sing.slotTimes(entry.job, current.job);
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
      list.push({
        ...window,
        label: target.label,
        display: entry === current ? target.display : null,
      });
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
  if (current.job.end !== undefined && now >= current.job.end)
    lit = position = sentence.display.length;
  cockpit.light(lit, position);
}

/** For checks. */
export const debug = () => ({
  at: readingAt,
  playing,
  busy,
  stats: { ...stats },
  current: current && current.place,
  next: next && next.place,
  windows: windows(),
});
