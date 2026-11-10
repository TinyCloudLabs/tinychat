// E2E driver: connect + key custody. See docs/connectors-spec.md §10 driver 1.
//
// Real FirefliesClient over real HTTP to the mock upstream at an ephemeral port.
// Real connectorSecrets wrapper against the fake-tinycloud FakeSecrets/FakeKv/FakeSqlDb.
//
// What this driver covers:
//   1. Vacuity guard — buildSeed() > 0 AND the mock serves > 0 transcripts on the
//      wire, so a broken mock upstream can't produce green tests below.
//   2. validateKey() happy — returns { ok: true } with a user shape.
//   3. validateKey() invalid-key mode — returns typed { ok: false, error.kind:
//      "invalid-key" } (NOT network-error, NOT graphql-error).
//   4. Connect-flow key custody — running the exact validate → unlock → save
//      steps the ConnectorDialog runs stores the key ONLY in fake secrets at
//      the global `FIREFLIES_API_KEY` path shared with Listen. It appears NOWHERE in fake
//      KV or fake SQL — the connect step must not touch data storage.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  FirefliesClient,
  type FirefliesResult,
  type FirefliesUser,
} from "../../frontend/src/lib/connectors/firefliesClient";
import {
  isSecretsUnlocked,
  saveConnectorKey,
  unlockSecrets,
} from "../../frontend/src/lib/connectors/connectorSecrets";
import { CONNECTORS } from "../../frontend/src/lib/connectors/registry";
import type { ConnectorDescriptor } from "../../frontend/src/lib/connectors/types";

import { makeFakeTinyCloud } from "./fake-tinycloud";
import { buildSeed, startMockFireflies } from "./mock-fireflies.mjs";

interface Handle {
  url: string;
  port: number;
  seed: unknown[];
  counts: Record<string, number>;
  resetCounters: () => void;
  stop: () => Promise<void>;
}

const FIREFLIES: ConnectorDescriptor = CONNECTORS.find(
  (c) => c.id === "fireflies",
)!;

const HAPPY_KEY = "sk-fire-happy-connect-e2e";
const BAD_KEY = "sk-fire-invalid-connect-e2e";

let handle: Handle;

beforeAll(async () => {
  handle = (await startMockFireflies({ mode: "happy" })) as unknown as Handle;
});

afterAll(async () => {
  await handle.stop();
});

describe("connect + key custody e2e (spec §10 driver 1)", () => {
  test("vacuity guard — seed is non-empty AND the mock serves > 0 transcripts over real HTTP", async () => {
    const seed = buildSeed();
    expect(seed.length).toBeGreaterThan(0);
    // Also assert on the wire so a bad HTTP shape can't produce a false green.
    const res = await fetch(handle.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${HAPPY_KEY}`,
      },
      body: JSON.stringify({
        query:
          "query ListTranscripts($limit: Int, $skip: Int) { transcripts(limit: $limit, skip: $skip) { id title date duration organizer_email } }",
        variables: { limit: 5, skip: 0 },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data?: { transcripts?: unknown[] };
    };
    expect(Array.isArray(body.data?.transcripts)).toBe(true);
    expect((body.data?.transcripts ?? []).length).toBeGreaterThan(0);
  });

  test("validateKey happy: real HTTP round-trip to mock returns { ok: true, data: user }", async () => {
    handle.resetCounters();
    const client = new FirefliesClient({
      apiKey: HAPPY_KEY,
      apiUrl: handle.url,
      delayMs: 0,
    });
    const res: FirefliesResult<FirefliesUser> = await client.validateKey();
    expect(res.ok).toBe(true);
    if (res.ok) {
      // The mock returns { name: "Mock User", email: "mock@example.com" }.
      expect(res.data.email).toBeTruthy();
    }
    // The user op fired exactly once (no retries on the happy path).
    expect(handle.counts.user).toBe(1);
  });

  test("validateKey invalid-key: typed { kind: 'invalid-key' } — NOT network-error, NOT graphql-error", async () => {
    handle.resetCounters();
    // Point the client at the mock with a per-request header instructing
    // invalid-key mode via a wrapping fetch. We can't set headers through
    // FirefliesClient directly, so wrap fetch to inject the mode header.
    const invalidFetch: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers ?? undefined);
      headers.set("x-mock-mode", "invalid-key");
      return fetch(input, { ...init, headers });
    };
    const client = new FirefliesClient({
      apiKey: BAD_KEY,
      apiUrl: handle.url,
      fetchImpl: invalidFetch,
      delayMs: 0,
    });
    const res = await client.validateKey();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.kind).toBe("invalid-key");
      // Guardrails: must not be misclassified.
      expect(res.error.kind).not.toBe("network-error");
      expect(res.error.kind).not.toBe("graphql-error");
    }
  });

  test("connect flow logic stores the key ONLY as the global Listen-compatible secret — nothing in KV or SQL", async () => {
    handle.resetCounters();
    const fake = makeFakeTinyCloud();

    // Precondition: the fake starts empty in every surface. If not, the
    // "nothing in KV/SQL" assertion below is meaningless.
    expect(fake.secrets.store.size).toBe(0);
    expect(fake.kv.entries.size).toBe(0);
    expect(fake.sql.meetings.size).toBe(0);
    expect(fake.sql.states.size).toBe(0);

    // 1. Validate — real HTTP against real mock.
    const client = new FirefliesClient({
      apiKey: HAPPY_KEY,
      apiUrl: handle.url,
      delayMs: 0,
    });
    const validated = await client.validateKey();
    expect(validated.ok).toBe(true);

    // 2. Unlock secrets (the ConnectorDialog does this before saving).
    expect(isSecretsUnlocked(fake.tcw)).toBe(false);
    const unlocked = await unlockSecrets(fake.tcw);
    expect(unlocked.ok).toBe(true);
    expect(isSecretsUnlocked(fake.tcw)).toBe(true);

    // 3. Save the key via the same wrapper the dialog uses.
    const saved = await saveConnectorKey(fake.tcw, FIREFLIES, HAPPY_KEY);
    expect(saved.ok).toBe(true);

    // The key MUST land in the global namespace — never anywhere else.
    expect(fake.secrets.has(FIREFLIES.secretScope, FIREFLIES.secretName)).toBe(
      true,
    );
    // Only one (scope, name) pair, and it is the shared Fireflies key.
    expect(fake.secrets.store.size).toBe(1);
    const global = fake.secrets.store.get("");
    expect(global?.size).toBe(1);
    expect(global?.get(FIREFLIES.secretName)).toBe(HAPPY_KEY);

    // Custody guard: the raw key value MUST NOT appear anywhere else.
    for (const [k, v] of fake.kv.entries) {
      expect(k).not.toContain(HAPPY_KEY);
      expect(v).not.toContain(HAPPY_KEY);
    }
    for (const row of fake.sql.meetings.values()) {
      expect(JSON.stringify(row)).not.toContain(HAPPY_KEY);
    }
    for (const row of fake.sql.states.values()) {
      expect(JSON.stringify(row)).not.toContain(HAPPY_KEY);
    }

    // The connect step must not have written any rows to KV or SQL at all.
    expect(fake.kv.entries.size).toBe(0);
    expect(fake.sql.meetings.size).toBe(0);
    expect(fake.sql.states.size).toBe(0);
    // And no SQL db was requested — connect never touches the SQL surface.
    expect(fake.dbNamesRequested).toEqual([]);
  });
});
