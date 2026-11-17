// TC-3166: account deletion also clears the account's private cloud transcription jobs (voice notes and uploads)
// and PROVES it: PTX's own list for that tenant must come back empty. Fake PTX only; no real job is touched.

import { describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import express from "express";

import { createPrivateCloudOnlyBulkDeleteRouter, createTranscriberRouter } from "../routes/transcriber.js";
import { createPrivateCloudPurger, PrivateCloudPurgeError } from "../services/private-cloud-purge.js";
import { PtxTransportError, tenantRefFor, type PtxClient, type PtxRequest, type PtxResponse } from "../services/private-cloud-transcription.js";
import { MemoryTranscriberIndexStore } from "../services/transcriber-index.js";
import type { TranscriptionApiClient } from "../services/transcription-api.js";

const KEY = "k".repeat(32);
const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const jobId = (n: number) => `trn_${String(n).padStart(26, "0")}`;

type DeleteBehavior = "delete" | "keep" | "fail" | "gone";

/** A PTX that scopes jobs by tenant ref, lists at most `limit` newest first (no cursor), and deletes by id. */
function fakePtx() {
  const jobs = new Map<string, Set<string>>();
  const requests: PtxRequest[] = [];
  const behavior = new Map<string, DeleteBehavior>();
  let down = false;
  let listBody: ((ids: string[]) => unknown) | undefined;
  const add = (address: string, count: number, from = 1) => {
    const ref = tenantRefFor(KEY, address);
    const set = jobs.get(ref) ?? new Set<string>();
    for (let n = from; n < from + count; n++) set.add(jobId(n));
    jobs.set(ref, set);
  };
  const idsOf = (address: string) => [...(jobs.get(tenantRefFor(KEY, address)) ?? [])];
  const client: PtxClient = {
    async request(request): Promise<PtxResponse> {
      requests.push(request);
      if (down) throw new PtxTransportError("connection refused");
      const set = jobs.get(request.tenantRef ?? "") ?? new Set<string>();
      if (request.method === "GET") {
        const limit = Number(new URL(request.path, "http://ptx").searchParams.get("limit"));
        const ids = [...set].slice(0, limit);
        return { status: 200, body: listBody ? listBody(ids) : { data: ids.map((id) => ({ id })) }, retryAfter: null };
      }
      const id = request.path.split("/").pop()!;
      const mode = behavior.get(id) ?? "delete";
      if (mode === "fail") return { status: 500, body: {}, retryAfter: null };
      if (mode === "gone") { set.delete(id); return { status: 404, body: {}, retryAfter: null }; }
      if (!set.has(id)) return { status: 404, body: {}, retryAfter: null };
      if (mode === "delete") set.delete(id);
      return { status: 204, body: null, retryAfter: null };
    },
  };
  return {
    client, add, idsOf, requests, behavior,
    setDown: (value: boolean) => { down = value; },
    setListBody: (fn: ((ids: string[]) => unknown) | undefined) => { listBody = fn; },
  };
}

describe("createPrivateCloudPurger", () => {
  test("drains more jobs than one page, and only for the caller's tenant ref", async () => {
    const ptx = fakePtx();
    ptx.add(OWNER, 120);
    ptx.add(OTHER, 3, 1000);
    const deleted = await createPrivateCloudPurger(ptx.client, KEY).purge(OWNER);
    expect(deleted).toBe(120);
    expect(ptx.idsOf(OWNER)).toEqual([]);
    expect(ptx.idsOf(OTHER)).toHaveLength(3);
    const refs = new Set(ptx.requests.map((request) => request.tenantRef));
    expect([...refs]).toEqual([tenantRefFor(KEY, OWNER)]);
  });

  test("an account with no jobs deletes nothing and succeeds", async () => {
    const ptx = fakePtx();
    expect(await createPrivateCloudPurger(ptx.client, KEY).purge(OWNER)).toBe(0);
    expect(ptx.requests.map((request) => request.method)).toEqual(["GET"]);
  });

  test("a job already gone (404) is not a failure: idempotent", async () => {
    const ptx = fakePtx();
    ptx.add(OWNER, 2);
    ptx.behavior.set(jobId(1), "gone");
    expect(await createPrivateCloudPurger(ptx.client, KEY).purge(OWNER)).toBe(2);
    expect(ptx.idsOf(OWNER)).toEqual([]);
  });

  test("PTX unreachable rejects, never resolves as deleted", async () => {
    const ptx = fakePtx();
    ptx.add(OWNER, 2);
    ptx.setDown(true);
    await expect(createPrivateCloudPurger(ptx.client, KEY).purge(OWNER)).rejects.toBeInstanceOf(PtxTransportError);
  });

  test("a delete PTX acknowledges but leaves listed is not_drained", async () => {
    const ptx = fakePtx();
    ptx.add(OWNER, 2);
    ptx.behavior.set(jobId(1), "keep");
    ptx.behavior.set(jobId(2), "keep");
    await expect(createPrivateCloudPurger(ptx.client, KEY).purge(OWNER)).rejects.toMatchObject({ reason: "not_drained" });
  });

  test("a failed delete rejects after the round, and the rest of that round was still deleted; the retry finishes", async () => {
    const ptx = fakePtx();
    ptx.add(OWNER, 3);
    ptx.behavior.set(jobId(2), "fail");
    const purger = createPrivateCloudPurger(ptx.client, KEY);
    const error = await purger.purge(OWNER).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(PrivateCloudPurgeError);
    expect((error as PrivateCloudPurgeError).reason).toBe("delete_failed");
    expect(ptx.idsOf(OWNER)).toEqual([jobId(2)]);
    ptx.behavior.delete(jobId(2));
    expect(await purger.purge(OWNER)).toBe(1);
    expect(ptx.idsOf(OWNER)).toEqual([]);
  });

  test("a list that is not the contract's shape rejects rather than reading as empty", async () => {
    for (const body of [{}, { data: "x" }, { data: [{ id: "not-a-job-id" }] }, { data: [{}] }]) {
      const ptx = fakePtx();
      ptx.add(OWNER, 1);
      ptx.setListBody(() => body);
      await expect(createPrivateCloudPurger(ptx.client, KEY).purge(OWNER)).rejects.toMatchObject({ reason: "list_off_contract" });
      expect(ptx.requests.every((request) => request.method === "GET")).toBe(true);
    }
  });
});

describe("bulk DELETE /api/transcriber/meetings runs the private cloud purge", () => {
  async function withServer<T>(privateCloud: { purge(address: string): Promise<number> } | undefined, fn: (base: string) => Promise<T>): Promise<T> {
    const app = express();
    app.use((req, _res, next) => { req.user = { address: OWNER }; next(); });
    app.use("/api/transcriber/meetings", createTranscriberRouter({
      api: {} as TranscriptionApiClient,
      index: new MemoryTranscriberIndexStore(),
      ...(privateCloud ? { privateCloud } : {}),
    }));
    const server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
    try {
      return await fn(`http://localhost:${(server.address() as { port: number }).port}`);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }
  const bulk = async (base: string) => {
    const response = await fetch(`${base}/api/transcriber/meetings`, { method: "DELETE" });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  test("with no meetings at all it still deletes the voice notes and uploads, and reports how many", async () => {
    const ptx = fakePtx();
    ptx.add(OWNER, 4);
    const result = await withServer(createPrivateCloudPurger(ptx.client, KEY), bulk);
    expect(result).toEqual({ status: 200, body: { removed: 0, deleting: 0, listOnly: 0, notDeleted: 0, privateCloudDeleted: 4 } });
    expect(ptx.idsOf(OWNER)).toEqual([]);
  });

  test("when the private cloud service is not used the count is null, never 0 (which would read as 'checked, none')", async () => {
    const result = await withServer(undefined, bulk);
    expect(result).toEqual({ status: 200, body: { removed: 0, deleting: 0, listOnly: 0, notDeleted: 0, privateCloudDeleted: null } });
  });

  test("an unconfirmed private cloud delete is a 503, never a success; the retry succeeds", async () => {
    const ptx = fakePtx();
    ptx.add(OWNER, 2);
    ptx.setDown(true);
    const purger = createPrivateCloudPurger(ptx.client, KEY);
    await withServer(purger, async (base) => {
      const failed = await bulk(base);
      expect(failed.status).toBe(503);
      expect(failed.body).toMatchObject({ error: "transcriber_unavailable", privateCloudFailed: true });
      expect(failed.body).not.toHaveProperty("privateCloudDeleted");
      ptx.setDown(false);
      expect(await bulk(base)).toMatchObject({ status: 200, body: { privateCloudDeleted: 2 } });
    });
  });

  test("GET /scope says whether private cloud is kept, from config alone", async () => {
    const scope = async (base: string) => {
      const response = await fetch(`${base}/api/transcriber/meetings/scope`);
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    expect(await withServer({ purge: async () => 0 }, scope)).toEqual({ status: 200, body: { privateCloud: true } });
    expect(await withServer(undefined, scope)).toEqual({ status: 200, body: { privateCloud: false } });
  });
});

describe("private cloud on, meeting transcriber off: the bulk DELETE is still there", () => {
  async function withOnlyRouter<T>(user: { address: string } | null, purge: (address: string) => Promise<number>, fn: (base: string) => Promise<T>): Promise<T> {
    const app = express();
    app.use((req, _res, next) => { if (user) req.user = user; next(); });
    app.use("/api/transcriber/meetings", createPrivateCloudOnlyBulkDeleteRouter({ purge }));
    const server = await new Promise<Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
    try {
      return await fn(`http://localhost:${(server.address() as { port: number }).port}`);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }
  const bulk = async (base: string) => {
    const response = await fetch(`${base}/api/transcriber/meetings`, { method: "DELETE" });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  test("it asks private cloud for the caller (lower-cased) and reports the count, with no meetings", async () => {
    const asked: string[] = [];
    const result = await withOnlyRouter({ address: OWNER.toUpperCase().replace("0X", "0x") }, async (address) => { asked.push(address); return 3; }, bulk);
    expect(result).toEqual({ status: 200, body: { removed: 0, deleting: 0, listOnly: 0, notDeleted: 0, privateCloudDeleted: 3 } });
    expect(asked).toEqual([OWNER]);
  });

  test("an unconfirmed delete is a 503, not 'nothing to delete'", async () => {
    const result = await withOnlyRouter({ address: OWNER }, async () => { throw new PrivateCloudPurgeError("not_drained"); }, bulk);
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ error: "transcriber_unavailable", privateCloudFailed: true });
  });

  test("without a session it is 401 and private cloud is never asked", async () => {
    let asked = 0;
    const result = await withOnlyRouter(null, async () => { asked++; return 0; }, bulk);
    expect(result.status).toBe(401);
    expect(asked).toBe(0);
  });

  test("GET /scope says private cloud is kept, and needs a session", async () => {
    const scope = async (base: string) => {
      const response = await fetch(`${base}/api/transcriber/meetings/scope`);
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    expect(await withOnlyRouter({ address: OWNER }, async () => 0, scope)).toEqual({ status: 200, body: { privateCloud: true } });
    expect((await withOnlyRouter(null, async () => 0, scope)).status).toBe(401);
  });
});
