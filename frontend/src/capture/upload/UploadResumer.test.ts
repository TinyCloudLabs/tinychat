// The launch resumer (TC-761): an upload a reload interrupted continues at
// launch without opening the sheet, but an own-key AssemblyAI upload never
// reaches the key (and so never unlocks the vault) while the vault is locked.
// It waits as "Upload paused" until the user's tap. The deps are the real
// ones (buildUploadDeps) with the vault read replaced by a spy; the runner is
// the real runner.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import type { readAssemblyAiKey } from "@/lib/assemblyai";
import { createUploadRunner, uploadRunner, type PendingUpload, type PendingUploadStore, type UploadDeps } from "@/lib/audioUpload";
import type { PrivateCloudApi } from "@/lib/privateCloud";
import { continuePausedUpload, pausedUpload } from "./pausedUpload";
import { resumeOnLaunch } from "./UploadResumer";
import { buildUploadDeps } from "./useUploadDeps";

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

function setup(stored: PendingUpload | null) {
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
  const vaultReads: string[] = [];
  // The vault read: reaching it unlocks the vault, and prompts.
  const readKey = (async () => {
    vaultReads.push("readAssemblyAiKey");
    return { ok: true, data: null };
  }) as unknown as typeof readAssemblyAiKey;
  const hostedCalls: string[] = [];
  const hosted = new Proxy({}, { get: (_t, key) => () => { hostedCalls.push(String(key)); throw new Error("stop here"); } });
  const built = buildUploadDeps({
    tcw: { did: OWNER, kv: {} } as unknown as TinyCloudWeb,
    backendUrl: "http://127.0.0.1",
    sessionStore: {} as SessionStore,
    origin: null,
    api: {} as PrivateCloudApi,
    hosted: hosted as never,
    readKey,
  });
  const deps: UploadDeps = { ...built, pending, lock: async () => () => {} };
  return { deps, vaultReads, hostedCalls };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(() => {
  pausedUpload.set(null);
  uploadRunner.reset();
});

describe("resumeOnLaunch", () => {
  test("an own-key upload with the vault locked never reaches the key: it is published as paused", async () => {
    const runner = createUploadRunner();
    const { deps, vaultReads } = setup(job());
    resumeOnLaunch(runner, deps, false);
    await settle();
    expect(vaultReads).toEqual([]);
    expect(runner.snapshot()).toBeNull();
    expect(pausedUpload.snapshot()).toEqual({ fileName: "Interview.m4a" });
  });

  test("a job from before key modes counts as the user's own key", async () => {
    const runner = createUploadRunner();
    const { deps, vaultReads } = setup(job({ assemblyAiMode: undefined }));
    resumeOnLaunch(runner, deps, false);
    await settle();
    expect(vaultReads).toEqual([]);
    expect(pausedUpload.snapshot()?.fileName).toBe("Interview.m4a");
  });

  test("with the vault already open, the same upload resumes at launch and nothing is paused", async () => {
    const runner = createUploadRunner();
    const { deps, vaultReads } = setup(job());
    resumeOnLaunch(runner, deps, true);
    await settle();
    expect(vaultReads).toEqual(["readAssemblyAiKey"]);
    expect(pausedUpload.snapshot()).toBeNull();
  });

  test("TinyCloud's account resumes at once and needs no key", async () => {
    const runner = createUploadRunner();
    const { deps, vaultReads } = setup(job({ assemblyAiMode: "hosted" }));
    resumeOnLaunch(runner, deps, false);
    await settle();
    expect(vaultReads).toEqual([]);
    expect(runner.snapshot()).not.toBeNull();
    expect(pausedUpload.snapshot()).toBeNull();
  });

  test("nothing stored: nothing resumes, nothing is paused", async () => {
    const runner = createUploadRunner();
    const { deps, vaultReads } = setup(null);
    resumeOnLaunch(runner, deps, false);
    await settle();
    expect(vaultReads).toEqual([]);
    expect(runner.snapshot()).toBeNull();
    expect(pausedUpload.snapshot()).toBeNull();
  });

  test("Continue, from the user's tap, is what reads the key", async () => {
    const { deps, vaultReads } = setup(job());
    resumeOnLaunch(createUploadRunner(), deps, false);
    expect(pausedUpload.snapshot()).not.toBeNull();
    continuePausedUpload(deps);
    await settle();
    expect(pausedUpload.snapshot()).toBeNull();
    expect(vaultReads).toEqual(["readAssemblyAiKey"]);
  });
});

describe("UploadResumer in App", () => {
  const app = readFileSync(join(import.meta.dir, "../../App.tsx"), "utf8");
  const resumer = readFileSync(join(import.meta.dir, "UploadResumer.tsx"), "utf8");

  test("gated like the other workers, and placed after BackendReconciler", () => {
    const at = app.indexOf("<UploadResumer");
    expect(at).toBeGreaterThan(app.indexOf("<BackendReconciler"));
    expect(app.slice(at - 200, at)).toContain('!LOCAL_VALIDATION && state === "ready" && tcw &&');
    const usage = app.slice(at, app.indexOf("/>", at));
    expect(usage).toContain("tcw={tcw}");
    expect(usage).toContain("sessionStore={sessionStoreRef.current}");
    expect(usage).toContain("backendUrl={BACKEND_URL}");
    expect(app.match(/<UploadResumer/g)).toHaveLength(1);
  });

  test("it resumes only through the guard, with the vault's state read without unlocking", () => {
    expect(resumer).toContain("resumeOnLaunch(uploadRunner, deps, isSecretsUnlocked(tcw));");
    expect(resumer).not.toContain("uploadRunner.resume(");
    expect(resumer).not.toContain("unlockSecrets");
    expect(resumer).not.toContain("readAssemblyAiKey");
    // Signed out: the paused upload belonged to that account.
    expect(resumer).toContain("return () => pausedUpload.set(null);");
  });
});
