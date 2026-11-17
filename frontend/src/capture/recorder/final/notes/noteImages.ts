import { IMAGE_PROMPT_COPY, imageUrlVerdict } from "@/lib/imageUrlFilter";

/** What the reader chose for the note's nth image: `load` draws it, `skip` leaves its description. */
export type ImageChoices = Readonly<Record<number, "load" | "skip">>;

const MAY_NEED_WORK = /<(?:img|a)\b/i;

function note(document: Document, className: string, text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

function choiceButton(document: Document, attribute: string, index: number, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "nt-img-gate-button";
  button.setAttribute(attribute, String(index));
  button.textContent = label;
  return button;
}

/**
 * The rendered note with its images checked by address: an image that looks like it carries data waits behind a "Load image
 * from <host>?" prompt, one that cannot load is left as its description, the rest are untouched. Links send no referrer.
 * The HTML is parsed in an inert template, so nothing loads while it is judged.
 */
export function gateNoteImages(html: string, choices: ImageChoices = {}): string {
  if (!MAY_NEED_WORK.test(html)) return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const link of template.content.querySelectorAll("a[href]")) {
    link.setAttribute("rel", "noopener noreferrer nofollow");
    link.setAttribute("referrerpolicy", "no-referrer");
  }
  template.content.querySelectorAll("img").forEach((image, index) => {
    const src = image.getAttribute("src") ?? "";
    const alt = image.getAttribute("alt") ?? "";
    const verdict = imageUrlVerdict(src);
    if (verdict.kind === "load" || (verdict.kind === "ask" && choices[index] === "load")) return;
    if (verdict.kind === "block" || choices[index] === "skip") {
      image.replaceWith(note(document, "nt-img-skipped", IMAGE_PROMPT_COPY.notLoaded(alt)));
      return;
    }
    const gate = document.createElement("span");
    gate.className = "nt-img-gate";
    gate.setAttribute("role", "group");
    gate.setAttribute("aria-label", IMAGE_PROMPT_COPY.title(verdict.host));
    gate.append(note(document, "nt-img-gate-title", IMAGE_PROMPT_COPY.title(verdict.host)));
    if (alt) gate.append(note(document, "nt-img-gate-alt", alt));
    gate.append(
      note(document, "nt-img-gate-address", verdict.address),
      note(document, "nt-img-gate-why", IMAGE_PROMPT_COPY.why(verdict.host)),
      choiceButton(document, "data-img-load", index, IMAGE_PROMPT_COPY.load),
      choiceButton(document, "data-img-skip", index, IMAGE_PROMPT_COPY.notNow),
    );
    image.replaceWith(gate);
  });
  return template.innerHTML;
}
