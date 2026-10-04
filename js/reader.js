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

// a chapter's boss has this many hit points at most (D-102)
const BOSS_HP = 5;

// a figure stands for this many bars of the song (sing ST-11)
const FIGURE_BARS = 2;

let book = null;
let analyzer = null;
let hooks = {};

// open, jump, startChapter, startAt, chapterEnd and bookEnd each begin a new turn; work of an
// earlier turn that comes back late (a prepared sentence, a figure's wait) finds turn changed
// and is dropped. A turn is not one action of the user: a chain of sentences handed to the song
// ahead shares the turn of the startAt that began it, and whatever starts the chain again takes
// a new one.
let turn = 0;

let playing = false;

// the place being read; it is what savePlace() keeps
let readingAt = { block: 0, sentence: 0 };

// { place, job, sentence, targets, jumped } being sung
let current = null;

// the same, handed over ahead
let next = null;

// the sentence before, for the 0.4 s after its last noun
let previous = null;

let totals = { chars: 0, sentences: 0, blocks: 0 };

// block index -> the index of its chapter, from 0
let chapterOf = [];

// chapter index -> its last block that is not a figure (places.js)
let lastBlockOf = [];

// block index -> Promise of [{ id, label, sentence, start, end, display }]
let blockTargets = new Map();

// stopped by ⏸: the battle stays frozen when a drawer closes (D-143)
let frozen = false;

// a sentence could not be analyzed in this book: reading goes on without a voice (D-150)
let analysisFailed = false;

// The turn whose launch, card (a chapter's or the book's end) or figure is up (0: none). While
// that turn is the current
// one the reader is busy: a press, the lever and the bomb do nothing. A jump begins a new turn,
// so what the turn before had up no longer holds the controls (D-151).
let busyTurn = 0;

/** Whether a launch, a card or a figure of the current turn is up. */
const busy = () => {
  const somethingIsUp = busyTurn !== 0;
  const itIsOfThisTurn = busyTurn === turn;

  return somethingIsUp && itIsOfThisTurn;
};

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

  hooks = {
    ...NO_HOOKS,
    ...opts,
  };

  sing.setScorer((text) => sungScoreOf(text));

  const cockpitHooks = {
    windows: hitWindows,
    audio: () => sing.audioContext(),
    onCount: (count) => prefs.setCount(count),
    sfx: opts.sfx,
    onStageTap: (event) => press(event),
  };
  cockpit.init(cockpitHooks);

  requestAnimationFrame(lightLoop);
}

// a sentence that could not be analyzed: 8 slots for 5 characters (SD-W09)
const UNSCORED_CHARS_PER_SLOT = 5 / 8;

/** A score without a voice and without targets, for a sentence that could not be analyzed: the
 * text's characters go over silent slots (「ッ」) at the song's pace, `charsPerSlot` characters to
 * a slot. */
function silentScore(text, charsPerSlot) {
  const morae = [];
  const slots = Math.ceil(text.length / charsPerSlot);

  for (let slot = 0; slot < slots; slot++) {
    const firstChar = Math.floor(slot * charsPerSlot);

    // the last slot ends with the text
    const firstCharOfNextSlot = Math.floor((slot + 1) * charsPerSlot);
    const charAfterLast = Math.min(text.length, firstCharOfNextSlot);

    const silentMora = {
      k: "ッ",
      start: firstChar,
      end: charAfterLast,
      tails: [],
    };
    morae.push(silentMora);
  }

  const onePhrase = {
    pause: true,
    morae,
  };

  return {
    phrases: [onePhrase],
    targets: [],
  };
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

  // a card of the book before goes
  cockpit.endWait();

  blockTargets.clear();
  current = null;
  next = null;
  previous = null;

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
  const kept = prefs.position(book.key);

  let keptBlock = null;
  if (kept) {
    keptBlock = book.blocks[kept.block];
  }

  if (keptBlock) {
    let keptSentence = 0;
    if (keptBlock.sentences[kept.sentence]) {
      keptSentence = kept.sentence;
    }

    readingAt = {
      block: kept.block,
      sentence: keptSentence,
    };
  } else {
    readingAt = { block: 0, sentence: 0 };
  }

  // the totals read so far; each is 0 when it was not kept
  totals = { chars: 0, sentences: 0, blocks: 0 };
  if (kept) {
    totals.chars = kept.chars || 0;
    totals.sentences = kept.sentences || 0;
    totals.blocks = kept.blocks || 0;
  }
  hooks.onChars(totals.chars);

  cockpit.clearRoad();

  const chapterIndex = chapterOf[readingAt.block];
  await startChapter(chapterIndex);
}

