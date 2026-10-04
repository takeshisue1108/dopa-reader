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

  // a bar of joined short phrases that may still take more (D-06)
  let openBar = null;

  const closeBar = () => {
    if (openBar) {
      bars.push(openBar);
      openBar = null;
    }
  };

  for (const phrase of phrases) {
    let remaining = phrase.morae;

    if (remaining.length <= 4) {
      let fitsOpenBar = false;
      if (openBar) {
        const joinedLength = openBar.length + remaining.length;
        fitsOpenBar = joinedLength <= SLOTS_PER_BAR;
      }

      if (fitsOpenBar) {
        // joined, no rest between (Q-23)
        openBar = openBar.concat(remaining);
      } else {
        closeBar();
        openBar = remaining.slice();
      }
    } else {
      closeBar();

      // D-18: full bars first
      while (remaining.length > SLOTS_PER_BAR) {
        const fullBar = remaining.slice(0, SLOTS_PER_BAR);
        bars.push(fullBar);
        remaining = remaining.slice(SLOTS_PER_BAR);
      }

      if (remaining.length <= 4) {
        openBar = remaining.slice();
      } else {
        // 5 to 8 morae: a bar of its own (D-17, D-18)
        const ownBar = remaining.slice();
        bars.push(ownBar);
      }
    }

    // the rests fall where the text pauses (Q-23)
    if (phrase.pause) {
      closeBar();
    }
  }

  closeBar();
  return bars;
}

/** A bar as "1" for each sung slot and "0" for each rest: 5 morae -> "11111000". */
export function rhythmOf(bar) {
  const sungSlots = "1".repeat(bar.length);
  const restSlots = "0".repeat(SLOTS_PER_BAR - bar.length);
  return sungSlots + restSlots;
}
