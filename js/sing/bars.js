// Bars of 8 slots from the phrases of a sentence score (SPEC_sing §6.2; 歌 ED D-03 to D-07, D-17 to D-20).
// A bar is a list of at most 8 morae: they are sung in its first slots, and the rest of the bar is rests (D-20).
export const SLOTS = 8;

/**
 * Cut the phrases (文節) of a sentence into bars. A phrase of up to 4 morae is joined to the
 * short phrases before it while they fit one bar together; a longer one starts a bar of its own
 * and fills whole bars first. A pause in the text closes the bar.
 */
export function barsOf(phrases) {
  const bars = [];
  let open = null; // a bar of joined short phrases that may still take more (D-06)
  const close = () => {
    if (open) {
      bars.push(open);
      open = null;
    }
  };
  for (const phrase of phrases) {
    let morae = phrase.morae;
    if (morae.length <= 4) {
      if (open && open.length + morae.length <= SLOTS)
        open = open.concat(morae); // joined, no rest between (Q-23)
      else {
        close();
        open = morae.slice();
      }
    } else {
      close();
      while (morae.length > SLOTS) {
        bars.push(morae.slice(0, SLOTS));
        morae = morae.slice(SLOTS);
      } // D-18: full bars first
      if (morae.length <= 4) open = morae.slice();
      else bars.push(morae.slice()); // 5 to 8 morae: a bar of its own (D-17, D-18)
    }
    if (phrase.pause) close(); // the rests fall where the text pauses (Q-23)
  }
  close();
  return bars;
}

/** A bar as "1" for each sung slot and "0" for each rest: 5 morae -> "11111000". */
export const rhythmOf = (bar) => "1".repeat(bar.length) + "0".repeat(SLOTS - bar.length);