/** A chapter starts (ST-13): its launch stands until its time is up or a click ends it, and the
 * song's files load behind it (sing.start() is not awaited here; startAt() awaits it again before
 * the first sentence). When the launch ends, reading starts at `readingAt`, unless the user
 * stopped the reader during the launch. */
async function startChapter(chapterIndex) {
  turn++;
  const myTurn = turn;
  busyTurn = myTurn;

  cockpit.setSinging(false);

  let chapter = book.chapters[chapterIndex];
  if (!chapter) {
    chapter = { title: book.title };
  }

  const noticeWhenVoiceMissing = () => {
    const voiceMissing = sing.voiceMissing();
    if (voiceMissing) {
      return hooks.onNotice(S.songFailed);
    }
    return voiceMissing;
  };
  const noticeSongFailed = () => hooks.onNotice(S.songFailed);

  const settings = prefs.settings();
  const songStarted = sing.start(settings);
  // without its voice files the song runs with no voice, and a notice says so (ST-33, D-87)
  const voiceChecked = songStarted.then(noticeWhenVoiceMissing);
  voiceChecked.catch(noticeSongFailed);

  const title = chapter.title || book.title;

  // titles are announced (ED-10)
  hooks.onAnnounce(title);

  // the launch: the chapter's title on the main monitor and 「M.E.O.W、発進！」 (ST-13, D-103)
  await cockpit.launch(title, S.launch);
  if (myTurn !== turn) {
    return;
  }

  busyTurn = 0;

  // stopped by the user during the launch: ▶ starts it
  if (playing) {
    startAt(readingAt);
  }
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

  current = null;
  next = null;
  previous = null;

  // a block before the book's first is its first, one past its last is its last
  const lastBlock = book.blocks.length - 1;
  const notPastTheLast = Math.min(lastBlock, blockIndex);
  const blockInTheBook = Math.max(0, notPastTheLast);

  readingAt = {
    block: blockInTheBook,
    sentence: 0,
  };
  savePlace();

  if (playing) {
    startAt(readingAt, { jumped: true });
  }
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
  if (!book) {
    return;
  }

  frozen = false;

  // a playing explosion is cut short (ST-32)
  if (cockpit.blastBusy()) {
    cockpit.shortenBlast();
  }

  cockpit.setLever(false);
  cockpit.setStopped(false);
  playing = true;
  sing.hold(false);
  cockpit.hold(false);
  cockpit.setSinging(true);
  hooks.onState({ playing });

  const nothingIsUnderWay = !current && !busy();
  if (nothingIsUnderWay) {
    startAt(readingAt);
  }
}

/** 「⏸ 一時停止」: everything stops where it is, the count is kept, nothing explodes (ST-18). */
export function pause() {
  playing = false;
  frozen = true;

  sing.hold(true);

  // the battle freezes where it is (ST-18)
  cockpit.hold(true);

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

  const songGoesOn = !frozen && !cockpit.lever();
  if (songGoesOn) {
    sing.hold(false);
  }

  cockpit.hold(frozen);
}

/** The gear lever moved down, or the bomb pressed (ST-32, D-144, D-145, D-128): the song is
 * held, the road stops, the lever goes down, and the explosion of the count plays and reaches the
 * robots on the road. Returns what exploded ({ tier, level, seconds }), or null when nothing was
 * counted (the song is held and the lever goes down all the same) or when a card, a launch or a
 * figure is up (then nothing happens). */
