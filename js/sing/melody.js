// Melody fragments: their file, the kind a bar asks for, and their steps onto the sung slots
// (SPEC_sing §5.3, §5.4, §6.4; 歌 ED D-11 to D-13, D-19, D-25). No browser dependency.
// A melody, B melody, C melody, and S for サビ (the chorus)
export const KINDS = ["A", "B", "C", "S"];

/** The fragments file as { fragments: { A, B, C, S }, skipped }. A line is "A  12321231" or
 * "A [--13245-]": a kind and 8 characters of 1-9, 0 (the step below the root) and - (a rest). A
 * line that is not understood, or that holds rests only, goes to `skipped`; what follows a # is a
 * comment. Only the order of a pattern's steps is used: its rests are dropped (D-19), since the
 * rhythm comes from the bar (bars.js). */
export function parseFragments(text) {
  const byKind = { A: [], B: [], C: [], S: [] };
  const skipped = [];

  const rawLines = text.split("\n");
  for (const rawLine of rawLines) {
    const withoutComment = rawLine.replace(/#.*/, "");
    const line = withoutComment.trim();
    if (!line) {
      continue;
    }

    const match = line.match(/^([ABCS])\s+\[?([0-9-]{8})\]?$/);
    if (!match) {
      skipped.push(rawLine);
      continue;
    }
    const kind = match[1];
    const pattern = match[2];

    // the fragment's rests are not used (D-19)
    const steps = [];
    for (const char of pattern) {
      if (char !== "-") {
        const step = Number(char);
        steps.push(step);
      }
    }

    if (steps.length) {
      const fragment = {
        kind,
        pattern,
        steps,
      };
      byKind[kind].push(fragment);
    } else {
      skipped.push(rawLine);
    }
  }

  // a kind with no fragment uses A's
  for (const kind of KINDS) {
    if (!byKind[kind].length) {
      byKind[kind] = byKind.A;
    }
  }

  return {
    fragments: byKind,
    skipped,
  };
}

/** The kind of a bar (0-based) from the progression's form; without a form, blocks of 4 bars: A,
 * A, B, S. */
export function kindAt(form, barIndex) {
  if (!form || !form.sections || !form.sections.length) {
    const block = Math.floor(barIndex / 4);
    return ["A", "A", "B", "S"][block % 4];
  }

  // the last section that starts at or before the bar; a section's `bar` is counted from 1
  let kind = form.sections[0].kind;
  for (const section of form.sections) {
    const sectionStart = section.bar - 1;
    if (sectionStart <= barIndex) {
      kind = section.kind;
    }
  }

  return kind;
}

/** One fragment of the kind at random, never the one of the bar before when there is another
 * (D-10). A kind with no fragment takes A's. */
export function pick(fragments, kind, previous, random = Math.random) {
  let list = fragments.A;
  if (fragments[kind] && fragments[kind].length) {
    list = fragments[kind];
  }

  let pool = list;
  if (list.length > 1) {
    pool = list.filter((fragment) => fragment !== previous);
  }

  const chance = random();
  const place = Math.floor(chance * pool.length);
  return pool[place];
}

/** The step of each sung slot: the fragment's steps in order, starting again when they run out
 * (D-19). */
export function stepsFor(fragment, sungCount) {
  const stepOfSlot = (_, slot) => {
    const place = slot % fragment.steps.length;
    return fragment.steps[place];
  };

  return Array.from({ length: sungCount }, stepOfSlot);
}
