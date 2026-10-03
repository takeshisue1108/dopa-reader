// The levels of the bomb (SPEC_dopa v3 §6.5; ED D-67, D-89, D-91, A-30). Pure numbers: how many
// enemies shot give which level, which tier of explosion a level sets off, and how full the
// gauge to the next level is. The drawing is in bomb.js.

const FIRST = 5, // level 2 needs 5 enemies
  STEP = 1.6; // each level after it needs about 1.6 times the one before (D-89)

/** The level of a count: 0 for 0, 1 for 1 to 4, then 2 + floor(log₁.₆(n ÷ 5)). */
export function level(count) {
  if (count <= 0) return 0;
  if (count < FIRST) return 1;
  return 2 + Math.floor(Math.log(count / FIRST) / Math.log(STEP) + 1e-9);
}

/** The smallest count that has a level (0 for level 0, 1 for level 1). */
export function levelStart(L) {
  if (L <= 0) return 0;
  if (L === 1) return 1;
  let n = Math.max(FIRST, Math.floor(FIRST * STEP ** (L - 2)) - 2);
  while (level(n) < L) n++;
  while (n > 1 && level(n - 1) >= L) n--;
  return n;
}

// The five tiers of A-30, by level: 1–2 small, 3–4 medium, 5–6 large, 7–8 very large, 9+ largest.
export const TIERS = ["small", "medium", "large", "xlarge", "max"];
export const TIER_WORDS = { small: "小", medium: "中", large: "大", xlarge: "特大", max: "最大" };
export const TIER_SECONDS = { small: 0.5, medium: 1, large: 1.5, xlarge: 2, max: 2.5 };

/** The tier of a level, or null for level 0 (nothing explodes). */
export function tier(L) {
  if (L <= 0) return null;
  return TIERS[Math.min(4, Math.floor((L - 1) / 2))];
}

/** How full the gauge to the next level is, 0 to 1 (D-91: no numbers are shown). */
export function gauge(count) {
  const L = level(count),
    from = levelStart(L),
    to = levelStart(L + 1);
  return to > from ? (count - from) / (to - from) : 0;
}
