// The reading loop of the site (SPEC_dopa v3 §6.2; ED D-52, D-102, D-103, D-107, ST-13, ST-14,
// ST-18, ST-19, ST-32, ST-35). The next sentence is handed to the song while the current one is
// sung, and the song calls takeOver() at its bar line, so that no bar of waiting falls between
// sentences (sing D-33). A figure stands for 2 bars of accompaniment; a chapter ends with the
// boss, the explosion of the count (the enemies shot since the last explosion) and the clear
// card; the next chapter starts with the launch.
//
// A sentence's "score" here is what the song sings of it, not points:
// { phrases: [{ pause, morae: [{ k (the kana sung), start, end (its characters), tails }] }],
// targets: [{ start, end, text }] } (lang/analyze.js).
import * as sing from "./sing/index.js";
import * as cockpit from "./cockpit/cockpit.js";
import { windowsOf } from "./cockpit/fire.js";
import { indexChapters, nextPlace, speechToDisplay, toDisplay } from "./places.js";
import * as prefs from "./store/prefs.js";
import { fill, S } from "./strings.js";

const BOSS_HP = 5; // a chapter's boss has this many hit points at most (D-102)
const FIGURE_BARS = 2; // a figure stands for this many bars of the song (sing ST-11)

let book = null,
  analyzer = null,
  hooks = {},
  // open, jump, startChapter, startAt, chapterEnd and bookEnd each begin a new turn; work of an
  // earlier turn that comes back late (a prepared sentence, a figure's wait) finds turn changed
  // and is dropped. A turn is not one action of the user: a chain of sentences handed to the song
  // ahead shares the turn of the startAt that began it, and whatever starts the chain again takes
  // a new one.
  turn = 0,
  playing = false,
  readingAt = { block: 0, sentence: 0 }, // the place being read; it is what savePlace() keeps
  current = null, // { place, job, sentence, targets, jumped } being sung
  next = null, // the same, handed over ahead
  previous = null, // the sentence before, for the 0.4 s after its last noun
  totals = { chars: 0, sentences: 0, blocks: 0 },
  chapterOf = [], // block index -> the index of its chapter, from 0
  lastBlockOf = [], // chapter index -> its last block that is not a figure (places.js)
  // block index -> Promise of [{ id, label, sentence, start, end, display }]
  blockTargets = new Map(),
  frozen = false, // stopped by ⏸: the battle stays frozen when a drawer closes (D-143)
  // a sentence could not be analyzed in this book: reading goes on without a voice (D-150)
  analysisFailed = false,
  // The turn whose launch, card (a chapter's or the book's end) or figure is up (0: none). While
  // that turn is the current
  // one the reader is busy: a press, the lever and the bomb do nothing. A jump begins a new turn,
  // so what the turn before had up no longer holds the controls (D-151).
  busyTurn = 0;

/** Whether a launch, a card or a figure of the current turn is up. */
const busy = () => busyTurn !== 0 && busyTurn === turn;

// A hook that the page does not give does nothing. (renderPdfPage is not among them: without it
// a PDF's figure page is not shown.)
const NO_HOOKS = {
  sfx() {},
  onBookEnd() {},
  onState() {},
  onChars() {},
  onAnnounce() {},
  onLive() {},
  onNotice() {},
};

/** `opts`: { analyzer, sfx(role), renderPdfPage(book, page), onBookEnd(), onState({ playing }),
 * onChars(n), onAnnounce(text) (a title or a card's headline, for a screen reader), onLive(text)
 * (the sentence as text, when the song has no voice), onNotice(text) and onNotice(null, text):
 * the second form takes that notice away if it is the one shown }. */
export function init(opts) {
  analyzer = opts.analyzer;
  hooks = { ...NO_HOOKS, ...opts };
  sing.setScorer((text) => sungScoreOf(text));
  cockpit.init({
    windows: hitWindows,
    audio: () => sing.audioContext(),
    onCount: (count) => prefs.setCount(count),
    sfx: opts.sfx,
    onStageTap: (event) => press(event),
  });
  requestAnimationFrame(lightLoop);
}

