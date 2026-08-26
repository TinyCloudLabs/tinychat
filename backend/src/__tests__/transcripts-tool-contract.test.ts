import { expect, test } from "bun:test";
import {
  TINYCLOUD_FIND_MEETINGS_TOOL,
  TINYCLOUD_LIST_MEETING_ACTIONS_TOOL,
  TINYCLOUD_MEETING_TOOLS,
  TINYCLOUD_READ_MEETING_TOOL,
  TINYCLOUD_SEARCH_TRANSCRIPTS_TOOL,
} from "../transcripts/tool-contract.js";

test("meeting tools have distinct closed, bounded public schemas", () => {
  expect(TINYCLOUD_MEETING_TOOLS.map((tool) => tool.function.name)).toEqual([
    "tinycloud_find_meetings",
    "tinycloud_read_meeting",
    "tinycloud_search_transcripts",
    "tinycloud_list_meeting_actions",
  ]);
  for (const tool of TINYCLOUD_MEETING_TOOLS) {
    expect(tool.function.parameters.additionalProperties).toBe(false);
    expect(JSON.stringify(tool)).not.toMatch(/\b(?:sql|path|space|limit)\b/i);
  }
  expect(TINYCLOUD_SEARCH_TRANSCRIPTS_TOOL.function.parameters.properties.query.maxLength).toBe(500);
  expect(TINYCLOUD_FIND_MEETINGS_TOOL.function.parameters.properties.selectFirst.type).toBe("boolean");
  expect(TINYCLOUD_READ_MEETING_TOOL.function.parameters.required).toEqual(["focus"]);
  expect(TINYCLOUD_READ_MEETING_TOOL.function.parameters.properties.meetingRef.description).toContain("Never pass a citation");
  expect(TINYCLOUD_LIST_MEETING_ACTIONS_TOOL.function.parameters.properties.from.pattern).toContain("\\d{4}");
  expect(TINYCLOUD_FIND_MEETINGS_TOOL.function.description).toContain("exact citation");
  expect(TINYCLOUD_READ_MEETING_TOOL.function.description).toContain("immediate follow-up");
  expect(TINYCLOUD_LIST_MEETING_ACTIONS_TOOL.function.description).toContain("Never use for an immediate follow-up");
});
