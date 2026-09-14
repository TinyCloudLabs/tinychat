import type {
  CatalogPageEnvelope,
  EvidenceEnvelope,
  SourceReference,
} from "@tinyboilerplate/core";
import type { MeetingCitation, MeetingResult } from "@tinyboilerplate/core";

const record = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) >= 0;
const nullableString = (v: unknown) => v === null || typeof v === "string";
const participants = (v: unknown) =>
  Array.isArray(v) &&
  v.every(
    (p) =>
      record(p) &&
      (p.name === undefined || typeof p.name === "string") &&
      (p.email === undefined || typeof p.email === "string"),
  );
const metadata = (v: unknown) =>
  record(v) &&
  nullableString(v.title) &&
  nullableString(v.startedAt) &&
  nullableString(v.organizerEmail) &&
  participants(v.participants) &&
  record(v.metadata);
const provenance = (v: unknown) =>
  record(v) &&
  nullableString(v.provider) &&
  nullableString(v.generatedAt) &&
  (v.sourceDigest === null ||
    (typeof v.sourceDigest === "string" &&
      /^[a-f0-9]{64}$/.test(v.sourceDigest))) &&
  ["known", "unknown"].includes(v.freshness);
export function validReference(v: unknown): v is SourceReference {
  return (
    record(v) &&
    ["fireflies", "google-meet", "tinycloud-transcriber"].includes(v.source) &&
    typeof v.sourceId === "string" &&
    !!v.sourceId &&
    v.sourceId.length <= 512 &&
    typeof v.meetingRef === "string" &&
    !!v.meetingRef &&
    v.meetingRef.length <= 128 &&
    typeof v.revision === "string" &&
    /^[a-f0-9]{64}$/.test(v.revision)
  );
}
export function sameReference(a: SourceReference, b: SourceReference): boolean {
  return (
    a.source === b.source &&
    a.sourceId === b.sourceId &&
    a.meetingRef === b.meetingRef &&
    a.revision === b.revision
  );
}
/** Validate the complete typed envelope. No inference from legacy prose or partial JSON. */
export function parseMeetingToolData(
  v: unknown,
): CatalogPageEnvelope | EvidenceEnvelope | null {
  if (
    !record(v) ||
    v.contractVersion !== 3 ||
    new TextEncoder().encode(JSON.stringify(v)).length > 2097152
  )
    return null;
  if (
    !Array.isArray(v.omissions) ||
    v.omissions.some((o: unknown) => !record(o) || typeof o.code !== "string")
  )
    return null;
  if (v.kind === "page") {
    if (
      !Array.isArray(v.rows) ||
      v.rows.length > 100 ||
      !count(v.examinedRows) ||
      v.examinedRows > 100 ||
      typeof v.exhausted !== "boolean" ||
      v.scope !== "observed" ||
      typeof v.observedAt !== "string" ||
      !(v.nextCursor === null || typeof v.nextCursor === "string") ||
      (!v.exhausted && !v.nextCursor)
    )
      return null;
    for (const row of v.rows)
      if (
        !record(row) ||
        typeof row.meetingRef !== "string" ||
        !row.meetingRef ||
        typeof row.sourceId !== "string" ||
        !["fireflies", "google-meet", "tinycloud-transcriber"].includes(
          row.source,
        ) ||
        !["published", "unverified", "unavailable"].includes(row.readiness) ||
        !participants(row.participants) ||
        !nullableString(row.title) ||
        !nullableString(row.startedAt) ||
        !nullableString(row.organizerEmail) ||
        !["transcript", "notes", null].includes(row.basis) ||
        (row.readiness === "published" && !validReference(row)) ||
        !(row.revision === null || validReference(row))
      )
        return null;
    return structuredClone(v) as CatalogPageEnvelope;
  }
  if (
    v.kind !== "evidence" ||
    !validReference(v.reference) ||
    !["transcript", "notes", "overview"].includes(v.basis) ||
    !["complete", "partial", "missing", "unavailable", "capacity"].includes(
      v.state,
    ) ||
    !record(v.coverage) ||
    typeof v.coverage.fetched !== "boolean" ||
    !count(v.coverage.decodedRecords) ||
    !count(v.coverage.suppliedRecords) ||
    !(v.coverage.totalRecords === null || count(v.coverage.totalRecords)) ||
    v.coverage.processedRecords !== null ||
    !Array.isArray(v.spans) ||
    !(v.metadata === null || metadata(v.metadata)) ||
    !(v.overviewProvenance === null || provenance(v.overviewProvenance))
  )
    return null;
  if (
    v.original !== null &&
    (!record(v.original) ||
      !/^[a-f0-9]{64}$/.test(v.original.digest) ||
      !count(v.original.byteLength) ||
      !(v.original.recordCount === null || count(v.original.recordCount)) ||
      !["known", "unknown"].includes(v.original.extent) ||
      ![true, false, null].includes(v.original.captureComplete))
  )
    return null;
  for (const span of v.spans)
    if (
      !record(span) ||
      typeof span.text !== "string" ||
      !count(span.recordIndex) ||
      !count(span.start) ||
      !count(span.end) ||
      span.end < span.start ||
      span.end - span.start !== span.text.length ||
      (span.speaker !== undefined && typeof span.speaker !== "string") ||
      (span.path !== undefined && typeof span.path !== "string") ||
      (v.coverage.totalRecords !== null &&
        span.recordIndex >= v.coverage.totalRecords) ||
      (span.startSecs !== undefined &&
        (typeof span.startSecs !== "number" ||
          !Number.isFinite(span.startSecs) ||
          span.startSecs < 0))
    )
      return null;
  const records = new Set(v.spans.map((s: any) => s.recordIndex)).size;
  if (
    records !== v.coverage.suppliedRecords ||
    v.coverage.suppliedRecords > v.coverage.decodedRecords ||
    (v.coverage.totalRecords !== null &&
      v.coverage.decodedRecords > v.coverage.totalRecords)
  )
    return null;
  if (
    v.state === "complete" &&
    (!v.coverage.fetched ||
      !v.spans.length ||
      v.omissions.length ||
      !v.metadata ||
      v.coverage.totalRecords === null ||
      records !== v.coverage.totalRecords ||
      v.spans.length !== records ||
      v.spans.some((span: any) => span.start !== 0) ||
      (v.basis === "overview" && !provenance(v.overviewProvenance)) ||
      (v.basis !== "overview" &&
        v.original?.recordCount !== null &&
        v.original?.recordCount !== records) ||
      (v.basis !== "overview" &&
        (!v.original ||
          v.original.byteLength > 1048576 ||
          v.original.extent !== "known")))
  )
    return null;
  return structuredClone(v) as EvidenceEnvelope;
}
export function citationsFor(
  evidence: EvidenceEnvelope,
  index: number,
): MeetingCitation[] {
  return evidence.spans.map((span, i) => ({
    ...span,
    ...evidence.reference,
    basis: evidence.basis,
    id: `M${index + 1}:E${i + 1}`,
  }));
}
export function recordCoverage(
  e: EvidenceEnvelope,
): MeetingResult["coverage"][number] {
  return {
    reference: e.reference,
    state: e.state,
    basis: e.basis,
    original: e.original,
    overviewProvenance: e.overviewProvenance,
    ...e.coverage,
    processedRecords: 0,
  };
}
