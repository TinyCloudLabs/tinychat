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

// The two numbers below go with the limits in imageAddressBits.ts. When a limit changes, change them here and nowhere
// else: the tests that use this file count from HEAVY_THAT_FIT. The fixture test in imageBudget.test.ts says when they
// no longer fit together.
const HEAVY_WORDS = 22;
/** How many heavy addresses load in one reply before its budget is used up. */
export const HEAVY_THAT_FIT = 5;

/**
 * An address that loads on its own and has a lot of room for data (about 1,450 bits): made-up words that no other host or
 * name shares, so nothing in it is cheaper for having been sent before. Keep `name` short: a long one takes the address
 * past what one address may have.
 */
export function heavyImageAddress(host: string, name = "p"): string {
  return `https://${host}/${name}/${Array.from({ length: HEAVY_WORDS }, (_, i) => madeUpWord(`${host}/${name}/${i}`)).join("-")}.png`;
}

/** Hosts for a reply of heavy images in which the last two must wait: a.example, b.example, and so on. */
export const HEAVY_HOSTS: readonly string[] = Array.from({ length: HEAVY_THAT_FIT + 2 }, (_, i) => `${"abcdefghijklmnopqrstuvwxyz"[i]}.example`);
