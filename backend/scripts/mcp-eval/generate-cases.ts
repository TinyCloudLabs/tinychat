/**
 * Cuts a NEW version of the frozen eval from the meeting-eval scenarios and the Eliza-derived cases below.
 * Not part of a normal run. Running it rewrites cases.json and manifest.json; commit the result only when
 * deliberately cutting a new eval version (bump VERSION first).
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createFixtureService, MEETING_EVAL_SCENARIOS, type MeetingEvalScenario } from "../meeting-eval-fixtures.js";
import { MCP_EVAL_DIR } from "./runner.js";
import type { EvalCase, EvalExpectation, FixtureEvidence, FixtureMeeting, FixtureSpace, Manifest } from "./types.js";

const VERSION = 1;
const CITATION_SYNTAX = String.raw`^\[M\d+(:E\d+(, [^\],]+, \d{2}:\d{2}:\d{2})?)?\]$`;
const FAILURE_WORDING = String.raw`this round|wasn['’]t able|unable|couldn['’]t|could not|failed|do not establish|not requested`;
const PUBLIC_WEB_URL = "https://example.invalid/juniper";

function expectation(partial: Partial<EvalExpectation> & Pick<EvalExpectation, "behavior">): EvalExpectation {
  return {
    requiredFacts: [], forbiddenPatterns: [], minCitedMeetings: 0, citableEvidenceIds: [], citationSyntax: CITATION_SYNTAX,
    coverage: { required: false, mentionsMeetings: [], mustMatch: [], mustNotMatch: [] }, publicSourceUrls: [], noSizeLimitErrors: false, ...partial,
  };
}

/** Reads the scenario's synthetic evidence through the existing fixture service, one exact read per meeting. */
function scenarioSpace(scenario: MeetingEvalScenario): FixtureSpace {
  const service = createFixtureService(scenario);
  const count = scenario.dataset === "none" ? 0 : scenario.count ?? 1;
  const probe = service.dispatch("tinycloud_find_meetings", { limit: 12 }, { retrievalMode: "range", timeZone: "Europe/Lisbon" });
  if (scenario.dataset === "revoked") return { access: "revoked", meetings: [] };
  const rows: Array<{ meetingRef: string; title: string; startedAt: string; participants: string[] }> = probe.result?.data?.meetings ?? [];
  if (rows.length !== Math.min(12, count)) throw new Error(`${scenario.id}: expected ${Math.min(12, count)} fixture rows, got ${rows.length}`);
  const meetings: FixtureMeeting[] = rows.map((row, index) => {
    const id = `M${index + 1}`;
    const metadataOnly = scenario.expectedKind === "meeting_metadata";
    const read = service.dispatch("tinycloud_read_meeting", { meetingRef: row.meetingRef, focus: "summary", includeBody: true }, { timeZone: "Europe/Lisbon" });
    const outcome = read.result.data.outcomes[0];
    const evidence: FixtureEvidence[] = metadataOnly ? [{ id: `${id}:E1`, kind: "metadata", text: "" }] : outcome.evidence.map((item: { id: string; kind: FixtureEvidence["kind"]; text: string; speaker?: string; startSecs?: number }) => ({
      id: `${id}:${item.id}`, kind: item.kind, text: item.text, ...(item.speaker ? { speaker: item.speaker, startSecs: item.startSecs } : {}),
    }));
    return { id, title: row.title, startedAt: row.startedAt, participants: row.participants, state: metadataOnly ? "metadata" : evidence.length ? "read" : "not_read", evidence };
  });
  const publicSources = scenario.id === "public-web" ? [{ title: "Juniper museum opening time", url: PUBLIC_WEB_URL, snippet: "Opens at 09:00." }] : undefined;
  return { access: "granted", meetings, ...(publicSources ? { publicSources } : {}) };
}

function scenarioExpectation(scenario: MeetingEvalScenario, space: FixtureSpace): EvalExpectation {
  if (scenario.expectedKind === "general") {
    return expectation({ behavior: "general", requiredFacts: scenario.requiredFacts, publicSourceUrls: scenario.id === "public-web" ? [PUBLIC_WEB_URL] : [] });
  }
  if (scenario.expectedKind === "clarify" || !scenario.answerable) {
    // No supported answer exists: no required facts, none of the fixture's rollout facts may be asserted.
    return expectation({ behavior: "decline", forbiddenPatterns: ["cobalt|saffron|marigold|jade|amber"] });
  }
  const shown = space.meetings.length;
  if (scenario.expectedKind === "meeting_metadata") {
    return expectation({ behavior: "metadata", requiredFacts: scenario.requiredFacts, minCitedMeetings: shown, coverage: { required: false, mentionsMeetings: [], mustMatch: [], mustNotMatch: [] } });
  }
  return expectation({
    behavior: "content", requiredFacts: scenario.requiredFacts, minCitedMeetings: Math.min(space.meetings.filter(m => m.evidence.length > 0).length, 3),
    coverage: { required: true, mentionsMeetings: space.meetings.map(m => m.id), mustMatch: [], mustNotMatch: [] },
  });
}

function scenarioCases(): EvalCase[] {
  return MEETING_EVAL_SCENARIOS.flatMap(scenario => {
    const space = scenarioSpace(scenario);
    return scenario.prompts.map((question, variant): EvalCase => ({
      id: `${scenario.id}#${variant}`, origin: `tinychat backend/scripts/meeting-eval-fixtures.ts scenario ${scenario.id}`,
      question, ...(scenario.history ? { history: scenario.history } : {}), space, expect: scenarioExpectation(scenario, space),
    }));
  });
}

const iso = (day: number) => `2026-09-0${day}T10:00:00.000Z`;

