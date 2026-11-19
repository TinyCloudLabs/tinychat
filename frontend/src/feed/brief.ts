// A card's brief, as the feed reads it from `payload.brief` (card guide v2). Only what an open card needs to decide
// whether it has a brief lives here; the sheet that shows one (BriefSheet.tsx) loads from its own chunk (TC-2882).

/** A card's brief: `markdown` carried inline, or `url`, a .md or .html page on this app's own origin. */
export interface Brief {
  title: string;
  markdown?: string;
  url?: string;
}

// Past this a brief is no longer one page, and rendering it would stall the sheet.
export const MAX_MARKDOWN = 100_000;

/**
 * The page a brief's `url` names, when the sheet can open it: a page on this app's own origin (a path, or an absolute
 * address on this origin), ending .md or .html. Nothing off-host: another host would learn the owner's address and
 * when they read the card, and could track or phish inside the frame (Bobbie's review, #680). Inline Markdown is the
 * preferred way to send a brief.
 */
export function briefPage(value: string): { href: string; format: "markdown" | "html" } | undefined {
  if (value.length > 2048) return undefined;
  const here = typeof window === "undefined" ? undefined : window.location.href;
  const onThisHost = value.startsWith("/") && !value.startsWith("//");
  let url: URL;
  try {
    // A path can only be resolved in the browser; elsewhere (tests, the server render) a placeholder host parses it.
    url = new URL(value, here ?? "https://this-host.invalid");
  } catch {
    return undefined;
  }
  const sameOrigin = onThisHost || (here !== undefined && url.origin === new URL(here).origin);
  if (!sameOrigin) return undefined;
  const path = url.pathname.toLowerCase();
  const format = /\.(md|markdown)$/.test(path) ? "markdown" : /\.html?$/.test(path) ? "html" : undefined;
  return format && { href: here ? url.href : value, format };
}

/** A card payload's brief, if it carries a well-formed one (`payload.brief`). Markdown wins when both are given. */
export function briefOf(payload: Record<string, unknown> | undefined): Brief | undefined {
  const value = payload?.brief;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { title, markdown, url } = value as Record<string, unknown>;
  if (typeof title !== "string" || !title.trim() || title.length > 200) return undefined;
  if (typeof markdown === "string" && markdown.trim() && markdown.length <= MAX_MARKDOWN) return { title: title.trim(), markdown };
  if (typeof url === "string" && briefPage(url)) return { title: title.trim(), url };
  return undefined;
}
