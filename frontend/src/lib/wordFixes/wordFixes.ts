// Word fixes (TC-2199): a per-user list of (find, replace) pairs applied as a display overlay on transcript text,
// e.g. "tiny cloud" -> "TinyCloud". Stored transcripts are never rewritten, so the list also fixes existing notes.
//
// Stored in the user's space, `settings` table, key "word-fixes", value a JSON string:
//   {"version":1,"entries":[{"find":"tiny cloud","replace":"TinyCloud"},{"find":"eliza","replace":"Eliza"}]}
//
// Matching: `find` matches case-insensitively and as a whole word or phrase (no letter, digit or "_" directly beside a
// match); runs of spaces in `find` match any run of whitespace. The longest `find` wins where
// entries overlap, replaced text is never matched again, and `replace` is inserted exactly as stored.

export const WORD_FIXES_SETTING_KEY = "word-fixes";
export const WORD_FIXES_VERSION = 1;
export const MAX_WORD_FIXES = 200;
export const MAX_WORD_FIX_LENGTH = 100;

export interface WordFix { readonly find: string; readonly replace: string }
export type WordFixes = readonly WordFix[];
export const NO_WORD_FIXES: WordFixes = Object.freeze([]);

/** A `find` as stored: single-spaced, trimmed, within the length limit. */
export function cleanFind(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim().slice(0, MAX_WORD_FIX_LENGTH).trim();
}

function cleanReplace(value: string): string {
  return value.replaceAll(/[\r\n]+/g, " ").slice(0, MAX_WORD_FIX_LENGTH);
}

const foldKey = (find: string) => find.toLocaleLowerCase();

/** Entries kept in order: empty finds dropped, duplicate finds (ignoring case) keep the last one, at most MAX_WORD_FIXES. */
function normalized(entries: Iterable<{ find: string; replace: string }>): WordFixes {
  const byKey = new Map<string, WordFix>();
  for (const entry of entries) {
    const find = cleanFind(entry.find);
    if (find === "") continue;
    const key = foldKey(find);
    byKey.delete(key);
    byKey.set(key, Object.freeze({ find, replace: cleanReplace(entry.replace) }));
  }
  const kept = [...byKey.values()].slice(0, MAX_WORD_FIXES);
  return kept.length === 0 ? NO_WORD_FIXES : Object.freeze(kept);
}

/** The list a stored value holds; anything that is not the stored shape reads as an empty list. */
export function parseWordFixes(raw: string | null | undefined): WordFixes {
  if (typeof raw !== "string" || raw === "") return NO_WORD_FIXES;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return NO_WORD_FIXES; }
  if (parsed === null || typeof parsed !== "object" || !("entries" in parsed) || !Array.isArray(parsed.entries)) return NO_WORD_FIXES;
  return normalized((parsed.entries as unknown[]).flatMap((entry) => {
    if (entry === null || typeof entry !== "object" || !("find" in entry) || !("replace" in entry)) return [];
    return typeof entry.find === "string" && typeof entry.replace === "string" ? [{ find: entry.find, replace: entry.replace }] : [];
  }));
}

export function serializeWordFixes(fixes: WordFixes): string {
  return JSON.stringify({ version: WORD_FIXES_VERSION, entries: fixes.map(({ find, replace }) => ({ find, replace })) });
}

/**
 * `fixes` with `find` set to `replace`. An entry with the same `find` (ignoring case) is replaced where it stands;
 * a new one goes last. An empty `find`, or a full list, changes nothing. `previous` is the entry being edited, so
 * changing its `find` moves it.
 */
export function withWordFix(fixes: WordFixes, entry: WordFix, previous?: string): WordFixes {
  const find = cleanFind(entry.find);
  if (find === "") return fixes;
  const key = foldKey(find);
  const editing = previous === undefined ? null : foldKey(cleanFind(previous));
  const next: WordFix[] = [];
  let placed = false;
  const fix = { find, replace: cleanReplace(entry.replace) };
  for (const existing of fixes) {
    const existingKey = foldKey(existing.find);
    if (existingKey === key || existingKey === editing) {
      if (!placed) { next.push(fix); placed = true; }
      continue;
    }
    next.push(existing);
  }
  if (!placed) {
    if (fixes.length >= MAX_WORD_FIXES) return fixes;
    next.push(fix);
  }
  return normalized(next);
}

export function withoutWordFix(fixes: WordFixes, find: string): WordFixes {
  const key = foldKey(find);
  return normalized(fixes.filter((fix) => foldKey(fix.find) !== key));
}

const WORD_CHAR = String.raw`[\p{L}\p{N}\p{M}_]`;
const escapeRegExp = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\-]/g, String.raw`\$&`);

/** One entry as a pattern: whitespace runs flexible, and no letter, digit or "_" directly beside the match. */
function patternOf(find: string): string {
  return `(?<!${WORD_CHAR})${find.split(" ").map(escapeRegExp).join(String.raw`\s+`)}(?!${WORD_CHAR})`;
}

export type WordFixApplier = (text: string) => string;

const identity: WordFixApplier = (text) => text;

/** Compiles the list once into one regular expression; the returned function is cheap to call per sentence. */
export function compileWordFixes(fixes: WordFixes): WordFixApplier {
  if (fixes.length === 0) return identity;
  // Longest find first, so the longest entry wins where several start at the same place.
  const ordered = [...fixes].sort((a, b) => b.find.length - a.find.length);
  const regex = new RegExp(ordered.map((fix) => `(${patternOf(fix.find)})`).join("|"), "giu");
  return (text) => text === "" ? text : text.replace(regex, (...args: unknown[]) => {
    for (let group = 0; group < ordered.length; group++) if (args[group + 1] !== undefined) return ordered[group]!.replace;
    return args[0] as string;
  });
}

/** Sentences (or any `{ text }` rows) with the fixes applied; the input is not changed. */
export function applyWordFixesToSentences<T extends { text: string }>(items: readonly T[], apply: WordFixApplier): T[] {
  if (apply === identity) return [...items];
  return items.map((item) => {
    const text = apply(item.text);
    return text === item.text ? item : { ...item, text };
  });
}