// a sentence that could not be analyzed: 8 slots for 5 characters (SD-W09)
const UNSCORED_CHARS_PER_SLOT = 5 / 8;

/** A score without a voice and without targets, for a sentence that could not be analyzed: the
 * text's characters go over silent slots (「ッ」) at the song's pace, `charsPerSlot` characters to
 * a slot. */
function silentScore(text, charsPerSlot) {
  const morae = [],
    slots = Math.ceil(text.length / charsPerSlot);
  for (let slot = 0; slot < slots; slot++)
    morae.push({
      k: "ッ",
      start: Math.floor(slot * charsPerSlot),
      end: Math.min(text.length, Math.floor((slot + 1) * charsPerSlot)),
      tails: [],
    });
  return { phrases: [{ pause: true, morae }], targets: [] };
}

/** The score of a sentence for the song, from the analyzer; an English sentence too, which the
 * analyzer turns into katakana (ED D-160, ST-34). When the analyzer cannot answer (its
 * dictionary did not load), reading goes on without a voice (D-87, D-150): a silent score, 8
 * slots for 5 characters, with the notice 「歌の素材を読み込めませんでした」 once for the book. */
async function sungScoreOf(text) {
  try {
    return await analyzer.analyze(text);
  } catch (error) {
    if (!analysisFailed) {
      analysisFailed = true;
      console.warn(`the words cannot be analyzed: ${error}`);
      hooks.onNotice(S.songFailed);
    }
    return silentScore(text, UNSCORED_CHARS_PER_SLOT);
  }
}

// ---------------------------------------------------------------- opening and moving
/** Open a book at its kept place (or the start) and read: the launch of its chapter first. */
export async function open(newBook) {
  book = newBook;
  turn++;
  sing.clear();
  cockpit.endWait(); // a card of the book before goes
  blockTargets.clear();
  current = next = previous = null;
  // a new book starts going: every hold of the book before is released, the lever is up (D-143)
  frozen = false;
  analysisFailed = false;
  playing = true;
  hooks.onState({ playing });
  sing.hold(false);
  cockpit.hold(false);
  cockpit.setStopped(false);
  cockpit.setLever(false);
  ({ chapterOf, lastBlockOf } = indexChapters(book));
  // the kept place, if the book has it: a block the book does not have is read as the book's
  // start, a sentence its block does not have as the block's first (D-150)
  const kept = prefs.position(book.key),
    keptBlock = kept ? book.blocks[kept.block] : null;
  readingAt = keptBlock
    ? { block: kept.block, sentence: keptBlock.sentences[kept.sentence] ? kept.sentence : 0 }
    : { block: 0, sentence: 0 };
  totals = {
    chars: (kept && kept.chars) || 0,
    sentences: (kept && kept.sentences) || 0,
    blocks: (kept && kept.blocks) || 0,
  };
  hooks.onChars(totals.chars);
  cockpit.clearRoad();
  await startChapter(chapterOf[readingAt.block]);
}

/** A chapter starts (ST-13): its launch stands until its time is up or a click ends it, and the
 * song's files load behind it (sing.start() is not awaited here; startAt() awaits it again before
 * the first sentence). When the launch ends, reading starts at `readingAt`, unless the user
 * stopped the reader during the launch. */
async function startChapter(chapterIndex) {
  const myTurn = ++turn;
  busyTurn = myTurn;
  cockpit.setSinging(false);
  const chapter = book.chapters[chapterIndex] || { title: book.title };
  sing
    .start(prefs.settings())
    // without its voice files the song runs with no voice, and a notice says so (ST-33, D-87)
    .then(() => sing.voiceMissing() && hooks.onNotice(S.songFailed))
    .catch(() => hooks.onNotice(S.songFailed));
  hooks.onAnnounce(chapter.title || book.title); // titles are announced (ED-10)
  // the launch: the chapter's title on the main monitor and 「M.E.O.W、発進！」 (ST-13, D-103)
  await cockpit.launch(chapter.title || book.title, S.launch);
  if (myTurn !== turn) return;
  busyTurn = 0;
  if (playing) startAt(readingAt); // stopped by the user during the launch: ▶ starts it
}

