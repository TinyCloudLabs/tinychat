import type { ChatAnswer, EvalCase, FixtureMeeting, FixtureSpace } from "./types.js";

const SIZE_LIMIT_PATTERN = /size_limit|result_size_limit|response_too_large|kv_response_too_large|sql_result_limit_exceeded/i;

/** Expands a generator-backed space into concrete meetings. Deterministic; plain spaces pass through. */
export function materializeSpace(space: FixtureSpace): FixtureSpace {
  const generator = space.generator;
  if (!generator) return space;
  const line = "Ada: we agreed to ship the importer on Friday.\n";
  const transcript = line.repeat(generator.transcriptLines);
  const newest = Date.parse(generator.newestStartedAt);
  const meetings: FixtureMeeting[] = Array.from({ length: generator.rows }, (_, i) => ({
    id: `M${i + 1}`,
    title: `Meeting m-${i}`,
    startedAt: new Date(newest - i * 3_600_000).toISOString(),
    participants: ["Ada"],
    state: "metadata" as const,
    evidence: [{ id: `M${i + 1}:E1`, kind: "summary" as const, text: "Short recap. ".repeat(80).trim() }],
    rawMetadata: JSON.stringify({ transcript_text: transcript, type: "transcript", transcript_count: 1 }),
  }));
  return { ...space, meetings, generator: undefined };
}

interface Citation {
  raw: string;
  meetingId: string;
  evidenceId?: string;
  speaker?: string;
  time?: string;
}

const CITATION = /\[(M\d+)(?::(E\d+))?(?:, ([^\],]+), (\d{2}:\d{2}:\d{2}))?\](?!\()/g;

export function parseCitations(text: string): Citation[] {
  // Public links `[title](url)` are excluded by the lookahead; citation-shaped text inside URLs is stripped first.
  const withoutUrls = text.replace(/https?:\/\/\S+/g, " ");
  return [...withoutUrls.matchAll(CITATION)].map(m => ({ raw: m[0], meetingId: m[1]!, evidenceId: m[2] ? `${m[1]}:${m[2]}` : undefined, speaker: m[3], time: m[4] }));
}

function formatTime(secs: number): string {
  const s = Math.floor(secs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** Splits the answer into body and the text of its `### Coverage` section (up to the next heading of equal or higher level). */
export function splitCoverage(text: string): { body: string; coverage?: string } {
  const match = /^###\s+Coverage\s*$/im.exec(text);
  if (!match) return { body: text };
  const rest = text.slice(match.index + match[0].length);
  const next = /^#{1,3}\s+\S/m.exec(rest);
  return { body: text.slice(0, match.index), coverage: next ? rest.slice(0, next.index) : rest };
}

export interface CaseScore {
  caseId: string;
  passed: boolean;
  failures: string[];
  citationInvalid: number;
  citationTotal: number;
  coveragePresent: boolean;
  sizeLimitErrors: number;
}

export function scoreCase(testCase: EvalCase, answer: ChatAnswer): CaseScore {
  const expect = testCase.expect;
  const space = materializeSpace(testCase.space);
  const failures: string[] = [];
  const { body, coverage } = splitCoverage(answer.text);
  const citations = parseCitations(body);
  const meetings = new Map(space.meetings.map(m => [m.id, m]));
  const evidence = new Map(space.meetings.flatMap(m => m.evidence.map(e => [e.id, e] as const)));

  let invalid = 0;
  const syntax = new RegExp(expect.citationSyntax);
  for (const citation of citations) {
    const reasons: string[] = [];
    if (!syntax.test(citation.raw)) reasons.push("syntax");
    if (!meetings.has(citation.meetingId)) reasons.push("unknown meeting");
    if (citation.evidenceId) {
      const item = evidence.get(citation.evidenceId);
      if (!item) reasons.push("unknown evidence");
      else {
        if (citation.speaker !== undefined && citation.speaker !== item.speaker) reasons.push("speaker mismatch");
        if (citation.time !== undefined && (item.startSecs === undefined || citation.time !== formatTime(item.startSecs))) reasons.push("time mismatch");
      }
    }
    if (reasons.length) {
      invalid++;
      failures.push(`invalid citation ${citation.raw}: ${reasons.join(", ")}`);
    }
  }

  const lower = answer.text.toLowerCase();
  for (const fact of expect.requiredFacts) if (!lower.includes(fact.toLowerCase())) failures.push(`missing required fact "${fact}"`);
  for (const pattern of expect.forbiddenPatterns) if (new RegExp(pattern, "i").test(answer.text)) failures.push(`forbidden pattern /${pattern}/ present`);

  const validContent = citations.filter(c => {
    if (!meetings.has(c.meetingId)) return false;
    if (c.evidenceId) {
      const item = evidence.get(c.evidenceId);
      if (!item || item.kind === "metadata") return false;
      return expect.citableEvidenceIds.length === 0 || expect.citableEvidenceIds.includes(c.evidenceId);
    }
    return false;
  });
  const citedMeetings = new Set((expect.behavior === "metadata" ? citations.filter(c => meetings.has(c.meetingId)) : validContent).map(c => c.meetingId));
  if (citedMeetings.size < expect.minCitedMeetings) failures.push(`cited ${citedMeetings.size} meeting(s), expected at least ${expect.minCitedMeetings}`);
  if (expect.behavior === "decline" || expect.behavior === "general") {
    const stray = citations.filter(c => meetings.has(c.meetingId));
    if (stray.length) failures.push(`cited meeting evidence where none supports an answer (${stray.map(c => c.raw).join(" ")})`);
  }

  const coveragePresent = coverage !== undefined;
  if (expect.coverage.required && !coveragePresent) failures.push("missing ### Coverage section");
  if (!expect.coverage.required && coveragePresent && (expect.behavior === "general")) failures.push("unexpected ### Coverage section on a non-meeting answer");
  if (coverage !== undefined) {
    for (const id of expect.coverage.mentionsMeetings) if (!new RegExp(`\\b${id}\\b`).test(coverage)) failures.push(`coverage does not mention ${id}`);
    for (const pattern of expect.coverage.mustMatch) if (!new RegExp(pattern, "i").test(coverage)) failures.push(`coverage does not match /${pattern}/`);
    for (const pattern of expect.coverage.mustNotMatch) if (new RegExp(pattern, "i").test(coverage)) failures.push(`coverage matches forbidden /${pattern}/`);
  }

  for (const url of expect.publicSourceUrls) if (!answer.text.includes(url)) failures.push(`missing public source ${url}`);

  const sizeLimitErrors = (answer.toolErrors ?? []).filter(code => SIZE_LIMIT_PATTERN.test(code)).length + (SIZE_LIMIT_PATTERN.test(answer.text) ? 1 : 0);
  if (expect.noSizeLimitErrors && sizeLimitErrors > 0) failures.push(`${sizeLimitErrors} size-limit error(s)`);

  return { caseId: testCase.id, passed: failures.length === 0, failures, citationInvalid: invalid, citationTotal: citations.length, coveragePresent, sizeLimitErrors };
}
