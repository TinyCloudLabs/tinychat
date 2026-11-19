// A Rocinante question in the Home feed with a field the card does not draw, so its Details has both columns (the
// "Not shown" list beside the "This card" rail from 900px), and an agent ID long enough to test the rail's width.
// Driven by test/home-feed-details-layout.e2e.test.ts (Clarissa, #711: the rail ran 170px under the list at 1280).
import { FeedViewEntries } from "@/feed/FeedView";
import type { HomeFeedEntry, HomeFeedSnapshot, HomeFeedSource } from "@/feed/feedStoreTypes";
import { syntheticRecord } from "@/feed/sitrep.fixtures";
import type { HarnessScreen } from "../screen";

function source(): HomeFeedSource {
  const record: Record<string, unknown> = { ...syntheticRecord("ask"), from: "Holden", title: "Seed the doc reviewer on tee?" };
  const cardId = `synthetic-ask-${String(record.id)}`;
  const owner = { answers: [], states: [], claimDecisions: [], threads: [], deliveries: [], heldNotes: [] };
  const entry = {
    source: { sourceId: "rocinante", agentDid: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK", label: "Rocinante", output: { spaceId: "owner", database: "xyz.tinycloud.tinychat/feed/feed_output_rocinante" }, responses: { spaceId: "owner", database: "xyz.tinycloud.tinychat/feed/feed_responses_rocinante" } },
    state: {
      card: { cardId, revision: 1, issuanceId: "issuance-1", kind: "ask", needsResponse: true, title: String(record.title), body: String(record.body), urgency: 2, createdAt: String(record.createdAt),
        payload: { sitrep: { version: 1, record }, project: "doc-reviewer-seed", source: { label: "Rocinante board", ref: "xyz.tinycloud.rocinante/board/ask/doc-reviewer-seed-needs-host-or-production" }, reviewer: { host: "tee", attempts: 2 } } },
      response: null, acknowledgement: null, outcome: null,
    },
    view: { sourceId: "rocinante", cardId, revision: 1, issuanceId: "issuance-1" },
  } as unknown as HomeFeedEntry;
  const snapshot = { entries: [entry], settings: { defaultSelector: "needs-action" } } as unknown as HomeFeedSnapshot;
  const quiet = async () => {};
  return {
    async load() { return Object.assign(structuredClone(snapshot), { sitrep: structuredClone(owner) }); },
    async saveResponse(_entry: unknown, response: Record<string, unknown>) { return { ...response, sequence: 1 }; },
    saveOwnerState: quiet, saveHeldNote: quiet, markSeen: quiet, snooze: quiet, setDefaultSelector: quiet,
    subscribe() { return () => {}; },
  } as unknown as HomeFeedSource;
}

export const homeFeedDetailsScreens: HarnessScreen[] = [
  { id: "home-feed-details", group: "homeFeedDetails", layout: "document", interactive: true, render: () => <FeedViewEntries realEntries={[]} source={source()} /> },
];
