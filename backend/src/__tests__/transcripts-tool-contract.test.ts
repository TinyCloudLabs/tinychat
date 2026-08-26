import { expect, test } from "bun:test";
import { TINYCLOUD_SEARCH_TRANSCRIPTS_TOOL } from "../transcripts/tool-contract.js";

test("transcript tool has a closed, bounded public schema", () => {
  expect(TINYCLOUD_SEARCH_TRANSCRIPTS_TOOL.function.name).toBe("tinycloud_search_transcripts");
  expect(TINYCLOUD_SEARCH_TRANSCRIPTS_TOOL.function.parameters.additionalProperties).toBe(false);
  expect(TINYCLOUD_SEARCH_TRANSCRIPTS_TOOL.function.parameters.properties.query.maxLength).toBe(500);
});