/** Jump to a block (「ブロックを指定」, 「目次」): what was handed to the song is taken back, the
 * road is cleared, and reading starts there at the next bar line; a stopped reader starts there
 * at the next ▶. A launch, a figure or a card that is up goes at once (D-151): the jump begins a
 * new turn, and the turn left behind does nothing more. */
export function jump(blockIndex) {
  turn++;
  sing.clear();
  cockpit.clearRoad();
  cockpit.endWait();
  cockpit.hideMonitor();
  current = next = previous = null;
  readingAt = { block: Math.max(0, Math.min(book.blocks.length - 1, blockIndex)), sentence: 0 };
  savePlace();
  if (playing) startAt(readingAt, { jumped: true });
}

// ---------------------------------------------------------------- playing and holding
// What each state holds (D-143, D-145, ST-18):
//
//                     the song   the cockpit's clock   Elena types   the road   the lever
//   playing           runs       runs                  yes           moves      up
//   paused (⏸)        held       held                  no            (held)     as it was
//   the lever down    held       runs                  no            stops      down
//   nothing to read   runs       runs                  no            moves      up
//
// "Nothing to read" is after the song could not start and after the book's end: ▶ reads again
// from the place kept. A drawer or the book list holds the song and the cockpit's clock on top of
// any of the four, and closing it gives the state under it back. `playing` is true in the first
// state only; `frozen` is true when paused only. A book is playing from the moment it is opened:
// while a launch, a figure or a card is up (`busy()`), `playing` is as it was, and when the
// launch or the figure ends reading goes on only if it is still true.
/** 「▶ 再生」, or the gear lever moved up (ST-37, D-145): go on from the same point. Nothing else
 * starts a stopped song (D-143). */
export function play() {
  if (!book) return;
  frozen = false;
  if (cockpit.blastBusy()) cockpit.shortenBlast(); // a playing explosion is cut short (ST-32)
  cockpit.setLever(false);
  cockpit.setStopped(false);
  playing = true;
  sing.hold(false);
  cockpit.hold(false);
  cockpit.setSinging(true);
  hooks.onState({ playing });
  if (!current && !busy()) startAt(readingAt);
}
/** 「⏸ 一時停止」: everything stops where it is, the count is kept, nothing explodes (ST-18). */
export function pause() {
  playing = false;
  frozen = true;
  sing.hold(true);
  cockpit.hold(true); // the battle freezes where it is (ST-18)
  cockpit.setSinging(false);
  hooks.onState({ playing });
}
/** A drawer or the book list holds the song and the cockpit's clock while it is open. Closing it
 * gives back what was held before it: after ⏸ the song and the clock stay held, with the lever
 * down the song stays held and the clock runs (its robots still move), and otherwise both go on
 * (D-143, D-148). "Otherwise" is reading, a launch, and a reader with nothing to read: it asks
 * `frozen` and the lever, not `playing`. */
export function hold(on) {
  if (on) {
    sing.hold(true);
    cockpit.hold(true);
    savePlace();
    return;
  }
  if (!frozen && !cockpit.lever()) sing.hold(false);
  cockpit.hold(frozen);
}
/** The gear lever moved down, or the bomb pressed (ST-32, D-144, D-145, D-128): the song is
 * held, the road stops, the lever goes down, and the explosion of the count plays and reaches the
 * robots on the road. Returns what exploded ({ tier, level, seconds }), or null when nothing was
 * counted (the song is held and the lever goes down all the same) or when a card, a launch or a
 * figure is up (then nothing happens). */
