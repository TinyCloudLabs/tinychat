// A card's "Details" pop-up (feed lab, after Aceternity's Animated Modal, rebuilt on Radix Dialog): on a phone
// (under 640px) it is a bottom sheet with a grabber that slides up; from 640px up it is a centred dialog that
// scales in. Radix gives the focus trap, Escape, scrim close and focus return to "Details". The motion is
// tailwindcss-animate keyframes on Radix's data-state, so the close plays out before the sheet leaves the page.
// With reduced motion it neither slides nor scales: it just appears and disappears.
import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";

/** The card's facts (`children`) in a sheet titled "Details". Controlled: the caller owns `open`. */
export function DetailsSheet({ open, onOpenChange, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:duration-250 data-[state=closed]:duration-150 motion-reduce:!animate-none" />
      <Dialog.Content
        aria-describedby={undefined}
        className={[
          "fixed z-50 flex flex-col bg-card text-card-foreground shadow-float outline-none",
          // Phone: pinned to the bottom edge, never under the status bar, clear of the home indicator.
          "inset-x-0 bottom-0 max-h-[calc(var(--tc-app-height,100dvh)-env(safe-area-inset-top)-0.75rem)] rounded-t-sheet border-t border-border pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]",
          // 640px up: centred with margins rather than a transform, so the keyframes' own transform cannot knock it
          // off centre mid-animation.
          "sm:inset-0 sm:m-auto sm:h-fit sm:max-h-[min(85dvh,calc(var(--tc-app-height,100dvh)-2rem))] sm:w-[calc(100%-2rem)] sm:max-w-md sm:rounded-sheet sm:border sm:p-0",
          // Phone motion: the whole sheet rises from below the screen and drops back.
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-bottom-full data-[state=closed]:slide-out-to-bottom-full data-[state=open]:duration-350 data-[state=open]:ease-drawer data-[state=closed]:duration-250 data-[state=closed]:ease-exit",
          // 640px up: a small rise, scale and fade instead, quicker on the way out.
          "sm:data-[state=open]:slide-in-from-bottom-2 sm:data-[state=closed]:slide-out-to-bottom-2 sm:data-[state=open]:zoom-in-95 sm:data-[state=closed]:zoom-out-95 sm:data-[state=open]:fade-in-0 sm:data-[state=closed]:fade-out-0 sm:data-[state=open]:duration-250 sm:data-[state=open]:ease-smooth sm:data-[state=closed]:duration-150",
          "motion-reduce:!animate-none",
        ].join(" ")}
      >
        <div aria-hidden className="mx-auto mt-2 h-1.5 w-9 shrink-0 rounded-full bg-muted-foreground/40 sm:hidden" />
        <div className="flex min-h-13 shrink-0 items-center gap-2 pl-4 pr-2 sm:pt-1">
          <Dialog.Title className="min-w-0 flex-1 font-display text-title-2">Details</Dialog.Title>
          <Dialog.Close aria-label="Close" className="tap-transparent flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-surface-2 fine:size-9">
            <XIcon className="size-5" />
          </Dialog.Close>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain break-words px-4 pb-4 pt-1 text-sm">{children}</div>
        <div className="flex shrink-0 justify-end border-t border-border px-4 py-3">
          <Dialog.Close className="min-h-11 rounded-lg border border-border px-4 text-sm transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-surface-2 fine:min-h-10">Close</Dialog.Close>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
