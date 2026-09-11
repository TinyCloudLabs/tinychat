import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { meetingInterpretationGuidance, PREPARE_MEETING_TURN_TOOL, validateMeetingPlan } from "../transcripts/meeting-turn.js";

// Reuse the JSON Schema validator already installed with the repository's linter.
const require = createRequire(import.meta.url);
const Ajv = createRequire(require.resolve("eslint/package.json"))("ajv");
const schemaAccepts = new Ajv({ allErrors: true }).compile(PREPARE_MEETING_TURN_TOOL.function.parameters);
const context = { localDate: "2026-09-11", timeZone: "Europe/Lisbon" };
const selected = { kind: "meeting_content", scope: "selected", purpose: "summary", evidenceRequirement: "overview" };

test.each([
  {},
  { kind: "meeting_content", scope: "single", title: "Local demo design", sort: "newest", selectFirst: true, purpose: "summary" },
  { kind: "meeting_content", scope: "selected", purpose: "actions" },
  { kind: "meeting_content", purpose: "summary", evidenceRequirement: "overview" },
  { kind: "clarify" },
  { kind: "general", query: "security" },
  { kind: "meeting_metadata", scope: "single", purpose: "summary" },
  { ...selected, title: "Design" },
  { ...selected, sort: "newest" },
  { ...selected, selectFirst: false },
  { ...selected, meetingRef: "meeting-a" },
  { ...selected, scope: "exact" },
  { ...selected, scope: "exact", meetingRef: "M1:E1" },
  { ...selected, scope: "exact", meetingRef: "meeting-a", participant: "Ava" },
  { ...selected, scope: "range", selectFirst: true },
  { ...selected, scope: "single", meetingRef: "meeting-a" },
  { ...selected, purpose: "speaker" },
  { ...selected, purpose: "topic" },
  { ...selected, scope: "single", title: "" },
  { ...selected, scope: "single", participant: "   " },
])("tool schema rejects plans the controller cannot accept: %j", plan => {
  expect(validateMeetingPlan(plan, context).ok).toBe(false);
  expect(schemaAccepts(plan)).toBe(false);
});

test("validator identifies missing content fields without inventing intent", () => {
  const empty = validateMeetingPlan({}, context);
  expect(empty).toMatchObject({ ok: false, errors: [expect.stringContaining("kind")] });
  const recap = validateMeetingPlan({ kind: "meeting_content", scope: "single", purpose: "summary" }, context);
  expect(recap).toMatchObject({ ok: false, errors: [expect.stringContaining("evidenceRequirement")] });
  const missing = validateMeetingPlan({ kind: "meeting_content" }, context);
  expect(missing).toMatchObject({ ok: false, errors: [expect.stringMatching(/scope.*purpose.*evidenceRequirement/)] });
});

test("validation feedback describes selected conflicts without echoing private values or keys", () => {
  const sentinel = "PRIVATE VALIDATION SENTINEL";
  const conflict = validateMeetingPlan({ ...selected, title: sentinel }, context);
  expect(conflict).toMatchObject({ ok: false, errors: [expect.stringMatching(/selected.*title/)] });
  const unknown = validateMeetingPlan({ ...selected, [sentinel]: sentinel }, context);
  expect(unknown).toMatchObject({ ok: false, errors: [expect.stringContaining("unsupported fields")] });
  expect(JSON.stringify([conflict, unknown])).not.toContain(sentinel);
});

test("every interpreter example is a complete schema-valid and runtime-valid JSON plan", () => {
  const examples = [...meetingInterpretationGuidance(context).matchAll(/^Example: .+ => (\{.+\})$/gm)].map(match => JSON.parse(match[1]));
  expect(examples.length).toBeGreaterThanOrEqual(10);
  for (const plan of examples) {
    expect(schemaAccepts(plan)).toBe(true);
    expect(validateMeetingPlan(plan, context).ok).toBe(true);
  }
});

test("selected body follow-ups remain unfiltered and the inline boolean adapter remains explicit", () => {
  for (const plan of [selected, { ...selected, evidenceRequirement: "body" }, { ...selected, scope: "exact", meetingRef: "meeting-a" }]) {
    expect(schemaAccepts(plan)).toBe(true);
    expect(validateMeetingPlan(plan, context).ok).toBe(true);
  }
  const inline = { kind: "meeting_metadata", scope: "single", selectFirst: "false" };
  expect(schemaAccepts(inline)).toBe(false);
  expect(validateMeetingPlan(inline, context).ok).toBe(false);
  expect(validateMeetingPlan(inline, context, true).ok).toBe(true);
});

test.each([
  { ...selected, kind: ["meeting_content"] },
  { ...selected, scope: ["selected"] },
  { ...selected, scope: "single", source: ["google-meet"] },
  { ...selected, scope: "range", relativeDate: ["today"] },
  { ...selected, purpose: ["summary"] },
  { ...selected, evidenceRequirement: ["overview"] },
])("enum fields reject arrays without coercion: %j", plan => {
  expect(schemaAccepts(plan)).toBe(false);
  expect(validateMeetingPlan(plan, context).ok).toBe(false);
  expect(validateMeetingPlan(plan, context, true).ok).toBe(false);
});

test("decisions and action overview uses overview evidence while transcript follow-ups require body", () => {
  const guidance = meetingInterpretationGuidance(context);
  const examples = new Map([...guidance.matchAll(/^Example: '([^']+)'[^\n]* => (\{.+\})$/gm)].map(match => [match[1], JSON.parse(match[2])]));
  expect(examples.get("Summarize that meeting’s decisions and action items")).toEqual({ kind: "meeting_content", scope: "selected", purpose: "summary", evidenceRequirement: "overview" });
  expect(examples.get("Read its transcript and explain what both speakers said")).toEqual({ kind: "meeting_content", scope: "selected", purpose: "summary", evidenceRequirement: "body" });
  expect(guidance).toContain("Multiple requested parts alone do not require body");
});
