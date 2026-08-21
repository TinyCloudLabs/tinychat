// Google Docs "Notes by Gemini" → TinyChat's established meeting shape.
//
// This is intentionally structural rather than a broad text scrape: both the
// marker and the Summary/Next steps headings must be present before a Doc can
// become a meeting. The sync engine is responsible for deciding which Drive
// metadata is worth reading in the first place.

import type { FirefliesSentence } from "./firefliesClient";
import type { NormalizedMeeting } from "./connectorStore";

export interface GoogleDocsDocument {
  documentId?: string;
  title?: string;
  body?: { content?: unknown[] };
}

export interface GmeetNotesProvenance {
  fileId: string;
  modifiedTime?: string | null;
}

export interface GmeetNotesParseResult {
  meeting: NormalizedMeeting;
  sentences: FirefliesSentence[];
}

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
    const candidate = paragraph.text.split(/[–—-]/)[0]?.trim() ?? "";
    if (!/\b(?:19|20)\d{2}\b/.test(candidate)) continue;
    const ms = Date.parse(candidate);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
}

function meetingId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `gmeet-notes-${Math.random().toString(36).slice(2)}`;
}

/** Parse a verified Notes-by-Gemini Google Doc, otherwise return null. */
export function parseGmeetNotesDocument(
  document: GoogleDocsDocument,
  provenance: GmeetNotesProvenance,
): GmeetNotesParseResult | null {
  if (!provenance.fileId.trim()) return null;
  const paragraphs = (document.body?.content ?? [])
    .map(paragraphFrom)
    .filter((paragraph): paragraph is DocumentParagraph => paragraph !== null);
  if (!paragraphs.some((paragraph) => normalHeading(paragraph.text) === "notes by gemini")) return null;

  const overview = sectionText(paragraphs, "summary");
  const actions = sectionText(paragraphs, "next steps");
  if (overview === null && actions === null) return null;

  const markerIndex = paragraphs.findIndex((paragraph) => normalHeading(paragraph.text) === "notes by gemini");
  const titleParagraph = paragraphs.slice(markerIndex + 1).find((paragraph) =>
    paragraph.style?.startsWith("HEADING") && !["summary", "next steps"].includes(normalHeading(paragraph.text)),
  );
  const title = titleParagraph?.text ?? (typeof document.title === "string" && document.title.trim() ? document.title.trim() : null);
  const texts = [overview, actions].filter((text): text is string => text !== null);
  const sentences = texts.map((text, index) => ({
    index,
    speaker_name: "Notes by Gemini",
    text,
    start_time: 0,
    end_time: 0,
  }));

  return {
    meeting: {
      id: meetingId(),
      source: "google-meet",
      sourceId: provenance.fileId,
      title,
      startedAt: parseStartTime(paragraphs),
      durationSecs: null,
      organizerEmail: null,
      participants: [],
      summaryOverview: overview,
      summaryActionItems: actions,
      keywords: null,
      meetingType: null,
      metadata: {
        drive_file_id: provenance.fileId,
        drive_modified_time: provenance.modifiedTime ?? null,
        notes_kind: "gemini",
        notes_owned_fields: ["summary_overview", "summary_action_items"],
      },
    },
    sentences,
  };
}
