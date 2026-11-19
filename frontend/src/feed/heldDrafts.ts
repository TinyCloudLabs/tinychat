import { deferOriginMove } from "@/lib/originMove";
import { holdsTypedWords } from "@/shell/unsavedWork";

/**
 * The feed's "Your own answer" drafts, by card. A draft lives here, not in the card's field, so a card folded with
 * "Show less" keeps it; and so does the hold on a tinycloud.chat page's move to tinycloud.one: while any draft has
 * words, the page stays (originMove.ts `deferOriginMove`). A draft that is cleared, deleted or dropped with
 * `clear()` lets go of its hold; `clear()` is also how the feed lets go of all of them when it goes.
 */
export class HeldDrafts extends Map<string, string> {
  private readonly holds = new Map<string, () => void>();

  override set(key: string, value: string): this {
    super.set(key, value);
    if (!holdsTypedWords(value)) this.release(key);
    else if (!this.holds.has(key)) this.holds.set(key, deferOriginMove());
    return this;
  }

  override delete(key: string): boolean {
    this.release(key);
    return super.delete(key);
  }

  override clear(): void {
    for (const key of [...this.holds.keys()]) this.release(key);
    super.clear();
  }

  private release(key: string) {
    this.holds.get(key)?.();
    this.holds.delete(key);
  }
}
