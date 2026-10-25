import { renderNoteHtml } from "@/capture/recorder/final/notes/renderMarkdown";
import { safeUrl } from "./feedData";
import wasmUrl from "../../node_modules/@franken-suite/franken-markdown/pkg/franken_markdown_bg.wasm?url";

export function secureArticleHtml(html: string): string {
  const container = document.createElement("div");
  container.innerHTML = html;
  for (const link of container.querySelectorAll("a")) {
    if (!safeUrl(link.getAttribute("href") ?? undefined)) {
      link.replaceWith(...link.childNodes);
    } else {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    }
  }
  return container.innerHTML;
}

export async function renderArticleHtml(markdown: string): Promise<string> {
  // The app renderer is lazy (7.7 MB WASM): a static import would put it on the feed's initial path.
  // Vite's dev optimizer cannot serve its default relative WASM URL. Initialize that same module
  // with Vite's asset URL before using the app's cached safe renderer.
  const renderer = await import("@franken-suite/franken-markdown");
  await renderer.init(wasmUrl);
  return secureArticleHtml(await renderNoteHtml(markdown));
}
