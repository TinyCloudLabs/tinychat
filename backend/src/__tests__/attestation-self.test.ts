import { describe, expect, test } from "bun:test";
import express, { type NextFunction, type Request, type Response } from "express";
import { privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";
import {
  BACKEND_ATTESTATION_PREFIX,
  buildBackendReportData,
  createDstackUnavailableError,
  selfAttest,
  type DstackClient,
} from "../attestation/selfAttest.js";
import { createAttestationSelfRouter } from "../routes/attestation-self.js";

const PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001";
const DID = `did:pkh:eip155:1:${privateKeyToAccount(PRIVATE_KEY).address}`;
const NONCE = "a".repeat(64);

function authStub(req: Request, res: Response, next: NextFunction) {
  if (!req.headers.authorization) {
    res.status(401).json({ error: "missing_token" });
    return;
  }
  req.user = { address: "0xUser" };
  next();
}

function createMockDstack(overrides?: Partial<DstackClient>) {
  const calls = { getQuote: 0, info: 0 };
  const client: DstackClient = {
    async getQuote(reportDataHex: string) {
      calls.getQuote += 1;
      return {
        quote: "0xquote",
        event_log: JSON.stringify([{ imr: 3, event: "compose-hash", digest: "0xabc" }]),
        report_data: reportDataHex,
      };
    },
    async info() {
      calls.info += 1;
      return {
        app_id: "app_123",
        instance_id: "instance_123",
        compose_hash: "0xabc",
        app_compose: "{\"services\":{}}",
        os_image_hash: "0xos",
      };
    },
    ...overrides,
  };
  return { client, calls };
}

function createApp(dstack: DstackClient) {
  const app = express();
  app.use(
    "/api/attestation/self",
    authStub,
    createAttestationSelfRouter({
      did: DID,
      privateKey: PRIVATE_KEY,
      dstack,
    }),
  );
  return app;
}

async function request(app: express.Express, path: string, init?: RequestInit) {
  const server = await new Promise<import("http").Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const { port } = server.address() as { port: number };
  try {
    return await fetch(`http://localhost:${port}${path}`, init);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("backend self-attestation", () => {
  test("builds report_data from exact prefix, backend address, and nonce bytes", async () => {
    const address = privateKeyToAccount(PRIVATE_KEY).address;
    const expected = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${BACKEND_ATTESTATION_PREFIX}${address}${NONCE}`),
    );
    const expectedHex = Array.from(new Uint8Array(expected), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");

    expect(await buildBackendReportData(address, NONCE)).toBe(expectedHex);
  });

  test("assembles the quote response and signs the fresh nonce with backend identity", async () => {
    const { client } = createMockDstack();

    const result = await selfAttest({
      privateKey: PRIVATE_KEY,
      did: DID,
      nonce: NONCE,
      dstack: client,
    });

    expect(result.identity).toMatchObject({
      did: DID,
      address: privateKeyToAccount(PRIVATE_KEY).address,
      nonce: NONCE,
    });
    expect(result.report_data).toHaveLength(64);
    expect(result.quote).toBe("0xquote");
    expect(result.event_log).toContain("compose-hash");
    expect(result.info).toMatchObject({ app_id: "app_123", compose_hash: "0xabc" });

    const recovered = await recoverMessageAddress({
      message: `${BACKEND_ATTESTATION_PREFIX}:${NONCE}`,
      signature: result.identity.nonce_signature,
    });
    expect(recovered).toBe(result.identity.address);
  });

  test("returns 400 for an invalid nonce before touching dstack", async () => {
    const { client, calls } = createMockDstack();

    const response = await request(createApp(client), "/api/attestation/self?nonce=bad", {
      headers: { Authorization: "Bearer test" },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_nonce",
      message: "nonce must be 32 bytes encoded as 64 hex characters",
    });
    expect(calls.getQuote).toBe(0);
    expect(calls.info).toBe(0);
  });

  test("returns 503 when dstack is unavailable", async () => {
    const { client } = createMockDstack({
      async getQuote() {
        throw createDstackUnavailableError("dstack socket is not available");
      },
    });

    const response = await request(createApp(client), `/api/attestation/self?nonce=${NONCE}`, {
      headers: { Authorization: "Bearer test" },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "attestation_unavailable",
      message: "dstack socket is not available",
    });
  });

  test("auth gate rejects unauthenticated callers before touching dstack", async () => {
    const { client, calls } = createMockDstack();

    const response = await request(createApp(client), `/api/attestation/self?nonce=${NONCE}`);

    expect(response.status).toBe(401);
    expect(calls.getQuote).toBe(0);
    expect(calls.info).toBe(0);
  });
});
