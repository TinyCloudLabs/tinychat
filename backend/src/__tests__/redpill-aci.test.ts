import { describe, expect, test } from "bun:test";
import type { AciConnection, AciReceiptAudit, ConnectAciOptions } from "@phala/aci-verifier/runtime";
import { createRedPillAciFetch, RedPillAttestationError } from "../redpill-aci.js";

const BASE_URL = "https://tee.redpill.ai/v1";
const RECEIPT_ID = "fixture-receipt-001";
const VERIFIED_AUDIT = {
  receiptId: RECEIPT_ID,
  transcript: { verdict: { verified: true } },
} as AciReceiptAudit;

function connectionFixture(options: {
  identityVerified?: boolean;
  responseHeaders?: HeadersInit;
  audit?: AciReceiptAudit;
}) {
  const calls: Array<{ url: string; body: string }> = [];
  const verified: string[] = [];
  const connection = {
    baseURL: BASE_URL,
    identity: { transcript: { verdict: { verified: options.identityVerified ?? true } } },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body ?? "") });
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream", "x-receipt-id": RECEIPT_ID, ...Object.fromEntries(new Headers(options.responseHeaders)) },
      });
    },
    verifyReceipt: async (id?: string) => {
      verified.push(id ?? "");
      return options.audit ?? VERIFIED_AUDIT;
    },
    receipts: () => [],
    refresh: async () => {},
    close: async () => {},
  } as unknown as AciConnection;
  return { connection, calls, verified };
}

describe("RedPill ACI fetch", () => {
  test("adds the verified-upstream constraint and audits the exact response receipt", async () => {
    const fixture = connectionFixture({});
    let optionsSeen: ConnectAciOptions | undefined;
    const fetch = createRedPillAciFetch(BASE_URL, async (options) => {
      optionsSeen = options;
      return fixture.connection;
    });

    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "z-ai/glm-5.3", messages: [{ role: "user", content: "fixture prompt" }] }),
    });

    expect(optionsSeen).toMatchObject({ baseURL: BASE_URL, serving: { requireVerified: true, requireReceipt: true } });
    expect(JSON.parse(fixture.calls[0].body).provider).toEqual({ aci_verified: true });
    expect(fixture.verified).toEqual([RECEIPT_ID]);
    expect(await response.text()).toBe("data: [DONE]\n\n");
  });

  test("does not release response bytes when the receipt verdict is unverified", async () => {
    const fixture = connectionFixture({ audit: { ...VERIFIED_AUDIT, transcript: { verdict: { verified: false } } } as AciReceiptAudit });
    const fetch = createRedPillAciFetch(BASE_URL, async () => fixture.connection);

    await expect(fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "z-ai/glm-5.3", messages: [] }),
    })).rejects.toBeInstanceOf(RedPillAttestationError);
    expect(fixture.verified).toEqual([RECEIPT_ID]);
  });

  test("refuses a successful completion without a receipt id", async () => {
    const fixture = connectionFixture({ responseHeaders: { "x-receipt-id": "" } });
    const fetch = createRedPillAciFetch(BASE_URL, async () => fixture.connection);

    await expect(fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "z-ai/glm-5.3", messages: [] }),
    })).rejects.toBeInstanceOf(RedPillAttestationError);
    expect(fixture.verified).toEqual([]);
  });

  test("refuses a model request if the gateway identity is not verified", async () => {
    const fixture = connectionFixture({ identityVerified: false });
    const fetch = createRedPillAciFetch(BASE_URL, async () => fixture.connection);

    await expect(fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "z-ai/glm-5.3", messages: [] }),
    })).rejects.toBeInstanceOf(RedPillAttestationError);
    expect(fixture.calls).toEqual([]);
  });
});
