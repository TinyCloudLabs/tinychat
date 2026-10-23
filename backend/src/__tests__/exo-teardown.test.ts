import { describe, expect, test } from "bun:test";
import { EXO_JOBS_PREFIX, EXO_REQUESTS_PREFIX } from "../delegation-verify.js";
import type { ExoActivatedGrant } from "../exo/activated-grant.js";
import { ledgerKey } from "../exo/durable-ledger.js";
import { EXO_NAMESPACE } from "../exo/mailbox.js";
import { EXO_MIRROR_JOBS_PREFIX, type ExoBackendKv } from "../exo/stores.js";
import { clearExoOwnerState, clearExoSourceState, type ExoTeardownDeps } from "../exo/teardown.js";

const OWNER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
// Checksum-style owner; its lowercase form is the key-layout owner.
const MIXED_OWNER = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";

function fakeKv(initial: string[]) {
  const entries = new Set(initial);
  return {
    entries,
    kv: {
      list: async (prefix: string) => ({ ok: true, data: { keys: [...entries].filter((key) => key.startsWith(prefix)) } }),
      delete: async (key: string) => {
        if (!entries.delete(key)) {
          return { ok: false, error: { code: "KV_NOT_FOUND", service: "kv", message: `Key not found: ${key}` } };
        }
        return { ok: true };
      },
    },
  };
}

function fakeGrant(requests: string[], jobs: string[]) {
  const removed: string[] = [];
  const grant: ExoActivatedGrant = {
    requestsGet: async () => undefined,
    requestsList: async (directory) => requests.filter((key) => key.startsWith(directory)),
    requestsRemove: async (path) => {
      removed.push(path);
    },
    jobsGet: async () => undefined,
    jobsPut: async () => {},
    jobsPutIfAbsent: async () => true,
    jobsList: async (directory) => jobs.filter((key) => key.startsWith(directory)),
    jobsRemove: async (path) => {
      removed.push(path);
    },
  };
  return { grant, removed };
}

function teardownDeps(kv: Pick<ExoBackendKv, "list" | "delete">, grant: ExoActivatedGrant | null): ExoTeardownDeps {
  return { kv, openOwnerGrant: async () => grant };
}

describe("clearExoOwnerState", () => {
  test("removes owner-space rows, this owner's mirror jobs and ledger rows, and keeps other owners", async () => {
    const requestKey = `${EXO_REQUESTS_PREFIX}sync-meetings/req-1`;
    const jobKey = `${EXO_JOBS_PREFIX}job-1`;
    const mirrorKey = `${EXO_MIRROR_JOBS_PREFIX}${OWNER}/job-1`;
    const otherMirror = `${EXO_MIRROR_JOBS_PREFIX}${OTHER}/job-2`;
    const ledger = ledgerKey(OWNER, "sync-meetings");
    const otherLedger = ledgerKey(OTHER, "sync-meetings");
    const { kv, entries } = fakeKv([mirrorKey, otherMirror, ledger, otherLedger]);
    const { grant, removed } = fakeGrant([requestKey], [jobKey]);

    const result = await clearExoOwnerState(teardownDeps(kv, grant), OWNER);

    expect(result).toEqual({ ownerSpace: true });
    expect(removed.sort()).toEqual([jobKey, requestKey].sort());
    expect([...entries].sort()).toEqual([otherLedger, otherMirror].sort());
  });

  test("removes this owner's source locks and keeps other owners' locks", async () => {
    const lock = `${EXO_NAMESPACE}/source-lock/${OWNER}/google`;
    const otherLock = `${EXO_NAMESPACE}/source-lock/${OTHER}/google`;
    const { kv, entries } = fakeKv([lock, otherLock]);
    const { grant } = fakeGrant([], []);

    await clearExoOwnerState(teardownDeps(kv, grant), OWNER);

    expect([...entries]).toEqual([otherLock]);
  });

  test("normalizes a checksum-cased owner to the lowercased key layout", async () => {
    const ledger = ledgerKey(MIXED_OWNER.toLowerCase(), "sync-google");
    const { kv, entries } = fakeKv([ledger]);

    await clearExoOwnerState(teardownDeps(kv, null), MIXED_OWNER);

    expect(entries.has(ledger)).toBe(false);
  });

  test("a grant that cannot be opened (expired, or live but unopenable) does not block teardown", async () => {
    const mirrorKey = `${EXO_MIRROR_JOBS_PREFIX}${OWNER}/job-1`;
    const ledger = ledgerKey(OWNER, "sync-fireflies");
    const { kv, entries } = fakeKv([mirrorKey, ledger]);

    const result = await clearExoOwnerState(teardownDeps(kv, null), OWNER);

    expect(result).toEqual({ ownerSpace: false });
    expect(entries.size).toBe(0);
  });

  test("a failed owner-space removal throws before backend rows are touched, so the retry still reaches them", async () => {
    const mirrorKey = `${EXO_MIRROR_JOBS_PREFIX}${OWNER}/job-1`;
    const { kv, entries } = fakeKv([mirrorKey]);
    const { grant } = fakeGrant([`${EXO_REQUESTS_PREFIX}sync-meetings/req-1`], []);
    const failing: ExoActivatedGrant = {
      ...grant,
      requestsRemove: async () => {
        throw new Error("kv unavailable");
      },
    };

    await expect(clearExoOwnerState(teardownDeps(kv, failing), OWNER)).rejects.toThrow("kv unavailable");
    expect(entries.has(mirrorKey)).toBe(true);
  });

  test("a key listed but already gone at delete time is not an error, so a retry finishes", async () => {
    const mirrorKey = `${EXO_MIRROR_JOBS_PREFIX}${OWNER}/job-1`;
    const kv = {
      list: async (prefix: string) => ({ ok: true, data: { keys: [mirrorKey].filter((key) => key.startsWith(prefix)) } }),
      delete: async (key: string) => ({ ok: false, error: { code: "KV_NOT_FOUND", service: "kv", message: `Key not found: ${key}` } }),
    };

    await expect(clearExoOwnerState(teardownDeps(kv, null), OWNER)).resolves.toEqual({ ownerSpace: false });
  });

  test("a listed key outside its prefix stops the teardown before anything is deleted", async () => {
    const deleted: string[] = [];
    const kv = {
      list: async () => ({ ok: true, data: { keys: [`${EXO_NAMESPACE}/ledger/${OTHER}/sync-meetings`] } }),
      delete: async (key: string) => {
        deleted.push(key);
        return { ok: true };
      },
    };

    await expect(clearExoOwnerState(teardownDeps(kv, null), OWNER)).rejects.toThrow("outside its prefix");
    expect(deleted).toEqual([]);
  });
});

describe("clearExoSourceState", () => {
  test("removes only the ledger rows of capabilities that read this source alone", async () => {
    const fireflies = ledgerKey(OWNER, "sync-fireflies");
    const google = ledgerKey(OWNER, "sync-google");
    const meetings = ledgerKey(OWNER, "sync-meetings");
    const { kv, entries } = fakeKv([fireflies, google, meetings]);

    await clearExoSourceState(kv, OWNER, "fireflies");

    expect([...entries].sort()).toEqual([google, meetings].sort());
  });

  test("normalizes a checksum-cased owner before building the ledger key", async () => {
    const google = ledgerKey(MIXED_OWNER.toLowerCase(), "sync-google");
    const { kv, entries } = fakeKv([google]);

    await clearExoSourceState(kv, MIXED_OWNER, "google");

    expect(entries.has(google)).toBe(false);
  });
});
