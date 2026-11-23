import { describe, expect, test } from "bun:test";
import type { SessionStore } from "@tinyboilerplate/client";
import { createFirefliesImportGrantsClient } from "./firefliesImportGrantsApi";

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
