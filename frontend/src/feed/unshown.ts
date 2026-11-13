// What an open card does not draw (Sam, via Holden: "details to indicate the unrendered content"; nothing in a card's
// data may be silently dropped). Each renderer's reach is declared as a Shape beside this walker; everything in the card
// outside it is listed in Details under "Not shown on the card", exactly as the agent sent it.

/**
 * What a renderer draws of a value. `true`: all of it (a drawn leaf, or a subtree drawn whole). An object: these keys,
 * each with its own shape; any other key is not shown. `{ "[]": shape }`: a list whose every item has that shape.
 */
export type Shape = true | { readonly "[]": Shape } | { readonly [key: string]: Shape };

/**
 * A part of the card the open card does not draw: where it is, and its value as sent. `quiet`: bookkeeping the feed
 * uses (sorting, expiry, closure) but does not draw; it is listed apart and not counted in the card's "+N".
 */
export interface UnshownField { path: string; value: unknown; quiet?: true }

const isList = (shape: Shape): shape is { readonly "[]": Shape } => typeof shape === "object" && "[]" in shape;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const join = (path: string, key: string) => (path ? `${path}.${key}` : key);

/**
 * Every part of `value` outside `shape`, outermost first: a key the shape does not name, or a value of another form
 * than the shape expects (a string where a list was drawn), is listed whole. Empty values (null, undefined, "", [], {})
 * carry nothing to show and are never listed.
 */
export function unshownFields(value: unknown, shape: Shape, path = ""): UnshownField[] {
  if (shape === true || isEmpty(value)) return [];
  if (isList(shape)) {
    if (!Array.isArray(value)) return [{ path, value }];
    return value.flatMap((item, index) => unshownFields(item, shape["[]"], `${path}[${index}]`));
  }
  if (!isRecord(value)) return [{ path, value }];
  return Object.entries(value).flatMap(([key, item]) => {
    const inner = Object.hasOwn(shape, key) ? (shape as Record<string, Shape>)[key] : undefined;
    if (inner === undefined) return isEmpty(item) ? [] : [{ path: join(path, key), value: item }];
    return unshownFields(item, inner, join(path, key));
  });
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return isRecord(value) && Object.keys(value).length === 0;
}

/** The plain words for a value's form, for the list's right-hand hint: "text", "number", "2 fields", "list of 3". */
export function formHint(value: unknown): string {
  if (Array.isArray(value)) return `list of ${value.length}`;
  if (isRecord(value)) { const count = Object.keys(value).length; return count === 1 ? "1 field" : `${count} fields`; }
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "yes or no";
  return "text";
}

/** Names that read better than the rule makes them (Monica, TC-2980). */
const LABELS: Readonly<Record<string, string>> = {
  askIds: "Asks", updaters: "Updated by", expiryBaseAt: "Expires from", resubmitOf: "Replaces", resubmitCount: "Times asked again", supersededBy: "Replaced by",
};

/**
 * A field's name in plain words, from the last key of its path: camel case split into words and a trailing "At" (a
 * time) dropped, so `payload.sitrep.record.askedAt` reads "Asked"; a few keys have their own name (LABELS).
 */
export function fieldLabel(path: string): string {
  const key = (path.split(".").at(-1) ?? path).replace(/\[\d+\]/g, "");
  if (Object.hasOwn(LABELS, key)) return LABELS[key]!;
  const words = key.replace(/(.)At$/, "$1").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : path;
}
