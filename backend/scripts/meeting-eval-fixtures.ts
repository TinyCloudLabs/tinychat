/** Synthetic material only. No real account, source ID, or provider transcript. */
import type { MeetingDiscovery, MeetingMetadata, MeetingOutcome, MeetingPurpose } from "../src/transcripts/meeting-evidence.js";
export const MEETING_EVAL_CALENDAR = { localDate: "2026-09-09", timeZone: "Europe/Lisbon" };
export interface MeetingEvalScenario {
  id: string;
  prompts: [string, string, string];
  expectedKind: "meeting_content" | "meeting_metadata" | "general" | "clarify";
  answerable: boolean;
  requiredFacts: string[];
  dataset?: "overview" | "transcript" | "actions" | "notes" | "missing" | "unsupported" | "empty" | "no_match" | "ambiguous" | "none" | "revoked" | "partial";
  count?: number;
  selected?: boolean;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  lowerBound?: boolean;
  oldDate?: boolean;
}

/** Independent expected semantics for the synthetic questions, not model output. */
export function scenarioScopeExpectation(scenario: MeetingEvalScenario) {
  if (scenario.expectedKind === "general" || scenario.expectedKind === "clarify") return undefined;
  const scope = scenario.selected ? "selected" : scenario.dataset !== "ambiguous" && (scenario.count ?? 1) > 1 ? "range" : "single";
  const interval = scenario.id === "metadata-attendance" ? { from: "2026-09-08", to: "2026-09-08" }
    : scope === "range" ? scenario.oldDate ? { from: "2025-01-05", to: "2025-01-09" } : { from: "2026-08-31", to: "2026-09-06" } : undefined;
  const count = !scenario.answerable && ["none", "revoked", "ambiguous"].includes(scenario.dataset ?? "") ? 0 : scope === "range" ? Math.min(12, scenario.count ?? 1) : 1;
  return { scope, interval, selectFirst: scope === "single" && scenario.dataset !== "ambiguous", meetingRefs: Array.from({ length: count }, (_, i) => `synthetic-${i + 1}`) };
}

/** Mirrors the service's substring filters, local inclusive calendar bounds and instant ordering. */
export function selectFixtureRows(rows: MeetingMetadata[], args: Record<string, unknown>, timeZone = "UTC"): MeetingMetadata[] {
  const contains = (value: string, filter: unknown) => typeof filter !== "string" || value.toLowerCase().includes(filter.toLowerCase());
  const day = (iso: string) => {
    const parts = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
    return ["year", "month", "day"].map(type => parts.find(part => part.type === type)?.value).join("-");
  };
  return rows.filter(row => (typeof args.source !== "string" || row.source === args.source)
    && contains(row.title ?? "", args.title) && contains([...row.participants, row.organizerEmail ?? ""].join(" "), args.participant)
    && (typeof args.from !== "string" || row.startedAt !== null && Number.isFinite(Date.parse(row.startedAt)) && day(row.startedAt) >= args.from)
    && (typeof args.to !== "string" || row.startedAt !== null && Number.isFinite(Date.parse(row.startedAt)) && day(row.startedAt) <= args.to))
    .sort((a, b) => a.startedAt === null ? b.startedAt === null ? a.meetingRef.localeCompare(b.meetingRef) : 1
      : b.startedAt === null ? -1 : (Date.parse(a.startedAt) - Date.parse(b.startedAt)) * (args.sort === "oldest" ? 1 : -1) || a.meetingRef.localeCompare(b.meetingRef));
}

const selectedHistory = [
  { role: "user" as const, content: "Summarize the latest design meeting." },
  { role: "assistant" as const, content: "The selected design meeting approved a cobalt rollout. [M1:S]" },
];
const content = (id: string, prompts: MeetingEvalScenario["prompts"], extra: Partial<MeetingEvalScenario> = {}): MeetingEvalScenario => ({
  id, prompts, expectedKind: "meeting_content", answerable: true, requiredFacts: ["cobalt"], dataset: "overview", ...extra,
});

