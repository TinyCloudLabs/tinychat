import { expect, test } from "bun:test";
import { advanceAccountGeneration } from "./accountContext";
import { createVoiceNoteCloud, localStorageVoiceNotePendingStore } from "./voiceNoteTranscription";
import type { PrivateCloudCreated } from "../privateCloud";

test("an account change during create reconciliation cannot send cancellation with the next account's session", async () => {
  const values = new Map<string, string>();
  const pending = localStorageVoiceNotePendingStore("did:test:cancel-owner", {
    getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); },
  });
  const created = Promise.withResolvers<PrivateCloudCreated>();
  const entered = Promise.withResolvers<void>();
  const cancellations: string[] = [];
  pending.write("note", { attemptId: "original-attempt", transcriptionId: null, failure: "cancelled",
    createBody: { content_type: "audio/wav", byte_size: 8, sha256: "a".repeat(64), language: "en", channel_mode: "mixed", channel_labels: ["You"] } });
  const cloud = createVoiceNoteCloud({ pending, origin: "https://unused.example",
    create: async () => { entered.resolve(); return created.promise; },
    api: { cancel: async (id: string) => { cancellations.push(id); } } as never,
    put: async () => { throw new Error("Cancellation cannot upload audio"); },
  });
  const cancellation = cloud.cancel!("note").catch((error: unknown) => error);
  await entered.promise;
  advanceAccountGeneration();
  created.resolve({ id: "trn_aaaaaaaaaaaaaaaa", status: "awaiting_upload", upload: null });
  expect(await cancellation).toMatchObject({ code: "account_changed" });
  expect(cancellations).toEqual([]);
  expect(cloud.cancellationPending!("note")).toBe(true);
  expect(pending.read("note")?.attemptId).toBe("original-attempt");
});
