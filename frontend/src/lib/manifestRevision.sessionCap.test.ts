import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import {
  applyManifestRevisionGate,
  createResignPromptGuard,
  recordManifestRevisionIfSigned,
  type RevisionStore,
} from "./manifestRevision";

// Nothing here leaves memory; HOME is still a throwaway dir, asserted before anything runs.
const testHome = mkdtempSync("/var/tmp/tc2056.");
process.env.HOME = testHome;
if (!process.env.HOME.startsWith("/var/tmp/tc2056.")) throw new Error("HOME is not the throwaway test home");
afterAll(() => { rmSync(testHome, { recursive: true, force: true }); });

const ADDRESS = "0x00000000000000000000000000000000000000Aa";
const OTHER = "0x00000000000000000000000000000000000000Bb";

/** Storage that reads fine but throws on every write (quota or a blocked profile). */
function unwritableStore(): RevisionStore {
  return {
    getItem: () => null,
    setItem: () => { throw new Error("QuotaExceededError"); },
  };
}

function restore(store: RevisionStore, guard: ReturnType<typeof createResignPromptGuard> | undefined, address: string | null = ADDRESS) {
  const calls: string[] = [];
  const outcome = applyManifestRevisionGate({
    store,
    address,
    isOffline: () => false,
    servedManifestCarriesBundle: async () => true,
    handoff: async () => true,
    clearSession: (cleared) => { calls.push(`clear:${cleared}`); },
    promptGuard: guard,
  });
  return outcome.then((result) => ({ result, calls }));
}

describe("unwritable revision storage", () => {
  test("asks to sign in again once per page session, not on every restore", async () => {
    const store = unwritableStore();
    const guard = createResignPromptGuard();
    expect(await restore(store, guard)).toEqual({ result: "cleared", calls: [`clear:${ADDRESS}`] });
    // The user signs in again; the revision cannot be written.
    recordManifestRevisionIfSigned(store, ADDRESS, { permissions: [] });
    for (let restoreNumber = 0; restoreNumber < 3; restoreNumber++) {
      expect(await restore(store, guard)).toEqual({ result: "current", calls: [] });
    }
  });

  test("a new page session (a new guard) may ask once more", async () => {
    const store = unwritableStore();
    expect((await restore(store, createResignPromptGuard())).result).toBe("cleared");
    expect((await restore(store, createResignPromptGuard())).result).toBe("cleared");
  });

  test("a deferred or failed gate does not use up the one prompt", async () => {
    const store = unwritableStore();
    const guard = createResignPromptGuard();
    const offline = await applyManifestRevisionGate({
      store, address: ADDRESS, isOffline: () => true,
      servedManifestCarriesBundle: async () => true, handoff: async () => true, clearSession: () => {}, promptGuard: guard,
    });
    expect(offline).toBe("deferred");
    const failedHandoff = await applyManifestRevisionGate({
      store, address: ADDRESS, isOffline: () => false,
      servedManifestCarriesBundle: async () => true, handoff: async () => false, clearSession: () => {}, promptGuard: guard,
    });
    expect(failedHandoff).toBe("handoff_failed");
    expect(guard.prompted).toBe(false);
    expect((await restore(store, guard)).result).toBe("cleared");
  });

  test("the cap is for the whole page session, whichever account restores next", async () => {
    const store = unwritableStore();
    const guard = createResignPromptGuard();
    expect((await restore(store, guard)).result).toBe("cleared");
    expect(await restore(store, guard, OTHER)).toEqual({ result: "current", calls: [] });
  });
});
