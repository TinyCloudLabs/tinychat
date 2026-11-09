import { afterEach, beforeEach, expect, test } from "bun:test";
import { createUploadRunner, uploadRunner, type PendingUpload, type UploadDeps, type UploadRunner, type UploadState } from "@/lib/audioUpload";
import { __resetHomeWorkForTests, homeWorkRunning, setHomeReauthorizing, subscribeHomeReauthorizing } from "@/lib/homeReauthorizing";
import { continuePausedUpload, pausedUpload } from "./pausedUpload";
import { resumeOnLaunch } from "./UploadResumer";

const OWNER = "did:example:a";

/** Resolves once `runner` shows a state that passes `seen`. */
function shown(runner: UploadRunner, seen: (state: UploadState) => boolean): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const off = runner.subscribe(() => {
    const state = runner.snapshot();
    if (state !== null && seen(state)) { off(); resolve(); }
  });
  return promise;
}

/** Resolves once no admitted upload holds a place. */
function uploadReleased(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const off = subscribeHomeReauthorizing(() => { if (!homeWorkRunning("upload")) { off(); resolve(); } });
  return promise;
}

beforeEach(() => { __resetHomeWorkForTests(); });
afterEach(() => {
  setHomeReauthorizing(false);
  pausedUpload.set(null);
  uploadRunner.reset();
});

/** An upload a reload interrupted before its file reached the service: resuming it fails asking for the file again. */
function stored(assemblyAiMode: "own" | "hosted"): PendingUpload {
  return { engine: "assemblyai", assemblyAiMode, meetingId: "m-1", attemptId: "a-1", jobId: null, diarize: false,
    file: { name: "Interview.m4a", type: "audio/mp4", size: 1024, lastModified: 0 }, owner: OWNER, saved: false };
}

/** Deps over one stored upload; `locks` counts claims on it, and the audio manifest read waits for `manifest`. */
function depsFor(job: PendingUpload) {
  let current: PendingUpload | null = job;
  const manifest = Promise.withResolvers<null>();
  const counts = { locks: 0, clients: 0 };
  const deps = {
    tcw: { did: OWNER, kv: {} },
    lock: async () => { counts.locks += 1; return () => {}; },
    pending: { read: () => current, write: (next: PendingUpload) => { current = next; }, clear: () => { current = null; } },
    audio: { put: async () => {}, manifest: () => manifest.promise, remove: async () => {} },
    assemblyAiClient: async () => { counts.clients += 1; return {}; },
  } as unknown as UploadDeps;
  return { deps, counts, manifest };
}

/** Deps that fail the test the moment anything reads them: a refused Continue must not touch the account or the job. */
function untouchable(): { deps: UploadDeps; touched: string[] } {
  const touched: string[] = [];
  const deps = new Proxy({}, { get(_target, property) { touched.push(String(property)); throw new Error(`deps.${String(property)} was read`); } });
  return { deps: deps as UploadDeps, touched };
}

test("Continue on a paused upload during a re-authorise starts nothing, and the upload stays paused", () => {
  const { deps, touched } = untouchable();
  pausedUpload.set({ fileName: "Interview.m4a" });
  setHomeReauthorizing(true);
  continuePausedUpload(deps);
  expect(touched).toEqual([]);
  expect(uploadRunner.snapshot()).toBeNull();
  expect(homeWorkRunning("upload")).toBe(false);
  expect(pausedUpload.snapshot()).toEqual({ fileName: "Interview.m4a" });
});

test("after the re-authorise, Continue on the same paused upload is admitted and holds the upload's place", async () => {
  const { deps, counts, manifest } = depsFor(stored("own"));
  pausedUpload.set({ fileName: "Interview.m4a" });
  setHomeReauthorizing(true);
  continuePausedUpload(deps);
  // Still offered: the refused tap left the upload paused.
  expect(pausedUpload.snapshot()).toEqual({ fileName: "Interview.m4a" });
  setHomeReauthorizing(false);
  const started = shown(uploadRunner, (state) => state.fileName === "Interview.m4a");
  continuePausedUpload(deps);
  expect(pausedUpload.snapshot()).toBeNull();
  expect(homeWorkRunning("upload")).toBe(true);
  await started;
  expect(counts.locks).toBe(1);
  // Let the run end (the runner is the app's one, shared with the next test).
  const released = uploadReleased();
  manifest.resolve(null);
  await released;
});

test("a resumed upload counts as busy until its run and the storage reads it started have settled", async () => {
  const { deps, manifest } = depsFor(stored("own"));
  pausedUpload.set({ fileName: "Interview.m4a" });
  const failed = shown(uploadRunner, (state) => state.stage === "failed");
  continuePausedUpload(deps);
  // The run fails (its file did not survive the reload) while the stored audio's manifest is still being read.
  await failed;
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  expect(homeWorkRunning("upload")).toBe(true);
  const released = uploadReleased();
  manifest.resolve(null);
  await released;
  expect(homeWorkRunning("upload")).toBe(false);
});

test("the launch resume is refused during a re-authorise before it claims the upload, and admitted and held after it", async () => {
  const runner = createUploadRunner();
  const { deps, counts } = depsFor(stored("hosted"));
  setHomeReauthorizing(true);
  resumeOnLaunch(runner, deps, false);
  // Refused synchronously: flush the microtasks a claim would have used.
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  expect(counts).toEqual({ locks: 0, clients: 0 });
  expect(runner.snapshot()).toBeNull();
  expect(homeWorkRunning("upload")).toBe(false);
  setHomeReauthorizing(false);
  const started = shown(runner, (state) => state.fileName === "Interview.m4a");
  resumeOnLaunch(runner, deps, false);
  expect(homeWorkRunning("upload")).toBe(true);
  await started;
  expect(counts.locks).toBe(1);
  runner.reset();
});
