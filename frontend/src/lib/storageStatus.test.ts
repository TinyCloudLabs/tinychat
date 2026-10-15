import { describe, expect, it } from "bun:test";
import {
  MANAGE_STORAGE_URL,
  STORAGE_READ_ONLY_NOTICE,
  storageSaveMessage,
} from "./storageStatus";

// Canonical copy: tinycloud-dev docs/specs/storage-full-messaging.md §5.
// Deletes don't reliably lower usage yet (TC-1141) and paid users have no
// add-storage product, so no "free up space" or "upgrade" remedy may appear.
describe("storage-full copy", () => {
  it("uses the canonical write-rejected message for a full space", () => {
    expect(storageSaveMessage({ code: "STORAGE_QUOTA_EXCEEDED" })).toBe(
      "Your TinyCloud storage is full, so this change was not saved. Reading still works.",
    );
  });

  it("uses the canonical too-large message when the write exceeds what is left", () => {
    const expected =
      "This change is larger than the TinyCloud storage you have left, so it was not saved. Reading still works.";
    expect(storageSaveMessage({ code: "STORAGE_LIMIT_REACHED" })).toBe(expected);
    expect(storageSaveMessage(new Error("write exceeds remaining storage"))).toBe(expected);
  });

  it("uses the canonical read-only notice and billing link", () => {
    expect(STORAGE_READ_ONLY_NOTICE).toBe(
      "Your TinyCloud storage, shared by all your TinyCloud apps, is full. You can still view and copy your data. New changes can't be saved while your storage is full.",
    );
    expect(MANAGE_STORAGE_URL).toBe("https://account.tinycloud.xyz/billing?reason=storage-full");
  });
});
