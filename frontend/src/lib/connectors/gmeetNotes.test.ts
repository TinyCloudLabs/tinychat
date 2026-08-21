import { describe, expect, test } from "bun:test";

import * as gmeetNotes from "./gmeetNotes";

const { parseGmeetNotesDocument } = gmeetNotes;

describe("parseGmeetNotesDocument", () => {
  test("turns a Notes by Gemini document into the existing meeting and sentence shapes", () => {
    const parsed = parseGmeetNotesDocument({
      documentId: "doc-1",
      title: "Project Atlas notes",
      body: {
        content: [
          { paragraph: { paragraphStyle: { namedStyleType: "TITLE" }, elements: [{ textRun: { content: "Notes by Gemini\n" } }] } },
          { paragraph: { paragraphStyle: { namedStyleType: "HEADING_1" }, elements: [{ textRun: { content: "Project Atlas\n" } }] } },
          { paragraph: { elements: [{ textRun: { content: "August 17, 2026, 9:00 AM -04:00 – 9:30 AM\n" } }] } },
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
    expect(parsed?.meeting.startedAt).toBe("2026-08-17T13:00:00.000Z");
    expect(parsed?.meeting.metadata).toMatchObject({
      datetime_source: "docs_content",
      datetime_exact: true,
      datetime_resolution_version: 1,
    });
    expect(parsed?.meeting.summaryOverview).toBe("The team agreed to ship the pilot.");
    expect(parsed?.meeting.summaryActionItems).toBe("Maya will prepare the launch checklist.");
    expect(parsed?.sentences).toEqual([{ index: 0, speaker_name: "Notes by Gemini", text: "The team agreed to ship the pilot.", start_time: 0, end_time: 0 }, { index: 1, speaker_name: "Notes by Gemini", text: "Maya will prepare the launch checklist.", start_time: 0, end_time: 0 }]);
  });

  test("accepts a title-marked legacy document without a duplicate body sentinel", () => {
    const parsed = parseGmeetNotesDocument({
      documentId: "doc-legacy",
      title: "Notes by Gemini — Project Atlas",
      body: { content: [
        { paragraph: { paragraphStyle: { namedStyleType: "HEADING_3" }, elements: [{ textRun: { content: "Summary\n" } }] } },
        { paragraph: { elements: [{ textRun: { content: "A sanitized legacy summary.\n" } }] } },
      ] },
    }, { fileId: "drive-legacy" });

    expect(parsed?.meeting.summaryOverview).toBe("A sanitized legacy summary.");
    expect(parsed?.meeting.title).toBe("Notes by Gemini — Project Atlas");
  });

  test("walks top-level tab bodies from a title-marked document", () => {
    const parsed = parseGmeetNotesDocument({
      documentId: "doc-tabbed",
      title: "Notes by Gemini — Project Atlas",
      tabs: [
        { tabProperties: { title: "Meeting notes" }, documentTab: { body: { content: [
          { paragraph: { paragraphStyle: { namedStyleType: "HEADING_3" }, elements: [{ textRun: { content: "Summary\n" } }] } },
          { paragraph: { elements: [{ textRun: { content: "A sanitized tabbed summary.\n" } }] } },
        ] } } },
        { tabProperties: { title: "Transcript" }, documentTab: { body: { content: [
          { paragraph: { elements: [{ textRun: { content: "Synthetic transcript content must not enter the Summary section.\n" } }] } },
        ] } } },
      ],
    }, { fileId: "drive-tabbed" });

    expect(parsed?.meeting.summaryOverview).toBe("A sanitized tabbed summary.");
    expect(parsed?.sentences.map((sentence) => sentence.text)).not.toContain("Synthetic transcript content must not enter the Summary section.");
  });

  test("uses Drive creation time only as provenance-labeled approximate display time", () => {
    const parsed = parseGmeetNotesDocument({
      documentId: "doc-approximate",
      title: "Notes by Gemini — Project Atlas",
      body: { content: [
        { paragraph: { elements: [{ textRun: { content: "August 17, 2026, 9:00 AM – 9:30 AM\n" } }] } },
        { paragraph: { paragraphStyle: { namedStyleType: "HEADING_1" }, elements: [{ textRun: { content: "Summary\n" } }] } },
        { paragraph: { elements: [{ textRun: { content: "A sanitized summary.\n" } }] } },
      ] },
    }, {
      fileId: "drive-approximate",
      createdTime: "2026-08-17T08:55:04.123Z",
      modifiedTime: "2026-08-19T11:12:13.000Z",
    });

    expect(parsed?.meeting.startedAt).toBe("2026-08-17T08:55:04.123Z");
    expect(parsed?.meeting.metadata).toMatchObject({
      datetime_source: "drive_created_time",
      datetime_exact: false,
      datetime_resolution_version: 1,
    });
    expect(parsed?.meeting.startedAt).not.toBe("2026-08-19T11:12:13.000Z");
  });

  test("keeps invalid and timezone-less values unavailable without a Drive creation time", () => {
    for (const content of [
      "August 17, 2026, 9:00 AM – 9:30 AM\n",
      "August 17, 2026, 25:00 UTC – invalid\n",
    ]) {
      const parsed = parseGmeetNotesDocument({
        title: "Notes by Gemini — Project Atlas",
        body: { content: [
          { paragraph: { elements: [{ textRun: { content } }] } },
          { paragraph: { paragraphStyle: { namedStyleType: "HEADING_1" }, elements: [{ textRun: { content: "Summary\n" } }] } },
          { paragraph: { elements: [{ textRun: { content: "A sanitized summary.\n" } }] } },
        ] },
      }, { fileId: "drive-unavailable", modifiedTime: "2026-08-19T11:12:13.000Z" });

      expect(parsed?.meeting.startedAt).toBeNull();
      expect(parsed?.meeting.metadata).toMatchObject({
        datetime_source: "unavailable",
        datetime_exact: false,
        datetime_resolution_version: 1,
      });
    }
  });

  test("rejects a timezone-less Drive creation value instead of using the host timezone", () => {
    const parsed = parseGmeetNotesDocument({
      title: "Notes by Gemini — Project Atlas",
      body: { content: [
        { paragraph: { paragraphStyle: { namedStyleType: "HEADING_1" }, elements: [{ textRun: { content: "Summary\n" } }] } },
        { paragraph: { elements: [{ textRun: { content: "A sanitized summary.\n" } }] } },
      ] },
    }, { fileId: "drive-invalid-created", createdTime: "2026-08-17 08:55:04" });

    expect(parsed?.meeting.startedAt).toBeNull();
    expect(parsed?.meeting.metadata).toMatchObject({
      datetime_source: "unavailable",
      datetime_exact: false,
    });
  });

  test("rejects an unrelated or structurally malformed document", () => {
    expect(parseGmeetNotesDocument({ documentId: "doc", title: "Draft", body: { content: [] } }, { fileId: "drive" })).toBeNull();
  });

  test("reports count-only parser rejection reasons without retaining document content", () => {
    const diagnose = (gmeetNotes as Record<string, unknown>).diagnoseGmeetNotesDocument;
    expect(typeof diagnose).toBe("function");
    if (typeof diagnose !== "function") return;

    const noMarker = diagnose({ body: { content: [] } }, { fileId: "fixture-a" });
    const noSection = diagnose({ body: { content: [
      { paragraph: { elements: [{ textRun: { content: "Notes by Gemini\n" } }] } },
    ] } }, { fileId: "fixture-b" });

    expect(noMarker).toEqual({ ok: false, reason: "no-marker" });
    expect(noSection).toEqual({ ok: false, reason: "no-supported-section" });
    expect(JSON.stringify([noMarker, noSection])).not.toContain("Notes by Gemini");
  });
});
