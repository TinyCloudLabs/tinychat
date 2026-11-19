import { useEffect, useId, useState, type ComponentPropsWithoutRef, type FC } from "react";
import { INTERNAL } from "@assistant-ui/react";

import { useReplyImageBudget, useWaitingImages } from "@/components/assistant-ui/image-budget";
import { IMAGE_PROMPT_COPY, imageUrlVerdict } from "@/lib/imageUrlFilter";

type ImgProps = ComponentPropsWithoutRef<"img"> & { node?: unknown };

/**
 * A Markdown image in a chat reply. It loads as usual unless its address looks like it carries data (then it asks first), or
 * the reply's images have used its budget (then it waits for the reply's one prompt). While the text is still streaming no
 * image loads, whatever its host: half-written addresses must not use the budget, every image that loads must be counted
 * against it, and the silent set must be the same on every mount, so it is decided once from the finished text, in
 * document order.
 */
export const GatedImage: FC<ImgProps> = ({ node: _node, src, alt, ...props }) => {
  const budget = useReplyImageBudget();
  useWaitingImages(budget);
  const id = useId();
  const streaming = INTERNAL.useSmoothStatus().type === "running";
  // The reader's choice belongs to the address they saw, in the reply they saw it in: a streamed reply can change the address
  // under the same image, and the thread can reuse this component for another message (a new budget).
  const [decision, setDecision] = useState<{ budget: typeof budget; src: string; choice: "load" | "skip" } | null>(null);
  const address = typeof src === "string" ? src : null;
  const claimed = address !== null && !streaming ? address : null;
  if (claimed !== null) budget?.claim(id, claimed);
  // A claim keeps its place when its address changes; it is given up only when the image goes away or stops claiming.
  useEffect(() => {
    if (!budget) return;
    if (claimed !== null) budget.claim(id, claimed);
    else budget.release(id);
    budget.publish();
  }, [budget, id, claimed]);
  useEffect(
    () => () => {
      budget?.release(id);
      budget?.publish();
    },
    [budget, id],
  );

  const verdict = address === null ? { kind: "block" as const } : imageUrlVerdict(address);
  const picture = <img src={address ?? undefined} alt={alt} referrerPolicy="no-referrer" {...props} />;
  const notLoaded = <span className="text-muted-foreground">{IMAGE_PROMPT_COPY.notLoaded(alt ?? "")}</span>;

  if (address === null || verdict.kind === "block") return notLoaded;
  if (streaming) return notLoaded;
  if (verdict.kind === "load") {
    if (!budget?.isHeld(address)) return picture;
    const held = budget.choice(address);
    if (held === "load") return picture;
    if (held === "skip") return notLoaded;
    return notLoaded; // the reply's prompt says why
  }
  const choice = decision?.src === address && decision.budget === budget ? decision.choice : null;
  if (choice === "load") return picture;
  if (choice === "skip") return notLoaded;
  return (
    <span
      role="group"
      aria-label={IMAGE_PROMPT_COPY.title(verdict.host)}
      className="my-2 block rounded-lg border border-border bg-muted p-3 text-sm"
    >
      <span className="block font-medium text-foreground">{IMAGE_PROMPT_COPY.title(verdict.host)}</span>
      {alt ? <span className="block text-muted-foreground">{alt}</span> : null}
      <span className="mt-1 block break-all font-mono text-xs text-muted-foreground">{verdict.address}</span>
      <span className="mt-1 block text-xs text-muted-foreground">{IMAGE_PROMPT_COPY.why(verdict.host)}</span>
      <span className="mt-2 flex gap-2">
        <button
          type="button"
          className="rounded-md border border-border bg-background px-3 py-1 text-sm font-medium"
          onClick={() => setDecision({ budget, src: address, choice: "load" })}
        >
          {IMAGE_PROMPT_COPY.load}
        </button>
        <button
          type="button"
          className="rounded-md px-3 py-1 text-sm text-muted-foreground"
          onClick={() => setDecision({ budget, src: address, choice: "skip" })}
        >
          {IMAGE_PROMPT_COPY.notNow}
        </button>
      </span>
    </span>
  );
};