export function explode() {
  if (!book || busy()) return null;
  playing = false;
  frozen = false;
  sing.hold(true);
  cockpit.hold(false); // the explosion and the robots keep moving
  cockpit.setSinging(false);
  cockpit.setStopped(true);
  cockpit.setLever(true);
  hooks.onState({ playing });
  return cockpit.explode({ road: true });
}
/** A tap on the gear lever: down sets the explosion off, up goes on (D-126, D-145). */
export function toggleLever() {
  if (!book || busy()) return;
  if (cockpit.lever()) play();
  else explode();
}
/** A press of the bomb's picture (D-144): what the lever moved down does. With the lever down
 * already and nothing counted there is nothing to set off, and nothing happens. */
export function pressBomb() {
  if (!book || busy()) return;
  if (cockpit.lever() && cockpit.count() === 0) return;
  explode();
}
/** A press of the play icon above the lever (D-152): what 「▶ 再生」 does to a stopped reader,
 * and nothing while it reads. */
export function pressGo() {
  if (!book || playing) return;
  play();
}
export const isPlaying = () => playing;

/** A press of 「発射」 or of the stage (D-61, D-100). While the reader is stopped it does nothing:
 * it does not fire, and it does not start the song (D-143). */
export function press(event) {
  if (!book || busy() || !playing) return;
  cockpit.press(event.timeStamp);
}

// ---------------------------------------------------------------- the chain of sung sentences
/** Start reading at a place. A figure block shows its figure; a block with nothing to sing is
 * stepped over; otherwise the sentence is made ready and handed to the song, which starts it at
 * its next free bar line. (A heading's section opener comes in takeOver.) `jumped`: the place was
 * reached by a jump, which brings no boss. */
async function startAt(place, { jumped = false } = {}) {
  const myTurn = ++turn;
  const blockIndex = place.block,
    block = book.blocks[blockIndex];
  if (!block) return bookEnd();
  if (block.kind === "figure") return showFigure(blockIndex, myTurn);
  if (!block.sentences.length) return advanceFrom({ block: blockIndex, sentence: 0 }, true);
  let prepared;
  // Nothing is sung while this sentence is made ready. If that takes more than 0.6 s (the song's
  // files, the dictionary or its voice sheets are still loading), the charging display shows
  // until it is ready (D-113, ST-43).
  const charging = setTimeout(() => hooks.onNotice(S.songLoading), 600);
  const chargingEnds = () => {
    clearTimeout(charging);
    hooks.onNotice(null, S.songLoading);
  };
  try {
    await sing.start(prefs.settings());
    // wait up to 0.6 s (twice 0.3 s) for the browser to let the song sound, then go on anyway
    if (!(await sing.unlocked())) await sing.unlocked();
    prepared = await prepare(place);
    chargingEnds();
  } catch (error) {
    chargingEnds();
    console.warn(`the song cannot start: ${error}`);
    hooks.onNotice(S.songFailed);
    // nothing is read: the reader does not say it is playing, and ▶ tries again (D-150): play()
    // starts at the place kept when no sentence is current
    if (myTurn === turn) {
      playing = false;
      cockpit.setSinging(false);
      hooks.onState({ playing });
    }
    return;
  }
  if (myTurn !== turn || !prepared) return;
  handToSong(place, prepared, myTurn, jumped);
}

/** Hand a sentence that was made ready to the song: reading moves to it at its bar line
 * (takeOver, which makes it `current`), and it counts as read at its end (ended). Returns its
 * entry; queueNext keeps that as `next`, and one handed by startAt is neither until its bar
 * line: till then `current` is the sentence that ended before it in the same block, or null
 * (after a jump, a figure or a block's end). */
function handToSong(place, prepared, myTurn, jumped = false) {
  const entry = { place, sentence: prepared.sentence, targets: prepared.targets, jumped };
  entry.job = sing.enqueue(prepared.sung, {
    onStart: () => takeOver(myTurn, entry),
    onEnd: () => ended(entry),
  });
  return entry;
}

