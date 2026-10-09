import { formatDuration } from "../recorderCopy";

export interface Moment {
  atMs: number;
  label: string;
}

export type MomentTime = string;

/** `m:ss`, or `h:mm:ss` past an hour; the time is floored, as the timer is. */
export const momentTime = (atMs: number): MomentTime => formatDuration(atMs);

/** The Markdown line of a moment; an empty label is a bare bookmark. */
export function momentLine(atMs: number, label: string): string {
  const text = label.trim();
  return `- **${momentTime(atMs)}**${text ? ` ${text}` : ""}`;
}

const MOMENT_LINE =
  /^- \*\*(\d+):([0-5]\d)(?::([0-5]\d))?\*\*(?: +(.*\S))?\s*$/;

/** The moments in a note: only `m:ss` and `h:mm:ss` lines, in order; every other line is ignored. */
export function parseMoments(md: string): Moment[] {
  const moments: Moment[] = [];
  for (const line of md.split("\n")) {
    const match = MOMENT_LINE.exec(line);
    if (!match) continue;
    const [, first, second, third, label] = match;
    const seconds =
      third === undefined
        ? Number(first) * 60 + Number(second)
        : (Number(first) * 60 + Number(second)) * 60 + Number(third);
    moments.push({ atMs: seconds * 1000, label: label ?? "" });
  }
  return moments;
}

export const hasNote = (md: string | undefined | null): boolean =>
  (md ?? "").trim().length > 0;

/** `md` with a line appended; returns the new text and the new line's index. */
export function appendLine(
  md: string,
  line: string,
): { md: string; index: number } {
  const lines = md.trim() ? md.replace(/\n+$/, "").split("\n") : [];
  lines.push(line);
  return { md: lines.join("\n"), index: lines.length - 1 };
}

export function replaceLine(md: string, index: number, line: string): string {
  const lines = md.split("\n");
  lines[index] = line;
  return lines.join("\n");
}

export function removeLine(md: string, index: number): string {
  const lines = md.split("\n");
  lines.splice(index, 1);
  return lines.join("\n");
}
