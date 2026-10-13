import type * as React from "react";

import { cn } from "@/lib/utils";

export type StatusTone = "primary" | "warning" | "destructive" | "neutral";

const TONE: Readonly<Record<StatusTone, string>> = {
  primary: "bg-primary",
  warning: "bg-warning",
  destructive: "bg-destructive",
  neutral: "bg-muted-foreground",
};

/** A status as a dot plus text. The text carries the meaning; the dot's colour only reinforces it. */
export function StatusDot({
  tone,
  children,
  className,
  ...rest
}: { tone: StatusTone; children: React.ReactNode; className?: string } & Omit<React.HTMLAttributes<HTMLSpanElement>, "className">) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)} {...rest}>
      <span aria-hidden data-tone={tone} className={cn("size-2 shrink-0 rounded-full", TONE[tone])} />
      {children}
    </span>
  );
}
