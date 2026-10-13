/** One change to a textarea: replace [from, to) with `text`, then select [select[0], select[1]]. */
export interface TextEdit {
  from: number;
  to: number;
  text: string;
  select: [number, number];
}

export const BLOCK = /^(\s*)(#{1,6} |[-*] \[[ xX]\] |[-*] |\d+\. |> )/;

export type WrapMark = "**" | "*";

export function applyEdit(value: string, edit: TextEdit): string {
  return value.slice(0, edit.from) + edit.text + value.slice(edit.to);
}

/** Bold or italic: wraps the selection (or a placeholder word), and unwraps if it is already wrapped. */
export function wrapEdit(
  value: string,
  start: number,
  end: number,
  mark: WrapMark,
  placeholder: string,
): TextEdit {
  const n = mark.length;
  if (
    value.slice(start - n, start) === mark &&
    value.slice(end, end + n) === mark
  ) {
    return {
      from: start - n,
      to: end + n,
      text: value.slice(start, end),
      select: [start - n, end - n],
    };
  }
  const text = value.slice(start, end) || placeholder;
  return {
    from: start,
    to: end,
    text: mark + text + mark,
    select: [start + n, start + n + text.length],
  };
}

/** Puts `prefix` on every line the selection touches, or takes it off if they all have it already. */
export function blockEdit(
  value: string,
  start: number,
  end: number,
  prefix: string,
  has: RegExp,
): TextEdit {
  const from = value.lastIndexOf("\n", start - 1) + 1;
  let to = value.indexOf("\n", end);
  if (to < 0) to = value.length;
  const lines = value.slice(from, to).split("\n");
  const all = lines.every((line) => has.test(line));
  const text = lines
    .map((line) =>
      all ? line.replace(BLOCK, "$1") : prefix + line.replace(BLOCK, "$1"),
    )
    .join("\n");
  const caret = from + text.length;
  return { from, to, text, select: [caret, caret] };
}

/** Enter inside a list or quote continues it; Enter on an empty item ends it. Null leaves Enter alone. */
export function continueEdit(
  value: string,
  start: number,
  end: number,
): TextEdit | null {
  if (start !== end) return null;
  const from = value.lastIndexOf("\n", start - 1) + 1;
  const line = value.slice(from, start);
  const match = line.match(BLOCK);
  if (!match || match[2]!.startsWith("#")) return null;
  if (line.trim() === match[2]!.trim()) {
    return { from, to: start, text: "", select: [from, from] };
  }
  let prefix = match[2]!;
  const number = prefix.match(/^(\d+)\. /);
  if (number) prefix = `${Number(number[1]) + 1}. `;
  prefix = prefix.replace(/\[[xX]\]/, "[ ]");
  const text = `\n${match[1]}${prefix}`;
  const caret = start + text.length;
  return { from: start, to: start, text, select: [caret, caret] };
}

export type FormatTool =
  | "heading"
  | "bold"
  | "italic"
  | "bullets"
  | "checklist"
  | "quote";

export function toolEdit(
  tool: FormatTool,
  value: string,
  start: number,
  end: number,
): TextEdit {
  switch (tool) {
    case "heading":
      return blockEdit(value, start, end, "## ", /^\s*#{1,6} /);
    case "bold":
      return wrapEdit(value, start, end, "**", "bold");
    case "italic":
      return wrapEdit(value, start, end, "*", "italic");
    case "bullets":
      return blockEdit(value, start, end, "- ", /^\s*[-*] (?!\[)/);
    case "checklist":
      return blockEdit(value, start, end, "- [ ] ", /^\s*[-*] \[[ xX]\] /);
    case "quote":
      return blockEdit(value, start, end, "> ", /^\s*> /);
  }
}

/** The edit a key press makes in the writer, or null when the key is not the writer's. */
export function keyEdit(
  event: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    isComposing: boolean;
  },
  value: string,
  start: number,
  end: number,
): TextEdit | null {
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  if (mod && key === "b") return toolEdit("bold", value, start, end);
  if (mod && key === "i") return toolEdit("italic", value, start, end);
  if (event.key === "Enter" && !mod && !event.shiftKey && !event.isComposing)
    return continueEdit(value, start, end);
  return null;
}
