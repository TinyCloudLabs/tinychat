// Turns the bytes of a fetched page into plain text for Main. It runs in the key-less fetch process on whatever a site
// sent, so it keeps no state, calls nothing, and returns only text: no markup, no script, no image reference.
//  - scripts, styles, embedded content and hidden-template content are dropped;
//  - an image becomes its alt text (a picture is never fetched or referenced);
//  - a link becomes "text (address)" so an address the page really offered can be followed, which is the only way a
//    page address becomes one Main may fetch (the gateway re-extracts them from this text).

import { MAX_URL_CHARS } from "./web";

const SKIPPED = "script,style,noscript,template,svg,iframe,object,canvas";
const LINES = "br,hr,li,dt,dd,tr,div,summary,figcaption";
const PARAGRAPHS = "p,ul,ol,dl,table,h1,h2,h3,h4,h5,h6,section,article,header,footer,nav,aside,main,form,pre,blockquote,figure,details,title";

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function entities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : " ";
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/**
 * The most text a page may give back: the caller cuts to this after the whitespace is tidied.
 */
export const MAX_TEXT_CHARS = 100_000;

/**
 * The most text built before that tidy-up. It is applied while the text is built, so a page of tiny links that each grow
 * into a full address cannot make the output many times larger than the page. Twice the cap leaves room for the
 * whitespace the tidy-up removes, so a long page still reaches MAX_TEXT_CHARS.
 */
const BUILD_LIMIT = 2 * MAX_TEXT_CHARS;

/** The page's text, as the byte-for-byte decoded string `html` (already decoded; see decodeBody). */
export async function htmlToText(html: string, base: URL): Promise<string> {
  const out: string[] = [];
  let size = 0;
  let skipping = 0;
  let raw = "";
  const full = () => size >= BUILD_LIMIT;
  const emit = (text: string) => {
    if (full()) return;
    const part = text.slice(0, BUILD_LIMIT - size);
    out.push(part);
    size += part.length;
  };
  const flush = () => {
    if (raw) emit(entities(raw));
    raw = "";
  };
  const rewriter = new HTMLRewriter()
    .on(SKIPPED, {
      element(element) {
        // A self-closing <svg/> has no end tag to hook, and asking for one throws.
        if (!element.canHaveContent) return;
        skipping++;
        element.onEndTag(() => void (skipping = Math.max(0, skipping - 1)));
      },
    })
    .on(LINES, {
      element() {
        flush();
        if (!skipping) emit("\n");
      },
    })
    .on(PARAGRAPHS, {
      element() {
        flush();
        if (!skipping) emit("\n\n");
      },
    })
    .on("img", {
      element(element) {
        flush();
        const alt = element.getAttribute("alt")?.trim();
        if (alt && !skipping) emit(` ${entities(alt)} `);
      },
    })
    .on("a[href]", {
      element(element) {
        const href = element.getAttribute("href");
        if (!href || skipping || full()) return;
        let target: URL;
        try {
          target = new URL(href.trim(), base);
        } catch {
          return;
        }
        if ((target.protocol !== "http:" && target.protocol !== "https:") || target.href.length > MAX_URL_CHARS) return;
        target.hash = "";
        element.onEndTag(() => {
          flush();
          if (!skipping) emit(` (${target.href}) `);
        });
      },
    })
    // Document-level, so text outside any element (a page with no <body>) is read too.
    .onDocument({
      text(chunk) {
        if (skipping || full()) return;
        raw += chunk.text;
        if (chunk.lastInTextNode) flush();
      },
    });
  // The rewriter's output is not used; its handlers collect the text. The input is one string, so no chunk is dropped.
  await rewriter.transform(new Response(html)).text();
  flush();
  return out
    .join("")
    .replace(/[\t\f\v\u00a0 ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Decodes page bytes with the charset the response declared, falling back to UTF-8 (replacing what cannot decode). */
export function decodeBody(body: Uint8Array, contentType: string): string {
  const label = /charset\s*=\s*"?([a-z0-9_.:-]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(label ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

/** The text of a page the guard returned: plain text as it is, HTML through the rewriter. */
export async function pageText(body: Uint8Array, mediaType: string, base: URL, declared: string): Promise<string> {
  const decoded = decodeBody(body, declared);
  return mediaType === "text/plain" ? decoded.replace(/\r\n?/g, "\n").trim() : htmlToText(decoded, base);
}