export function explode() {
  if (!book || busy()) {
    return null;
  }

  playing = false;
  frozen = false;

  sing.hold(true);

  // the explosion and the robots keep moving
  cockpit.hold(false);

  cockpit.setSinging(false);
  cockpit.setStopped(true);
  cockpit.setLever(true);
  hooks.onState({ playing });

  return cockpit.explode({ road: true });
}

/** A tap on the gear lever: down sets the explosion off, up goes on (D-126, D-145). */
export function toggleLever() {
  if (!book || busy()) {
    return;
  }

  if (cockpit.lever()) {
    play();
  } else {
    explode();
  }
}

/** A press of the bomb's picture (D-144): what the lever moved down does. With the lever down
 * already and nothing counted there is nothing to set off, and nothing happens. */
export function pressBomb() {
  if (!book || busy()) {
    return;
  }

  const nothingToSetOff = cockpit.lever() && cockpit.count() === 0;
  if (nothingToSetOff) {
    return;
  }

  explode();
}

/** A press of the play icon above the lever (D-152): what 「▶ 再生」 does to a stopped reader,
 * and nothing while it reads. */
export function pressGo() {
  if (!book || playing) {
    return;
  }

  play();
}

export const isPlaying = () => playing;

/** A press of 「発射」 or of the stage (D-61, D-100). While the reader is stopped it does nothing:
 * it does not fire, and it does not start the song (D-143). */
export function press(event) {
  if (!book || busy()) {
    return;
  }
  if (!playing) {
    return;
  }

  cockpit.press(event.timeStamp);
}

// ---------------------------------------------------------------- the chain of sung sentences
/** Start reading at a place. A figure block shows its figure; a block with nothing to sing is
 * stepped over; otherwise the sentence is made ready and handed to the song, which starts it at
 * its next free bar line. (A heading's section opener comes in takeOver.) `jumped`: the place was
 * reached by a jump, which brings no boss. */
async function startAt(place, { jumped = false } = {}) {
  turn++;
  const myTurn = turn;

  const blockIndex = place.block;
  const block = book.blocks[blockIndex];

  if (!block) {
    return bookEnd();
  }
  if (block.kind === "figure") {
    return showFigure(blockIndex, myTurn);
  }
  if (!block.sentences.length) {
    const blockStart = {
      block: blockIndex,
      sentence: 0,
    };
    return advanceFrom(blockStart, true);
  }

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
    const settings = prefs.settings();
    await sing.start(settings);

    // wait up to 0.6 s (twice 0.3 s) for the browser to let the song sound, then go on anyway
    const unlockedAtOnce = await sing.unlocked();
    if (!unlockedAtOnce) {
      await sing.unlocked();
    }

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

  if (myTurn !== turn) {
    return;
  }
  if (!prepared) {
    return;
  }

  handToSong(place, prepared, myTurn, jumped);
}

/** Hand a sentence that was made ready to the song: reading moves to it at its bar line
 * (takeOver, which makes it `current`), and it counts as read at its end (ended). Returns its
 * entry; queueNext keeps that as `next`, and one handed by startAt is neither until its bar
 * line: till then `current` is the sentence that ended before it in the same block, or null
 * (after a jump, a figure or a block's end). */
function handToSong(place, prepared, myTurn, jumped = false) {
  const entry = {
    place,
    sentence: prepared.sentence,
    targets: prepared.targets,
    jumped,
  };

  const calledByTheSong = {
    onStart: () => takeOver(myTurn, entry),
    onEnd: () => ended(entry),
  };
  entry.job = sing.enqueue(prepared.sung, calledByTheSong);

  return entry;
}

/** The sentence at a place made ready for the song, with its targets: { sung, sentence, targets },
 * or null when the place has no sentence. */
