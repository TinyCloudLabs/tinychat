// The signed-in account owns every request for its job: once it leaves, nothing more is sent
// with the new account's token, and the job is kept for the account's next run.
import { describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { memoryHoldStore } from "@/harness/memoryHoldStore";
import { createPrivateCloudApi } from "../privateCloud";
import { VoiceNoteAudioError } from "./voiceNoteAudio";
import type { SessionStore } from "../session";
import { createVoiceNoteCloud, createVoiceNoteTranscriber, ACCOUNT_CHANGED } from "./voiceNoteTranscription";

const CAPS = { max_bytes: 1_000_000, max_duration_seconds: 100 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function setup(switchOn: "first-get" | "first-result", opts: { notFound?: boolean } = {}) {
  let account = "A";
  const requests: string[] = [];
  const cleared: string[] = [];
  let gets = 0;
  const api = createPrivateCloudApi("https://backend.example", {
    sessionStore: { getToken: () => account, isExpired: () => false } as unknown as SessionStore,
    fetchImpl: (async (url: string, init: RequestInit) => {
      const token = new Headers(init.headers).get("Authorization")!.replace("Bearer ", "");
      const method = init.method ?? "GET";
      if (url.endsWith("/capabilities")) return json(CAPS);
      if (url.endsWith("/result")) {
        requests.push(`result:${token}`);
        if (switchOn === "first-result") account = "B";
        return json({ status: "completed", transcript: { segments: [], text: "" } });
      }
      requests.push(`${method === "DELETE" ? "delete" : method === "POST" ? "cancel" : "get"}:${token}`);
      if (opts.notFound && token === "B") return json({ error: { code: "transcription_not_found", message: "no" } }, 404);
      if (method !== "GET") return json({});
      gets++;
      if (switchOn === "first-get" && gets === 1) {
        account = "B";
        return json({ id: "trn_A", status: "queued" });
      }
      return json({ id: "trn_A", status: "completed" });
    }) as typeof fetch,
  });
  const pending = {
    read: () => ({ attemptId: "attempt", transcriptionId: "trn_A" }),
    write() {},
    clear: (id: string) => void cleared.push(id),
    sourceIds: () => ["a-note"],
  };
  const cloud = createVoiceNoteCloud({
    origin: "https://ptx.example",
    pending,
    create: async () => { throw new Error("unexpected create"); },
    put: async () => { throw new Error("unexpected upload"); },
    api,
    clock: { now: () => 0, random: () => 0.5, sleep: async () => {} },
  });
  const outcome: { error: unknown } = { error: null };
  const transcriber = createVoiceNoteTranscriber({
    tcw: () => ({ did: "A" }) as TinyCloudWeb,
    cloud,
    consent: { get: () => true, set() {} },
    holds: memoryHoldStore(),
    runNote: async (args) => {
      try {
        await cloud.transcribe({ sourceId: args.sourceId, capabilities: args.capabilities, allowed: args.allowed, loadAudio: async () => { throw new Error("unexpected audio read"); } }, args.report);
      } catch (err) {
        outcome.error = err;
        throw err;
      }
      return "no_speech";
    },
  });
  return { transcriber, requests, cleared, outcome, current: () => account === "A" };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("an existing Private job when its account leaves", () => {
  test("no request goes out with the new account's token while it is polled or its result read", async () => {
    const s = setup("first-get");
    await s.transcriber.check({ current: s.current });
    await settle();
    expect(s.requests).toEqual(["get:A"]);
    expect((s.outcome.error as { code?: string }).code).toBe(ACCOUNT_CHANGED);
  });

  test("nor after the result request, and the job is kept, neither cleared nor cancelled", async () => {
    const s = setup("first-result");
    await s.transcriber.check({ current: s.current });
    await settle();
    expect(s.requests.filter((r) => r.endsWith(":B"))).toEqual([]);
    expect(s.cleared).toEqual([]);
    expect((s.outcome.error as { code?: string }).code).toBe(ACCOUNT_CHANGED);
  });

  test("the transcriber shows no job for it afterwards, not a failure", async () => {
    const s = setup("first-get");
    await s.transcriber.check({ current: s.current });
    await settle();
    expect(s.transcriber.snapshot().jobs.size).toBe(0);
  });
});

describe("an account that leaves while its note's audio is being prepared", () => {
  function prepare(loadAudio: (leave: () => void) => Promise<never>) {
    let account = "A";
    const requests: string[] = [];
    const cleared: string[] = [];
    const api = createPrivateCloudApi("https://backend.example", {
      sessionStore: { getToken: () => account, isExpired: () => false } as unknown as SessionStore,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        requests.push(`${init.method ?? "GET"}:${new Headers(init.headers).get("Authorization")}`);
        return json({ id: "trn_A", status: "awaiting_upload" });
      }) as typeof fetch,
    });
    const cloud = createVoiceNoteCloud({
      origin: "https://ptx.example",
      api,
      pending: { read: () => ({ attemptId: "attempt-A", transcriptionId: "trn_A" }), write() {}, clear: (id: string) => void cleared.push(id), sourceIds: () => ["a-note"] },
      create: async () => { throw new Error("unexpected create"); },
      put: async () => { throw new Error("unexpected upload"); },
      clock: { now: () => 0, random: () => 0.5, sleep: async () => {} },
    });
    const run = () => cloud.transcribe(
      { sourceId: "a-note", capabilities: CAPS, allowed: () => account === "A", loadAudio: () => loadAudio(() => { account = "B"; }) },
      () => {},
    ).catch((err: unknown) => err);
    return { run, requests, cleared };
  }

  test("a rejecting audio load keeps A's job and sends nothing with B's token", async () => {
    const s = prepare(async (leave) => { leave(); throw new Error("audio read failed while signing out"); });
    expect((await s.run() as { code?: string }).code).toBe(ACCOUNT_CHANGED);
    expect(s.requests.filter((request) => request.endsWith("Bearer B"))).toEqual([]);
    expect(s.cleared).toEqual([]);
  });

  test("an error that would release the job (a note too long) still leaves A's job alone once A has left", async () => {
    const s = prepare(async (leave) => { leave(); throw new VoiceNoteAudioError("recording_too_long_for_phone", "too long"); });
    expect((await s.run() as { code?: string }).code).toBe(ACCOUNT_CHANGED);
    expect(s.requests.filter((request) => request.endsWith("Bearer B"))).toEqual([]);
    expect(s.cleared).toEqual([]);
  });

  test("with the account still current the same failure releases the job: cancels it and forgets it", async () => {
    const s = prepare(async () => { throw new VoiceNoteAudioError("recording_too_long_for_phone", "too long"); });
    expect((await s.run() as { code?: string }).code).toBe("recording_too_long_for_phone");
    expect(s.cleared).toContain("a-note");
    expect(s.requests.some((request) => request.startsWith("POST:") && request.endsWith("Bearer A"))).toBe(true);
  });
});
