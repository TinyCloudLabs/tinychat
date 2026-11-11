import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ContentStore, InMemoryContentBlobStore, contentMasterFingerprint, type ContentContinuityStorage, type SealedBlob } from "../services/content-store.js";

const master = "test-content-master-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
function fixture() {
  let canary: SealedBlob | null = null;
  let writes = 0;
  const storage: ContentContinuityStorage = {
    readCanary: async () => canary,
    writeCanary: async blob => { writes++; canary = blob; },
    findIndex: async () => null,
    hasContent: async () => false,
  };
  const blobs = new InMemoryContentBlobStore();
  return { storage, store: (key = master) => new ContentStore(blobs, { master: () => key }), writes: () => writes };
}
const fresh = { CONNECTOR_CONTENT_ENROLL_FRESH: "true" };
test("explicit fresh enrollment creates encrypted canary; same master passes without replacing it", async () => {
  const f = fixture();
  await f.store().assertContinuity(f.storage, fresh);
  expect(f.writes()).toBe(1);
  expect(JSON.stringify(await f.storage.readCanary())).not.toContain(master);
  await f.store().assertContinuity(f.storage, {});
  expect(f.writes()).toBe(1);
});
test("changed master refuses and leaves canary unchanged", async () => {
  const f = fixture();
  await f.store().assertContinuity(f.storage, fresh);
  await expect(f.store(master + "different").assertContinuity(f.storage, fresh)).rejects.toThrow("refusing startup and writes");
  expect(f.writes()).toBe(1);
});
test("fresh install requires operator flag and rejects a mismatched pin", async () => {
  const f = fixture();
  await expect(f.store().assertContinuity(f.storage, {})).rejects.toThrow();
  await expect(f.store().assertContinuity(f.storage, { ...fresh, CONNECTOR_CONTENT_EXPECTED_SHA256: "wrong" })).rejects.toThrow();
  expect(f.writes()).toBe(0);
});
test("existing archive requires matching pin and successful decrypt before any write", async () => {
  const f = fixture();
  f.storage.findIndex = async () => ({ source: "fireflies", address: "0x1111111111111111111111111111111111111111" });
  await expect(f.store().assertContinuity(f.storage, fresh)).rejects.toThrow();
  await expect(f.store().assertContinuity(f.storage, { CONNECTOR_CONTENT_EXPECTED_SHA256: contentMasterFingerprint(master) })).rejects.toThrow();
  expect(f.writes()).toBe(0);
});
test("orphan content and storage failures never enroll", async () => {
  const f = fixture();
  f.storage.hasContent = async () => true;
  await expect(f.store().assertContinuity(f.storage, fresh)).rejects.toThrow();
  f.storage.readCanary = async () => { throw new Error("private storage detail"); };
  await expect(f.store().assertContinuity(f.storage, fresh)).rejects.toThrow("connector content continuity failed; refusing startup and writes");
  expect(f.writes()).toBe(0);
});
test("commitment matches #637 SHA-256 and contains no master material", () => {
  const digest = contentMasterFingerprint(master);
  expect(digest).toBe(createHash("sha256").update(master, "utf8").digest("hex"));
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  expect(digest).not.toContain(master);
  expect(digest).not.toContain(Buffer.from(master).toString("base64"));
});

test("matching live pin enrolls only after a real existing index decrypts", async () => {
  const blobs = new InMemoryContentBlobStore();
  const source = "fireflies";
  const address = "0x1111111111111111111111111111111111111111";
  const store = new ContentStore(blobs, { master: () => master });
  const now = new Date().toISOString();
  expect((await store.upsert({ source, address, sourceId: "meeting-1", kind: "transcript", content: { sentences: ["private meeting"] }, fetchedAt: now, receivedAt: now })).ok).toBe(true);
  const f = fixture();
  f.storage.findIndex = async () => ({ source, address });
  const probe = await store.probeIndex({ source, address });
  expect(probe.ok).toBe(true);
  expect(JSON.stringify(probe)).not.toContain(address);
  await store.assertContinuity(f.storage, { CONNECTOR_CONTENT_EXPECTED_SHA256: contentMasterFingerprint(master) });
  expect(f.writes()).toBe(1);
  expect((await new ContentStore(blobs, { master: () => master + "changed" }).probeIndex({ source, address })).ok).toBe(false);
});

test("enrolled canary rejects tampering and an explicitly wrong expected digest", async () => {
  const f = fixture();
  await f.store().assertContinuity(f.storage, fresh);
  await expect(f.store().assertContinuity(f.storage, { CONNECTOR_CONTENT_EXPECTED_SHA256: "0".repeat(64) })).rejects.toThrow();
  const saved = (await f.storage.readCanary())!;
  f.storage.readCanary = async () => ({ ...saved, ciphertext: "invalid" });
  await expect(f.store().assertContinuity(f.storage, {})).rejects.toThrow();
  expect(f.writes()).toBe(1);
});
