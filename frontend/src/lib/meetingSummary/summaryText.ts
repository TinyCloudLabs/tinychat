// TC-1152 v1b-b: the one plain-text shape a combined meeting's summary has, its strict parser, and the
// two stored columns.
//
//   OVERVIEW:
//   <a few sentences>
//   ACTION ITEMS:
//   - <one follow-up per line>          (or "- None")
//
// A model reply is DATA. The parser accepts only that shape, strips markup, caps every length and
// answers null for anything else. Nothing here renders, evaluates or follows links; the UI shows the
// parsed strings as React text.

export interface SummaryLimits {
  overviewChars: number;
  items: number;
  itemChars: number;
}

export interface ParsedSummary {
  overview: string;
  actionItems: string[];
}

/** What is stored and shown for a whole meeting. */
export const SUMMARY_LIMITS: SummaryLimits = { overviewChars: 2000, items: 20, itemChars: 300 };
/** What one chunk's digest may carry into the final step of a long meeting. */
export const DIGEST_LIMITS: SummaryLimits = { overviewChars: 1000, items: 8, itemChars: 200 };
/** A reply longer than this is not a summary. */
const MAX_REPLY_CHARS = 20_000;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const OVERVIEW_HEADER = /^OVERVIEW:[ \t]*(.*)$/i;
const ACTIONS_HEADER = /^ACTION ITEMS:[ \t]*(.*)$/i;
const BULLET = /^(?:[-*•])[ \t]+(.*)$/;
/** Any other all-caps "HEADER:" line: the reply is not the shape asked for. */
const OTHER_HEADER = /^[A-Z][A-Z -]{2,}:/;
const NONE = /^(?:none|n\/a|no action items?|nothing)\.?$/i;

/** Plain text only: tags and link/image syntax go, whitespace collapses, length is capped. */
export function cleanText(input: string, maxChars: number): string {
  const text = input
    .replace(CONTROL, " ")
    .replace(/<\/?[A-Za-z!?][^>]*>?/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/** The summary in `raw`, or null when it is not exactly the requested shape. Never throws. */
export function parseSummary(raw: unknown, limits: SummaryLimits = SUMMARY_LIMITS): ParsedSummary | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_REPLY_CHARS) return null;
  const lines = raw.replace(/\r\n?/g, "\n").replace(CONTROL, " ").split("\n").map((line) => line.trim());
  let i = 0;
  while (i < lines.length && lines[i] === "") i++;
  const first = OVERVIEW_HEADER.exec(lines[i] ?? "");
  if (first === null) return null;
  i++;
  const overviewLines: string[] = first[1] ? [first[1]] : [];
  let inActions: RegExpExecArray | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    inActions = ACTIONS_HEADER.exec(line);
    if (inActions) break;
    if (OVERVIEW_HEADER.test(line) || OTHER_HEADER.test(line)) return null;
    overviewLines.push(line);
  }
  if (inActions === null) return null;
  i++;
  const items: string[] = [];
  const rest = inActions[1] ?? "";
  const actionLines = [...(rest ? [rest] : []), ...lines.slice(i)];
  for (const line of actionLines) {
    if (line === "") continue;
    if (ACTIONS_HEADER.test(line) || OVERVIEW_HEADER.test(line) || OTHER_HEADER.test(line)) return null;
    const bullet = BULLET.exec(line);
    if (bullet) items.push(bullet[1]!);
    // A bullet that wrapped onto the next line.
    else if (items.length > 0) items[items.length - 1] += ` ${line}`;
    else return null;
  }
  // Paragraph breaks in the overview are kept (one blank line at most); every paragraph is cleaned.
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of [...overviewLines, ""]) {
    if (line !== "") current.push(line);
    else {
      const paragraph = cleanText(current.join(" "), limits.overviewChars);
      if (paragraph !== "") paragraphs.push(paragraph);
      current = [];
    }
  }
  if (paragraphs.length === 0) return null;
  const joined = paragraphs.join("\n\n");
  const overview = joined.length <= limits.overviewChars ? joined : `${joined.slice(0, limits.overviewChars - 1).trimEnd()}…`;
  const cleaned = items.map((item) => cleanText(item, limits.itemChars)).filter((item) => item !== "");
  const actionItems = cleaned.length === 1 && NONE.test(cleaned[0]!) ? [] : cleaned.slice(0, limits.items);
  return { overview, actionItems };
}

/** The `summary_action_items` column: one item per line (items are single-line); null when there are none. */
export function actionItemsToColumn(items: readonly string[]): string | null {
  const lines = items.map((item) => item.replace(/\s+/g, " ").trim()).filter((item) => item !== "");
  return lines.length === 0 ? null : lines.join("\n");
}

/** The items of a stored `summary_action_items`; a bulleted list (other sources write one) loses its bullets. */
export function actionItemsFromColumn(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value.split("\n").map((line) => cleanText(line.replace(BULLET, "$1"), SUMMARY_LIMITS.itemChars)).filter((line) => line !== "").slice(0, SUMMARY_LIMITS.items);
}

/** A stored `summary_overview` for display: any writer's text, cleaned the way a parsed one is (paragraphs kept). */
export function overviewFromColumn(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const joined = value.replace(/\r\n?/g, "\n").split(/\n{2,}/).map((p) => cleanText(p, SUMMARY_LIMITS.overviewChars)).filter((p) => p !== "").join("\n\n");
  if (joined === "") return null;
  return joined.length <= SUMMARY_LIMITS.overviewChars ? joined : `${joined.slice(0, SUMMARY_LIMITS.overviewChars - 1).trimEnd()}…`;
}
