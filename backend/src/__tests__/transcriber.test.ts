// The TRANSCRIBER surface (routes/transcriber.ts): a per-address proxy over the private
// transcription API. Rules pinned here:
//   1. the tenant is the session address — another address's meeting id is `not_found`;
//   2. a bad meeting URL is refused BEFORE upstream is called;
//   3. create attributes the meeting to the address (metadata) and records it in the index;
//   4. transcript passes upstream's 202/200 through; stop and delete are owner-only;
//   5. upstream text never reaches the caller — only our own error codes;
//   6. the api client speaks the SPEC.md contract (paths, bearer, 202 handling).

import { describe, expect, test } from "bun:test";
import express from "express";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createTranscriberRouter } from "../routes/transcriber.js";
import { MemoryTranscriberIndexStore } from "../services/transcriber-index.js";
import {
  createTranscriptionApiClient,
  TranscriptionApiError,
  type TranscriptionApiClient,
  type TranscriptionMeeting,
} from "../services/transcription-api.js";

const ADDRESS_A = "0xAaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAA";
const ADDRESS_B = "0xBbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBB";

function meeting(id: string, patch: Partial<TranscriptionMeeting> = {}): TranscriptionMeeting {
  return {
    id,
    object: "meeting",
    status: "queued",
    platform: "jitsi",
    meeting_url: "https://meet.jit.si/tinycloud-demo",
    created_at: "2026-08-18T10:00:00.000Z",
    metadata: {},
    ...patch,
  };
}

function fakeApi() {
  const calls: { method: string; args: unknown[] }[] = [];
  const store = new Map<string, TranscriptionMeeting>();
  let nextId = 1;
  const api: TranscriptionApiClient = {
    async createMeeting(input) {
      calls.push({ method: "createMeeting", args: [input] });
      const m = meeting(`mtg_${nextId++}`, {
        meeting_url: input.meeting_url,
        bot: { name: input.bot_name ?? "" },
        metadata: input.metadata ?? {},
      });
      store.set(m.id, m);
      return m;
    },
    async getMeeting(id) {
      calls.push({ method: "getMeeting", args: [id] });
      const m = store.get(id);
      if (!m) throw new TranscriptionApiError(404, "meeting_not_found", "no such meeting");
      return m;
    },
    async stopMeeting(id) {
      calls.push({ method: "stopMeeting", args: [id] });
      const m = store.get(id);
      if (!m) throw new TranscriptionApiError(404, "meeting_not_found", "no such meeting");
      m.status = "processing";
      return { id, status: m.status };
    },
    async getTranscript(id) {
      calls.push({ method: "getTranscript", args: [id] });
      const m = store.get(id);
      if (!m) throw new TranscriptionApiError(404, "meeting_not_found", "no such meeting");
      if (m.status !== "completed") return { pending: true, status: m.status };
      return {
        pending: false,
        transcript: {
          meeting_id: id,
          status: "completed",
          language: "en",
          duration_seconds: 3,
          speakers: [{ id: "speaker_0", name: "Sam" }],
          segments: [
            { id: "seg_001", speaker_id: "speaker_0", speaker_name: "Sam", start: 0, end: 3, text: "hello" },
          ],
          text: "Sam: hello",
        },
      };
    },
    async deleteMeeting(id) {
      calls.push({ method: "deleteMeeting", args: [id] });
      if (!store.delete(id)) throw new TranscriptionApiError(404, "meeting_not_found", "no such meeting");
    },
  };
  return { api, calls, store };
}

function harness(address: string | null = ADDRESS_A) {
  const { api, calls, store } = fakeApi();
  const index = new MemoryTranscriberIndexStore();
  const session: { address: string | null } = { address };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (session.address !== null) req.user = { address: session.address };
    next();
  });
  app.use("/api/transcriber/meetings", createTranscriberRouter({ api, index }));
  return { app, api, calls, store, index, session };
}

async function withServer<T>(app: express.Express, fn: (base: string) => Promise<T>): Promise<T> {
  const server = await new Promise<import("http").Server>((r) => {
    const s = app.listen(0, () => r(s));
  });
  const { port } = server.address() as { port: number };
  try {
    return await fn(`http://localhost:${port}`);
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  }
}

async function call(base: string, path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* empty body */
  }
  return { status: response.status, body: parsed, text };
}