async function prepare(place) {
  const block = book.blocks[place.block];
  const sentence = block.sentences[place.sentence];

  if (!sentence) {
    return null;
  }

  const sung = await sing.prepare(sentence.speech);

  const all = await targetsOf(place.block);
  const targetsOfTheSentence = all.filter((target) => target.sentence === place.sentence);

  return {
    sung,
    sentence,
    targets: targetsOfTheSentence,
  };
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

    const targetsOfSentence = async (sentence, sentenceIndex) => {
      let analysis;
      try {
        analysis = await sungScoreOf(sentence.speech);
      } catch {
        return [];
      }

      const found = analysis.targets || [];

      return found.map((target, targetIndex) => {
        const display = toDisplay(sentence, target.start, target.end);

        // the text shown; the analyzer's own text where the span shows nothing
        const shownText = sentence.display.slice(display.start, display.end);
        const label = shownText || target.text;

        const made = {
          id: `${blockIndex}:${sentenceIndex}:${targetIndex}`,
          sentence: sentenceIndex,
          start: target.start,
          end: target.end,
          display,
          label,
        };

        // "en": the shout is in English (D-98)
        if (target.lang) {
          made.lang = target.lang;
        }

        return made;
      });
    };

    // every sentence is asked for at once; the block's targets are their lists end to end
    const listsRequested = block.sentences.map(targetsOfSentence);
    const allLists = Promise.all(listsRequested);
    const request = allLists.then((lists) => lists.flat());

    blockTargets.set(blockIndex, request);

    if (blockTargets.size > 8) {
      const askedForFirst = blockTargets.keys().next().value;
      blockTargets.delete(askedForFirst);
    }
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
  const ofAnEarlierTurn = myTurn !== turn;
  const handedAhead = entry === next;
  if (ofAnEarlierTurn && !handedAhead) {
    return;
  }

  const newBlock = !current || current.place.block !== entry.place.block;

  previous = current;
  current = entry;
  next = null;
  readingAt = { ...entry.place };

  cockpit.setSinging(playing);

  // the words that can be targets are blue from the start (D-124)
  const lang = book.blocks[readingAt.block].lang;
  const targetSpans = entry.targets.map((target) => target.display);
  cockpit.sentence(entry.sentence.display, lang, targetSpans);

  // without a voice the caption is the live text, one sentence at a time (PR-02, PR-12)
  const noVoice = sing.voiceMissing() || analysisFailed;
  if (noVoice) {
    hooks.onLive(entry.sentence.display);
  }

  if (newBlock) {
    const block = book.blocks[readingAt.block];

    if (block.kind === "heading") {
      cockpit.section(entry.sentence.display, S.launch); // ST-12
    }

    const targets = await targetsOf(readingAt.block);
    if (current !== entry) {
      return;
    }

    const idsAndLabels = targets.map(({ id, label }) => ({ id, label }));
    const bossHp = bossHpFor(readingAt.block, targets, entry.jumped);
    cockpit.block(idsAndLabels, bossHp);
  }

  savePlace();
  queueNext(turn);
}

/** Whether a block is its chapter's last block that is not a figure: the one that brings the
 * boss, and whose robots stay for the chapter's explosion. */
const isChapterLastBlock = (blockIndex) => {
  const chapterIndex = chapterOf[blockIndex];

  return blockIndex === lastBlockOf[chapterIndex];
};

/** The hit points of the boss that comes with a block, or null when none comes. The chapter's
 * last block brings the boss (D-102), unless reading jumped straight into it or it has no target.
 * If the boss of the chapter's end reached last was left standing, the new boss starts with the
 * hit points that one had left (kept then, until the next chapter's end writes them anew).
 * Otherwise it has BOSS_HP, and never more than the block has targets. */
function bossHpFor(blockIndex, targets, jumped) {
  if (!isChapterLastBlock(blockIndex)) {
    return null;
  }
  if (jumped) {
    return null;
  }
  if (!targets.length) {
    return null;
  }

  const kept = prefs.position(book.key);

  const bossWasLeftStanding = kept && kept.bossHp;
  if (bossWasLeftStanding) {
    return kept.bossHp;
  }

  return Math.min(BOSS_HP, targets.length);
}

/** Hand the following sentence to the song now, if the song can go straight on into it: the
 * next sentence of the block, or the first of the next text block of the same chapter. */
