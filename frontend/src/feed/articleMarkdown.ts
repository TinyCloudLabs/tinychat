import { renderNoteHtml } from "@/capture/recorder/final/notes/renderMarkdown";
import { safeUrl } from "./feedData";
import wasmUrl from "../../node_modules/@franken-suite/franken-markdown/pkg/franken_markdown_bg.wasm?url";

export function secureArticleHtml(html: string): string {
  // Template content is inert: reject resource-bearing nodes before any HTML reaches the card.
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const element of template.content.querySelectorAll("*")) {
    if (element.tagName === "IMG") {
      element.replaceWith(document.createTextNode(element.getAttribute("alt") ?? ""));
      continue;
    }
    if (/^(PICTURE|SOURCE|VIDEO|AUDIO|IFRAME|OBJECT|EMBED|SVG|LINK|STYLE|SCRIPT)$/i.test(element.tagName)) {
      element.remove();
      continue;
    }
    const href = element.tagName === "A" ? element.getAttribute("href") : null;
    for (const attribute of [...element.attributes]) {
      if (attribute.name !== "class") element.removeAttribute(attribute.name);
    }
    if (element.tagName === "A") {
      if (!safeUrl(href ?? undefined)) {
        element.replaceWith(...element.childNodes);
      } else {
        element.setAttribute("href", href!);
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noopener noreferrer");
      }
    }
  }
  return template.innerHTML;
}

const articleDependencies = {
  // The app renderer is lazy (7.7 MB WASM): a static import would put it on the feed's initial path.
  // Vite's dev optimizer cannot serve its default relative WASM URL.
  init: async () => { await (await import("@franken-suite/franken-markdown")).init(wasmUrl); },
  render: renderNoteHtml,
};

export async function renderArticleHtml(markdown: string, dependencies: {
  init: () => Promise<void>;
  render: (markdown: string) => Promise<string>;
} = articleDependencies): Promise<string> {
  await dependencies.init();
  return secureArticleHtml(await dependencies.render(markdown));
}
