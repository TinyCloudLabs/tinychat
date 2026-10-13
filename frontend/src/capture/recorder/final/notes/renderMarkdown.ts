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

const cache = new Map<string, string>();

export async function renderNoteHtml(md: string): Promise<string> {
  const cached = cache.get(md);
  if (cached !== undefined) return cached;
  const renderer = await loadRenderer();
  const output = await renderer.renderHtml(md, {
    customCss: APP_STYLED,
    darkMode: "disabled",
  });
  const html = extractMain(output.text());
  if (cache.size >= 32) cache.clear();
  cache.set(md, html);
  return html;
}
