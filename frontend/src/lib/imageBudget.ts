import { isAllowlistedImageHost } from "./imageHosts";
import { imageUrlVerdict } from "./imageUrlFilter";

// The address filter judges one image at a time. A reply or note can hold many, and each silent image to someone else's
// server can carry about 1.4 kbit in its address. So per reply (or note), at most this many different images from hosts
// outside the allowlist load without asking; the rest wait behind one prompt for the whole reply.
export const SILENT_THIRD_PARTY_IMAGES = 2;

export type HeldImage = { src: string; host: string };

/**
 * The images of one reply or note that must wait, from every image address in document order: the different addresses that
 * pass the filter and are not ours, after the first SILENT_THIRD_PARTY_IMAGES. An address that asks or is blocked is judged on
 * its own and never counts; the same address twice counts once.
 */
export function heldImages(srcs: readonly string[]): HeldImage[] {
  const counted = new Map<string, string>();
  for (const src of srcs) {
    if (counted.has(src) || imageUrlVerdict(src).kind !== "load") continue;
    const { hostname, host } = new URL(src);
    if (!isAllowlistedImageHost(hostname)) counted.set(src, host);
  }
  return [...counted].slice(SILENT_THIRD_PARTY_IMAGES).map(([src, host]) => ({ src, host }));
}

/** One reply's images as they render, and what the reader chose for each held address. Choices are bound to the exact address. */
export class ReplyImageBudget {
  #claimed: string[] = [];
  #choices = new Map<string, "load" | "skip">();
  #listeners = new Set<() => void>();
  #waiting: readonly HeldImage[] = [];

  /** An image says it is here; safe to call on every render. */
  claim(src: string): void {
    if (!this.#claimed.includes(src)) this.#claimed.push(src);
  }

  isHeld(src: string): boolean {
    return heldImages(this.#claimed).some((held) => held.src === src);
  }

  choice(src: string): "load" | "skip" | undefined {
    return this.#choices.get(src);
  }

  decide(srcs: readonly string[], choice: "load" | "skip"): void {
    for (const src of srcs) this.#choices.set(src, choice);
    this.publish();
  }

  /** The held images nobody has chosen for yet; the same array until it changes. */
  waiting = (): readonly HeldImage[] => this.#waiting;

  /** Called after render, when claims may have changed. */
  publish(): void {
    const next = heldImages(this.#claimed).filter((held) => !this.#choices.has(held.src));
    if (next.length === this.#waiting.length && next.every((held, i) => held.src === this.#waiting[i]!.src)) return;
    this.#waiting = next;
    for (const listener of this.#listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
}