function elizaCases(): EvalCase[] {
  const meeting = (n: number, extra: Partial<FixtureMeeting> & { evidence: FixtureEvidence[] }): FixtureMeeting => ({ id: `M${n}`, title: `M${n} planning`, startedAt: iso(n), participants: [], state: "read", ...extra });
  const recap = (n: number): FixtureMeeting => meeting(n, { title: `Planning ${n}`, participants: ["Ava"], evidence: [{ id: `M${n}:E1`, kind: "summary", text: `Recap ${n}: the team chose cobalt for launch ${n}.` }] });
  const origin = (name: string) => `tinycloud-agents packages/eliza-service ${name} @ ed320bd`;
  return [
    {
      id: "eliza-two-meeting-citations", origin: origin("src/tasks/answer.test.ts 'expands an unambiguous short citation' / 'rejects unknown labels'"),
      question: "What did the two planning meetings say about the release?",
      space: { access: "granted", meetings: [
        meeting(1, { evidence: [{ id: "M1:E1", kind: "summary", text: "The supplied fixture says the release was delayed.", speaker: "Alice", startSecs: 30 }] }),
        meeting(2, { evidence: [{ id: "M2:E1", kind: "summary", text: "The supplied fixture says the release was delayed again.", speaker: "Bob", startSecs: 60 }] }),
      ] },
      expect: expectation({ behavior: "content", requiredFacts: ["delayed"], minCitedMeetings: 2, coverage: { required: true, mentionsMeetings: ["M1", "M2"], mustMatch: [], mustNotMatch: [] }, forbiddenPatterns: ["storage-record-"] }),
    },
    {
      id: "eliza-recap-only-three", origin: origin("src/tasks/answer.test.ts 'recap-only answers are a choice, not a failure'"),
      question: "Tell me about my last few meetings for which there is a transcript.",
      space: { access: "granted", meetings: [recap(1), recap(2), recap(3)] },
      expect: expectation({ behavior: "content", requiredFacts: ["cobalt"], minCitedMeetings: 3, forbiddenPatterns: ["full transcript coverage|coverage for this meeting is complete|no other decisions"],
        coverage: { required: true, mentionsMeetings: ["M1", "M2", "M3"], mustMatch: ["stored recap"], mustNotMatch: [FAILURE_WORDING] } }),
    },
    {
      id: "eliza-mixed-read-states", origin: origin("src/tasks/answer.test.ts 'renders all seven statuses and keeps read-but-uncited, body-not-requested and actually missing distinct'"),
      question: "Summarize my planning meetings.",
      space: { access: "granted", meetings: [
        meeting(1, { evidence: [{ id: "M1:E1", kind: "summary", text: "The supplied fixture says the release was delayed." }] }),
        meeting(2, { state: "metadata", evidence: [] }),
        meeting(3, { state: "not_read", evidence: [] }),
      ] },
      expect: expectation({ behavior: "content", requiredFacts: ["delayed"], minCitedMeetings: 1, forbiddenPatterns: ["I read all 3 meetings"],
        coverage: { required: true, mentionsMeetings: ["M1", "M2", "M3"], mustMatch: ["not read"], mustNotMatch: [] } }),
    },
    {
      id: "eliza-public-plus-private", origin: origin("src/tasks/answer.test.ts 'appends only returned public source provenance'"),
      question: "Compare the meeting decision with the vendor documentation.",
      space: { access: "granted", meetings: [meeting(1, { evidence: [{ id: "M1:E1", kind: "summary", text: "The supplied fixture says the release was delayed." }] })],
        publicSources: [{ title: "Vendor docs", url: "https://vendor.example/docs", snippet: "Public source fixture." }] },
      expect: expectation({ behavior: "content", requiredFacts: ["delayed"], minCitedMeetings: 1, publicSourceUrls: ["https://vendor.example/docs"], coverage: { required: true, mentionsMeetings: ["M1"], mustMatch: [], mustNotMatch: [] } }),
    },
    {
      id: "eliza-size-limit-501-transcript-heavy-rows", sizeLimit: true, origin: origin("src/transcript-registry-listing.test.ts '501 transcript-heavy rows list under the transport cap' (TC-2163)"),
      question: "List my three most recent meetings.",
      space: { access: "granted", meetings: [], generator: { kind: "transcript-heavy-rows", rows: 501, transcriptLines: 1100, newestStartedAt: "2026-10-21T00:00:00.000Z" } },
      expect: expectation({ behavior: "metadata", requiredFacts: ["Meeting m-0", "Meeting m-1", "Meeting m-2"], minCitedMeetings: 3, noSizeLimitErrors: true }),
    },
  ];
}

const cases = [...scenarioCases(), ...elizaCases()];
const body = `${JSON.stringify({ version: VERSION, cases }, null, 1)}\n`;
const manifest: Manifest = {
  version: VERSION, frozenOn: "2026-10-27", caseCount: cases.length, casesSha256: createHash("sha256").update(body).digest("hex"),
  sizeLimitCaseIds: cases.filter(c => c.sizeLimit).map(c => c.id),
  derivedFrom: { tinychat: "backend/scripts/meeting-eval-fixtures.ts (30 scenarios x 3 paraphrases)", "tinycloud-agents": "TinyCloudLabs/tinycloud-agents main ed320bda0fd40ecbf1f0088719d2fd8392ddb919 (TC-2163 #31)" },
  notes: ["Synthetic data only; the size-limit case regenerates its 501 rows deterministically at run time.", "Frozen: edit nothing in this directory's cases.json; cut version N+1 instead."],
};
await writeFile(resolve(MCP_EVAL_DIR, "cases.json"), body);
await writeFile(resolve(MCP_EVAL_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote v${VERSION}: ${cases.length} cases`);