describe("POST /api/transcriber/meetings", () => {
  test("refuses a bad meeting URL before touching upstream", async () => {
    const h = harness();
    await withServer(h.app, async (base) => {
      for (const bad of [undefined, "", "not a url", "ftp://x/y", "javascript:alert(1)"]) {
        const r = await call(base, "/api/transcriber/meetings", "POST", { meeting_url: bad });
        expect(r.status).toBe(400);
        expect(r.body.error).toBe("invalid_meeting_url");
      }
    });
    expect(h.calls).toEqual([]);
  });

  test("creates upstream with the address in metadata, indexes it, returns 201", async () => {
    const h = harness();
    await withServer(h.app, async (base) => {
      const r = await call(base, "/api/transcriber/meetings", "POST", {
        meeting_url: "https://meet.jit.si/tinycloud-demo",
        bot_name: "  Notetaker ",
      });
      expect(r.status).toBe(201);
      expect(r.body.id).toBe("mtg_1");
      expect(r.body.status).toBe("queued");
    });
    expect(h.calls[0]).toEqual({
      method: "createMeeting",
      args: [
        {
          meeting_url: "https://meet.jit.si/tinycloud-demo",
          bot_name: "Notetaker",
          metadata: { tinychat_address: ADDRESS_A.toLowerCase() },
        },
      ],
    });
    expect(await h.index.list(ADDRESS_A)).toEqual(["mtg_1"]);
  });

  test("uses the default bot name when none is given", async () => {
    const h = harness();
    await withServer(h.app, async (base) => {
      await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.google.com/abc-defg-hij" });
    });
    expect((h.calls[0]!.args[0] as { bot_name: string }).bot_name).toBe("TinyCloud Notetaker");
  });

  test("401 without a session", async () => {
    const h = harness(null);
    await withServer(h.app, async (base) => {
      const r = await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/x" });
      expect(r.status).toBe(401);
    });
    expect(h.calls).toEqual([]);
  });
});

describe("GET /api/transcriber/meetings", () => {
  test("lists only the address's meetings, newest first, refreshed upstream", async () => {
    const h = harness();
    await withServer(h.app, async (base) => {
      await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/one" });
      await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/two" });
      // Someone else's meeting exists upstream but not in A's index.
      h.store.set("mtg_other", meeting("mtg_other"));
      h.store.get("mtg_1")!.status = "in_progress";

      const r = await call(base, "/api/transcriber/meetings");
      expect(r.status).toBe(200);
      expect(r.body.meetings.map((m: TranscriptionMeeting) => m.id)).toEqual(["mtg_2", "mtg_1"]);
      expect(r.body.meetings[1].status).toBe("in_progress");
    });
  });

  test("a meeting deleted upstream out of band drops out of the list and the index", async () => {
    const h = harness();
    await withServer(h.app, async (base) => {
      await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/one" });
      h.store.delete("mtg_1");
      const r = await call(base, "/api/transcriber/meetings");
      expect(r.body.meetings).toEqual([]);
    });
    expect(await h.index.list(ADDRESS_A)).toEqual([]);
  });

  test("an upstream outage on one row is told as unavailable, not dropped", async () => {
    const h = harness();
    const realGet = h.api.getMeeting;
    h.api.getMeeting = async (id) => {
      if (id === "mtg_1") throw new TranscriptionApiError(503, null, "vexa down");
      return realGet(id);
    };
    await withServer(h.app, async (base) => {
      await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/one" });
      const r = await call(base, "/api/transcriber/meetings");
      expect(r.body.meetings).toEqual([{ id: "mtg_1", unavailable: true }]);
      expect(r.text).not.toContain("vexa");
    });
  });
});

