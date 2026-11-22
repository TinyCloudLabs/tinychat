// Text a box wrote (a question, a choice) is shown as plain text and nothing else. React renders strings as text, so
// no markup, link or image can come out of them; this keeps characters that change how text reads or hides what
// it says (control characters, bidirectional overrides, zero-width marks) out of the card as well.

/** C0 and C1 controls, bidi embeddings, overrides and isolates (and marks), zero-width and invisible joiners, BOM, line and paragraph separators. */
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\u180e\ufeff\ufff9-\ufffb]/gu;

/** One line of plain text, at most `max` characters (code points): hidden characters become spaces, runs of spaces one space. */
export function plainText(value: string, max: number): string {
  const text = value.replace(HIDDEN, " ").replace(/ {2,}/g, " ").trim();
  const points = [...text];
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : text;
}

/** Plain text that keeps its lines (a proposed message): each line as `plainText`, at most two line breaks in a row, `max` characters in all. */
export function plainLines(value: string, max: number): string {
  const text = value.replace(/\r\n?/g, "\n").split("\n").map((line) => plainText(line, max)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const points = [...text];
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : text;
}

export const MAX_QUESTION = 280;
export const MAX_CHOICE = 60;
export const MAX_CHOICES = 4;
export const MAX_ANSWER = 280;

/** The service's `appReply` message text starts with these words when the owner said not now; the chat line follows it. */
const DECLINED_REPLY = "The person chose not to answer now.";

export const isDeclinedReply = (text: string): boolean => text.startsWith(DECLINED_REPLY);
