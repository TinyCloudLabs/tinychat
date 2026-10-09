// The shared confirmation pattern: a title, one line saying what is lost, the
// safe choice first and focused, the destructive choice in red below. Esc is
// "keep", and focus goes back to whatever opened it.
//
// Local to Meeting sources on purpose. D1 ships its own ConfirmDialog over a
// hand-rolled SheetDialog; this one rides Radix AlertDialog so it nests inside
// the Meeting sources Radix Dialog (layered Escape, focus return) without a
// second capture-phase key handler fighting Radix's. They should be
// consolidated once both are on the integration branch.
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useRef, type ReactNode } from "react";

import { useSoftTheme } from "../home/softTheme";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  keepLabel: string;
  dropLabel: string;
  /** Escape, the keep button, or (when not busy) dismissing the sheet. */
  onKeep: () => void;
  onDrop: () => void;
  /** The destructive action is running: the sheet cannot be dismissed. */
  busy?: boolean;
  /** A failed attempt, shown above the buttons. The sheet stays open. */
  error?: string | null;
  /** Where focus goes when the sheet closes, if not the element that opened it (e.g. it is about to be removed). */
  returnFocus?: () => HTMLElement | null;
  testId?: string;
}

export function ConfirmDialog({
  open,
  title,
  message,
  keepLabel,
  dropLabel,
  onKeep,
  onDrop,
  busy = false,
  error = null,
  returnFocus,
  testId,
}: ConfirmDialogProps) {
  const theme = useSoftTheme();
  const keepRef = useRef<HTMLButtonElement>(null);
  // Radix returns focus to its Trigger, and this sheet is opened from a button
  // that is not one (it is controlled), so the opener is captured here.
  const openerRef = useRef<HTMLElement | null>(null);
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onKeep();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={`ms-veil ms-veil-confirm ${theme}`} />
        <AlertDialog.Content
          className={`soft-skin ${theme} ms-confirm`}
          data-layout="desktop"
          data-testid={testId}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            openerRef.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
            keepRef.current?.focus({ preventScroll: true });
          }}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = returnFocus?.() ?? openerRef.current;
            if (target?.isConnected) target.focus({ preventScroll: true });
          }}
        >
          <AlertDialog.Title className="soft-title ms-confirm-title">{title}</AlertDialog.Title>
          <AlertDialog.Description className="ms-confirm-message">{message}</AlertDialog.Description>
          {error && (
            <p role="alert" className="ms-confirm-error">
              {error}
            </p>
          )}
          <button
            ref={keepRef}
            type="button"
            className="ms-confirm-keep"
            aria-disabled={busy}
            onClick={() => {
              if (!busy) onKeep();
            }}
          >
            {keepLabel}
          </button>
          <button
            type="button"
            className="ms-confirm-drop"
            aria-disabled={busy}
            onClick={() => {
              if (!busy) onDrop();
            }}
          >
            {dropLabel}
          </button>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
