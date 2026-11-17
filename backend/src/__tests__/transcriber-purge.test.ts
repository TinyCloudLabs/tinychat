// TC-3136: Remove (and the account-deletion step) must purge the capture provider's copy and PROVE it.
// The proof is the private transcription API's read-back: not-found. A purge that cannot be confirmed
// keeps the entry as "deleting" and the sweeper retries with backoff; nothing is dropped silently.
// Mock ptx API and in-memory index only; no real recording is touched.

import { describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import express from "express";

import { createTranscriberRouter } from "../routes/transcriber.js";
import { MemoryTranscriberIndexStore } from "../services/transcriber-index.js";
import { PurgeSweeper, purgeBackoffMs } from "../services/transcriber-purge.js";
import { createTranscriptionApiClient, TranscriptionApiError, type TranscriptionApiClient, type TranscriptionMeeting } from "../services/transcription-api.js";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

type DeleteMode = "ok" | "retain" | "fail";

function fakePtx() {
  const store = new Map<string, TranscriptionMeeting>();
  const modes = new Map<string, DeleteMode>();
  const calls: string[] = [];
  let failuresLeft = 0;
  const add = (id: string, owner: string | undefined = OWNER, mode: DeleteMode = "ok") => {
    store.set(id, {
      id, object: "meeting", status: "completed", platform: "jitsi", meeting_url: "https://meet.jit.si/x",
      created_at: "2026-11-17T10:00:00.000Z", metadata: owner ? { tinychat_address: owner } : {},
    } as TranscriptionMeeting);
    modes.set(id, mode);
  };
  const api = {
    async getMeeting(id: string) {
      calls.push(`get:${id}`);
      const m = store.get(id);
      if (!m) throw new TranscriptionApiError(404, "meeting_not_found", "no such meeting");
      return m;
    },
    async deleteMeeting(id: string) {
      calls.push(`delete:${id}`);
      if (!store.has(id)) throw new TranscriptionApiError(404, "meeting_not_found", "no such meeting");
      if (failuresLeft > 0) { failuresLeft--; throw new TranscriptionApiError(503, "provider_unavailable", "x"); }
      const mode = modes.get(id);
      if (mode === "fail") throw new TranscriptionApiError(503, "provider_unavailable", "x");
      if (mode === "ok") store.delete(id);
    },
    async lookupMeetingByIdempotencyKey() { return null; },
  } as unknown as TranscriptionApiClient;
  return { api, store, modes, calls, add, failNext: (n: number) => { failuresLeft = n; } };
}

async function setup(owned: Array<[string, DeleteMode?]> = []) {
  const ptx = fakePtx();
  const index = new MemoryTranscriberIndexStore();
  for (const [id, mode] of owned) { ptx.add(id, OWNER, mode); await index.add(OWNER, id); }
  const sweeper = new PurgeSweeper(ptx.api, index, { now: () => clock.now });
  const clock = { now: 1_000_000 };
  const app = express();
  app.use((req, _res, next) => { req.user = { address: OWNER }; next(); });
  app.use("/api/transcriber/meetings", createTranscriberRouter({ api: ptx.api, index, purger: sweeper, purgeDelaysMs: [0, 0, 0] }));
  return { ptx, index, sweeper, clock, app };
}

async function withServer<T>(app: express.Express, fn: (base: string) => Promise<T>): Promise<T> {
  const server = await new Promise<Server>((r) => { const s = app.listen(0, () => r(s)); });
  try {
    return await fn(`http://localhost:${(server.address() as { port: number }).port}`);
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  }
}

const call = async (base: string, path: string, method = "GET") => {
  const response = await fetch(`${base}${path}`, { method });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

const BASE = "/api/transcriber/meetings";

describe("Remove purges upstream and reads it back", () => {
  test("delete then read-back not-found: 204 and the entry is gone", async () => {
    const h = await setup([["mtg_1"]]);
    await withServer(h.app, async (base) => {
      expect((await call(base, `${BASE}/mtg_1`, "DELETE")).status).toBe(204);
    });
    expect(h.ptx.calls).toEqual(["get:mtg_1", "delete:mtg_1", "get:mtg_1"]);
    expect(await h.index.list(OWNER)).toEqual([]);
  });

  test("an already-purged meeting (upstream 404) is a clean 204: idempotent", async () => {
    const h = await setup([["mtg_1"]]);
    h.ptx.store.delete("mtg_1");
    await withServer(h.app, async (base) => {
      expect((await call(base, `${BASE}/mtg_1`, "DELETE")).status).toBe(204);
      expect((await call(base, `${BASE}/mtg_1`, "DELETE")).status).toBe(404); // already off the list
    });
    expect(h.ptx.calls.filter((c) => c.startsWith("delete:"))).toEqual([]);
    expect(await h.index.list(OWNER)).toEqual([]);
  });

  test("a transient upstream failure is retried inside the request", async () => {
    const h = await setup([["mtg_1"]]);
    h.ptx.failNext(1);
    await withServer(h.app, async (base) => {
      expect((await call(base, `${BASE}/mtg_1`, "DELETE")).status).toBe(204);
    });
    expect(h.ptx.calls.filter((c) => c === "delete:mtg_1")).toHaveLength(2);
    expect(await h.index.list(OWNER)).toEqual([]);
  });

  test("a delete upstream that answers 2xx but still reads back is NOT gone: 202 deleting, entry kept, then the sweeper converges", async () => {
    const h = await setup([["mtg_1", "retain"]]);
    await withServer(h.app, async (base) => {
      const r = await call(base, `${BASE}/mtg_1`, "DELETE");
      expect(r).toEqual({ status: 202, body: { id: "mtg_1", status: "deleting" } });
      expect(h.ptx.calls.filter((c) => c === "delete:mtg_1")).toHaveLength(3);
      // Still listed, as deleting, never silently dropped; the owner cannot mistake it for gone.
      expect(await h.index.list(OWNER)).toEqual(["mtg_1"]);
      const listed = await call(base, BASE);
      expect(listed.body.meetings).toEqual([{ id: "mtg_1", unavailable: true, deleting: true }]);

      // Backoff: not due yet right after the in-request tries? The first sweep is due (nextAt 0), fails, and backs off.
      h.ptx.calls.length = 0;
      expect(await h.sweeper.sweep()).toEqual({ attempted: 1, gone: 0 });
      const attemptsAfterFirst = (await h.index.entries(OWNER)).purging?.mtg_1;
      expect(attemptsAfterFirst).toMatchObject({ attempts: 1, nextAt: h.clock.now + purgeBackoffMs(1) });
      h.ptx.calls.length = 0;
      expect(await h.sweeper.sweep()).toEqual({ attempted: 0, gone: 0 });
      expect(h.ptx.calls).toEqual([]); // not due: no upstream traffic

      // The provider recovers; once due, the sweeper deletes, reads back not-found, and drops the entry.
      h.ptx.modes.set("mtg_1", "ok");
      h.clock.now += purgeBackoffMs(1);
      expect(await h.sweeper.sweep()).toEqual({ attempted: 1, gone: 1 });
    });
    expect(await h.index.list(OWNER)).toEqual([]);
    expect(h.ptx.store.has("mtg_1")).toBe(false);
  });

  test("an own entry the provider attributes to someone else is dropped from the list, nothing is deleted upstream, and the caller is told (200 not_deleted)", async () => {
    const h = await setup();
    h.ptx.add("mtg_theirs", OTHER);
    await h.index.add(OWNER, "mtg_theirs");
    await withServer(h.app, async (base) => {
      expect(await call(base, `${BASE}/mtg_theirs`, "DELETE")).toEqual({ status: 200, body: { id: "mtg_theirs", status: "not_deleted" } });
    });
    expect(h.ptx.calls.filter((c) => c.startsWith("delete:"))).toEqual([]);
    expect(h.ptx.store.has("mtg_theirs")).toBe(true);
    expect(await h.index.list(OWNER)).toEqual([]);
  });

  test("an own entry with no attribution at all is also reported as not_deleted, never as a clean 204", async () => {
    const h = await setup();
    h.ptx.add("mtg_bare", "");
    await h.index.add(OWNER, "mtg_bare");
    await withServer(h.app, async (base) => {
      expect(await call(base, `${BASE}/mtg_bare`, "DELETE")).toEqual({ status: 200, body: { id: "mtg_bare", status: "not_deleted" } });
    });
    expect(h.ptx.store.has("mtg_bare")).toBe(true);
  });

  test("backoff grows and is capped; a restarted sweeper picks up stuck purges from the index", async () => {
    expect([1, 2, 3, 4].map(purgeBackoffMs)).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(purgeBackoffMs(50)).toBe(3_600_000);
    const h = await setup([["mtg_1", "retain"]]);
    await withServer(h.app, async (base) => { await call(base, `${BASE}/mtg_1`, "DELETE"); });
    const restarted = new PurgeSweeper(h.ptx.api, h.index, { now: () => h.clock.now });
    await restarted.seed();
    h.ptx.modes.set("mtg_1", "ok");
    expect(await restarted.sweep()).toEqual({ attempted: 1, gone: 1 });
    expect(await h.index.list(OWNER)).toEqual([]);
  });
});

describe("DELETE / (the step before account deletion)", () => {
  test("purges every own recording, drops shared ones from the list only, and reports what is still deleting", async () => {
    const h = await setup([["mtg_1"], ["mtg_2"], ["mtg_3", "retain"]]);
    h.ptx.add("mtg_shared", OTHER);
    await h.index.addShared(OWNER, "mtg_shared", { ownerAddress: OTHER, title: "t", scheduledStart: "" } as never);
    await withServer(h.app, async (base) => {
      const r = await call(base, BASE, "DELETE");
      expect(r).toEqual({ status: 202, body: { removed: 3, deleting: 1, listOnly: 1, notDeleted: 0, privateCloudDeleted: null } }); // listOnly: the shared one
    });
    expect(h.ptx.store.has("mtg_shared")).toBe(true); // the owner's copy is theirs
    expect([...h.ptx.store.keys()].sort()).toEqual(["mtg_3", "mtg_shared"]);
    expect(await h.index.list(OWNER)).toEqual(["mtg_3"]);
    expect(Object.keys((await h.index.entries(OWNER)).purging ?? {})).toEqual(["mtg_3"]);

    h.ptx.modes.set("mtg_3", "ok");
    await withServer(h.app, async (base) => {
      // Idempotent: asking again finishes the stuck one and reports a clean 200.
      expect(await call(base, BASE, "DELETE")).toEqual({ status: 200, body: { removed: 1, deleting: 0, listOnly: 0, notDeleted: 0, privateCloudDeleted: null } });
    });
    expect(h.ptx.store.has("mtg_3")).toBe(false);
    expect(await h.index.list(OWNER)).toEqual([]);
  });

  test("an own entry the provider does not attribute to this address is counted as notDeleted, not as shared or deleted", async () => {
    const h = await setup([["mtg_1"]]);
    h.ptx.add("mtg_foreign", OTHER); // listed as ours, but the provider says another address created it
    await h.index.add(OWNER, "mtg_foreign");
    h.ptx.add("mtg_bare", ""); // no attribution at all (empty metadata)
    await h.index.add(OWNER, "mtg_bare");
    await withServer(h.app, async (base) => {
      expect(await call(base, BASE, "DELETE")).toEqual({ status: 200, body: { removed: 3, deleting: 0, listOnly: 0, notDeleted: 2, privateCloudDeleted: null } });
    });
    expect([...h.ptx.store.keys()].sort()).toEqual(["mtg_bare", "mtg_foreign"]); // only the confirmed own one was deleted
    expect(await h.index.list(OWNER)).toEqual([]);
  });
});

// The attribution the purge relies on must hold end to end: the stamp this router sends on create is the one
// it reads back on Remove. Real transcription client against a wire-level fake that, like ptx, stores the
// request's metadata and returns it on every read; nothing here is injected as a pre-stamped meeting.
describe("the stamp written on create is the stamp Remove reads back", () => {
  test("a recording created through the router is attributed to its creator, deleted at the provider, and read back gone", async () => {
    const wire = new Map<string, Record<string, unknown>>();
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const { pathname } = new URL(String(url));
      const method = init?.method ?? "GET";
      seen.push(`${method} ${pathname}`);
      const notFound = () => Response.json({ error: { code: "meeting_not_found", message: "no such meeting" } }, { status: 404 });
      if (method === "POST" && pathname === "/v1/meetings") {
        const body = JSON.parse(String(init?.body)) as { meeting_url: string; metadata?: Record<string, unknown> };
        const meeting = { id: "mtg_wire", object: "meeting", status: "queued", platform: "jitsi", meeting_url: body.meeting_url,
          created_at: "2026-11-17T10:00:00.000Z", metadata: body.metadata ?? {} };
        wire.set(meeting.id, meeting);
        return Response.json(meeting, { status: 201 });
      }
      const id = pathname.split("/")[3] ?? "";
      if (method === "GET") return wire.has(id) ? Response.json(wire.get(id)) : notFound();
      if (method === "DELETE") {
        if (!wire.delete(id)) return notFound();
        return new Response(null, { status: 204 });
      }
      return Response.json({ error: { code: "unexpected", message: `${method} ${pathname}` } }, { status: 500 });
    }) as typeof fetch;
    const api = createTranscriptionApiClient({ baseUrl: "https://ptx.example", apiKey: "k", fetchImpl, sleep: async () => {} });
    const index = new MemoryTranscriberIndexStore();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { address: OWNER }; next(); });
    app.use("/api/transcriber/meetings", createTranscriberRouter({ api, index, purgeDelaysMs: [0, 0, 0] }));
    await withServer(app, async (base) => {
      const created = await fetch(`${base}${BASE}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ meeting_url: "https://meet.jit.si/WireRoom" }),
      });
      expect(created.status).toBe(201);
      expect((wire.get("mtg_wire")?.metadata as { tinychat_address?: string }).tinychat_address).toBe(OWNER);
      const removed = await fetch(`${base}${BASE}/mtg_wire`, { method: "DELETE" });
      expect(removed.status).toBe(204); // not 200 not_deleted: the creator is recognised
    });
    expect(wire.has("mtg_wire")).toBe(false);
    expect(seen.filter((s) => s.startsWith("DELETE"))).toEqual(["DELETE /v1/meetings/mtg_wire"]);
    expect(seen.at(-1)).toBe("GET /v1/meetings/mtg_wire"); // read back after the delete, which found it gone
    expect(await index.list(OWNER)).toEqual([]);
  });
});
