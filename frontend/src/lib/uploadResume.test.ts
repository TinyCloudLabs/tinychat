// The upload resume guard (TC-761): nothing unlocks the vault on mount, so an
// interrupted own-key AssemblyAI upload waits for the user's tap.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { createUploadRunner, type PendingUpload, type PendingUploadStore, type UploadDeps } from "./audioUpload";
import { resumeNeedsUnlock, resumeUnlessLocked } from "./uploadResume";

const OWNER = "did:pkh:eip155:1:0x00000000000000000000000000000000000000a1";

function job(patch: Partial<PendingUpload> = {}): PendingUpload {
  return {
    engine: "assemblyai",
    meetingId: "m-1",
    attemptId: "a-1",
    jobId: "t-1",
    diarize: false,
    file: { name: "Interview.m4a", type: "audio/mp4", size: 1024, lastModified: 0 },
    owner: OWNER,
    saved: false,
    assemblyAiMode: "own",
    ...patch,
  };
}

describe("resumeNeedsUnlock", () => {
  test("only an own-key AssemblyAI job with the vault locked waits", () => {
    expect(resumeNeedsUnlock(job({ engine: "private-cloud", assemblyAiMode: undefined }), false)).toBe(false);
    expect(resumeNeedsUnlock(job({ assemblyAiMode: "hosted" }), false)).toBe(false);
    expect(resumeNeedsUnlock(job({ assemblyAiMode: "own" }), false)).toBe(true);
    expect(resumeNeedsUnlock(job({ assemblyAiMode: "own" }), true)).toBe(false);
    expect(resumeNeedsUnlock(null, false)).toBe(false);
    expect(resumeNeedsUnlock(null, true)).toBe(false);
  });

  test("a job from before key modes was made with the user's own key, as the runner reads it", () => {
    expect(resumeNeedsUnlock(job({ assemblyAiMode: undefined }), false)).toBe(true);
    expect(resumeNeedsUnlock(job({ assemblyAiMode: undefined }), true)).toBe(false);
  });

  test("saved jobs (cleanup only) and discards need the key too", () => {
    expect(resumeNeedsUnlock(job({ saved: true }), false)).toBe(true);
    expect(resumeNeedsUnlock(job({ discarding: true }), false)).toBe(true);
  });
});

describe("resumeUnlessLocked, with the real runner", () => {
  function deps(stored: PendingUpload | null) {
    let current = stored;
    const pending: PendingUploadStore = {
      read: () => current,
      write: (next) => {
        current = next;
      },
      clear: () => {
        current = null;
      },
    };
    const calls: string[] = [];
    const value: UploadDeps = {
      tcw: { did: OWNER, kv: {} } as unknown as TinyCloudWeb,
      privateCloud: null,
      save: async () => {
        throw new Error("not reached");
      },
      pending,
      // The own key comes from the vault: reaching this would unlock it.
      assemblyAiClient: async (mode) => {
        calls.push(`assemblyAiClient:${mode}`);
        throw new Error("stop here");
      },
      lock: async () => () => {},
    };
    return { value, calls };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  test("an own-key job with the vault locked is left alone: the vault is never reached", async () => {
    const runner = createUploadRunner();
    const { value, calls } = deps(job());
    const paused = resumeUnlessLocked(runner, value, false);
    await settle();
    expect(paused?.file.name).toBe("Interview.m4a");
    expect(calls).toEqual([]);
    expect(runner.snapshot()).toBeNull();
  });

  test("the same job resumes once the vault is open (or when the user taps Continue)", async () => {
    const runner = createUploadRunner();
    const { value, calls } = deps(job());
    expect(resumeUnlessLocked(runner, value, true)).toBeNull();
    await settle();
    expect(calls).toEqual(["assemblyAiClient:own"]);
  });

  test("TinyCloud's account and private cloud resume at once, with no key", async () => {
    const runner = createUploadRunner();
    const hosted = deps(job({ assemblyAiMode: "hosted" }));
    expect(resumeUnlessLocked(runner, hosted.value, false)).toBeNull();
    await settle();
    expect(hosted.calls).toEqual(["assemblyAiClient:hosted"]);
  });

  test("nothing stored, nothing to do", async () => {
    const runner = createUploadRunner();
    const { value, calls } = deps(null);
    expect(resumeUnlessLocked(runner, value, false)).toBeNull();
    await settle();
    expect(calls).toEqual([]);
  });
});

describe("uploads resume only behind the guard", () => {
  const read = (path: string) => readFileSync(join(import.meta.dir, path), "utf8");
  const resumer = read("../capture/upload/UploadResumer.tsx");
  const paused = read("../capture/upload/pausedUpload.ts");
  const deps = read("../capture/upload/useUploadDeps.ts");
  const guard = read("uploadResume.ts");

  test("the launch resume goes through resumeUnlessLocked with the vault's state", () => {
    expect(resumer).toContain("resumeOnLaunch(uploadRunner, deps, isSecretsUnlocked(tcw))");
    expect(resumer).toContain("const stored = resumeUnlessLocked(runner, deps, secretsUnlocked);");
    // runner.resume( in the guard comes only after resumeNeedsUnlock( decided.
    const body = guard.slice(guard.indexOf("export function resumeUnlessLocked("));
    expect(body.indexOf("if (resumeNeedsUnlock(")).toBeGreaterThan(-1);
    expect(body.indexOf("runner.resume(")).toBeGreaterThan(body.indexOf("if (resumeNeedsUnlock("));
  });

  test("the only direct resume is Continue, from the user's tap", () => {
    for (const path of [
      "../capture/upload/UploadResumer.tsx",
      "../capture/upload/UploadSheet.tsx",
      "../capture/CaptureSurface.tsx",
      "../capture/InProgressRows.tsx",
      "../chat/AudioUploadPanel.tsx",
    ]) {
      expect(read(path)).not.toContain("uploadRunner.resume(");
    }
    const direct = [...paused.matchAll(/uploadRunner\.resume\(/g)].map((m) => m.index!);
    expect(direct).toHaveLength(1);
    const handler = paused.slice(paused.lastIndexOf("export function continuePausedUpload(", direct[0]!), direct[0]!);
    expect(handler).toContain("export function continuePausedUpload(");
    // Continue is wired to taps only: the sheet's button and the In progress row's.
    expect(read("../chat/AudioUploadPanel.tsx")).toContain("const onContinue = useCallback(() => continuePausedUpload(deps), [deps]);");
    expect(read("../capture/CaptureSurface.tsx")).toContain("onContinue={() => continuePausedUpload(uploadDeps)}");
  });

  test("the upload's storage calls are queued with the Library's (lib/spaceQueue.ts)", () => {
    expect(deps).toContain("const space = scheduledSpace(tcw);");
    expect(deps).toContain("save: createLocalTranscriptSaver(space)");
    expect(deps).toContain("tcw: space,");
    expect(read("../chat/AudioUploadPanel.tsx")).toContain("useUploadDeps(tcw, backendUrl, sessionStore)");
  });
});