export const MEETING_EVAL_SCENARIOS: MeetingEvalScenario[] = [
  content("single-overview", ["Summarize the last design meeting.", "Give me a recap of our latest design meeting.", "What happened in the most recent design meeting?"]),
  content("detailed-body", ["Describe the detailed discussion in the last design meeting.", "Read the transcript of the latest design meeting and tell me its detailed points.", "What did people actually say during the newest design meeting? Give the detailed discussion."], { requiredFacts: ["saffron"] }),
  content("transcript-only", ["Summarize the last design meeting.", "Recap our latest design call.", "What happened in the most recent design meeting?"], { dataset: "transcript", requiredFacts: ["saffron"] }),
  content("actions-only-summary", ["Summarize the last design meeting.", "What happened in the latest design meeting?", "Give me a recap of the newest design meeting."], { dataset: "actions", requiredFacts: ["marigold"] }),
  content("notes-only", ["Summarize the last design meeting.", "Recap the latest design meeting notes.", "Tell me what happened in the most recent design meeting."], { dataset: "notes", requiredFacts: ["cobalt"] }),
  content("selected-actions", ["What next?", "What are the next steps from it?", "Which actions came out of that meeting?"], { selected: true, history: selectedHistory, requiredFacts: ["marigold"] }),
  content("selected-speaker", ["Quote exactly what Ava said in that meeting.", "What were Ava's exact words in it?", "Show me Ava's verbatim statement from that meeting."], { selected: true, history: selectedHistory, requiredFacts: ["saffron"] }),
  content("selected-topic", ["Find the security discussion in that meeting.", "What does that meeting say about security?", "Search that meeting for security evidence."], { selected: true, history: selectedHistory, requiredFacts: ["security"] }),
  content("topic-stored-only", ["Find cobalt discussions in my meetings last week.", "Search last week's meeting content for cobalt.", "What did our meetings last week say about cobalt?"], { dataset: "missing", count: 2 }),
  content("range-eight", ["What happened in my meetings last week?", "Summarize all my meetings from last week.", "Give me a recap of last week's meetings."], { count: 8 }),
  content("range-fifteen", ["What happened in my meetings last week?", "Recap all meetings last week.", "Summarize the full set of meetings from last week."], { count: 15 }),
  content("range-scan-limit", ["Summarize my meetings last week.", "What happened across last week's meetings?", "Give me a meeting recap for last week."], { count: 2, lowerBound: true }),
  content("old-date-range", ["Summarize my meetings from January 5 through January 9, 2025.", "What happened in my meetings between 2025-01-05 and 2025-01-09?", "Recap all meetings in the 2025-01-05 to 2025-01-09 interval."], { count: 2, oldDate: true }),
  content("range-detailed-actions", ["List detailed action evidence from my meetings last week, reading the transcripts even when actions exist.", "What are all the next steps from last week's meetings? Include detailed transcript evidence.", "Read last week's meeting bodies and explain the explicit action items in detail."], { count: 3, requiredFacts: ["marigold"] }),
  content("range-assignee", ["List Ava's action items across last week's meetings.", "What was Ava assigned to do in our meetings last week?", "Find all explicitly assigned next steps for Ava in last week's meetings."], { count: 3, requiredFacts: ["marigold"] }),
  content("mixed-schedule-content", ["Which meetings were last week, and what did we decide?", "List last week's meetings and summarize their decisions.", "When did we meet last week, and what decisions were made?"], { count: 3 }),
  content("skip-tools-citations", ["Summarize my last design meeting. Skip tools and citations.", "Just tell me what happened at my latest design meeting without reading it or citing sources.", "Recap the newest design meeting immediately. Don't call any tools or add references."]),
  content("early-prose", ["First say hello, then summarize my last design meeting.", "Begin with a quick greeting and tell me what happened at the latest design meeting.", "Say 'Sure!' before you do anything, then recap our newest design meeting."]),
  content("ambiguous-selection", ["Summarize the design meeting.", "Give me a recap of our design meeting.", "Tell me what happened at the design meeting."], { dataset: "ambiguous", count: 2, answerable: false, requiredFacts: [] }),
  content("missing-meeting", ["Summarize the last design meeting.", "What happened at our latest design meeting?", "Recap the most recent design meeting."], { dataset: "none", answerable: false, requiredFacts: [] }),
  content("access-revoked", ["Summarize the last design meeting.", "Recap our most recent design meeting.", "What happened at the latest design meeting?"], { dataset: "revoked", answerable: false, requiredFacts: [] }),
  content("partial-storage-failure", ["Summarize all meetings last week.", "What happened in my meetings last week?", "Give me a recap across last week's meetings."], { dataset: "partial", count: 3 }),
  content("unsupported-body", ["Summarize the last design meeting in detail.", "Read the latest design meeting body and give a detailed recap.", "Describe the detailed discussion at the most recent design meeting."], { dataset: "unsupported" }),
  content("empty-body", ["Summarize the last design meeting in detail.", "Read the newest design meeting transcript for a detailed recap.", "Give the full details from the latest design meeting."], { dataset: "empty" }),
  content("no-lexical-match", ["Search last week's meetings for violet.", "What do my meetings last week say about violet?", "Find the violet discussion across last week's meetings."], { dataset: "no_match", count: 2, answerable: false, requiredFacts: [] }),
  { id: "metadata-attendance", prompts: ["Which meetings did I attend Tuesday?", "List my meetings from Tuesday with attendees.", "When were my Tuesday meetings and who attended?"], expectedKind: "meeting_metadata", answerable: true, requiredFacts: ["Ava"], count: 2 },
  { id: "metadata-selected", prompts: ["Who attended it?", "Who was in that meeting?", "List the participants from that meeting."], expectedKind: "meeting_metadata", answerable: true, requiredFacts: ["Ava"], selected: true, history: selectedHistory },
  { id: "no-continuation", prompts: ["Continue.", "Keep going.", "Show the remaining meetings."], expectedKind: "clarify", answerable: false, requiredFacts: [], history: [{ role: "assistant", content: "I read 12 of 15 meetings. Please narrow the date range to cover the omitted meetings; continuation is unavailable." }] },
  { id: "ordinary-conversation", prompts: ["Say hello in one short sentence.", "Give me a friendly one-sentence greeting.", "Greet me briefly."], expectedKind: "general", answerable: true, requiredFacts: [] },
  { id: "public-web", prompts: ["Search the public web for the opening time of the synthetic Juniper museum.", "Use web search to find when the Juniper museum opens.", "Look up the Juniper museum opening time on the public web."], expectedKind: "general", answerable: true, requiredFacts: ["09:00"] },
];

