import { expect, test } from "bun:test";
import { TINYCLOUD_FIND_MEETINGS_TOOL, TINYCLOUD_READ_MEETING_TOOL, TINYCLOUD_SEARCH_TRANSCRIPTS_TOOL, TINYCLOUD_LIST_MEETING_ACTIONS_TOOL } from "../src/transcripts/tool-contract.js";
import { parseMeetingToolData } from "../src/transcripts/meeting-evidence.js";

// Cross-repository acceptance in the prepared workspace; neither production
// repository depends on sibling source or a new shared package at runtime.
const servicePath = process.env.MEETING_SERVICE_SOURCE ?? new URL("../../../tinycloud-agents/packages/eliza-service/src/actions/tinycloud-search-transcripts.ts", import.meta.url).href;
const service = await import(servicePath);
const row = { meetingRef: "fixture-a", source: "google-meet", sourceId: "source-a", title: "Synthetic review", startedAt: "2026-09-02T12:00:00Z", participantNames: ["Sam"], participantEmails: ["sam@example.test"], organizerEmail: null, summaryOverview: "The team chose green.", summaryActionItems: "Sam: verify the green layout." };
const reader = { listMetadata: async () => [row], getMetadata: async (ref: string) => ref === row.meetingRef ? row : null, getTranscript: async () => [{ text: "Sam agreed to verify the green layout.", speaker_name: "Sam", start_time: 5 }] };
test("the four backend schemas and live service argument parsers accept the same v2 additions", () => {
  const cases = [
    [TINYCLOUD_FIND_MEETINGS_TOOL, service.parseFindMeetingsArgs, { title: "Review", participant: "Sam", from: "2026-09-01", to: "2026-09-09", source: "google-meet", sort: "oldest", selectFirst: false, limit: 12 }],
    [TINYCLOUD_READ_MEETING_TOOL, service.parseReadMeetingArgs, { meetingRef: "fixture-a", focus: "actions", assignee: "Sam", includeBody: true }],
    [TINYCLOUD_SEARCH_TRANSCRIPTS_TOOL, service.parseTranscriptSearchArgs, { query: "green", sort: "oldest", source: "google-meet", speaker: "Sam" }],
    [TINYCLOUD_LIST_MEETING_ACTIONS_TOOL, service.parseListMeetingActionsArgs, { assignee: "Sam", includeBody: true, sort: "oldest" }],
  ] as const;
  for (const [tool, parse, args] of cases) {
    expect(parse(args)).toEqual(args);
    for (const key of Object.keys(args)) expect(Object.keys(tool.function.parameters.properties)).toContain(key);
    expect(parse({ ...args, sql: "SELECT secret" })).toBeNull();
  }
  expect(service.parseFindMeetingsArgs({ limit: 13 })).toBeNull(); expect(service.parseReadMeetingArgs({ focus: "summary", includeBody: "true" })).toBeNull();
});
test("the backend accepts actual retained v2 service outcomes and legacy projections stay aligned", async () => {
  for (const result of [
    await service.findMeetings(reader, { limit: 12 }),
    await service.readMeeting(reader, { meetingRef: "fixture-a", focus: "summary" }),
    await service.readMeeting(reader, { meetingRef: "fixture-a", focus: "speaker", speaker: "Sam", includeBody: true }),
    await service.searchTranscripts(reader, { query: "green", meetingRef: "fixture-a" }, undefined, { retrievalMode: "single" }),
    await service.listMeetingActions(reader, { assignee: "Sam", includeBody: true }, undefined, { retrievalMode: "range" }),
  ]) {
    const parsed = parseMeetingToolData(result.data);
    expect(parsed).not.toBeNull(); expect(parsed!.outcomes).toHaveLength(1); expect(parsed!.outcomes[0].meetingRef).toBe("fixture-a");
    expect(result.data.contractVersion).toBe(2); expect(typeof result.text).toBe("string");
  }
});
