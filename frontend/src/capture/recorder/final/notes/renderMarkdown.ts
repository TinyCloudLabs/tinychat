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

// A note's text can come from a model (a summary) or from what a meeting said, so every note is untrusted. An image the
// engine draws would be fetched the moment the note opens, with no click, and its address can carry anything. So the
// renderer never emits a loadable image: each is a placeholder with its description and host, and its address waits in
// `data-` attributes, which the browser does not fetch. The note view asks "Load images from <host>?" and only after an
// Allow does `showAllowedImages` turn that host's placeholders into images. A web link keeps its address and gets its
// full host beside it, so the label cannot hide where it goes. Raw HTML never gets here: the engine escapes it, so
// every `<img` in the engine's output is one it drew from Markdown.
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
      const place = host && src ? ` data-note-image-host="${escapeText(host).replace(/"/g, "&quot;")}" data-note-image-src="${src}" data-note-image-alt="${alt ?? ""}"` : "";
      return `<span class="note-image"${place}>Image not loaded${alt ? `: ${alt}` : ""}${host ? ` (${escapeText(host)})` : ""}</span>`;
    })
    .replace(/(<a\b[^>]*\shref="([^"]*)"[^>]*>)([\s\S]*?)<\/a>/gi, (whole, open: string, href: string, inner: string) => {
      const host = webHost(unescapeAttr(href));
      if (!host) return whole;
      // A label that already starts with the host (the address itself, or the host name) says it once.
      const label = unescapeAttr(inner.replace(/<[^>]*>/g, "")).trim().toLowerCase().replace(/^https?:\/\//, "");
      if (label === host || label.startsWith(`${host}/`)) return whole;
      return `${open}${inner}</a> <span class="note-link-host">(${escapeText(host)})</span>`;
    });
}

const PLACEHOLDER = /<span class="note-image" data-note-image-host="([^"]*)" data-note-image-src="([^"]*)" data-note-image-alt="([^"]*)">[\s\S]*?<\/span>/g;

/** The sites whose images this note still holds back, in order of first appearance, as the host text shown to the owner. */
export function blockedImageHosts(html: string, allowed: ReadonlySet<string> = new Set()): string[] {
  const hosts: string[] = [];
  for (const match of html.matchAll(PLACEHOLDER)) {
    const host = unescapeAttr(match[1]!);
    if (!allowed.has(host) && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

/** Turns the placeholders of the sites the owner allowed into images; every other placeholder stays a placeholder. */
export function showAllowedImages(html: string, allowed: ReadonlySet<string>): string {
  if (allowed.size === 0) return html;
  return html.replace(PLACEHOLDER, (whole, host: string, src: string, alt: string) =>
    allowed.has(unescapeAttr(host))
      ? `<img class="note-image" src="${src}" alt="${alt}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
      : whole);
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
