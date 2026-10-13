import type { ReactNode, RefObject } from "react";
import { SheetDialog } from "../SheetDialog";

export interface ConfirmDialogProps {
  role?: "alertdialog" | "dialog";
  title: string;
  description: ReactNode;
  titleId: string;
  descriptionId: string;
  /** The safe choice: focused when the dialog opens. */
  keep: { label: string; onPress: () => void };
  /** The other choice, below it. */
  other: { label: string; onPress: () => void; tone: "danger" | "dim" };
  /** What Escape and a click on the veil do; the safe choice unless said otherwise. */
  onCancel?: () => void;
  /** The control that opened the dialog: focus goes back to it on every close. */
  returnFocus: RefObject<HTMLElement | null>;
  fallbackFocus?: RefObject<HTMLElement | null>;
  children?: ReactNode;
}

/** A centred dialog over the recorder: traps Tab, Escape cancels (keeps, for a discard), focus returns to the opener. */
export function ConfirmDialog({
  role = "alertdialog",
  title,
  description,
  titleId,
  descriptionId,
  keep,
  other,
  onCancel = keep.onPress,
  returnFocus,
  fallbackFocus,
  children,
}: ConfirmDialogProps) {
  return (
    <div className="dr-confirm">
      <SheetDialog
        role={role}
        titleId={titleId}
        descriptionId={descriptionId}
        title={title}
        description={description}
        onCancel={onCancel}
        returnFocus={returnFocus}
        fallbackFocus={fallbackFocus}
      >
        <button
          type="button"
          className="pr-keep"
          data-initial=""
          onClick={keep.onPress}
        >
          {keep.label}
        </button>
        <button
          type="button"
          className="pr-discard"
          style={other.tone === "dim" ? { color: "var(--dim)" } : undefined}
          onClick={other.onPress}
        >
          {other.label}
        </button>
        {children}
      </SheetDialog>
    </div>
  );
}