async function queueNext(myTurn) {
  const place = nextPlace(book, chapterOf, current.place);
  if (!place) {
    return;
  }

  let prepared;
  try {
    prepared = await prepare(place);
  } catch {
    return;
  }

  // The sentence being sung may have ended while this one was being prepared (a slow network):
  // ended() has then started a new turn, and startAt() hands this same sentence to the song.
  // Handing it over here too would sing it twice, and every sentence after it.
  if (myTurn !== turn) {
    return;
  }

  // (a second guard: the place after the current sentence must still be this one)
  const stillNext = current && nextPlace(book, chapterOf, current.place);

  if (!prepared) {
    return;
  }
  if (!stillNext) {
    return;
  }
  if (stillNext.block !== place.block) {
    return;
  }
  if (stillNext.sentence !== place.sentence) {
    return;
  }

  next = handToSong(place, prepared, myTurn);
}

/** The end of a sentence's last bar: it counts as read. A block that ends sends its enemies away
 * (ST-30), but not the chapter's last block: chapterEnd() does that after its explosion, so that
 * the explosion still finds them on the road. */
function ended(entry) {
  totals.chars += entry.sentence.display.length;
  totals.sentences += 1;
  hooks.onChars(totals.chars);

  const block = book.blocks[entry.place.block];
  const lastSentence = block.sentences.length - 1;
  const lastInBlock = entry.place.sentence === lastSentence;

  if (lastInBlock) {
    totals.blocks += 1;

    if (!isChapterLastBlock(entry.place.block)) {
      cockpit.blockEnd();
    }
  }

  savePlace();

  // the song goes straight on into `next`; or this is no longer the sentence read (the next one
  // took over at the same bar line, or a jump came)
  if (next) {
    return;
  }
  if (entry !== current) {
    return;
  }

  advanceFrom(entry.place);
}

/** What follows a place when nothing was handed over ahead: the next sentence of its block; or,
 * the block being done (`blockIsDone`: it had nothing to sing), the next block of the chapter (a
 * figure, an empty block, a text), the chapter's end, or the last chapter's end. The next block
 * is started only while playing (stopped, ▶ starts it); the next sentence is started without
 * asking, since the song is held while the reader is stopped and no sentence ends then. */
function advanceFrom(place, blockIsDone = false) {
  const block = book.blocks[place.block];

  const sentenceAfter = place.sentence + 1;
  const blockHasMore = !blockIsDone && sentenceAfter < block.sentences.length;
  if (blockHasMore) {
    const nextInBlock = {
      block: place.block,
      sentence: sentenceAfter,
    };
    return startAt(nextInBlock);
  }

  const following = place.block + 1;
  const chapterIndex = chapterOf[place.block];

  if (following >= book.blocks.length) {
    return chapterEnd(chapterIndex, true);
  }
  if (chapterOf[following] !== chapterIndex) {
    return chapterEnd(chapterIndex, false);
  }

  readingAt = {
    block: following,
    sentence: 0,
  };
  current = null;

  if (playing) {
    startAt(readingAt);
  }
}

/** A figure block (ST-19): it stands for 2 bars of accompaniment, then reading goes on. The wait
 * ends 0.6 s before the second bar line from now, and lasts 1 s at least; without a running song
 * it is 4 s. It is a wait of real time: ⏸ and a drawer do not hold it. */
async function showFigure(blockIndex, myTurn) {
  const figure = book.blocks[blockIndex].figure;
  busyTurn = myTurn;

  cockpit.clearCaption();

  const label = figure.label || "";

  let line;
  if (figure.page) {
    const labelAndPage = {
      label,
      page: figure.page,
    };
    line = fill(S.figureLine, labelAndPage);
  } else {
    line = fill(S.figureLineNoPage, { label });
  }

  const pageCanBeDrawn = figure.kind === "pdfPage" && hooks.renderPdfPage;
  if (pageCanBeDrawn) {
    const drawing = hooks.renderPdfPage(book, figure.page);
    const rendered = await drawing.catch(() => null);

    // a jump came while the page was drawn: it is not shown
    if (myTurn !== turn) {
      return;
    }

    if (rendered) {
      const drawnPage = {
        kind: "canvas",
        canvas: rendered,
      };
      await cockpit.figure(drawnPage, line);
    }
  } else {
    await cockpit.figure(figure, line);
  }
  if (myTurn !== turn) {
    return;
  }

  let waitSeconds = 4;
  if (sing.running()) {
    const secondsToSecondBarLine = sing.secondsToBarLine(FIGURE_BARS);
    waitSeconds = Math.max(1, secondsToSecondBarLine - 0.6);
  }

  const waitMs = waitSeconds * 1000;
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  if (myTurn !== turn) {
    return;
  }

  cockpit.hideMonitor();
  busyTurn = 0;
  current = null;

  const blockStart = {
    block: blockIndex,
    sentence: 0,
  };
  advanceFrom(blockStart, true);
}

