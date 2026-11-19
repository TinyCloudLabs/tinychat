// Image addresses for the budget tests (imageBudget.ts): ordinary-looking, with a known amount of room for data.

/** A made-up word of ten letters, the same for the same seed. */
function madeUpWord(seed: string): string {
  let state = 2166136261;
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
  return Array.from({ length: 10 }, (_, i) => {
    state = (Math.imul(state ^ (state >>> 13), 0x5bd1e995) + i) >>> 0;
    const letters = i % 2 ? "aeiou" : "bcdfghjklmnprstvz";
    return letters[state % letters.length];
  }).join("");
}

/**
 * An address that loads on its own and has room for about 1,150 bits: seventeen made-up words that no other host or name
 * shares, so nothing in it is cheaper for having been sent before. Three of them fit in one reply's budget of 4,096 bits;
 * a fourth does not.
 */
export function heavyImageAddress(host: string, name = "p"): string {
  return `https://${host}/${name}/${Array.from({ length: 17 }, (_, i) => madeUpWord(`${host}/${name}/${i}`)).join("-")}.png`;
}
