import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Nothing to show yet, said plainly (shadcn's Empty pattern): an optional
 * icon, a title, one short line, and what to do about it. Left-aligned, like
 * the rest of Exo's screens.
 */
export function Empty(props: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  [data: `data-${string}`]: string | undefined;
}) {
  const { icon, title, description, action, className, ...data } = props;
  return (
    <div className={cn("flex flex-col items-start gap-2 py-6", className)} {...data}>
      {icon && (
        <span aria-hidden="true" className="mb-1 flex size-10 items-center justify-center rounded-lg bg-surface-2 text-muted-foreground [&_svg]:size-5">
          {icon}
        </span>
      )}
      <p className="text-headline">{title}</p>
      {description && <p className="max-w-[34ch] text-callout text-muted-foreground">{description}</p>}
      {action && <div className="mt-1 flex flex-wrap gap-2">{action}</div>}
    </div>
  );
}