/** The chapter's end (ST-14, D-102, D-103): the explosion of the count, which also strikes a boss
 * still standing; the clear card; then the next chapter's launch, or the book's end. */
async function chapterEnd(chapterIndex, isLastChapter) {
  turn++;
  const myTurn = turn;
  busyTurn = myTurn;

  current = null;
  next = null;
  previous = null;

  cockpit.setSinging(false);

  const { blast, bossLeft } = cockpit.chapterBlast(isLastChapter);
  prefs.setPosition(book.key, { bossHp: bossLeft });

  let blastSeconds = 0;
  if (blast) {
    blastSeconds = blast.seconds;
  }
  const waitMs = (blastSeconds + 0.8) * 1000;
  await new Promise((resolve) => setTimeout(resolve, waitMs));

  // a jump came during the explosion: the new place's robots stay
  if (myTurn !== turn) {
    return;
  }

  cockpit.blockEnd();

  const chapter = book.chapters[chapterIndex] || {};

  let clearLine;
  if (chapter.title) {
    clearLine = fill(S.clearNamed, { name: chapter.title });
  } else {
    const chapterNumber = chapterIndex + 1;
    clearLine = fill(S.clearNumbered, { n: chapterNumber });
  }

  await showCard(clearLine, 5);
  if (myTurn !== turn) {
    return;
  }

  busyTurn = 0;

  const chapterAfter = chapterIndex + 1;
  const noChapterFollows = isLastChapter || chapterAfter >= book.chapters.length;
  if (noChapterFollows) {
    return bookEnd();
  }

  const firstBlockAfter = book.chapters[chapterAfter].firstBlock;
  readingAt = {
    block: firstBlockAfter,
    sentence: 0,
  };
  savePlace();

  await startChapter(chapterAfter);
}

/** A card with a headline and, under it, the totals read so far, with the fanfare; the headline
 * is announced. Resolves when the card closes: after `seconds`, or at a click on it. */
function showCard(headline, seconds) {
  hooks.sfx("fanfare");
  hooks.onAnnounce(headline);

  const totalsRead = {
    c: totals.chars,
    s: totals.sentences,
    p: totals.blocks,
  };
  const totalsLine = fill(S.totals, totalsRead);

  // each line with whether it is the big one
  const lines = [
    [headline, true],
    [totalsLine, false],
  ];

  return cockpit.card(lines, seconds);
}

/** The book's end (A-38): 「読了！」 with the totals and the fanfare, then the book list. The
 * kept place goes back to the book's start; the totals stay. */
async function bookEnd() {
  turn++;
  const myTurn = turn;
  busyTurn = myTurn;

  await showCard(S.bookEnd, 6);

  // a jump, or another book, came while the card was up
  if (myTurn !== turn) {
    return;
  }

  busyTurn = 0;
  playing = false;
  hooks.onState({ playing });

  // the list that follows leaves the cockpit as it is (D-147)
  cockpit.clearCaption();

  readingAt = { block: 0, sentence: 0 };
  savePlace();

  hooks.onBookEnd();
}

function savePlace() {
  if (!book) {
    return;
  }

  const placeAndTotals = {
    block: readingAt.block,
    sentence: readingAt.sentence,
    chars: totals.chars,
    sentences: totals.sentences,
    blocks: totals.blocks,
  };
  prefs.setPosition(book.key, placeAndTotals);
}

