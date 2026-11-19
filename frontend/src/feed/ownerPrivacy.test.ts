import { expect, test } from "bun:test";
import { inspect } from "node:util";
import { SQLService, ServiceContext } from "@tinycloud/sdk-services";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { createHomeFeedSource, HOME_FEED_RESOURCE } from "./feedStore";
import { savePrivateOwnerState } from "./sitrepOwnerStore";
import type { HomeFeedEntry } from "./feedStoreTypes";
import { syntheticRecord, SITREP_NOW } from "./sitrep.fixtures";

const marker = "SYNTHETIC-OWNER-PRIVATE-CODE-DO-NOT-LOG-21";
const session = { delegationHeader: { Authorization: "isolated-test-invocation" }, delegationCid: "isolated-cid", spaceId: "isolated-owner-privacy", verificationMethod: "did:key:isolated-test", jwk: {} };
const entry: HomeFeedEntry = {
  source: { sourceId: "isolated", agentDid: "did:key:isolated", label: "Isolated", output: { spaceId: session.spaceId, database: "xyz.tinycloud.tinychat/feed/feed_output_isolated" }, responses: { spaceId: session.spaceId, database: "xyz.tinycloud.tinychat/feed/feed_responses_isolated" } },
  state: { card: { cardId: "private-card", revision: 1, issuanceId: "private-issuance", kind: "task", needsResponse: true, title: "Private state rehearsal", body: "", urgency: 1, createdAt: SITREP_NOW, payload: { sitrep: { version: 1, record: syntheticRecord("task") } } }, response: null, acknowledgement: null, outcome: null },
  view: { sourceId: "isolated", cardId: "private-card", revision: 1, issuanceId: "private-issuance" },
};

// "feed-load" reads the registry (with the private owner events), fails, runs the schema batch and reads again.
for (const operation of ["feed-load", "private-write"] as const) {
  test(`${operation} never exposes a backend private-value echo to ordinary error subscribers`, async () => {
    // The Feed's private databases echo private values; the threads database (the default-view setting the load reads beside them) holds none.
    let echoed = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => /tinychat\/(home_feed|feed\/)/.test(request.headers.get("authorization") ?? "") && ++echoed
      ? Response.json({ error: marker, cause: { private: marker }, meta: { input: marker } }, { status: 400 })
      : Response.json({ error: "denied" }, { status: 400 }) });
    try {
      const context = new ServiceContext({ hosts: [server.url.href], session, invoke: (_session: unknown, _service: unknown, path: unknown) => ({ Authorization: `isolated-test-invocation ${String(path)}` }), retryPolicy: { maxAttempts: 1 } });
      const ordinary: unknown[] = [];
      context.on("service.error", (event) => ordinary.push(event));
      const sql = new SQLService(); sql.initialize(context);
      const database = sql.db(HOME_FEED_RESOURCE);
      const work = operation === "private-write" ? savePrivateOwnerState(database, entry, { eventId: "private-event", state: { kind: "task", id: "task-synthetic", steps: {}, notes: [{ at: SITREP_NOW, text: marker }], updatedAt: SITREP_NOW } })
        : createHomeFeedSource({ spaceId: session.spaceId, sql, hooks: {} } as unknown as TinyCloudWeb).load();
      let failure: unknown;
      try { await work; } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect(ordinary).toContainEqual(expect.objectContaining({ service: "sql", error: expect.objectContaining({ code: "SQL_ERROR" }) }));
      expect(echoed).toBeGreaterThan(0);
      expect(inspect({ failure, ordinary }, { depth: 20 })).not.toContain(marker);
    } finally { server.stop(true); }
  });
}