/** The sentence at a place made ready for the song, with its targets: { sung, sentence, targets },
 * or null when the place has no sentence. */
async function prepare(place) {
  const block = book.blocks[place.block],
    sentence = block.sentences[place.sentence];
  if (!sentence) return null;
  const sung = await sing.prepare(sentence.speech);
  const all = await targetsOf(place.block);
  return { sung, sentence, targets: all.filter((target) => target.sentence === place.sentence) };
}

/** The targets of a block (§5.6), with ids, their sentence, their speech span and their display
 * span and text (the shout and the sign use the display text, §5.6 step 3), and `lang: "en"` for
 * a target of an English sentence. Every sentence of the
 * block is analyzed for this before its first sentence starts; the analyzer keeps its answers
 * (lang/client.js), so making the same sentence ready for the song asks nothing twice. The targets
 * of 8 blocks are kept; the block asked for first goes first. */
function targetsOf(blockIndex) {
  if (!blockTargets.has(blockIndex)) {
    const block = book.blocks[blockIndex];
    const request = Promise.all(
      block.sentences.map(async (sentence, sentenceIndex) => {
        let analysis;
        try {
          analysis = await sungScoreOf(sentence.speech);
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
            ...(target.lang && { lang: target.lang }), // "en": the shout is in English (D-98)
          };
        });
      }),
    ).then((lists) => lists.flat());
    blockTargets.set(blockIndex, request);
    if (blockTargets.size > 8) blockTargets.delete(blockTargets.keys().next().value);
  }
  return blockTargets.get(blockIndex);
}

/** The song reached the bar line of a sentence: reading moves to it. The caption and the place
 * kept become this sentence's; at a block's first sentence its targets, and its boss if one
 * comes, are sent to the cockpit (a heading opens its section); the sentence after it is asked
 * for ahead. */
async function takeOver(myTurn, entry) {
  // an entry of an earlier turn is dropped, unless it is the one handed over ahead (no case was
  // found in which `next` outlives its turn: jump, open and chapterEnd all empty it)
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
  if (sing.voiceMissing() || analysisFailed) hooks.onLive(entry.sentence.display);
  if (newBlock) {
    const block = book.blocks[readingAt.block];
    if (block.kind === "heading") cockpit.section(entry.sentence.display, S.launch); // ST-12
    const targets = await targetsOf(readingAt.block);
    if (current !== entry) return;
    cockpit.block(
      targets.map(({ id, label }) => ({ id, label })),
      bossHpFor(readingAt.block, targets, entry.jumped),
    );
  }
  savePlace();
  queueNext(turn);
}

/** Whether a block is its chapter's last block that is not a figure: the one that brings the
 * boss, and whose robots stay for the chapter's explosion. */
const isChapterLastBlock = (blockIndex) => blockIndex === lastBlockOf[chapterOf[blockIndex]];

/** The hit points of the boss that comes with a block, or null when none comes. The chapter's
 * last block brings the boss (D-102), unless reading jumped straight into it or it has no target.
 * If the boss of the chapter's end reached last was left standing, the new boss starts with the
 * hit points that one had left (kept then, until the next chapter's end writes them anew).
 * Otherwise it has BOSS_HP, and never more than the block has targets. */
function bossHpFor(blockIndex, targets, jumped) {
  if (!isChapterLastBlock(blockIndex) || jumped || !targets.length) return null;
  const kept = prefs.position(book.key);
  return kept && kept.bossHp ? kept.bossHp : Math.min(BOSS_HP, targets.length);
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
  // (a second guard: the place after the current sentence must still be this one)
  const stillNext = current && nextPlace(book, chapterOf, current.place);
  if (
    !prepared ||
    !stillNext ||
    stillNext.block !== place.block ||
    stillNext.sentence !== place.sentence
  )
    return;
  next = handToSong(place, prepared, myTurn);
}

/** The end of a sentence's last bar: it counts as read. A block that ends sends its enemies away
 * (ST-30), but not the chapter's last block: chapterEnd() does that after its explosion, so that
 * the explosion still finds them on the road. */
