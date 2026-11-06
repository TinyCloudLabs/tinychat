#!/usr/bin/env node
// Feed rig: merge a private overlay into the committed fixture.
//   node scripts/feed-rig-merge.mjs <fixture.json> <overlay.json> <out.json>
// overlay: { "replace": { "<cardId in the fixture>": <HomeFeedEntry> } }. Every fixture entry
// whose state.card.cardId has a replacement is swapped for it, in every state. Prints a count.
import { readFileSync, writeFileSync } from "node:fs";

const [fixturePath, overlayPath, outPath] = process.argv.slice(2);
if (!fixturePath || !overlayPath || !outPath) {
  console.error("usage: feed-rig-merge.mjs <fixture.json> <overlay.json> <out.json>");
  process.exit(2);
}
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const { replace = {} } = JSON.parse(readFileSync(overlayPath, "utf8"));
let swapped = 0;
const used = new Set();
for (const state of Object.values(fixture.states)) {
  const entries = state.snapshot?.entries;
  if (!Array.isArray(entries)) continue;
  state.snapshot.entries = entries.map((entry) => {
    const real = replace[entry.state.card.cardId];
    if (!real) return entry;
    swapped++;
    used.add(entry.state.card.cardId);
    return real;
  });
}
const unused = Object.keys(replace).filter((id) => !used.has(id));
if (unused.length) {
  console.error(`feed-rig-merge: overlay ids not found in the fixture: ${unused.join(", ")}`);
  process.exit(1);
}
writeFileSync(outPath, JSON.stringify(fixture));
console.log(`feed-rig-merge: replaced ${swapped} entries (${used.size} cards) from the private overlay`);
