import { useEffect, useState, type ComponentPropsWithoutRef, type FC } from "react";

import { useReplyImageBudget, useWaitingImages } from "@/components/assistant-ui/image-budget";
import { IMAGE_PROMPT_COPY, imageUrlVerdict } from "@/lib/imageUrlFilter";

type ImgProps = ComponentPropsWithoutRef<"img"> & { node?: unknown };

/**
 * A Markdown image in a chat reply. It loads as usual unless its address looks like it carries data (then it asks first), or
 * the reply already holds its share of images from other hosts (then it waits for the reply's one prompt).
 */
export const GatedImage: FC<ImgProps> = ({ node: _node, src, alt, ...props }) => {
  const budget = useReplyImageBudget();
  useWaitingImages(budget);
  // The reader's choice belongs to the address they saw: a streamed reply can change the address under the same image.
  const [decision, setDecision] = useState<{ src: string; choice: "load" | "skip" } | null>(null);
  const address = typeof src === "string" ? src : null;
  if (address !== null) budget?.claim(address);
  useEffect(() => budget?.publish(), [budget, address]);

  const verdict = address === null ? { kind: "block" as const } : imageUrlVerdict(address);
  const picture = <img src={address ?? undefined} alt={alt} referrerPolicy="no-referrer" {...props} />;
  const notLoaded = <span className="text-muted-foreground">{IMAGE_PROMPT_COPY.notLoaded(alt ?? "")}</span>;

  if (address === null || verdict.kind === "block") return notLoaded;
  if (verdict.kind === "load") {
    if (!budget?.isHeld(address)) return picture;
    const held = budget.choice(address);
    if (held === "load") return picture;
    if (held === "skip") return notLoaded;
    return <span className="text-muted-foreground">{IMAGE_PROMPT_COPY.waiting(alt ?? "")}</span>;
  }
  const choice = decision?.src === address ? decision.choice : null;
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
          onClick={() => setDecision({ src: address, choice: "load" })}
        >
          {IMAGE_PROMPT_COPY.load}
        </button>
        <button
          type="button"
          className="rounded-md px-3 py-1 text-sm text-muted-foreground"
          onClick={() => setDecision({ src: address, choice: "skip" })}
        >
          {IMAGE_PROMPT_COPY.notNow}
        </button>
      </span>
    </span>
  );
};
