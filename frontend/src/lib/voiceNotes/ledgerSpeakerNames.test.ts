// The ledger write composes over the map stored right now (read → owner/rev check → updateLedger),
// so a rename between a stale UI snapshot and the write can never overwrite another writer's names.
import { afterEach, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { VoiceNotes, __setVoiceNotesForTests } from "./nativeVoiceNotes";
import { readLedgerSpeakerNames, saveLedgerSpeakerNames } from "./ledgerSpeakerNames";

const tcw = { did: "did:test" } as unknown as TinyCloudWeb;

type PluginArgs = { id: string; did: string; rev: number; patch: { speakerNames?: Record<string, string> | null } };
type Recording = {
  id: string; owner: string; rev: number;
  ledger: { speakerNames?: Record<string, string> | null };
};

const rec = (over: Partial<Recording> = {}): Recording => ({
  id: "rec-1", owner: "did:test", rev: 3, ledger: {}, ...over,
});

afterEach(() => __setVoiceNotesForTests(VoiceNotes, { available: null }));

test("a write is composed over the map stored at write time, not the snapshot the caller last saw", async () => {
  const recording = rec();
  recording.ledger.speakerNames = { Them: "Alice" };
  const plugin = {
    listPending: async () => ({ recordings: [recording] }),
    updateLedger: async ({ rev, patch }: PluginArgs) => {
      if (rev !== recording.rev) throw Object.assign(new Error("rev"), { code: "rev_conflict" });
      recording.rev += 1;
      Object.assign(recording.ledger, patch);
      return { rev: recording.rev };
    },
  };
  __setVoiceNotesForTests(plugin as never, { available: true });
  // The caller's intent adds its own name; the name the ledger already carried is preserved.
  const names = await saveLedgerSpeakerNames(tcw, "rec-1", (stored) => ({ ...stored, Me: "Sam" }));
  expect(names).toEqual({ Them: "Alice", Me: "Sam" });
  expect(recording.ledger.speakerNames).toEqual({ Them: "Alice", Me: "Sam" });
});

test("a rev conflict re-reads and reapplies once; the concurrent writer's name survives", async () => {
  const recording = rec();
  let calls = 0;
  const plugin = {
    listPending: async () => ({ recordings: [recording] }),
    updateLedger: async ({ rev, patch }: PluginArgs) => {
      calls++;
      if (calls === 1) {
        // A concurrent writer lands first: new rev, new names the retried write must keep.
        recording.rev += 1;
        recording.ledger.speakerNames = { Them: "Alice" };
        throw Object.assign(new Error("rev"), { code: "rev_conflict" });
      }
      if (rev !== recording.rev) throw Object.assign(new Error("rev"), { code: "rev_conflict" });
      recording.rev += 1;
      Object.assign(recording.ledger, patch);
      return { rev: recording.rev };
    },
  };
  __setVoiceNotesForTests(plugin as never, { available: true });
  const names = await saveLedgerSpeakerNames(tcw, "rec-1", (stored) => ({ ...stored, Me: "Sam" }));
  // The second read saw the concurrent map; both names land.
  expect(names).toEqual({ Them: "Alice", Me: "Sam" });
  expect(recording.ledger.speakerNames).toEqual({ Them: "Alice", Me: "Sam" });
  expect(calls).toBe(2);
});

test("two conflicts in a row fail the save without a blind third write", async () => {
  const recording = rec();
  let calls = 0;
  const plugin = {
    listPending: async () => ({ recordings: [recording] }),
    updateLedger: async () => {
      calls++;
      recording.rev += 1;
      throw Object.assign(new Error("rev"), { code: "rev_conflict" });
    },
  };
  __setVoiceNotesForTests(plugin as never, { available: true });
  await expect(saveLedgerSpeakerNames(tcw, "rec-1", () => ({ Me: "Sam" }))).rejects.toThrow();
  expect(calls).toBe(2);
});

test("another account's note is read-only and the ledger is never written", async () => {
  const recording = rec({ owner: "did:someone-else" });
  let writes = 0;
  const plugin = {
    listPending: async () => ({ recordings: [recording] }),
    updateLedger: async () => { writes++; return { rev: 4 }; },
  };
  __setVoiceNotesForTests(plugin as never, { available: true });
  expect(await readLedgerSpeakerNames(tcw, "rec-1")).toBe("not-owned");
  await expect(saveLedgerSpeakerNames(tcw, "rec-1", () => ({ Me: "Sam" }))).rejects.toThrow("another account");
  expect(writes).toBe(0);
});
