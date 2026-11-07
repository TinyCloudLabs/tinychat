#!/usr/bin/env node
// Feed rig: merge a private overlay into the committed fixture.
//   node scripts/feed-rig-merge.mjs <fixture.json> <overlay.json> <out.json>
// overlay: { "replace": { "<cardId in the fixture>": <HomeFeedEntry> } }. Every fixture entry
// whose state.card.cardId has a replacement is swapped for it, in every state. A sample thread on
// a replaced typed card moves to the replacement's record, so it stays on that card, and a sample
// conversation on a replaced plain card (payload.replies, and its earlier revision with the owner's
// message in historicalEntries) moves onto the replacement. Prints a count.
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
    const from = entry.state.card.payload?.sitrep?.record;
    const to = real.state?.card?.payload?.sitrep?.record;
    if (from && to && Array.isArray(state.snapshot.sitrep?.threads)) {
      for (const message of state.snapshot.sitrep.threads) {
        if (message.kind === from.kind && message.id === from.id) { message.kind = to.kind; message.id = to.id; }
      }
    }
    const replies = entry.state.card.payload?.replies;
    if (Array.isArray(replies)) {
      const card = entry.state.card;
      const moved = structuredClone(real);
      moved.state.card = { ...moved.state.card, revision: card.revision, issuanceId: card.issuanceId, createdAt: card.createdAt, payload: { ...moved.state.card.payload, render: "thread", replies } };
      moved.view = { ...moved.view, revision: card.revision, issuanceId: card.issuanceId };
      return moved;
    }
    return real;
  });
  if (Array.isArray(state.snapshot.historicalEntries)) {
    state.snapshot.historicalEntries = state.snapshot.historicalEntries.map((entry) => {
      const real = replace[entry.state.card.cardId];
      if (!real) return entry;
      const { cardId, title, body, kind, choices, needsResponse } = real.state.card;
      const moved = structuredClone(entry);
      moved.source = real.source;
      const { replies: _replies, ...payload } = real.state.card.payload ?? {};
      moved.state.card = { ...moved.state.card, cardId, title, body, kind, needsResponse, urgency: real.state.card.urgency, payload: { ...payload, render: "thread" }, ...(choices ? { choices } : {}) };
      moved.view = { ...moved.view, sourceId: real.source.sourceId, cardId };
      moved.responses = (moved.responses ?? []).map((response) => ({ ...response, cardId }));
      return moved;
    });
  }
}
const unused = Object.keys(replace).filter((id) => !used.has(id));
if (unused.length) {
  console.error(`feed-rig-merge: overlay ids not found in the fixture: ${unused.join(", ")}`);
  process.exit(1);
}
writeFileSync(outPath, JSON.stringify(fixture));
console.log(`feed-rig-merge: replaced ${swapped} entries (${used.size} cards) from the private overlay`);
