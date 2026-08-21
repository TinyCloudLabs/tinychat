import { describe, expect, test } from "bun:test";

import { parseGmeetNotesDocument } from "./gmeetNotes";

describe("parseGmeetNotesDocument", () => {
  test("turns a Notes by Gemini document into the existing meeting and sentence shapes", () => {
    const parsed = parseGmeetNotesDocument({
      documentId: "doc-1",
      title: "Project Atlas notes",
      body: {
        content: [
          { paragraph: { paragraphStyle: { namedStyleType: "TITLE" }, elements: [{ textRun: { content: "Notes by Gemini\n" } }] } },
          { paragraph: { paragraphStyle: { namedStyleType: "HEADING_1" }, elements: [{ textRun: { content: "Project Atlas\n" } }] } },
          { paragraph: { elements: [{ textRun: { content: "August 17, 2026, 9:00 AM – 9:30 AM\n" } }] } },
          { paragraph: { paragraphStyle: { namedStyleType: "HEADING_1" }, elements: [{ textRun: { content: "Summary\n" } }] } },
          { paragraph: { elements: [{ textRun: { content: "The team agreed to ship the pilot.\n" } }] } },
          { paragraph: { paragraphStyle: { namedStyleType: "HEADING_1" }, elements: [{ textRun: { content: "Next steps\n" } }] } },
          { paragraph: { elements: [{ textRun: { content: "• Maya will prepare the launch checklist.\n" } }] } },
        ],
      },
    }, { fileId: "drive-file-1", modifiedTime: "2026-08-17T10:00:00.000Z" });

    expect(parsed).not.toBeNull();
    expect(parsed?.meeting.source).toBe("google-meet");
    expect(parsed?.meeting.sourceId).toBe("drive-file-1");
    expect(parsed?.meeting.title).toBe("Project Atlas");
    expect(parsed?.meeting.startedAt).toBe("2026-08-17T09:00:00.000Z");
    expect(parsed?.meeting.summaryOverview).toBe("The team agreed to ship the pilot.");
    expect(parsed?.meeting.summaryActionItems).toBe("Maya will prepare the launch checklist.");
    expect(parsed?.sentences).toEqual([{ index: 0, speaker_name: "Notes by Gemini", text: "The team agreed to ship the pilot.", start_time: 0, end_time: 0 }, { index: 1, speaker_name: "Notes by Gemini", text: "Maya will prepare the launch checklist.", start_time: 0, end_time: 0 }]);
  });

  test("rejects an unrelated or structurally malformed document", () => {
    expect(parseGmeetNotesDocument({ documentId: "doc", title: "Draft", body: { content: [] } }, { fileId: "drive" })).toBeNull();
  });
});
