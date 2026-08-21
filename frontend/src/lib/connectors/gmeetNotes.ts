// Google Docs "Notes by Gemini" → TinyChat's established meeting shape.
//
// This is intentionally structural rather than a broad text scrape: both the
// marker and the Summary/Next steps headings must be present before a Doc can
// become a meeting. The sync engine is responsible for deciding which Drive
// metadata is worth reading in the first place.

import type { FirefliesSentence } from "./firefliesClient";
import type { NormalizedMeeting } from "./connectorStore";
import type { GoogleDocsDocument } from "./gmeetClient";

export const GMEET_DATETIME_RESOLUTION_VERSION = 1;

export interface GmeetNotesProvenance {
  fileId: string;
  createdTime?: string | null;
  modifiedTime?: string | null;
  verifiedCandidate?: boolean;
}

export interface GmeetNotesParseResult {
  meeting: NormalizedMeeting;
  sentences: FirefliesSentence[];
}

export type GmeetNotesParseOutcome =
  | { ok: true; data: GmeetNotesParseResult }
  | { ok: false; reason: "no-marker" | "no-supported-section" };

interface DocumentParagraph {
  text: string;
  style: string | null;
}

function paragraphFrom(value: unknown): DocumentParagraph | null {
  if (!value || typeof value !== "object") return null;
  const paragraph = (value as { paragraph?: unknown }).paragraph;
  if (!paragraph || typeof paragraph !== "object") return null;
  const p = paragraph as {
    paragraphStyle?: { namedStyleType?: unknown };
    elements?: Array<{ textRun?: { content?: unknown } }>;
  };
  const text = (p.elements ?? [])
    .map((element) => typeof element.textRun?.content === "string" ? element.textRun.content : "")
    .join("")
    .replace(/\n+$/g, "")
    .trim();
  if (!text) return null;
  return { text, style: typeof p.paragraphStyle?.namedStyleType === "string" ? p.paragraphStyle.namedStyleType : null };
}

function normalHeading(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/:$/, "");
}

function sectionText(paragraphs: readonly DocumentParagraph[], heading: string): string | null {
  const start = paragraphs.findIndex((p) => p.style?.startsWith("HEADING") && normalHeading(p.text) === heading);
  if (start < 0) return null;
  const lines: string[] = [];
  for (const paragraph of paragraphs.slice(start + 1)) {
    if (paragraph.style?.startsWith("HEADING")) break;
    lines.push(paragraph.text.replace(/^[•*-]\s*/, ""));
  }
  const text = lines.join("\n").trim();
  return text || null;
}

function parseStartTime(paragraphs: readonly DocumentParagraph[]): string | null {
  for (const paragraph of paragraphs) {
    const candidate = paragraph.text.split(/[–—]/)[0]?.trim() ?? "";
    if (!/\b(?:19|20)\d{2}\b/.test(candidate) || !/\d{1,2}:\d{2}/.test(candidate)) continue;
    if (!/(?:\b(?:UTC|GMT)\b|(?:Z|[+-]\d{2}:?\d{2})\s*$)/i.test(candidate)) continue;
    const ms = Date.parse(candidate);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
}

function normalizeIsoInstant(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const candidate = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(candidate)) return null;
  const ms = Date.parse(candidate);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function meetingId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `gmeet-notes-${Math.random().toString(36).slice(2)}`;
}

/** Parse a verified Notes-by-Gemini Google Doc with a count-only rejection reason. */
export function diagnoseGmeetNotesDocument(
  document: GoogleDocsDocument,
  provenance: GmeetNotesProvenance,
): GmeetNotesParseOutcome {
  const paragraphGroups = [document.body?.content, ...(document.tabs ?? []).map((tab) => tab.documentTab?.body?.content)]
    .filter((content): content is unknown[] => Array.isArray(content))
    .map((content) => content.map(paragraphFrom).filter((paragraph): paragraph is DocumentParagraph => paragraph !== null));
  const paragraphs = paragraphGroups.flat();
  const titleHasMarker = typeof document.title === "string" && /\bnotes by gemini\b/i.test(document.title);
  if (!provenance.verifiedCandidate && !titleHasMarker
    && !paragraphs.some((paragraph) => normalHeading(paragraph.text) === "notes by gemini")) {
    return { ok: false, reason: "no-marker" };
  }

  const overview = paragraphGroups.map((group) => sectionText(group, "summary")).find((text) => text !== null) ?? null;
  const actions = paragraphGroups.map((group) => sectionText(group, "next steps")).find((text) => text !== null) ?? null;
  if (overview === null && actions === null) {
    return { ok: false, reason: "no-supported-section" };
  }

  const markerIndex = paragraphs.findIndex((paragraph) => normalHeading(paragraph.text) === "notes by gemini");
  const titleParagraph = paragraphs.slice(markerIndex + 1).find((paragraph) =>
    paragraph.style?.startsWith("HEADING") && !["summary", "next steps"].includes(normalHeading(paragraph.text)),
  );
  const title = titleParagraph?.text ?? (typeof document.title === "string" && document.title.trim() ? document.title.trim() : null);
  const texts = [overview, actions].filter((text): text is string => text !== null);
  const docsStartedAt = parseStartTime(paragraphs);
  const createdAt = normalizeIsoInstant(provenance.createdTime);
  const datetime = docsStartedAt !== null
    ? { startedAt: docsStartedAt, source: "docs_content", exact: true }
    : createdAt !== null
      ? { startedAt: createdAt, source: "drive_created_time", exact: false }
      : { startedAt: null, source: "unavailable", exact: false };
  const sentences = texts.map((text, index) => ({
    index,
    speaker_name: "Notes by Gemini",
    text,
    start_time: 0,
    end_time: 0,
  }));

  return { ok: true, data: {
    meeting: {
      id: meetingId(),
      source: "google-meet",
      sourceId: provenance.fileId,
      title,
      startedAt: datetime.startedAt,
      durationSecs: null,
      organizerEmail: null,
      participants: [],
      summaryOverview: overview,
      summaryActionItems: actions,
      keywords: null,
      meetingType: null,
      metadata: {
        drive_file_id: provenance.fileId,
        drive_created_time: provenance.createdTime ?? null,
        drive_modified_time: provenance.modifiedTime ?? null,
        datetime_source: datetime.source,
        datetime_exact: datetime.exact,
        datetime_resolution_version: GMEET_DATETIME_RESOLUTION_VERSION,
        notes_kind: "gemini",
        notes_owned_fields: ["summary_overview", "summary_action_items"],
      },
    },
    sentences,
  } };
}

/** Compatibility wrapper for callers that do not need the rejection bucket. */
export function parseGmeetNotesDocument(
  document: GoogleDocsDocument,
  provenance: GmeetNotesProvenance,
): GmeetNotesParseResult | null {
  if (!provenance.fileId.trim()) return null;
  const outcome = diagnoseGmeetNotesDocument(document, provenance);
  return outcome.ok ? outcome.data : null;
}
