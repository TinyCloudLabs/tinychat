import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { InfoIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A compact (i) that reveals a one-line hint: on hover or focus with a mouse,
 * and on tap on touch screens (Radix tooltips never open on touch by
 * themselves, so the open state is controlled here). Use it for a short hint
 * next to a label. Longer explanations belong on the How it works page
 * (lib/about.ts), linked with HowItWorksLink.
 */
export function InfoTip(props: {
  /** Accessible name of the trigger, e.g. "About transcription". */
  label: string;
  children: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <TooltipPrimitive.Provider delayDuration={150}>
      <TooltipPrimitive.Root open={open} onOpenChange={setOpen}>
        <TooltipPrimitive.Trigger asChild>
          <button
            type="button"
            aria-label={props.label}
            onClick={(event) => {
              event.preventDefault();
              setOpen((current) => !current);
            }}
            className={cn(
              "inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring fine:size-7",
              props.className,
            )}
          >
            <InfoIcon className="size-4" aria-hidden="true" />
          </button>
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={props.side ?? "top"}
            sideOffset={4}
            collisionPadding={12}
            className="z-50 max-w-[min(18rem,calc(100vw-2rem))] rounded-md border border-border bg-popover px-3 py-2 text-meta text-popover-foreground shadow-float animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 motion-reduce:animate-none"
          >
            {props.children}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
