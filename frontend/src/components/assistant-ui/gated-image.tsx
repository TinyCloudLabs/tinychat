import { useState, type ComponentPropsWithoutRef, type FC } from "react";

import { IMAGE_PROMPT_COPY, imageUrlVerdict } from "@/lib/imageUrlFilter";

type ImgProps = ComponentPropsWithoutRef<"img"> & { node?: unknown };

/** A Markdown image in a chat reply: loads as usual unless its address looks like it carries data, then asks first. */
export const GatedImage: FC<ImgProps> = ({ node: _node, src, alt, ...props }) => {
  const [choice, setChoice] = useState<"load" | "skip" | null>(null);
  const verdict = typeof src === "string" ? imageUrlVerdict(src) : { kind: "block" as const };

  if (verdict.kind === "load" || (verdict.kind === "ask" && choice === "load")) {
    return <img src={src as string} alt={alt} {...props} />;
  }
  if (verdict.kind === "block" || choice === "skip") {
    return <span className="text-muted-foreground">{IMAGE_PROMPT_COPY.notLoaded(alt ?? "")}</span>;
  }
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
          onClick={() => setChoice("load")}
        >
          {IMAGE_PROMPT_COPY.load}
        </button>
        <button
          type="button"
          className="rounded-md px-3 py-1 text-sm text-muted-foreground"
          onClick={() => setChoice("skip")}
        >
          {IMAGE_PROMPT_COPY.notNow}
        </button>
      </span>
    </span>
  );
};
