import { describe, expect, it } from "bun:test";
import { deleteShareRecordsForThread, shareIndexKeyFor, snapshotKeyFor } from "./shareRecords";

const SHARE_1 = "11111111-1111-4111-8111-111111111111";
const SHARE_2 = "22222222-2222-4222-8222-222222222222";

function indexEntry(shareId: string, threadId: string, key = snapshotKeyFor(shareId)) {
  return JSON.stringify({
    shareId,
    threadId,
    title: `Chat ${threadId}`,
    key,
    cid: `cid-${shareId}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z",
  });
}

function fakeTcw(failRevokeFor: Set<string> = new Set()) {
  const kv = new Map<string, string>();
  const revoked: string[] = [];
  const tcw = {
    kv: {
      get: async (key: string) =>
        kv.has(key) ? { ok: true, data: { data: kv.get(key) } } : { ok: false, error: { message: "not found" } },
      delete: async (key: string) => {
        kv.delete(key);
        return { ok: true, data: {} };
      },
      list: async ({ path }: { path: string }) => ({
        ok: true,
        data: { keys: [...kv.keys()].filter((key) => key.startsWith(path)) },
      }),
    },
    revokeDelegation: async (cid: string) => {
      if (failRevokeFor.has(cid)) return { ok: false, error: { message: "Controlled revoke failure" } };
      revoked.push(cid);
      return { ok: true, data: {} };
    },
  };
  return { tcw: tcw as never, kv, revoked };
}

function seed(kv: Map<string, string>) {
  kv.set(snapshotKeyFor(SHARE_1), "{}");
  kv.set(shareIndexKeyFor(SHARE_1), indexEntry(SHARE_1, "thread-1"));
  kv.set(snapshotKeyFor(SHARE_2), "{}");
  kv.set(shareIndexKeyFor(SHARE_2), indexEntry(SHARE_2, "thread-2"));
}

describe("deleting a chat removes its share records", () => {
  it("removes only the deleted chat's snapshot, owner record, and grant", async () => {
    const { tcw, kv, revoked } = fakeTcw();
    seed(kv);

    await deleteShareRecordsForThread(tcw, "thread-1");

    expect(revoked).toEqual([`cid-${SHARE_1}`]);
    expect(kv.has(snapshotKeyFor(SHARE_1))).toBe(false);
    expect(kv.has(shareIndexKeyFor(SHARE_1))).toBe(false);
    expect(kv.has(snapshotKeyFor(SHARE_2))).toBe(true);
    expect(kv.has(shareIndexKeyFor(SHARE_2))).toBe(true);
  });

  it("keeps the owner record when the grant cannot be revoked, but still deletes the snapshot", async () => {
    const { tcw, kv, revoked } = fakeTcw(new Set([`cid-${SHARE_1}`]));
    seed(kv);

    await deleteShareRecordsForThread(tcw, "thread-1");

    expect(revoked).toEqual([]);
    expect(kv.has(snapshotKeyFor(SHARE_1))).toBe(false);
    expect(kv.has(shareIndexKeyFor(SHARE_1))).toBe(true);
  });

  it("deletes nothing when the owner record's key does not name its own share snapshot", async () => {
    const { tcw, kv, revoked } = fakeTcw();
    kv.set(snapshotKeyFor(SHARE_2), "{}");
    kv.set(shareIndexKeyFor(SHARE_1), indexEntry(SHARE_1, "thread-1", snapshotKeyFor(SHARE_2)));
    const before = new Map(kv);

    await deleteShareRecordsForThread(tcw, "thread-1");

    expect(revoked).toEqual([]);
    expect(kv).toEqual(before);
  });
});
