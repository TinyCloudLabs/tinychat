import type { MeetingCitation, MeetingObligation } from "@tinyboilerplate/core";
export interface MeetingDraftAnswer {
  obligationId: string;
  text: string;
  citationIds: string[];
}
export function validateMeetingDraft(
  input: unknown,
  obligations: MeetingObligation[],
  citations: MeetingCitation[],
):
  | { valid: true; answers: MeetingDraftAnswer[] }
  | { valid: false; errors: string[] } {
  const draft = input as { answers?: unknown };
  if (
    !draft ||
    !Array.isArray(draft.answers) ||
    !draft.answers.length ||
    draft.answers.length > 64
  )
    return { valid: false, errors: ["invalid_answers"] };
  const seen = new Set<string>();
  for (const answer of draft.answers) {
    if (
      !answer ||
      typeof answer.obligationId !== "string" ||
      typeof answer.text !== "string" ||
      !answer.text.trim() ||
      answer.text.length > 8000 ||
      /\[[^\]]*\]|https?:|<\/?[a-z]/i.test(answer.text) ||
      !Array.isArray(answer.citationIds) ||
      !answer.citationIds.length ||
      seen.has(answer.obligationId)
    )
      return { valid: false, errors: ["invalid_answer_shape"] };
    seen.add(answer.obligationId);
    const obligation = obligations.find((o) => o.id === answer.obligationId);
    if (!obligation?.source || obligation.reason)
      return { valid: false, errors: ["unavailable_obligation"] };
    for (const id of answer.citationIds) {
      const citation = citations.find((c) => c.id === id);
      if (
        !citation ||
        citation.meetingRef !== obligation.source.meetingRef ||
        citation.revision !== obligation.source.revision ||
        citation.source !== obligation.source.source ||
        citation.sourceId !== obligation.source.sourceId
      )
        return { valid: false, errors: ["citation_mismatch"] };
    }
  }
  return { valid: true, answers: draft.answers as MeetingDraftAnswer[] };
}
export function escapeMeetingText(text: string): string {
  return (
    text
      .replace(/[\\`*_{}[\]<>#|]/g, "\\$&")
      // Strip C0 controls from safely rendered evidence.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
  );
}
export function renderMeetingAnswer(answers: MeetingDraftAnswer[]): string {
  return answers
    .map(
      (a) =>
        `${escapeMeetingText(a.text)} ${a.citationIds.map((id) => `[${id}]`).join(" ")}`,
    )
    .join("\n\n");
}
