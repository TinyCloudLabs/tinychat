import { describe, expect, test } from "bun:test";
import { labelForActivity } from "./ToolActivityChip";

describe("tool activity errors", () => {
  test("does not tell users a failed transcript lookup needs reconnection", () => {
    expect(labelForActivity({ id: "a", name: "tinycloud_search_transcripts", status: "error" })).toBe("Transcript search failed");
  });

  test("does not tell users a failed meeting read needs reconnection", () => {
    expect(labelForActivity({ id: "b", name: "tinycloud_read_meeting", status: "error" })).toBe("Meeting read failed");
  });
});
