import { expect, test } from "bun:test";
import { parseMeetingToolData } from "../transcripts/meeting-evidence.js";
const fixture = () => ({
  contractVersion: 3,
  kind: "evidence",
  reference: {
    source: "fireflies",
    sourceId: "a",
    meetingRef: "a",
    revision: "a".repeat(64),
  },
  basis: "transcript",
  state: "complete",
  metadata: {
    title: "A",
    startedAt: null,
    organizerEmail: null,
    participants: [],
    metadata: {},
  },
  original: {
    digest: "b".repeat(64),
    byteLength: 4,
    recordCount: 1,
    extent: "known",
    captureComplete: null,
  },
  coverage: {
    fetched: true,
    decodedRecords: 1,
    totalRecords: 1,
    suppliedRecords: 1,
    processedRecords: null,
  },
  spans: [{ text: "Text", recordIndex: 0, start: 0, end: 4 }],
  omissions: [],
  overviewProvenance: null,
});
test.each([
  "decoded_excess",
  "original_count",
  "record_index",
  "prefix_span",
  "metadata",
  "path",
])("rejects falsely complete evidence: %s", (kind) => {
  const e: any = fixture();
  if (kind === "decoded_excess") e.coverage.decodedRecords = 2;
  if (kind === "original_count") e.original.recordCount = 2;
  if (kind === "record_index") e.spans[0].recordIndex = 99;
  if (kind === "prefix_span") {
    e.spans[0].start = 2;
    e.spans[0].end = 6;
  }
  if (kind === "metadata") e.metadata.participants = [null];
  if (kind === "path") e.spans[0].path = 7;
  expect(parseMeetingToolData(e)).toBeNull();
});
test("stored overview requires explicit provenance including unknown freshness", () => {
  const e: any = fixture();
  e.basis = "overview";
  e.original = null;
  expect(parseMeetingToolData(e)).toBeNull();
  e.overviewProvenance = {
    provider: null,
    generatedAt: null,
    sourceDigest: null,
    freshness: "unknown",
  };
  expect(parseMeetingToolData(e)).not.toBeNull();
});