function ended(entry) {
  totals.chars += entry.sentence.display.length;
  totals.sentences += 1;
  hooks.onChars(totals.chars);
  const block = book.blocks[entry.place.block],
    lastInBlock = entry.place.sentence === block.sentences.length - 1;
  if (lastInBlock) {
    totals.blocks += 1;
    if (!isChapterLastBlock(entry.place.block)) cockpit.blockEnd();
  }
  savePlace();
  // the song goes straight on into `next`; or this is no longer the sentence read (the next one
  // took over at the same bar line, or a jump came)
  if (next || entry !== current) return;
  advanceFrom(entry.place);
}

/** What follows a place when nothing was handed over ahead: the next sentence of its block; or,
 * the block being done (`blockIsDone`: it had nothing to sing), the next block of the chapter (a
 * figure, an empty block, a text), the chapter's end, or the last chapter's end. The next block
 * is started only while playing (stopped, ▶ starts it); the next sentence is started without
 * asking, since the song is held while the reader is stopped and no sentence ends then. */
function advanceFrom(place, blockIsDone = false) {
  const block = book.blocks[place.block];
  if (!blockIsDone && place.sentence + 1 < block.sentences.length)
    return startAt({ block: place.block, sentence: place.sentence + 1 });
  const following = place.block + 1;
  if (following >= book.blocks.length) return chapterEnd(chapterOf[place.block], true);
  if (chapterOf[following] !== chapterOf[place.block])
    return chapterEnd(chapterOf[place.block], false);
  readingAt = { block: following, sentence: 0 };
  current = null;
  if (playing) startAt(readingAt);
}

/** A figure block (ST-19): it stands for 2 bars of accompaniment, then reading goes on. The wait
 * ends 0.6 s before the second bar line from now, and lasts 1 s at least; without a running song
 * it is 4 s. It is a wait of real time: ⏸ and a drawer do not hold it. */
async function showFigure(blockIndex, myTurn) {
  const figure = book.blocks[blockIndex].figure;
  busyTurn = myTurn;
  cockpit.clearCaption();
  const label = figure.label || "";
  const line = figure.page
    ? fill(S.figureLine, { label, page: figure.page })
    : fill(S.figureLineNoPage, { label });
  if (figure.kind === "pdfPage" && hooks.renderPdfPage) {
    const rendered = await hooks.renderPdfPage(book, figure.page).catch(() => null);
    if (myTurn !== turn) return; // a jump came while the page was drawn: it is not shown
    if (rendered) await cockpit.figure({ kind: "canvas", canvas: rendered }, line);
  } else await cockpit.figure(figure, line);
  if (myTurn !== turn) return;
  const waitSeconds = sing.running() ? Math.max(1, sing.secondsToBarLine(FIGURE_BARS) - 0.6) : 4;
  await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
  if (myTurn !== turn) return;
  cockpit.hideMonitor();
  busyTurn = 0;
  current = null;
  advanceFrom({ block: blockIndex, sentence: 0 }, true);
}

/** The chapter's end (ST-14, D-102, D-103): the explosion of the count, which also strikes a boss
 * still standing; the clear card; then the next chapter's launch, or the book's end. */
async function chapterEnd(chapterIndex, isLastChapter) {
  const myTurn = ++turn;
  busyTurn = myTurn;
  current = next = previous = null;
  cockpit.setSinging(false);
  const { blast, bossLeft } = cockpit.chapterBlast(isLastChapter);
  prefs.setPosition(book.key, { bossHp: bossLeft });
  await new Promise((resolve) => setTimeout(resolve, ((blast ? blast.seconds : 0) + 0.8) * 1000));
  if (myTurn !== turn) return; // a jump came during the explosion: the new place's robots stay
  cockpit.blockEnd();
  const chapter = book.chapters[chapterIndex] || {},
    clearLine = chapter.title
      ? fill(S.clearNamed, { name: chapter.title })
      : fill(S.clearNumbered, { n: chapterIndex + 1 });
  await showCard(clearLine, 5);
  if (myTurn !== turn) return;
  busyTurn = 0;
  if (isLastChapter || chapterIndex + 1 >= book.chapters.length) return bookEnd();
  readingAt = { block: book.chapters[chapterIndex + 1].firstBlock, sentence: 0 };
  savePlace();
  await startChapter(chapterIndex + 1);
}

