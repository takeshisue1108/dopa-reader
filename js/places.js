// Places in a book and spans in a sentence (SPEC_dopa v3 §5.1, §5.6 step 3, §6.2). Pure: no
// browser, no song, no state. A place is { block, sentence }; a span is { start, end } in the
// characters of a sentence's display text.

/** The index in a sentence's display text of character `i` of its speech text. `sentence.map`
 * gives it for each speech character (a ruby's reading maps to its base); a sentence without a
 * map is spoken as it is shown. Past the end of the speech it is the end of the display. */
export const speechToDisplay = (sentence, i) =>
  sentence.map
    ? i >= sentence.map.length
      ? sentence.display.length
      : sentence.map[i]
    : Math.min(i, sentence.display.length);
/** The display span { start, end } of the speech span [start, end) of a sentence. It ends just
 * past what the last speech character shows: for a ruby's reading that is the end of its base, so
 * a word with a ruby is its whole base (旅人《たびびと》 is 旅人, ED D-146). */
export function toDisplay(sentence, start, end) {
  const from = speechToDisplay(sentence, start);
  if (end <= 0) return { start: from, end: from };
  const last = end - 1,
    to =
      sentence.ends && last < sentence.ends.length
        ? Math.min(sentence.ends[last], sentence.display.length)
        : speechToDisplay(sentence, last) + 1;
  return { start: from, end: Math.max(from, to) };
}

/** The place the song can go straight on into after `place`: the next sentence of the block, or
 * the first sentence of the next block when that block is in the same chapter and has text.
 * null when a figure, an empty block, a chapter's end or the book's end comes next. */
export function nextPlace(book, chapterOf, place) {
  const block = book.blocks[place.block];
  if (place.sentence + 1 < block.sentences.length)
    return { block: place.block, sentence: place.sentence + 1 };
  const following = book.blocks[place.block + 1];
  if (!following || chapterOf[place.block + 1] !== chapterOf[place.block]) return null;
  if (following.kind === "figure" || !following.sentences.length) return null;
  return { block: place.block + 1, sentence: 0 };
}

/** For each block the index of its chapter (from 0; a block before the first chapter's first
 * block counts to chapter 0), and for each chapter its last block that is not a figure (-1 when
 * it has none): { chapterOf, lastBlockOf }. */
export function indexChapters(book) {
  const chapterOf = [],
    lastBlockOf = [];
  book.chapters.forEach((chapter, chapterIndex) => {
    const endBlock =
      chapterIndex + 1 < book.chapters.length
        ? book.chapters[chapterIndex + 1].firstBlock
        : book.blocks.length;
    for (let blockIndex = chapter.firstBlock; blockIndex < endBlock; blockIndex++)
      chapterOf[blockIndex] = chapterIndex;
    let lastNonFigure = -1;
    for (let blockIndex = chapter.firstBlock; blockIndex < endBlock; blockIndex++)
      if (book.blocks[blockIndex].kind !== "figure") lastNonFigure = blockIndex;
    lastBlockOf[chapterIndex] = lastNonFigure;
  });
  for (let blockIndex = 0; blockIndex < book.blocks.length; blockIndex++)
    if (chapterOf[blockIndex] === undefined) chapterOf[blockIndex] = 0;
  return { chapterOf, lastBlockOf };
}