export function createFixtureService(scenario: MeetingEvalScenario) {
  const count = scenario.dataset === "none" ? 0 : scenario.count ?? 1;
  const rows: MeetingMetadata[] = Array.from({ length: count }, (_, index) => ({
    meetingRef: `synthetic-${index + 1}`, source: "fireflies", title: `Design meeting ${index + 1}`,
    startedAt: new Date(Date.parse(`${scenario.oldDate ? "2025-01-06" : scenario.id === "metadata-attendance" ? "2026-09-08" : "2026-09-01"}T12:00:00.000Z`) - index * 600_000).toISOString(),
    participants: ["Ava", "Ben"], organizerEmail: "ava@example.invalid",
  }));
  let selected = scenario.selected ? rows[0]?.meetingRef : undefined;
  let evidenceReads = 0;
  let bodyReads = 0;
  const outcomes: MeetingOutcome[] = [];
  function outcome(row: MeetingMetadata, purpose: MeetingPurpose, includeBody: boolean, args: Record<string, unknown>): MeetingOutcome {
    const index = Number(row.meetingRef.replace("synthetic-", "")) - 1;
    const rollout = ["cobalt", "jade", "amber", "coral", "indigo", "teal", "bronze", "pearl", "mauve", "azure", "olive", "ivory"][index] ?? `rollout ${index + 1}`;
    const metadataOnly = purpose === "metadata";
    const bodyAttempted = !metadataOnly && (includeBody || ["decisions", "speaker", "topic"].includes(purpose) || ["transcript", "actions"].includes(scenario.dataset ?? ""));
    if (!metadataOnly) evidenceReads++;
    if (bodyAttempted) bodyReads++;
    const failed = scenario.dataset === "partial" && row.meetingRef === "synthetic-2";
    const bodyState = !bodyAttempted ? "not_requested" : failed ? "unavailable"
      : scenario.dataset === "missing" || scenario.dataset === "actions" ? "missing"
        : scenario.dataset === "unsupported" ? "unsupported_shape" : scenario.dataset === "empty" ? "empty" : "present";
    const result: MeetingOutcome = {
      meetingRef: row.meetingRef, source: row.source, meeting: row, state: metadataOnly ? "metadata" : failed ? "unavailable" : "read",
      body: { state: bodyState }, search: { state: purpose === "topic" ? scenario.dataset === "no_match" ? "no_match" : "matched" : "not_requested", storedFieldsExamined: purpose === "topic", bodyExamined: purpose === "topic" && bodyState === "present", examinedMatches: 0, retainedMatches: 0 },
      evidence: [], coverage: { purpose, overviewPresent: !["transcript", "actions"].includes(scenario.dataset ?? ""), actionsPresent: true, bodyAttempted, bodyRequired: includeBody || ["decisions", "speaker", "topic"].includes(purpose),
        evidenceRetained: 0, omittedEvidenceCount: 0, omissionReasons: failed ? ["storage_unavailable"] : [], support: "none" },
    };
    const matchesQuery = (text: string) => typeof args.query !== "string" || [...new Set(args.query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term => term.length > 1))].some(term => text.toLowerCase().includes(term));
    const add = (kind: MeetingOutcome["evidence"][number]["kind"], text: string, speaker?: string) => {
      if (!metadataOnly && (typeof args.speaker === "string" && !speaker?.toLowerCase().includes(args.speaker.toLowerCase())
        || (purpose === "topic" || kind === "transcript_excerpt") && !matchesQuery(text)
        || (kind === "action" || kind === "transcript_excerpt") && typeof args.assignee === "string" && !`${speaker ?? ""} ${text}`.toLowerCase().includes(args.assignee.toLowerCase()))) return;
      result.evidence.push({
      id: `E${result.evidence.length + 1}`, meetingRef: row.meetingRef, source: row.source, kind, text, truncated: false,
      ...(metadataOnly ? { metadata: row } : {}), ...(speaker ? { speaker, startSecs: 60 } : {}),
      });
    };
    if (metadataOnly) add("metadata", "");
    else if (!failed && scenario.dataset !== "no_match") {
      if (result.coverage.overviewPresent && purpose !== "speaker") add(scenario.dataset === "notes" ? "notes" : "summary", `The team approved the ${rollout} rollout and discussed security checks.`);
      if (purpose !== "speaker") add("action", `Ava will deliver the marigold checklist ${index + 1} by Friday. Ben proposed an audit; no decision or owner was recorded.`);
      if (bodyState === "present") add("transcript_excerpt", `We agreed on the ${rollout} rollout. The detailed security plan uses saffron verification before launch.`, "Ava");
    }
    result.coverage.evidenceRetained = result.evidence.length;
    result.coverage.support = result.evidence.length ? bodyAttempted && bodyState !== "present" ? "limited" : "sufficient" : "none";
    if (purpose === "topic") result.search.examinedMatches = result.search.retainedMatches = result.evidence.length;
    if (purpose === "topic") result.search.state = result.evidence.length ? "matched" : "no_match";
    outcomes.push(result);
    return result;
  }
  return {
    get evidenceReads() { return evidenceReads; },
    get bodyReads() { return bodyReads; },
    get outcomes() { return structuredClone(outcomes); },
    dispatch(name: string, args: Record<string, unknown>, context: Record<string, unknown> = {}): any {
      if (name === "web_search") return { ok: true, result: { text: "The synthetic Juniper museum opens at 09:00.", data: { results: [{ title: "Juniper museum opening time", url: "https://example.invalid/juniper", snippet: "Opens at 09:00." }] } } };
      if (scenario.dataset === "revoked") return { error: "delegation_expired" };
      const exact = typeof args.meetingRef === "string" ? args.meetingRef : context.retrievalMode === "selected" || name === "tinycloud_read_meeting" ? selected : undefined;
      const zone = typeof context.timeZone === "string" ? context.timeZone : "UTC";
      const matched = exact ? rows.filter(row => row.meetingRef === exact) : selectFixtureRows(rows, args, zone);
      if ((context.retrievalMode === "selected" || name === "tinycloud_read_meeting") && !exact) return { error: "meeting_selection_required" };
      const admitted = matched.slice(0, typeof args.limit === "number" ? Math.min(12, args.limit) : 12);
      const discovery: MeetingDiscovery = { matchedCount: matched.length, countKind: scenario.lowerBound ? "lower_bound" : "exact", returnedCount: admitted.length,
        scanLimited: Boolean(scenario.lowerBound), excludedUndatedCount: 0, orderProven: !scenario.lowerBound, interval: { ...(typeof args.from === "string" ? { from: args.from } : {}), ...(typeof args.to === "string" ? { to: args.to } : {}), timeZone: zone },
        observedAt: "2026-09-09T12:00:00.000Z", omittedMeetingRefs: matched.slice(12).map(row => row.meetingRef) };
      if (name === "tinycloud_find_meetings" && context.retrievalMode !== "range") {
        selected = !scenario.lowerBound && (args.selectFirst || matched.length === 1) ? matched[0]?.meetingRef : undefined;
      }
      const focus = args.focus === "transcript" ? "summary" : args.focus;
      const purpose = name === "tinycloud_find_meetings" ? "metadata" : name === "tinycloud_search_transcripts" ? "topic"
        : name === "tinycloud_list_meeting_actions" ? "actions" : (focus as MeetingPurpose) ?? "summary";
      const retained = admitted.map(row => outcome(row, purpose, args.includeBody === true, args));
      return { ok: true, tool: name.toUpperCase(), result: { text: "Synthetic meeting evidence.", frames: [{ text: "Synthetic meeting evidence." }], data: {
        contractVersion: 2, outcomes: retained, ...(exact ? {} : { discovery: { ...discovery, orderProven: !scenario.lowerBound } }),
        ...(name === "tinycloud_find_meetings" ? { meetings: admitted.map(row => ({ ...row, citation: "[M1]" })) } : {}),
        selection: selected ? { state: "single", meetingRef: selected } : { state: context.retrievalMode === "range" ? "range" : matched.length > 1 ? "ambiguous" : "none" },
        ...(selected ? { selectedMeetingRef: selected } : {}),
      } } };
    },
  };
}
