import { expect, test } from "bun:test";
import { stubSdkDomGlobals } from "../../test/sdkDomGlobals";

// The web SDK needs DOM globals during module evaluation in Bun's test runtime.
const restore = stubSdkDomGlobals();
const { createConnectorWebhooksClient } = await import("./webhooksApi");
restore();

test("per-item Fireflies deletion records only the selected id and clears its ledger on allow-back", async () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const api = createConnectorWebhooksClient("https://backend.example", {
    sessionStore: { getToken: () => "token", isExpired: () => false } as never,
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  expect((await api.recordDeleted("fireflies", "ff-1")).status).toBe("ok");
  expect((await api.clearDeleted("fireflies")).status).toBe("ok");
  expect(calls).toEqual([
    { url: "https://backend.example/api/connectors/webhooks/deleted", method: "POST", body: { source: "fireflies", meetingId: "ff-1" } },
    { url: "https://backend.example/api/connectors/webhooks/deleted", method: "DELETE", body: { source: "fireflies" } },
  ]);
});
