// Bars of 8 slots from the phrases of a sentence score (SPEC_sing §6.2; 歌 ED D-03 to D-07, D-17
// to D-20). A bar is a list of at most 8 morae: they are sung in its first slots, and the rest of
// the bar is rests (D-20).
export const SLOTS_PER_BAR = 8;

/**
 * Cut the phrases (文節) of a sentence into bars. A phrase of up to 4 morae is joined to the
 * short phrases before it while they fit one bar together (up to all 8 slots); a longer one
 * starts a bar of its own and fills whole bars first, and what is left of it, when 4 morae or
 * fewer, stays open like a short phrase for the short phrases after it. A pause in the text
 * closes the bar.
 */
export function barsOf(phrases) {
  const bars = [];
  let openBar = null; // a bar of joined short phrases that may still take more (D-06)
  const closeBar = () => {
    if (openBar) {
      bars.push(openBar);
      openBar = null;
    }
  };
  for (const phrase of phrases) {
    let remaining = phrase.morae;
    if (remaining.length <= 4) {
      if (openBar && openBar.length + remaining.length <= SLOTS_PER_BAR)
        openBar = openBar.concat(remaining); // joined, no rest between (Q-23)
      else {
        closeBar();
        openBar = remaining.slice();
      }
    } else {
      closeBar();
      while (remaining.length > SLOTS_PER_BAR) {
        bars.push(remaining.slice(0, SLOTS_PER_BAR));
        remaining = remaining.slice(SLOTS_PER_BAR);
      } // D-18: full bars first
      if (remaining.length <= 4) openBar = remaining.slice();
      else bars.push(remaining.slice()); // 5 to 8 morae: a bar of its own (D-17, D-18)
    }
    if (phrase.pause) closeBar(); // the rests fall where the text pauses (Q-23)
  }
  closeBar();
  return bars;
}

/** A bar as "1" for each sung slot and "0" for each rest: 5 morae -> "11111000". */
export const rhythmOf = (bar) => "1".repeat(bar.length) + "0".repeat(SLOTS_PER_BAR - bar.length);
