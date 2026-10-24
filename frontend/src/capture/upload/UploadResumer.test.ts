import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { createUploadRunner, uploadRunner, type PendingUpload, type PendingUploadStore, type UploadDeps } from "@/lib/audioUpload";
import type { PrivateCloudApi } from "@/lib/privateCloud";
import { pausedUpload } from "./pausedUpload";
import { resumeOnLaunch } from "./UploadResumer";
import { buildUploadDeps } from "./useUploadDeps";

const OWNER = "did:pkh:eip155:1:0x00000000000000000000000000000000000000a1";
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function setup(stored: PendingUpload | null) {
  let current = stored;
  const pending: PendingUploadStore = {
    read: () => current, write: (next) => { current = next; }, clear: () => { current = null; },
  };
  const hostedCalls: string[] = [];
  const hosted = new Proxy({}, { get: (_target, key) => () => { hostedCalls.push(String(key)); throw new Error("stop here"); } });
  const built = buildUploadDeps({ tcw: { did: OWNER, kv: {} } as unknown as TinyCloudWeb,
    backendUrl: "http://127.0.0.1", sessionStore: {} as SessionStore,
    origin: null, api: {} as PrivateCloudApi, hosted: hosted as never });
  return { deps: { ...built, pending, lock: async () => () => {} } as UploadDeps, hostedCalls };
}

afterEach(() => { pausedUpload.set(null); uploadRunner.reset(); });

describe("resumeOnLaunch", () => {
  test("a hosted AssemblyAI upload resumes without a key or vault", async () => {
    const runner = createUploadRunner();
    const { deps } = setup({ engine: "assemblyai", assemblyAiMode: "hosted", meetingId: "m-1", attemptId: "a-1",
      jobId: "t-1", diarize: false, file: { name: "Interview.m4a", type: "audio/mp4", size: 1024, lastModified: 0 },
      owner: OWNER, saved: false });
    resumeOnLaunch(runner, deps, false);
    await settle();
    expect(runner.snapshot()).not.toBeNull();
    expect(pausedUpload.snapshot()).toBeNull();
  });

  test("nothing stored resumes nothing", async () => {
    const runner = createUploadRunner();
    resumeOnLaunch(runner, setup(null).deps, false);
    await settle();
    expect(runner.snapshot()).toBeNull();
    expect(pausedUpload.snapshot()).toBeNull();
  });
});

describe("UploadResumer in App", () => {
  const app = readFileSync(join(import.meta.dir, "../../App.tsx"), "utf8");
  test("is mounted once after GmeetSessionSync", () => {
    const at = app.indexOf("<UploadResumer");
    expect(at).toBeGreaterThan(app.indexOf("<GmeetSessionSync"));
    expect(app.match(/<UploadResumer/g)).toHaveLength(1);
  });
});
