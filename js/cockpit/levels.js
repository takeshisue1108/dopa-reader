// The levels of the bomb (SPEC_dopa v3 §6.5; ED D-67, D-89, D-91, A-30). Pure numbers: how many
// enemies shot give which level, which tier of explosion a level sets off, and how full the
// gauge to the next level is. The drawing is in bomb.js.

const LEVEL_2_COUNT = 5, // level 2 needs 5 enemies
  GROWTH = 1.6; // each level after it needs about 1.6 times the one before (D-89)

/** The level of a count: 0 for 0, 1 for 1 to 4, then 2 + floor(log₁.₆(n ÷ 5)). */
export function level(count) {
  if (count <= 0) return 0;
  if (count < LEVEL_2_COUNT) return 1;
  // 1e-9: a guard against a logarithm that comes out just under a whole number
  return 2 + Math.floor(Math.log(count / LEVEL_2_COUNT) / Math.log(GROWTH) + 1e-9);
}

/** The smallest count that has the level `wanted` (0 for level 0, 1 for level 1). It starts 2
 * under the formula's estimate and walks to the first count of that level, so that it always
 * agrees with level(). */
export function levelStart(wanted) {
  if (wanted <= 0) return 0;
  if (wanted === 1) return 1;
  let n = Math.max(LEVEL_2_COUNT, Math.floor(LEVEL_2_COUNT * GROWTH ** (wanted - 2)) - 2);
  while (level(n) < wanted) n++;
  while (n > 1 && level(n - 1) >= wanted) n--;
  return n;
}

// The five tiers of A-30, by level: 1–2 small, 3–4 medium, 5–6 large, 7–8 very large, 9+ largest.
export const TIERS = ["small", "medium", "large", "xlarge", "max"];
export const TIER_WORDS = { small: "小", medium: "中", large: "大", xlarge: "特大", max: "最大" };
export const TIER_SECONDS = { small: 0.5, medium: 1, large: 1.5, xlarge: 2, max: 2.5 };

/** The tier of a level, or null for level 0 (nothing explodes). */
export function tier(reached) {
  if (reached <= 0) return null;
  return TIERS[Math.min(4, Math.floor((reached - 1) / 2))];
}

/** How full the gauge to the next level is, 0 to 1 (D-91: no numbers are shown). */
export function gauge(count) {
  const reached = level(count),
    from = levelStart(reached),
    to = levelStart(reached + 1);
  return to > from ? (count - from) / (to - from) : 0;
}
