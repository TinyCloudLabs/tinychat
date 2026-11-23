import { describe, expect, test } from "bun:test";
import type { SessionStore } from "@tinyboilerplate/client";
import type { DisconnectImportGrants } from "./connectorLifecycle";
import { createFirefliesImportGrantsClient, withPendingRevokes } from "./firefliesImportGrantsApi";
import type { ConnectorWebhooksResult } from "./webhooksApi";

const BACKEND = "https://api.example";
const sessionStore = { getToken: () => "t0ken", isExpired: () => false } as unknown as SessionStore;

function clientAnswering(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const requests: Array<{ url: string; method: string | undefined }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), method: init?.method });
    return respond(String(input), init ?? {});
  }) as typeof fetch;
  return { client: createFirefliesImportGrantsClient(BACKEND, { sessionStore, fetchImpl }), requests };
}

describe("Fireflies import grants client", () => {
  test("lists the two permission ids from the grants route", async () => {
    const { client, requests } = clientAnswering(() => Response.json({ grantCids: ["a", "b"] }));

    expect(await client.listGrantCids()).toEqual({ status: "ok", value: ["a", "b"] });
    expect(requests).toEqual([{ url: `${BACKEND}/api/connectors/fireflies/delegation/grants`, method: "GET" }]);
  });

  test("an answer that is not a list of ids is a failure, never an empty list", async () => {
    for (const body of [{}, { grantCids: "a" }, { grantCids: ["a", 7] }, { grantCids: [""] }]) {
      const { client } = clientAnswering(() => Response.json(body));
      expect((await client.listGrantCids()).status).toBe("rejected");
    }
  });

  test("a missing route means the server holds nothing; a server error is retryable", async () => {
    expect((await clientAnswering(() => new Response(null, { status: 404 })).client.listGrantCids()).status).toBe("feature-dark");
    expect((await clientAnswering(() => new Response(null, { status: 503 })).client.listGrantCids()).status).toBe("retryable");
  });

  test("removes the stored permissions with a DELETE on the delegation route", async () => {
    const { client, requests } = clientAnswering(() => new Response(null, { status: 204 }));

    expect(await client.removeGrant()).toEqual({ status: "ok", value: null });
    expect(requests).toEqual([{ url: `${BACKEND}/api/connectors/fireflies/delegation`, method: "DELETE" }]);
  });
});

describe("ids kept in this browser until each permission is withdrawn", () => {
  function memoryStore() {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    };
  }
  function inner(listed: ConnectorWebhooksResult<string[]>, revoked: (cid: string) => boolean) {
    const revokeCalls: string[] = [];
    const grants: DisconnectImportGrants = {
      listGrantCids: async () => listed,
      revoke: async (cid) => {
        revokeCalls.push(cid);
        return revoked(cid);
      },
    };
    return { grants, revokeCalls };
  }

  test("an unconfirmed revoke is offered again on the next run, even when the server then lists nothing", async () => {
    const store = memoryStore();
    const first = inner({ status: "ok", value: ["a", "b"] }, (cid) => cid === "a");
    const run1 = withPendingRevokes(first.grants, { accountKey: "0xabc", store });
    expect(await run1.listGrantCids()).toEqual({ status: "ok", value: ["a", "b"] });
    await run1.revoke("a");
    await run1.revoke("b");

    // The server already dropped its copy, so it lists nothing; the browser still knows "b" is open.
    const second = inner({ status: "ok", value: [] }, () => true);
    const run2 = withPendingRevokes(second.grants, { accountKey: "0xabc", store });
    expect(await run2.listGrantCids()).toEqual({ status: "ok", value: ["b"] });
    await run2.revoke("b");
    expect(store.map.size).toBe(0);
  });

  test("a run abandoned after listing keeps the ids; a server with the import off still yields them", async () => {
    const store = memoryStore();
    await withPendingRevokes(inner({ status: "ok", value: ["a", "b"] }, () => true).grants, { accountKey: "0xabc", store }).listGrantCids();

    const off = withPendingRevokes(inner({ status: "feature-dark" }, () => true).grants, { accountKey: "0xabc", store });
    expect(await off.listGrantCids()).toEqual({ status: "ok", value: ["a", "b"] });
  });

  test("ids are per account, a failed listing stays a failure, and entries older than 8 days are dropped", async () => {
    const store = memoryStore();
    let now = 1_000;
    const mine = withPendingRevokes(inner({ status: "ok", value: ["a"] }, () => false).grants, { accountKey: "0xabc", store, now: () => now });
    await mine.listGrantCids();

    const other = withPendingRevokes(inner({ status: "ok", value: [] }, () => true).grants, { accountKey: "0xdef", store, now: () => now });
    expect(await other.listGrantCids()).toEqual({ status: "ok", value: [] });

    const failing = withPendingRevokes(inner({ status: "retryable", httpStatus: 503, code: null }, () => true).grants, { accountKey: "0xabc", store });
    expect((await failing.listGrantCids()).status).toBe("retryable");

    now += 8 * 24 * 60 * 60 * 1000 + 1;
    const later = withPendingRevokes(inner({ status: "ok", value: [] }, () => true).grants, { accountKey: "0xabc", store, now: () => now });
    expect(await later.listGrantCids()).toEqual({ status: "ok", value: [] });
  });
});

describe("status and submit", () => {
  test("status reads the state, end date, delegate and ids; a malformed answer is a failure", async () => {
    const good = { state: "active", expiresAt: "2026-11-29T17:00:00.000Z", delegateDid: "did:key:z6Mk", grantCids: ["a", "b"] };
    const { client, requests } = clientAnswering(() => Response.json(good));
    expect(await client.status()).toEqual({ status: "ok", value: good });
    expect(requests).toEqual([{ url: `${BACKEND}/api/connectors/fireflies/delegation/status`, method: "GET" }]);

    for (const body of [{ ...good, state: "weird" }, { ...good, delegateDid: 7 }, { ...good, grantCids: [""] }, { ...good, expiresAt: 5 }]) {
      expect((await clientAnswering(() => Response.json(body)).client.status()).status).toBe("rejected");
    }
  });

  test("submit posts the pair as JSON and reads the end date; a 400 is rejected, a 503 retryable", async () => {
    let sent: { body?: unknown; type?: string | null } = {};
    const { client } = clientAnswering((_url, init) => {
      sent = { body: JSON.parse(String(init.body)), type: new Headers(init.headers).get("content-type") };
      return Response.json({ state: "active", expiresAt: "2026-11-29T17:00:00.000Z" });
    });
    const pair = { secretsGrant: "s", meetingsGrant: "m", siwe: "w", signature: "g" };
    expect(await client.submit(pair, ["old-1", "old-2"])).toEqual({ status: "ok", value: { state: "active", expiresAt: "2026-11-29T17:00:00.000Z" } });
    expect(sent).toEqual({ body: { ...pair, replaces: ["old-1", "old-2"] }, type: "application/json" });

    expect((await clientAnswering(() => Response.json({ error: "bad" }, { status: 400 })).client.submit(pair, [])).status).toBe("rejected");
    // A refusal because the ids named are not the ids held is a 409: the pair is not saved.
    expect((await clientAnswering(() => Response.json({ error: "replaces_mismatch" }, { status: 409 })).client.submit(pair, ["a", "b"])).status).toBe("rejected");
    expect((await clientAnswering(() => new Response(null, { status: 503 })).client.submit(pair, [])).status).toBe("retryable");
  });
});
