// Every owner-visible word of a feedback report the owner's main bot proposes (TC-4336): the card and the line it
// collapses to after the tap. Monica's words; nothing else in the app writes these.
import type { FeedbackOutcome } from "./botsApi";
import { BOTS_STRINGS } from "./botsStrings";

const BOT = BOTS_STRINGS.mainName;

/** Where reports go: the one host the service posts them to. */
export const FEEDBACK_HOST = "feedback.tinycloud.xyz";

/** The feedback service's report id: a ULID. Any other id is not shown. */
const REPORT_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const FEEDBACK_STRINGS = {
  title: `${BOT} wants to send feedback to the TinyCloud team`,
  destination: `Goes to ${FEEDBACK_HOST}. Only the TinyCloud team can read it.`,
  labels: { kind: "Type", title: "Title", tried: "What I tried", happened: "What happened", expected: "What I expected" },
  /** The report's `kind`, in the owner's words. */
  kinds: { bug: "Something broke", friction: "Hard to use", improvement: "Idea" } as Record<string, string>,
  sender: "Sent without your name or account, so the team can't reply to you.",
  agent: (agent: string) => `Sent as: ${agent}`,
  send: "Send report",
  decline: "Don't send",
  /** A Send tapped after the chat read the owner's private data, or after the request ended. */
  refused: "Not sent. This chat holds your private data, or the request ended.",
  /** The chat's lines for the owner's decision on a report. */
  lineSent: "You sent a feedback report to the TinyCloud team.",
  lineDeclined: "You chose not to send a feedback report.",
} as const;

/** The line a sent report's card collapses to, by the service's outcome. */
export function feedbackOutcomeText(outcome: FeedbackOutcome, reportId?: string): string {
  switch (outcome) {
    case "filed": return reportId && REPORT_ID.test(reportId) ? `Sent. Report ${reportId}.` : "Sent.";
    case "rate_limited": return `Not sent: the feedback service is taking too many reports. Ask ${BOT} to try in a few minutes.`;
    case "busy": return `Not sent: the feedback service is busy. Ask ${BOT} to try in a few hours.`;
    case "rejected": return "Not sent: the feedback service refused this report.";
    case "unknown": return `This report may have been sent. If you ask ${BOT} to resend it, the team may get two copies.`;
    case "refused": return FEEDBACK_STRINGS.refused;
  }
}
