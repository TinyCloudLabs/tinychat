import { type RefObject } from "react";
import type {
  MomentField as MomentFieldState,
  MomentFlow,
} from "./momentController";
import { useAccessoryBarHidden } from "./keyboardInset";
import { NOTES_COPY } from "./notesCopy";
import { EnterIcon } from "./notesIcons";

export interface MomentFieldProps {
  field: MomentFieldState;
  flow: MomentFlow;
  /** Called once the moment is saved or cancelled; `refocus` is false when the field lost focus to something else. */
  onClosed: (result: "saved" | "cancelled", refocus: boolean) => void;
}

/** The one-line field under the timer: Enter or ↵ saves, Escape cancels, blur saves. */
export function MomentField({ field, flow, onClosed }: MomentFieldProps) {
  const { time } = field;
  useAccessoryBarHidden();
  const save = (refocus: boolean) => {
    if (!flow.isOpen()) return;
    flow.commit();
    onClosed("saved", refocus);
  };
  return (
    <div className="pr-moment">
      <span className="pr-moment-time soft-title">{time ?? "…"}</span>
      <input
        type="text"
        // Mounting focuses it inside the tap that opened it; the keyboard only comes up for a focus made in a gesture.
        autoFocus
        autoComplete="off"
        enterKeyHint="done"
        placeholder={
          time === null
            ? NOTES_COPY.momentPendingPlaceholder
            : NOTES_COPY.momentPlaceholder(time)
        }
        aria-label={
          time === null
            ? NOTES_COPY.momentLabelPending
            : NOTES_COPY.momentLabel(time)
        }
        onChange={(event) => flow.type(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            save(true);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            flow.cancel();
            onClosed("cancelled", true);
          }
        }}
        onBlur={() => save(false)}
      />
      <button
        type="button"
        aria-label={NOTES_COPY.saveMoment}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => save(true)}
      >
        <EnterIcon />
      </button>
    </div>
  );
}

export type MarkButtonRef = RefObject<HTMLButtonElement | null>;
