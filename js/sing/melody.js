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
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const match = line.match(/^([ABCS])\s+\[?([0-9-]{8})\]?$/);
    if (!match) {
      skipped.push(rawLine);
      continue;
    }
    // the fragment's rests are not used (D-19)
    const steps = [...match[2]].filter((char) => char !== "-").map(Number);
    if (steps.length) byKind[match[1]].push({ kind: match[1], pattern: match[2], steps });
    else skipped.push(rawLine);
  }
  // a kind with no fragment uses A's
  for (const kind of KINDS) if (!byKind[kind].length) byKind[kind] = byKind.A;
  return { fragments: byKind, skipped };
}

/** The kind of a bar (0-based) from the progression's form; without a form, blocks of 4 bars: A,
 * A, B, S. */
export function kindAt(form, barIndex) {
  if (!form || !form.sections || !form.sections.length)
    return ["A", "A", "B", "S"][Math.floor(barIndex / 4) % 4];
  let kind = form.sections[0].kind;
  for (const section of form.sections) if (section.bar - 1 <= barIndex) kind = section.kind;
  return kind;
}

/** One fragment of the kind at random, never the one of the bar before when there is another
 * (D-10). A kind with no fragment takes A's. */
export function pick(fragments, kind, previous, random = Math.random) {
  const list = fragments[kind] && fragments[kind].length ? fragments[kind] : fragments.A;
  const pool = list.length > 1 ? list.filter((fragment) => fragment !== previous) : list;
  return pool[Math.floor(random() * pool.length)];
}

/** The step of each sung slot: the fragment's steps in order, starting again when they run out
 * (D-19). */
export const stepsFor = (fragment, sungCount) =>
  Array.from({ length: sungCount }, (_, slot) => fragment.steps[slot % fragment.steps.length]);
