import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import { request, type Server } from "node:http";
import { createRequestContextMiddleware, normalizeRequestId, parseRequestIdFirstPartyOrigins, type RequestEvent } from "../request-context.js";
import { createTranscriptionApiClient } from "../services/transcription-api.js";
import { createPtxClient } from "../services/private-cloud-transcription.js";
// Vendored verbatim from TinyCloudLabs/tinycloud-dev, canonical commit:
// 76bd10752a52f179ac2a49214f488236d02f8192, ops/logging/request-id-vectors.json.
import shared from "./fixtures/request-id-vectors.json";

const httpCases = shared.cases.filter(vector => vector.name !== "padding" && vector.name !== "trailing-newline");
const additionalVersions = [
  "12345678-abcd-2abc-9abc-123456789abc",
  "12345678-abcd-3abc-aabc-123456789abc",
  "12345678-abcd-5abc-8abc-123456789abc",
  "12345678-abcd-6abc-9abc-123456789abc",
];
const minted = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const events: RequestEvent[] = [];
const outbound: Array<string | undefined> = [];
const servers: Server[] = [];
let url = "";

beforeAll(async () => {
  const ptx = express();
  ptx.use((req, res) => {
    outbound.push(req.get("x-request-id"));
    res.json({ id: "synthetic-meeting", status: "queued" });
  });
  const ptxReady = Promise.withResolvers<void>();
  const ptxServer = ptx.listen(0, "127.0.0.1", ptxReady.resolve);
  servers.push(ptxServer);
  await ptxReady.promise;
  const ptxAddress = ptxServer.address();
  if (!ptxAddress || typeof ptxAddress === "string") throw new Error("PTX fixture did not listen");
  const baseUrl = `http://127.0.0.1:${ptxAddress.port}`;
  const api = createTranscriptionApiClient({
    baseUrl, apiKey: "synthetic-first-party-key", requestIdFirstPartyOrigins: new Set([baseUrl]),
  });
  const app = express();
  app.use(createRequestContextMiddleware(event => events.push(event)));
  app.get("/meeting", (_req, res, next) => {
    api.getMeeting("synthetic-meeting").then(meeting => res.json(meeting), next);
  });
  const origins: Record<string, ReadonlySet<string> | undefined> = {
    absent: undefined,
    "wrong-port": new Set([`http://127.0.0.1:${ptxAddress.port + 1}`]),
    "wrong-scheme": new Set([`https://127.0.0.1:${ptxAddress.port}`]),
    "different-host": new Set([`http://localhost:${ptxAddress.port}`]),
    "path-only": new Set([baseUrl + "/v1/meetings"]),
    "host-suffix": new Set([`http://127.0.0.1.evil.invalid:${ptxAddress.port}`]),
  };
  app.get("/origin-policy/:client/:policy", (req, res, next) => {
    const config = { baseUrl, apiKey: "synthetic-key", requestIdFirstPartyOrigins: origins[req.params.policy] };
    const result = req.params.client === "dev"
      ? createTranscriptionApiClient(config).getMeeting("synthetic-meeting")
      : createPtxClient(config).request({
        method: "GET", path: "/v1/transcriptions/capabilities",
        correlationId: "00000000-0000-0000-0000-000000000000", maxBytes: 4096,
      });
    result.then(value => res.json(value), next);
  });
  const ready = Promise.withResolvers<void>();
  const server = app.listen(0, "127.0.0.1", ready.resolve);
  servers.push(server);
  await ready.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Backend fixture did not listen");
  url = `http://127.0.0.1:${address.port}/meeting`;
});

afterAll(async () => {
  for (const server of servers) {
    const closed = Promise.withResolvers<void>();
    server.closeAllConnections();
    server.close(() => closed.resolve());
    await closed.promise;
  }
});

async function requestWithFieldOccurrences(incoming: string[] | null) {
  const completed = Promise.withResolvers<{ status: number | undefined; id: string | undefined }>();
  const req = request(url, {
    agent: false, headers: incoming === null ? {} : { "x-request-id": incoming },
  }, res => {
    const header = res.headers["x-request-id"];
    res.on("error", completed.reject);
    res.once("end", () => completed.resolve({
      status: res.statusCode, id: typeof header === "string" ? header : undefined,
    }));
    res.resume();
  });
  req.on("error", completed.reject);
  req.end();
  return completed.promise;
}

describe("N0 exact shared request-ID vectors", () => {
  test.each(shared.cases.map(vector => [vector.name, vector] as const))("%s", (_name, vector) => {
    // The raw corpus includes values an HTTP parser rejects or normalizes before middleware.
    const normalized = normalizeRequestId(vector.incoming?.join(","));
    expect(normalized).toBe(vector.normalized);
    expect(normalized !== undefined).toBe(vector.accepted);
  });
});

describe("RFC 9562 request IDs across actual T→P HTTP", () => {
  test.each(httpCases.map(vector => [vector.name, vector] as const))("%s preserves canonical ID and replacement state", async (_name, vector) => {
    const response = await requestWithFieldOccurrences(vector.incoming);
    expect(response.status).toBe(200);
    if (vector.accepted) expect(response.id).toBe(vector.normalized);
    else expect(response.id).toMatch(minted);
    expect(outbound.at(-1)).toBe(response.id);
    const event = events.at(-1);
    expect(event).toEqual({
      event: "tinychat_request", request_id: response.id, request_id_replaced: vector.request_id_replaced,
      method: "GET", route: "/meeting", status: 200, duration_ms: expect.any(Number),
    });
    if (vector.request_id_replaced) {
      for (const rejected of vector.incoming ?? []) {
        if (rejected) expect(JSON.stringify(event)).not.toContain(rejected);
      }
    }
  });

  test.each(additionalVersions)("accepts the remaining RFC version %s", async incoming => {
    const response = await requestWithFieldOccurrences([incoming]);
    expect(response.id).toBe(incoming);
    expect(outbound.at(-1)).toBe(incoming);
  });

  test("rejected-value canary is absent from emitted request events and the actual PTX edge", async () => {
    const canary = "private-wallet-tenant-capability-transcript";
    const response = await requestWithFieldOccurrences([canary]);
    expect(response.id).toMatch(minted);
    expect(outbound.at(-1)).toBe(response.id);
    expect(JSON.stringify(events.at(-1))).not.toContain(canary);
  });

  for (const client of ["dev", "batch"]) {
    test.each(["absent", "wrong-port", "wrong-scheme", "different-host", "path-only", "host-suffix"])(
      `does not classify configured ${client} destinations as first-party under policy %s`,
      async policy => {
        const id = "12345678-abcd-1abc-8abc-123456789abc";
        const response = await fetch(new URL(`/origin-policy/${client}/${policy}`, url), { headers: { "x-request-id": id } });
        expect(response.status).toBe(200);
        expect(response.headers.get("x-request-id")).toBe(id);
        expect(outbound.at(-1)).toBeUndefined();
      },
    );
  }

  test("canonicalizes explicit origins and rejects non-origin classification without echoing configuration", () => {
    expect([...parseRequestIdFirstPartyOrigins("HTTPS://PTX.EXAMPLE:443,http://127.0.0.1:8080/")])
      .toEqual(["https://ptx.example", "http://127.0.0.1:8080"]);
    for (const value of ["https://ptx.example/path", "https://user:private-canary@ptx.example", "https://ptx.example/?", "https://ptx.example/#", "private-canary", "https://ptx.example,"]) {
      let failure: unknown;
      try { parseRequestIdFirstPartyOrigins(value); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain(value);
      expect(String(failure)).not.toContain("private-canary");
    }
  });
});
