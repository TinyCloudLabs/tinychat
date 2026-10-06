// One sheet, two shapes (TC-761), after shadcn's responsive Dialog/Drawer: a
// bottom sheet on compact screens (phones, upright or on their side) and a
// centred Dialog on medium and expanded ones. Same API as BottomSheet, so a
// caller never branches on size.
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";

import { BottomSheet, BottomSheetBody, BottomSheetFooter, type BottomSheetProps } from "@/components/ui/bottom-sheet";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useSizeClass } from "@/lib/sizeClass";
import { cn } from "@/lib/utils";

export type ResponsiveSheetProps = BottomSheetProps;

export function ResponsiveSheet(props: ResponsiveSheetProps) {
  const { size } = useSizeClass();
  if (size === "compact") return <BottomSheet {...props} />;
  const { open, onOpenChange, dismissible = true, title, description, children, contentProps } = props;
  const block = (event: Event) => {
    if (!dismissible) event.preventDefault();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (dismissible || next) && onOpenChange(next)}>
      <DialogContent
        {...contentProps}
        {...(description ? {} : { "aria-describedby": undefined })}
        hideCloseButton
        onEscapeKeyDown={block}
        onPointerDownOutside={block}
        onInteractOutside={block}
        className={cn(
          "flex max-w-lg flex-col gap-0 overflow-hidden bg-card p-0 text-card-foreground",
          props.height === "full" && "h-[min(90dvh,calc(var(--tc-app-height,100dvh)-env(safe-area-inset-top)-env(safe-area-inset-bottom)))]",
        )}
      >
        <div className="flex min-h-13 shrink-0 items-center gap-2 pl-4 pr-2 pt-1">
          <DialogTitle className="min-w-0 flex-1 truncate font-display text-title-2">{title}</DialogTitle>
          {dismissible && (
            <DialogPrimitive.Close
              aria-label="Close"
              className="tap-transparent flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-surface-2 fine:size-9"
            >
              <XIcon className="size-5" />
            </DialogPrimitive.Close>
          )}
        </div>
        {description && (
          <DialogDescription className="shrink-0 px-4 pb-1 text-callout text-muted-foreground">{description}</DialogDescription>
        )}
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** The scrolling middle of a sheet (both shapes). */
export const ResponsiveSheetBody = BottomSheetBody;

/** Actions pinned under the body (both shapes). */
export const ResponsiveSheetFooter = BottomSheetFooter;
