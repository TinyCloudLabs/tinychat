import { heldImages, type HeldImage } from "@/lib/imageBudget";
import { IMAGE_PROMPT_COPY, imageUrlVerdict } from "@/lib/imageUrlFilter";

/** What the reader chose for an image address: `load` draws it, `skip` leaves its description. Bound to the exact address. */
export type ImageChoices = Readonly<Record<string, "load" | "skip">>;

export type GatedNote = {
  html: string;
  /** Images beyond the note's share from other hosts that nobody has chosen for yet: asked once, for the whole note. */
  waiting: HeldImage[];
};

const MAY_NEED_WORK = /<(?:img|a)\b/i;

function note(document: Document, className: string, text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

function choiceButton(document: Document, attribute: string, src: string, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "nt-img-gate-button";
  button.setAttribute(attribute, src);
  button.textContent = label;
  return button;
}

/**
 * The rendered note with its images checked: an image whose address looks like it carries data waits behind its own "Load
 * image from <host>?" prompt, one that cannot load is left as its description, and images beyond the note's budget for other
 * hosts wait for one prompt for the whole note (`waiting`). Links and images send no referrer. The HTML is parsed in an inert
 * template, so nothing loads while it is judged.
 */
export function gateNoteImages(html: string, choices: ImageChoices = {}): GatedNote {
  if (!MAY_NEED_WORK.test(html)) return { html, waiting: [] };
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const link of template.content.querySelectorAll("a[href]")) {
    link.setAttribute("rel", "noopener noreferrer nofollow");
    link.setAttribute("referrerpolicy", "no-referrer");
  }
  const images = [...template.content.querySelectorAll("img")];
  const held = heldImages(images.map((image) => image.getAttribute("src") ?? ""));
  const heldSrcs = new Set(held.map((image) => image.src));
  for (const image of images) {
    const src = image.getAttribute("src") ?? "";
    const alt = image.getAttribute("alt") ?? "";
    const verdict = imageUrlVerdict(src);
    const choice = choices[src];
    const draw = verdict.kind === "load" ? !heldSrcs.has(src) || choice === "load" : verdict.kind === "ask" && choice === "load";
    if (draw) {
      image.setAttribute("referrerpolicy", "no-referrer");
    } else if (verdict.kind === "block" || choice === "skip") {
      image.replaceWith(note(document, "nt-img-skipped", IMAGE_PROMPT_COPY.notLoaded(alt)));
    } else if (verdict.kind === "load") {
      image.replaceWith(note(document, "nt-img-skipped", IMAGE_PROMPT_COPY.notLoaded(alt)));
    } else if (verdict.kind === "ask") {
      const gate = document.createElement("span");
      gate.className = "nt-img-gate";
      gate.setAttribute("role", "group");
      gate.setAttribute("aria-label", IMAGE_PROMPT_COPY.title(verdict.host));
      gate.append(note(document, "nt-img-gate-title", IMAGE_PROMPT_COPY.title(verdict.host)));
      if (alt) gate.append(note(document, "nt-img-gate-alt", alt));
      gate.append(
        note(document, "nt-img-gate-address", verdict.address),
        note(document, "nt-img-gate-why", IMAGE_PROMPT_COPY.why(verdict.host)),
        choiceButton(document, "data-img-load", src, IMAGE_PROMPT_COPY.load),
        choiceButton(document, "data-img-skip", src, IMAGE_PROMPT_COPY.notNow),
      );
      image.replaceWith(gate);
    }
  }
  return { html: template.innerHTML, waiting: held.filter((image) => choices[image.src] === undefined) };
}
