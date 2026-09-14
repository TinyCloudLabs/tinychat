import { TOOL_RESULT_MAX_CHARS } from "../lib/contextGuard.js";
import type { MeetingToolData } from "./meeting-evidence.js";

type ObjectValue = Record<string, unknown>;
interface CitedText { citation: string; text: string; truncated?: boolean }
interface ProjectedMeeting {
  meetingRef: string;
  source: string;
  title: string | null;
  startedAt: string | null;
  participants: string[];
  organizerEmail: string | null;
  citation?: string;
  summary?: CitedText;
  actionItems: CitedText[];
  excerpts: CitedText[];
  coverage: {
    purpose: string;
    state: string;
    bodyState: string;
    bodyAttempted: boolean;
    bodyRequired?: boolean;
    bodyReasonCode?: string;
    overviewPresent: boolean;
    actionsPresent: boolean;
    support: string;
    evidenceRetained: number;
    omittedEvidenceCount: number;
    omissionReasons: string[];
    contextTruncated: boolean;
    omittedParticipantCount: number;
    organizerEmailOmitted: boolean;
  };
}
const object = (value: unknown): ObjectValue | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
const objects = (value: unknown): ObjectValue[] => Array.isArray(value) ? value.flatMap(item => object(item) ? [item as ObjectValue] : []) : [];
const citation = (value: unknown): string | undefined => typeof value === "string" && /^\[[MT]\d+(?::[A-Z]\d*)?(?:,[^\]\r\n]*)?\]$/.test(value) ? value : undefined;

