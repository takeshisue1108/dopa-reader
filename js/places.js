// Places in a book and spans in a sentence (SPEC_dopa v3 §5.1, §5.6 step 3, §6.2). Pure: no
// browser, no song, no state. A place is { block, sentence }; a span is { start, end } in the
// characters of a sentence's display text.

/** The index in a sentence's display text of character `i` of its speech text. `sentence.map`
 * gives it for each speech character (a ruby's reading maps to its base); a sentence without a
 * map is spoken as it is shown. Past the end of the speech it is the end of the display. */
export function speechToDisplay(sentence, i) {
  if (!sentence.map) {
    return Math.min(i, sentence.display.length);
  }

  const pastTheSpeech = i >= sentence.map.length;
  if (pastTheSpeech) {
    return sentence.display.length;
  }

  return sentence.map[i];
}

/** The display span { start, end } of the speech span [start, end) of a sentence. It ends just
 * past what the last speech character shows: for a ruby's reading that is the end of its base, so
 * a word with a ruby is its whole base (旅人《たびびと》 is 旅人, ED D-146). */
export function toDisplay(sentence, start, end) {
  const from = speechToDisplay(sentence, start);

  if (end <= 0) {
    return {
      start: from,
      end: from,
    };
  }

  const last = end - 1;
  const endOfLastIsGiven = sentence.ends && last < sentence.ends.length;

  let to;
  if (endOfLastIsGiven) {
    to = Math.min(sentence.ends[last], sentence.display.length);
  } else {
    const shownByLast = speechToDisplay(sentence, last);
    to = shownByLast + 1;
  }

  // an empty span rather than one that ends before its start
  const endAtLeastStart = Math.max(from, to);

  return {
    start: from,
    end: endAtLeastStart,
  };
}

/** The place the song can go straight on into after `place`: the next sentence of the block, or
 * the first sentence of the next block when that block is in the same chapter and has text.
 * null when a figure, an empty block, a chapter's end or the book's end comes next. */
export function nextPlace(book, chapterOf, place) {
  const block = book.blocks[place.block];

  const sentenceAfter = place.sentence + 1;
  if (sentenceAfter < block.sentences.length) {
    return {
      block: place.block,
      sentence: sentenceAfter,
    };
  }

  const blockAfter = place.block + 1;
  const following = book.blocks[blockAfter];

  if (!following) {
    return null;
  }
  if (chapterOf[blockAfter] !== chapterOf[place.block]) {
    return null;
  }
  if (following.kind === "figure") {
    return null;
  }
  if (!following.sentences.length) {
    return null;
  }

  return {
    block: blockAfter,
    sentence: 0,
  };
}

/** For each block the index of its chapter (from 0; a block before the first chapter's first
 * block counts to chapter 0), and for each chapter its last block that is not a figure (-1 when
 * it has none): { chapterOf, lastBlockOf }. */
export function indexChapters(book) {
  const chapterOf = [];
  const lastBlockOf = [];

  book.chapters.forEach((chapter, chapterIndex) => {
    // a chapter ends where the next one starts, and the last one where the book ends
    const chapterAfter = chapterIndex + 1;
    let endBlock;
    if (chapterAfter < book.chapters.length) {
      endBlock = book.chapters[chapterAfter].firstBlock;
    } else {
      endBlock = book.blocks.length;
    }

    for (let blockIndex = chapter.firstBlock; blockIndex < endBlock; blockIndex++) {
      chapterOf[blockIndex] = chapterIndex;
    }

    let lastNonFigure = -1;
    for (let blockIndex = chapter.firstBlock; blockIndex < endBlock; blockIndex++) {
      const isFigure = book.blocks[blockIndex].kind === "figure";
      if (!isFigure) {
        lastNonFigure = blockIndex;
      }
    }
    lastBlockOf[chapterIndex] = lastNonFigure;
  });

  for (let blockIndex = 0; blockIndex < book.blocks.length; blockIndex++) {
    if (chapterOf[blockIndex] === undefined) {
      chapterOf[blockIndex] = 0;
    }
  }

  return { chapterOf, lastBlockOf };
}
