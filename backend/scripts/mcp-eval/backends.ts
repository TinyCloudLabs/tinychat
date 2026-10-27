import { OFFERED_CHAT_MODELS } from "../../../packages/core/src/chatModels.js";
import { materializeSpace } from "./scoring.js";
import { BackendUnavailableError, type ChatAnswer, type ChatBackend, type ChatQuestion, type EvalCase, type FixtureSpace } from "./types.js";

export const OFFERED_MODEL_IDS: readonly string[] = OFFERED_CHAT_MODELS.map(m => m.id);

/**
 * STUB. Not a working adapter. The current Eliza path (`POST /tasks` SSE via `backend/src/agent-task-client.ts`)
 * needs a live Eliza service, a per-user private-access delegation and a paid model provider; none of those is
 * available to an offline eval, and the frozen fixture space has no way to be loaded into Eliza's storage yet.
 * Every call reports NOT RUN. It never answers and is never scored as a pass or a fail.
 */
export const elizaStubBackend: ChatBackend = {
  id: "eliza (STUB: not implemented, always NOT RUN)",
  models: () => OFFERED_MODEL_IDS,
  async answer() {
    throw new BackendUnavailableError("Eliza adapter is a stub: needs a live Eliza service, a user delegation and a paid model provider, and a way to load the fixture space into Eliza storage");
  },
};

/**
 * Answer-key backend used to check the eval itself: it builds its answer from the case's expectations and the
 * fixture space, so a correct scorer must give it 100%. Its numbers are NOT a chat backend baseline.
 */
export function createAnswerKeyBackend(cases: EvalCase[]): ChatBackend {
  // The same question text appears in several scenarios; the space object identifies the scenario.
  const bySpace = new Map<FixtureSpace, Map<string, EvalCase>>();
  for (const c of cases) {
    const questions = bySpace.get(c.space) ?? new Map<string, EvalCase>();
    questions.set(c.question, c);
    bySpace.set(c.space, questions);
  }
  return {
    id: "answer-key (self-check oracle, not a chat backend)",
    models: () => OFFERED_MODEL_IDS,
    async answer(question: ChatQuestion, space: FixtureSpace): Promise<ChatAnswer> {
      const testCase = bySpace.get(space)?.get(question.text);
      if (!testCase) throw new Error(`answer key has no case for question: ${question.text}`);
      return keyAnswer(testCase, space);
    },
  };
}

function keyAnswer(testCase: EvalCase, rawSpace: FixtureSpace): ChatAnswer {
  const { expect } = testCase;
  const space = materializeSpace(rawSpace);
  if (expect.behavior === "decline") return { text: "I could not find supported meeting content to answer this. Please narrow the request or check access." };
  if (expect.behavior === "general") {
    const sources = space.publicSources ?? [];
    const facts = expect.requiredFacts.join(" ");
    return { text: `${facts || "Hello!"}${sources.length ? `\n\n### Public sources\n${sources.map(s => `- [${s.title}](${s.url})`).join("\n")}` : ""}` };
  }
  const shown = space.meetings.slice(0, 12);
  const lines: string[] = [];
  for (const meeting of shown) {
    if (expect.behavior === "metadata") {
      lines.push(`${meeting.title} (${meeting.startedAt}; ${meeting.participants.join(", ")}) [${meeting.id}]`);
      continue;
    }
    for (const item of meeting.evidence.filter(e => e.kind !== "metadata")) {
      const cite = item.speaker !== undefined && item.startSecs !== undefined ? `[${item.id}, ${item.speaker}, ${clock(item.startSecs)}]` : `[${item.id}]`;
      lines.push(`${item.text} ${cite}`);
    }
  }
  if (expect.requiredFacts.length) lines.push(expect.requiredFacts.join(" "));
  const sourceLines = (space.publicSources ?? []).map(s => `- [${s.title}](${s.url})`);
  const coverageLines = shown.map(m => `${m.id} — ${m.state === "read" ? "Content was read; this answer cites this record. Based on the stored recap." : "Discovered; content was not read."}`);
  return {
    text: [lines.join("\n"), sourceLines.length ? `### Public sources\n${sourceLines.join("\n")}` : "", `### Coverage\n${coverageLines.join("\n")}`].filter(Boolean).join("\n\n"),
  };
}

function clock(secs: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor((secs % 3600) / 60))}:${pad(secs % 60)}`;
}
