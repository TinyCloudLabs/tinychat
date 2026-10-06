// A sheet that rises from the bottom edge (TC-761), on vaul: drag down, the
// scrim or Escape (Android Back) closes it; content scrolls inside; iOS keeps a
// focused field above the keyboard (repositionInputs). vaul is pinned and
// unmaintained, so this is the only file that imports it; the swap target is
// the @base-ui/react Drawer. Motion and its reduced-motion fade are in
// index.css (vaul ships no reduced-motion rule).
import * as React from "react";
import { XIcon } from "lucide-react";
import { Drawer } from "vaul";

import { cn } from "@/lib/utils";

export interface BottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** False while busy: no drag, scrim or Escape closes it, and there is no close button. */
  dismissible?: boolean;
  /** `content` grows with what it holds (up to the screen); `full` takes the whole height. */
  height?: "content" | "full";
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  /** Data attributes for the sheet itself (harness and tests). */
  contentProps?: Record<`data-${string}`, string>;
}

export function BottomSheet({
  open,
  onOpenChange,
  dismissible = true,
  height = "content",
  title,
  description,
  children,
  contentProps,
}: BottomSheetProps) {
  return (
    <Drawer.Root
      open={open}
      onOpenChange={onOpenChange}
      dismissible={dismissible}
      shouldScaleBackground={false}
      repositionInputs
    >
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Drawer.Content
          {...contentProps}
          {...(description ? {} : { "aria-describedby": undefined })}
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-sheet bg-card text-card-foreground shadow-float outline-none",
            "pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]",
            // Never under the status bar; the visible viewport shrinks with the keyboard.
            "max-h-[calc(var(--tc-app-height,100dvh)-env(safe-area-inset-top)-0.75rem)]",
            height === "full" && "h-[calc(var(--tc-app-height,100dvh)-env(safe-area-inset-top)-0.75rem)]",
          )}
        >
          <div aria-hidden className="mx-auto mt-2 h-1.5 w-9 shrink-0 rounded-full bg-muted-foreground/40" />
          <div className="flex min-h-13 shrink-0 items-center gap-2 pl-4 pr-2">
            <Drawer.Title className="min-w-0 flex-1 truncate font-display text-title-2">{title}</Drawer.Title>
            {dismissible && (
              <Drawer.Close
                aria-label="Close"
                className="tap-transparent flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground active:bg-surface-2"
              >
                <XIcon className="size-5" />
              </Drawer.Close>
            )}
          </div>
          {description && (
            <Drawer.Description className="shrink-0 px-4 pb-1 text-callout text-muted-foreground">{description}</Drawer.Description>
          )}
          {children}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

/** The scrolling middle of a sheet. */
export function BottomSheetBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 pt-1", className)} {...props} />;
}

/** Actions pinned under the body. */
export function BottomSheetFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex shrink-0 items-center justify-end gap-2 px-4 pb-3 pt-2", className)} {...props} />;
}
