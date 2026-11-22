// Hides a secret's value in text that goes back to Main after a call_with_secret call. A site can echo what it was
// sent, so every reply is searched for the value whole and in the encodings a site is likely to echo it in: base64
// and base64url (at any byte offset, so the value inside a longer encoded string such as `user:<value>` is found
// too), URL-encoded (both percent and form spelling), hex in either case, and JSON-escaped. Other transformations
// (hashes, partial echoes, a different alphabet) cannot be caught; the design says so plainly.

export const HIDDEN = "[hidden]";
/** An encoded fragment shorter than this is too likely to occur by chance to be cut out of a reply. */
const MIN_FRAGMENT_CHARS = 8;

/** The part of `base64(prefix + value)` that depends on the value alone, for each of the three byte offsets. */
function base64Cores(value: Uint8Array): string[] {
  const cores: string[] = [];
  for (let offset = 0; offset < 3; offset++) {
    const padded = new Uint8Array(offset + value.length);
    padded.set(value, offset);
    const encoded = Buffer.from(padded).toString("base64").replace(/=+$/, "");
    const core = encoded.slice(Math.ceil((offset * 8) / 6), Math.floor(((offset + value.length) * 8) / 6));
    if (core.length >= MIN_FRAGMENT_CHARS) cores.push(core);
    // Base64 of exactly the value is the common case: its last, partial character belongs to the value too.
    if (offset === 0 && encoded.length >= MIN_FRAGMENT_CHARS) cores.push(encoded);
  }
  return cores;
}

/** Every spelling of `value` this module hides, longest first so a longer form is never left half-replaced. */
export function secretForms(value: string): string[] {
  if (value === "") return [];
  const bytes = new TextEncoder().encode(value);
  const forms = new Set<string>([value]);
  for (const core of base64Cores(bytes)) {
    forms.add(core);
    forms.add(core.replaceAll("+", "-").replaceAll("/", "_"));
  }
  const percent = encodeURIComponent(value);
  forms.add(percent);
  forms.add(percent.replace(/%[0-9A-F]{2}/g, match => match.toLowerCase()));
  forms.add(percent.replaceAll("%20", "+"));
  // Characters encodeURIComponent keeps but stricter encoders escape.
  forms.add(percent.replace(/[!'()*~]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`));
  const hex = Buffer.from(bytes).toString("hex");
  if (hex.length >= MIN_FRAGMENT_CHARS) {
    forms.add(hex);
    forms.add(hex.toUpperCase());
  }
  const json = JSON.stringify(value).slice(1, -1);
  forms.add(json);
  forms.add(json.replace(/[^\x20-\x7e]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`));
  forms.add(json.replaceAll("/", "\\/"));
  return [...forms].filter(form => form !== "").sort((a, b) => b.length - a.length);
}

export interface Redactor {
  /** `text` with every form of the value replaced by [hidden]. */
  redact(text: string): string;
  /** The longest form: a reply cut short can end in a partial one at most this long. */
  readonly longest: number;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactor(value: string): Redactor {
  const forms = secretForms(value);
  const pattern = forms.length === 0 ? undefined : new RegExp(forms.map(escape).join("|"), "g");
  // Hex is also matched in any mix of cases; its two plain spellings are already in `forms`.
  const hex = Buffer.from(new TextEncoder().encode(value)).toString("hex");
  const mixedHex = hex.length >= MIN_FRAGMENT_CHARS ? new RegExp(hex, "gi") : undefined;
  return {
    redact: text => {
      const once = pattern ? text.replace(pattern, HIDDEN) : text;
      return mixedHex ? once.replace(mixedHex, HIDDEN) : once;
    },
    longest: forms[0]?.length ?? 0,
  };
}

/**
 * Redacts first, then cuts to `maxChars`. When the text was already cut short before it got here (`cutShort`, the
 * read cap), its last `longest - 1` characters may hold the start of a form the cut broke, so they go too.
 */
export function redactThenTruncate(text: string, value: Redactor, maxChars: number, cutShort: boolean): { text: string; truncated: boolean } {
  let redacted = value.redact(text);
  let truncated = cutShort;
  if (cutShort && value.longest > 1) redacted = redacted.slice(0, Math.max(0, redacted.length - (value.longest - 1)));
  if (redacted.length > maxChars) {
    redacted = redacted.slice(0, maxChars);
    truncated = true;
  }
  return { text: redacted, truncated };
}