describe("per-meeting routes", () => {
  test("another address's meeting is not_found for get/stop/transcript/delete", async () => {
    const h = harness();
    await withServer(h.app, async (base) => {
      await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/one" });
      h.session.address = ADDRESS_B;
      expect((await call(base, "/api/transcriber/meetings/mtg_1")).status).toBe(404);
      expect((await call(base, "/api/transcriber/meetings/mtg_1/stop", "POST")).status).toBe(404);
      expect((await call(base, "/api/transcriber/meetings/mtg_1/transcript")).status).toBe(404);
      expect((await call(base, "/api/transcriber/meetings/mtg_1", "DELETE")).status).toBe(404);
    });
    // Ownership was checked before upstream: none of these reached the API.
    expect(h.calls.filter((c) => c.method !== "createMeeting")).toEqual([]);
    expect(h.store.has("mtg_1")).toBe(true);
  });

  test("transcript is 202 while pending and 200 with segments once completed", async () => {
    const h = harness();
    await withServer(h.app, async (base) => {
      await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/one" });
      const pending = await call(base, "/api/transcriber/meetings/mtg_1/transcript");
      expect(pending.status).toBe(202);
      expect(pending.body).toEqual({ meeting_id: "mtg_1", status: "queued" });

      h.store.get("mtg_1")!.status = "completed";
      const done = await call(base, "/api/transcriber/meetings/mtg_1/transcript");
      expect(done.status).toBe(200);
      expect(done.body.segments[0].speaker_name).toBe("Sam");
      expect(done.body.text).toBe("Sam: hello");
    });
  });

  test("stop proxies to upstream for the owner", async () => {
    const h = harness();
    await withServer(h.app, async (base) => {
      await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/one" });
      const r = await call(base, "/api/transcriber/meetings/mtg_1/stop", "POST");
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ id: "mtg_1", status: "processing" });
    });
  });

  test("delete removes upstream and from the index; a second delete is not_found", async () => {
    const h = harness();
    await withServer(h.app, async (base) => {
      await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/one" });
      expect((await call(base, "/api/transcriber/meetings/mtg_1", "DELETE")).status).toBe(204);
      expect(h.store.has("mtg_1")).toBe(false);
      expect(await h.index.list(ADDRESS_A)).toEqual([]);
      expect((await call(base, "/api/transcriber/meetings/mtg_1", "DELETE")).status).toBe(404);
    });
  });

  test("upstream failures surface as our own codes, never upstream text", async () => {
    const h = harness();
    h.api.createMeeting = async () => {
      throw new TranscriptionApiError(400, "unsupported_platform", "Vexa cannot join webex");
    };
    await withServer(h.app, async (base) => {
      const r = await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://webex.com/m/1" });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("unsupported_platform");
    });
    h.api.createMeeting = async () => {
      throw new Error("ECONNREFUSED 10.0.0.7:8056");
    };
    await withServer(h.app, async (base) => {
      const r = await call(base, "/api/transcriber/meetings", "POST", { meeting_url: "https://meet.jit.si/x" });
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ error: "transcriber_unavailable" });
      expect(r.text).not.toContain("ECONNREFUSED");
    });
  });
});

describe("transcription api client", () => {
  test("speaks the SPEC.md contract: bearer key, /v1 paths, 202 = pending", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const answers: Record<string, { status: number; body: unknown }> = {
      "POST /v1/meetings": { status: 201, body: meeting("mtg_9") },
      "GET /v1/meetings/mtg_9": { status: 200, body: meeting("mtg_9", { status: "in_progress" }) },
      "GET /v1/meetings/mtg_9/transcript": { status: 202, body: { meeting_id: "mtg_9", status: "processing" } },
      "POST /v1/meetings/mtg_9/stop": { status: 200, body: { id: "mtg_9", status: "processing" } },
      "DELETE /v1/meetings/mtg_9": { status: 204, body: "" },
    };
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      const key = `${init?.method} ${new URL(String(url)).pathname}`;
      const a = answers[key];
      if (!a) return new Response(JSON.stringify({ error: { code: "meeting_not_found", message: "x" } }), { status: 404 });
      return new Response(a.body === "" ? null : JSON.stringify(a.body), { status: a.status });
    }) as typeof fetch;

    const api = createTranscriptionApiClient({ baseUrl: "https://transcribe.example/", apiKey: "tc_live_abc", fetchImpl });
    const created = await api.createMeeting({ meeting_url: "https://meet.jit.si/x" });
    expect(created.id).toBe("mtg_9");
    expect((await api.getMeeting("mtg_9")).status).toBe("in_progress");
    expect(await api.getTranscript("mtg_9")).toEqual({ pending: true, status: "processing" });
    // Live upstream answers 200 + {meeting_id, status} (no segments) for failed/cancelled.
    answers["GET /v1/meetings/mtg_9/transcript"] = { status: 200, body: { meeting_id: "mtg_9", status: "failed" } };
    expect(await api.getTranscript("mtg_9")).toEqual({ pending: true, status: "failed" });
    expect(await api.stopMeeting("mtg_9")).toEqual({ id: "mtg_9", status: "processing" });
    await api.deleteMeeting("mtg_9");
    await expect(api.getMeeting("mtg_missing")).rejects.toMatchObject({ status: 404, code: "meeting_not_found" });

    expect(seen[0]!.url).toBe("https://transcribe.example/v1/meetings");
    for (const s of seen) {
      expect((s.init.headers as Record<string, string>).Authorization).toBe("Bearer tc_live_abc");
    }
  });
});

describe("wiring", () => {
  test("index.ts mounts /api/transcriber/meetings behind authMiddleware, gated on the env config", () => {
    const src = readFileSync(resolve(import.meta.dir, "../index.ts"), "utf8");
    expect(src).toMatch(/app\.use\(\s*\n?\s*"\/api\/transcriber\/meetings",\s*\n?\s*authMiddleware,/);
    expect(src).toContain("transcriptionApiConfigFromEnv()");
  });

  test("rate-limits gives the transcriber its own bucket", async () => {
    const limits = await import("../rate-limits.js");
    expect(limits.TRANSCRIBER_PATHS).toEqual(["/api/transcriber"]);
    expect(limits.TRANSCRIBER_LIMIT).toBeGreaterThan(limits.GLOBAL_LIMIT);
  });
});