/** Keep the service's cited projection together before the legacy head-only cap. */
export function compactLegacyMeetingResult(raw: ObjectValue, typed: MeetingToolData): string | null {
  const first = object(raw.meeting);
  const projections = [
    ...objects(raw.meetings), ...objects(raw.matches),
    ...(first ? [{ ...first, summary: raw.summary, actionItems: raw.actionItems, excerpts: raw.excerpts }] : []),
  ];
  const discovery = typed.discovery ? {
    matchedCount: typed.discovery.matchedCount, countKind: typed.discovery.countKind,
    returnedCount: typed.discovery.returnedCount, scanLimited: typed.discovery.scanLimited,
    excludedUndatedCount: typed.discovery.excludedUndatedCount, interval: typed.discovery.interval,
    ...(typed.discovery.orderProven === undefined ? {} : { orderProven: typed.discovery.orderProven }),
  } : undefined;
  if (!projections.some(item => citation(item.citation))) {
    const unavailable = JSON.stringify({ meetings: [], ...(discovery ? { discovery } : {}), omittedMeetingCount: typed.outcomes.length,
      ...(typed.outcomes.length ? { limit: "citation_projection_unavailable" } : {}) });
    return unavailable.length <= TOOL_RESULT_MAX_CHARS ? unavailable : JSON.stringify({ meetings: [], omittedMeetingCount: typed.outcomes.length, limit: "context_limit" });
  }
  const meetings: ProjectedMeeting[] = typed.outcomes.map(outcome => {
    const projected = projections.find(item => item.meetingRef === outcome.meetingRef && item.source === outcome.source);
    const copy = (value: unknown, kinds?: string[]): CitedText | undefined => {
      const entry = object(value);
      const label = citation(entry?.citation);
      if (!label || typeof entry?.text !== "string" || !entry.text.trim()) return undefined;
      const evidence = outcome.evidence.find(item => item.kind !== "metadata" && item.text === entry.text && (!kinds || kinds.includes(item.kind)));
      if (!evidence) return undefined;
      return { citation: label, text: entry.text, ...(evidence.truncated ? { truncated: true } : {}) };
    };
    const summary = copy(projected?.summary, ["summary", "notes"]);
    const actionItems = objects(projected?.actionItems).flatMap(item => { const result = copy(item, ["action"]); return result ? [result] : []; });
    const excerpts = [...objects(projected?.excerpts), ...objects(projected?.transcriptCandidates)]
      .flatMap(item => { const result = copy(item); return result ? [result] : []; })
      .filter((item, index, all) => all.findIndex(other => other.citation === item.citation && other.text === item.text) === index);
    const retained = Number(Boolean(summary)) + actionItems.length + excerpts.length;
    const contentEvidence = outcome.evidence.filter(item => item.kind !== "metadata").length;
    const omitted = Math.max(0, contentEvidence - retained);
    return {
      meetingRef: outcome.meetingRef, source: outcome.source,
      title: outcome.meeting.title?.slice(0, 160).replace(/[\uD800-\uDBFF]$/, "") ?? null, startedAt: outcome.meeting.startedAt,
      participants: [...outcome.meeting.participants], organizerEmail: outcome.meeting.organizerEmail,
      ...(citation(projected?.citation) ? { citation: citation(projected?.citation) } : {}),
      ...(summary ? { summary } : {}), actionItems, excerpts,
      coverage: {
        purpose: outcome.coverage.purpose, state: outcome.state, bodyState: outcome.body.state,
        bodyAttempted: outcome.coverage.bodyAttempted,
        ...(outcome.coverage.bodyRequired === undefined ? {} : { bodyRequired: outcome.coverage.bodyRequired }),
        ...(outcome.body.reasonCode === undefined ? {} : { bodyReasonCode: outcome.body.reasonCode }),
        overviewPresent: outcome.coverage.overviewPresent, actionsPresent: outcome.coverage.actionsPresent,
        support: outcome.coverage.support === "none" || (!retained && outcome.coverage.purpose !== "metadata") ? "none" : omitted ? "limited" : outcome.coverage.support,
        evidenceRetained: retained + Number(outcome.coverage.purpose === "metadata" && Boolean(citation(projected?.citation))),
        omittedEvidenceCount: outcome.coverage.omittedEvidenceCount + omitted,
        omissionReasons: [...outcome.coverage.omissionReasons], contextTruncated: omitted > 0 || (outcome.meeting.title?.length ?? 0) > 160,
        omittedParticipantCount: 0, organizerEmailOmitted: false,
      },
    };
  });
  let omittedMeetingCount = 0;
  const serialize = () => JSON.stringify({ meetings, ...(discovery ? { discovery } : {}), omittedMeetingCount });
  const limit = (meeting: ProjectedMeeting) => {
    meeting.coverage.contextTruncated = true;
    meeting.coverage.support = meeting.coverage.support !== "none" && meeting.coverage.evidenceRetained ? "limited" : "none";
  };
  let text = serialize();
  while (text.length > TOOL_RESULT_MAX_CHARS) {
    const evidence = meetings.flatMap(meeting => [
      ...(meeting.summary ? [{ meeting, item: meeting.summary, priority: 0 }] : []),
      ...meeting.actionItems.map(item => ({ meeting, item, priority: 1 })),
      ...meeting.excerpts.map(item => ({ meeting, item, priority: 2 })),
    ]);
    const longest = evidence.filter(entry => entry.item.text.length > 80).sort((a, b) => b.item.text.length - a.item.text.length)[0];
    const metadata = meetings.flatMap(meeting => [
      ...meeting.participants.map((value, index) => ({ meeting, value, index })),
      ...(meeting.organizerEmail === null ? [] : [{ meeting, value: meeting.organizerEmail, index: -1 }]),
    ]).sort((a, b) => JSON.stringify(b.value).length - JSON.stringify(a.value).length)[0];
    if (longest) {
      longest.item.text = longest.item.text.slice(0, Math.max(80, Math.floor(longest.item.text.length * 0.75))).replace(/[\uD800-\uDBFF]$/, "");
      longest.item.truncated = true;
      limit(longest.meeting);
    } else if (metadata) {
      // Omit whole names/addresses so shortened identities cannot become claims.
      if (metadata.index < 0) {
        metadata.meeting.organizerEmail = null;
        metadata.meeting.coverage.organizerEmailOmitted = true;
      } else {
        metadata.meeting.participants.splice(metadata.index, 1);
        metadata.meeting.coverage.omittedParticipantCount++;
      }
      if (!metadata.meeting.coverage.omissionReasons.includes("metadata_budget")) metadata.meeting.coverage.omissionReasons.push("metadata_budget");
      limit(metadata.meeting);
    } else if (evidence.length) {
      // Retain summaries before actions, and actions before longer body excerpts.
      const removed = evidence.sort((a, b) => a.priority - b.priority).at(-1)!;
      if (removed.meeting.summary === removed.item) delete removed.meeting.summary;
      removed.meeting.actionItems = removed.meeting.actionItems.filter(item => item !== removed.item);
      removed.meeting.excerpts = removed.meeting.excerpts.filter(item => item !== removed.item);
      removed.meeting.coverage.evidenceRetained--;
      removed.meeting.coverage.omittedEvidenceCount++;
      limit(removed.meeting);
    } else {
      const longTitle = meetings.find(meeting => (meeting.title?.length ?? 0) > 40);
      if (longTitle) { longTitle.title = longTitle.title!.slice(0, 40); limit(longTitle); }
      else if (meetings.length) { meetings.pop(); omittedMeetingCount++; }
      else return JSON.stringify({ meetings: [], omittedMeetingCount: typed.outcomes.length, limit: "context_limit" });
    }
    text = serialize();
  }
  return text;
}