// ---------------------------------------------------------------- the light and the windows
/** The sung morae of an entry, on the song's clock: slot k of bar b is the sentence's slot 8b + k
 * (sing D-20: the sung slots of a bar come first), at the time the song gives it (the score's tempo
 * changes between bars, SPEC_dopa v3.9 §6.11). `dur` is the slot's length. A sentence handed over
 * ahead starts where the one before it ends (sing D-33). [] while it cannot be placed. The
 * entry's job is the song's: { bars: a list of bars, each a list of morae; t0 and end, set by the
 * song when the sentence starts and ends }. */
function moraTimes(entry) {
  const times = slotTimesOf(entry);
  const morae = [];

  if (!times) {
    return morae;
  }

  entry.job.bars.forEach((bar, barIndex) => {
    bar.forEach((mora, slotInBar) => {
      const slot = 8 * barIndex + slotInBar;

      const timed = {
        t: times[slot],
        dur: times[slot + 1] - times[slot],
        start: mora.start,
        end: mora.end,
      };
      morae.push(timed);
    });
  });

  return morae;
}

/** The times of an entry's slots from the song (one more entry than slots: the last is the end
 * of the last bar), or null while the sentence cannot be placed: it has not started and it is not
 * the one handed over ahead of a sentence that has. */
function slotTimesOf(entry) {
  const hasStarted = entry.job.t0 !== undefined;
  if (hasStarted) {
    return sing.slotTimes(entry.job);
  }

  const handedAhead = entry === next;
  const currentHasStarted = current && current.job.t0 !== undefined;
  if (handedAhead && currentHasStarted) {
    return sing.slotTimes(entry.job, current.job);
  }

  return null;
}

/** The windows of the sentences that can be hit now: the one before (the window of its last noun
 * stays open for 0.4 s after it: AFTER in fire.js), the one being sung and the one handed over
 * ahead (§5.6 step 4). Only the sentence being sung gives its display span: the caption shows no
 * other sentence, so no other span may flash on it. */
function hitWindows() {
  const list = [];

  for (const entry of [previous, current, next]) {
    if (!entry) {
      continue;
    }
    if (!entry.targets.length) {
      continue;
    }

    const morae = moraTimes(entry);
    if (!morae.length) {
      continue;
    }

    const slotSeconds = sing.slotSeconds();
    const found = windowsOf(entry.targets, morae, slotSeconds);

    for (const timed of found) {
      const target = entry.targets.find((one) => one.id === timed.id);

      let display = null;
      if (entry === current) {
        display = target.display;
      }

      const hittable = {
        ...timed,
        label: target.label,
        display,
      };
      if (target.lang) {
        hittable.lang = target.lang;
      }

      list.push(hittable);
    }
  }

  return list;
}

/** The light of the caption follows the sung morae (ST-04). */
function lightLoop() {
  requestAnimationFrame(lightLoop);

  if (!current) {
    return;
  }
  if (current.job.t0 === undefined) {
    return;
  }

  // the song's time now, less the time the sound takes to come out
  const songNow = sing.now();
  let outputLatency = 0;
  if (sing.audioContext()) {
    outputLatency = sing.audioContext().outputLatency || 0;
  }
  const now = songNow - outputLatency;

  const sentence = current.sentence;

  let lit = 0;

  // where the song is, in display characters, fractional (D-132)
  let position = 0;

  const sungMorae = moraTimes(current);
  for (const mora of sungMorae) {
    if (mora.t <= now) {
      const litByMora = speechToDisplay(sentence, mora.end);
      lit = Math.max(lit, litByMora);

      const from = speechToDisplay(sentence, mora.start);
      const to = speechToDisplay(sentence, mora.end);

      // the share of the mora that has been sung, 1 at most
      const sungSeconds = now - mora.t;
      const sungShare = Math.min(1, sungSeconds / mora.dur);

      const reached = from + (to - from) * sungShare;
      position = Math.max(position, reached);
    }
  }

  const sentenceIsOver = current.job.end !== undefined && now >= current.job.end;
  if (sentenceIsOver) {
    lit = sentence.display.length;
    position = sentence.display.length;
  }

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
