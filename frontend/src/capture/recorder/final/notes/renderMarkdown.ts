import type { FmdRenderer } from "@franken-suite/franken-markdown";

// The renderer's WASM is 7.7 MB: nothing imports this package statically, so it stays out of the main chunk and is only
// fetched by `warmRenderer` (a few seconds into a recording) or the first Preview.
let loading: Promise<FmdRenderer> | null = null;

export function loadRenderer(): Promise<FmdRenderer> {
  loading ??= import("@franken-suite/franken-markdown")
    .then((module) => module.createRenderer())
    .catch((error: unknown) => {
      loading = null;
      throw error;
    });
  return loading;
}

export function warmRenderer(): void {
  loadRenderer().catch((error: unknown) =>
    console.error("[Recorder] Could not warm the notes renderer", error),
  );
}

// A custom stylesheet replaces the engine's built-in theme, so the HTML is small and semantic and notes.css styles it.
// Raw HTML in a note stays escaped (`allowRawHtml` defaults to false) and `javascript:` links are dropped.
const APP_STYLED = "/* styled by the app */";

/** The inner HTML of the `<main class="fmd">` of the engine's full document. */
export function extractMain(document: string): string {
  const open = document.indexOf('<main class="fmd">');
  const close = document.lastIndexOf("</main>");
  if (open < 0 || close < open) {
    throw new Error('The renderer\'s output has no <main class="fmd">');
  }
  return document.slice(open + '<main class="fmd">'.length, close).trim();
}

// A note's text can come from a model (a summary) or from what a meeting said, so it is untrusted. An image the engine
// draws would be fetched the moment the note opens, with no click, and its address can carry anything. Images are
// replaced by their description and the site they point to, and no `src` reaches the DOM. A web link keeps its address
// and gets its full host beside it, so the label cannot hide where it goes. Raw HTML never gets here: the engine
// escapes it, so every `<img` in the output is one the engine drew from Markdown.
const unescapeAttr = (value: string) =>
  value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const escapeText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attrOf = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`, "i").exec(tag)?.[1];

function webHost(address: string): string | null {
  try {
    const url = new URL(address);
    return url.protocol === "http:" || url.protocol === "https:" ? url.host : null;
  } catch {
    return null;
  }
}

function withoutRemoteLoads(html: string): string {
  return html
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const alt = attrOf(tag, "alt");
      const src = attrOf(tag, "src");
      const host = src ? webHost(unescapeAttr(src)) : null;
      return `<span class="note-image">[Image not loaded${alt ? `: ${alt}` : ""}${host ? ` (${escapeText(host)})` : ""}]</span>`;
    })
    .replace(/(<a\b[^>]*\shref="([^"]*)"[^>]*>)([\s\S]*?)<\/a>/gi, (whole, open: string, href: string, inner: string) => {
      const host = webHost(unescapeAttr(href));
      return host ? `${open}${inner}</a> <span class="note-link-host">(${escapeText(host)})</span>` : whole;
    });
}

const cache = new Map<string, string>();

export async function renderNoteHtml(md: string): Promise<string> {
  const cached = cache.get(md);
  if (cached !== undefined) return cached;
  const renderer = await loadRenderer();
  const output = await renderer.renderHtml(md, {
    customCss: APP_STYLED,
    darkMode: "disabled",
  });
  const html = withoutRemoteLoads(extractMain(output.text()));
  if (cache.size >= 32) cache.clear();
  cache.set(md, html);
  return html;
}
