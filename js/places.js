// Places in a book and spans in a sentence (SPEC_dopa v3 §5.1, §5.6 step 3, §6.2). Pure: no
// browser, no song, no state. A place is { block, sentence }; a span is { start, end } in the
// characters of a sentence's display text.

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

export function nextPlace(book, chapterOf, place) {
  const block = book.blocks[place.block];
  if (place.sentence + 1 < block.sentences.length)
    return { block: place.block, sentence: place.sentence + 1 };
  const following = book.blocks[place.block + 1];
  if (!following || chapterOf[place.block + 1] !== chapterOf[place.block]) return null;
  if (following.kind === "figure" || !following.sentences.length) return null;
  return { block: place.block + 1, sentence: 0 };
}

/** For each block the number of its chapter, and for each chapter its last block that is not a
 * figure (-1 when it has none): { chapterOf, lastBlockOf }. */
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
    let lastText = -1;
    for (let blockIndex = chapter.firstBlock; blockIndex < endBlock; blockIndex++)
      if (book.blocks[blockIndex].kind !== "figure") lastText = blockIndex;
    lastBlockOf[chapterIndex] = lastText;
  });
  for (let blockIndex = 0; blockIndex < book.blocks.length; blockIndex++)
    if (chapterOf[blockIndex] === undefined) chapterOf[blockIndex] = 0;
  return { chapterOf, lastBlockOf };
}
