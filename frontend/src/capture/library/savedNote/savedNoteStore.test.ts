// The saved note's store: a recording with no row in the space reads only the device's note, so opening and
// editing it never waits on the network (a note just recorded, offline).
import { beforeEach, describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { saveNote } from "@/lib/voiceNotes/recordingNotes";
import { spaceSavedNoteStore } from "./savedNoteStore";

let gets: string[] = [];
beforeEach(() => {
  gets = [];
});
const offline = {
  kv: {
    get: async (key: string) => {
      gets.push(key);
      throw new Error("offline");
    },
  },
} as unknown as TinyCloudWeb;

describe("spaceSavedNoteStore", () => {
  test("a recording with no space row and no note yet loads empty and ready, offline, without asking the space", async () => {
    const store = spaceSavedNoteStore(offline, () => false);
    expect(await store.load("rec-offline-empty")).toBeNull();
    expect(gets).toEqual([]);
  });

  test("a recording with no space row loads the device's note without asking the space", async () => {
    await saveNote("rec-offline-note", "- **0:02** call back");
    const store = spaceSavedNoteStore(offline, () => false);
    expect((await store.load("rec-offline-note"))?.md).toContain("call back");
    expect(gets).toEqual([]);
  });

  test("a note with a row still falls back to the space, and an offline space is a load error", async () => {
    const store = spaceSavedNoteStore(offline);
    await expect(store.load("rec-has-row")).rejects.toThrow("offline");
    expect(gets).toHaveLength(1);
  });

  test("the question is asked at each load, so a store kept across the row landing starts reading the space", async () => {
    let hasRow = false;
    const store = spaceSavedNoteStore(offline, () => hasRow);
    expect(await store.load("rec-lands")).toBeNull();
    hasRow = true;
    await expect(store.load("rec-lands")).rejects.toThrow("offline");
  });
});
