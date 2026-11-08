import { afterEach, beforeEach, expect, test } from "bun:test";
import { createUploadRunner, type UploadDeps } from "./audioUpload";
import { __resetHomeWorkForTests, homeWorkRunning, setHomeReauthorizing } from "./homeReauthorizing";

beforeEach(() => { __resetHomeWorkForTests(); });
afterEach(() => { setHomeReauthorizing(false); });

/** Deps that fail the test the moment anything reads them: a refused call must not touch the account or the job. */
function untouchable(): { deps: UploadDeps; touched: string[] } {
  const touched: string[] = [];
  const deps = new Proxy({}, { get(_target, property) { touched.push(String(property)); throw new Error(`deps.${String(property)} was read`); } });
  return { deps: deps as UploadDeps, touched };
}

test("while a Home re-authorise is in progress, start, resume (the launch resume included), retry and discard are refused before they touch anything", async () => {
  const runner = createUploadRunner();
  const { deps, touched } = untouchable();
  setHomeReauthorizing(true);
  const file = new File(["x"], "standup.mp3", { type: "audio/mpeg" });
  // A start deferred behind a consent dialog lands here too: it is the same call.
  runner.start(deps, { file, engine: "private-cloud", diarize: false });
  runner.resume(deps);
  runner.retry(deps);
  await runner.dismiss(deps);
  expect(touched).toEqual([]);
  expect(runner.snapshot()).toBeNull();
  expect(homeWorkRunning("upload")).toBe(false);
});

/** An upload that failed (its engine call throws) and offers Retry; `reads` counts every use of its deps. */
async function failedUpload() {
  const runner = createUploadRunner();
  const reads: string[] = [];
  let job: unknown = null;
  const base = {
    tcw: { did: "did:example:a", kv: {} },
    lock: async () => () => {},
    pending: { read: () => job, write: (next: unknown) => { job = next; }, clear: () => { job = null; } },
    audio: { put: async () => { throw new Error("not stored"); }, manifest: async () => null, remove: async () => {} },
  };
  const deps = new Proxy(base, {
    get(target, property) {
      if (property === "then") return undefined;
      reads.push(String(property));
      if (property in target) return (target as Record<string | symbol, unknown>)[property];
      return () => { throw new Error(`deps.${String(property)} is not available here`); };
    },
  }) as unknown as UploadDeps;
  const failed = new Promise<void>((resolve) => {
    const off = runner.subscribe(() => { if (runner.snapshot()?.stage === "failed") { off(); resolve(); } });
  });
  runner.start(deps, { file: new File(["x"], "standup.mp3", { type: "audio/mpeg" }), engine: "private-cloud", diarize: false });
  await failed;
  return { runner, deps, reads };
}

test("Retry and Discard on a failed upload are refused during a re-authorise, and go ahead after it", async () => {
  const { runner, deps, reads } = await failedUpload();
  expect(runner.snapshot()?.error?.retry).toBe(true);
  expect(homeWorkRunning("upload")).toBe(false);
  const before = reads.length;
  setHomeReauthorizing(true);
  runner.retry(deps);
  await runner.dismiss(deps);
  expect(runner.snapshot()?.stage).toBe("failed");
  // Only the owner check (the account's DID) is read; no job, lock, storage or engine is touched.
  expect(reads.slice(before).filter((property) => property !== "tcw")).toEqual([]);
  expect(homeWorkRunning("upload")).toBe(false);
  setHomeReauthorizing(false);
  runner.retry(deps);
  expect(runner.snapshot()?.stage).toBe("preparing");
  expect(homeWorkRunning("upload")).toBe(true);
  runner.reset();
});
