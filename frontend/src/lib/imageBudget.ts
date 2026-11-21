import { IMAGE_BIT_FLOOR, REPLY_BIT_BUDGET, addressBits } from "./imageAddressBits";
import { isAllowlistedImageHost } from "./imageHosts";
import { imageUrlVerdict } from "./imageUrlFilter";

// The address filter judges one image at a time. A reply or note can hold many, so what its images can carry is bounded
// together: every image that loads without asking is charged the room for data in its address, in bits
// (imageAddressBits.ts), and the images of one reply or note load on their own only while their total stays within
// REPLY_BIT_BUDGET. The rest wait behind one prompt for the whole reply.
//
// The budget is one number for the whole reply. It is not kept per host or per domain, so sending to many domains buys
// nothing, and no image is free: each is charged at least IMAGE_BIT_FLOOR. An address on the allowlist (imageHosts.ts) is
// charged only that floor, because its requests are not read by whoever wrote the reply. A piece of an address that an
// earlier image of the reply already sent (the host, a folder) is charged as an index, not again in full.

export type HeldImage = { src: string; host: string };

/**
 * The images of one reply or note that must wait, from every image address in document order: those that would take the
 * total past the budget. One that waits is not charged, so a smaller image after it may still load. An address that asks or
 * is blocked is judged on its own and is never charged; the same address twice is charged once.
 */
export function heldImages(srcs: readonly string[]): HeldImage[] {
  const counted = new Set<string>();
  const held: HeldImage[] = [];
  let sent = new Set<string>();
  let spent = 0;
  for (const src of srcs) {
    if (counted.has(src)) continue;
    counted.add(src);
    const verdict = imageUrlVerdict(src);
    if (verdict.kind !== "load") continue;
    const { hostname, host } = new URL(src);
    const withThis = new Set(sent);
    const bits = isAllowlistedImageHost(hostname)
      ? IMAGE_BIT_FLOOR
      : Math.max(IMAGE_BIT_FLOOR, Math.ceil(verdict.charged.reduce((sum, href) => sum + addressBits(new URL(href), withThis), 0)));
    if (spent + bits > REPLY_BIT_BUDGET) {
      held.push({ src, host });
      continue;
    }
    spent += bits;
    if (!isAllowlistedImageHost(hostname)) sent = withThis;
  }
  return held;
}

/**
 * One reply's images as they render, and what the reader chose for each held address. Choices are bound to the exact address.
 * Each image instance claims its current address while it is mounted and releases it when it goes away or changes, so a stale
 * address (a half-streamed one) never keeps a slot, and the silent set is always computed from the images that are there,
 * in document order.
 */
export class ReplyImageBudget {
  #claims = new Map<string, string>();
  #choices = new Map<string, "load" | "skip">();
  #listeners = new Set<() => void>();
  #waiting: readonly HeldImage[] = [];

  /** An image instance says which address it shows; safe to call on every render. */
  claim(id: string, src: string): void {
    this.#claims.set(id, src);
  }

  release(id: string): void {
    this.#claims.delete(id);
  }

  isHeld(src: string): boolean {
    return heldImages([...this.#claims.values()]).some((held) => held.src === src);
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
    const next = heldImages([...this.#claims.values()]).filter((held) => !this.#choices.has(held.src));
    if (next.length === this.#waiting.length && next.every((held, i) => held.src === this.#waiting[i]!.src)) return;
    this.#waiting = next;
    for (const listener of this.#listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
}
