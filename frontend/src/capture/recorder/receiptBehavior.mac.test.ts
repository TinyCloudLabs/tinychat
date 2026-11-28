import { describe, expect, test } from "bun:test";

import { noteAfterReceipt } from "./receiptBehavior";

describe("where a receipt that closes by itself leaves the user", () => {
  test("on the Mac, the recording's own page takes the place of a receipt that was on screen", () => {
    expect(noteAfterReceipt("tauri", true, "rec-1")).toBe("rec-1");
  });

  test("a receipt that was not on screen (minimised, or stopped from the call tile) moves nobody", () => {
    expect(noteAfterReceipt("tauri", false, "rec-1")).toBeNull();
  });

  test("a phone's receipt is a sheet over the screen the user is on, and goes back to it", () => {
    for (const platform of ["ios", "android", "web"]) expect(noteAfterReceipt(platform, true, "rec-1")).toBeNull();
  });

  test("without a saved recording there is no page to show", () => {
    expect(noteAfterReceipt("tauri", true, null)).toBeNull();
  });
});