/** A card with a headline and, under it, the totals read so far, with the fanfare; the headline
 * is announced. Resolves when the card closes: after `seconds`, or at a click on it. */
function showCard(headline, seconds) {
  hooks.sfx("fanfare");
  hooks.onAnnounce(headline);
  return cockpit.card(
    [
      [headline, true],
      [fill(S.totals, { c: totals.chars, s: totals.sentences, p: totals.blocks }), false],
    ],
    seconds,
  );
}

/** The book's end (A-38): 「読了！」 with the totals and the fanfare, then the book list. The
 * kept place goes back to the book's start; the totals stay. */
async function bookEnd() {
  const myTurn = ++turn;
  busyTurn = myTurn;
  await showCard(S.bookEnd, 6);
  if (myTurn !== turn) return; // a jump, or another book, came while the card was up
  busyTurn = 0;
  playing = false;
  hooks.onState({ playing });
  cockpit.clearCaption(); // the list that follows leaves the cockpit as it is (D-147)
  readingAt = { block: 0, sentence: 0 };
  savePlace();
  hooks.onBookEnd();
}

function savePlace() {
  if (!book) return;
  prefs.setPosition(book.key, {
    block: readingAt.block,
    sentence: readingAt.sentence,
    chars: totals.chars,
    sentences: totals.sentences,
    blocks: totals.blocks,
  });
}

// ---------------------------------------------------------------- the light and the windows
/** The sung morae of an entry, on the song's clock: slot k of bar b is the sentence's slot 8b + k
 * (sing D-20: the sung slots of a bar come first), at the time the song gives it (the score's tempo
 * changes between bars, SPEC_dopa v3.9 §6.11). `dur` is the slot's length. A sentence handed over
 * ahead starts where the one before it ends (sing D-33). [] while it cannot be placed. The
 * entry's job is the song's: { bars: a list of bars, each a list of morae; t0 and end, set by the
 * song when the sentence starts and ends }. */
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
/** The times of an entry's slots from the song (one more entry than slots: the last is the end
 * of the last bar), or null while the sentence cannot be placed: it has not started and it is not
 * the one handed over ahead of a sentence that has. */
function slotTimesOf(entry) {
  if (entry.job.t0 !== undefined) return sing.slotTimes(entry.job);
  if (entry === next && current && current.job.t0 !== undefined)
    return sing.slotTimes(entry.job, current.job);
  return null;
}

/** The windows of the sentences that can be hit now: the one before (the window of its last noun
 * stays open for 0.4 s after it: AFTER in fire.js), the one being sung and the one handed over
 * ahead (§5.6 step 4). Only the sentence being sung gives its display span: the caption shows no
 * other sentence, so no other span may flash on it. */
function hitWindows() {
  const list = [];
  for (const entry of [previous, current, next]) {
    if (!entry || !entry.targets.length) continue;
    const morae = moraTimes(entry);
    if (!morae.length) continue;
    const found = windowsOf(entry.targets, morae, sing.slotSeconds());
    for (const timed of found) {
      const target = entry.targets.find((one) => one.id === timed.id);
      list.push({
        ...timed,
        label: target.label,
        display: entry === current ? target.display : null,
        ...(target.lang && { lang: target.lang }),
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

/** For checks, and for the page: main.js reads `at` for the jump box and the block counter. */
export const debug = () => ({
  at: readingAt,
  playing,
  busy: busy(),
  stats: { ...totals },
  current: current && current.place,
  next: next && next.place,
  windows: hitWindows(),
});
