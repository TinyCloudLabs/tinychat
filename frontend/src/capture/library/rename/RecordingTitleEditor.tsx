// Inline recording-title editor shared by the Library rows and the note header.
// Enter saves, Escape cancels, leaving the field saves. An empty title is valid:
// it returns the recording to its automatic title (renameRecording).
import { useEffect, useId, useRef, useState, type FC } from "react";
import { CheckIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MAX_RECORDING_TITLE_LENGTH } from "@/lib/recordingTitleMeta";
import {
  RECORDING_RENAME_CANCEL,
  RECORDING_RENAME_FIELD_LABEL,
  RECORDING_RENAME_HINT,
  RECORDING_RENAME_PLACEHOLDER,
  RECORDING_RENAME_SAVE,
} from "./recordingRenameStrings";

export interface RecordingTitleEditorProps {
  /** The title shown when editing starts. */
  initial: string;
  onSave: (title: string) => void;
  onCancel: () => void;
  className?: string;
}

export const RecordingTitleEditor: FC<RecordingTitleEditorProps> = ({ initial, onSave, onCancel, className }) => {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  // Escape, Save and Cancel each end the edit once; the blur they cause must not save again.
  const done = useRef(false);
  const hintId = useId();

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
    // Selecting scrolls a long title to its end; show the start of it.
    input.scrollLeft = 0;
  }, []);

  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save) onSave(value);
    else onCancel();
  };

  return (
    <div className={cn("flex min-w-0 flex-1 items-center gap-1", className)}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        maxLength={MAX_RECORDING_TITLE_LENGTH}
        aria-label={RECORDING_RENAME_FIELD_LABEL}
        aria-describedby={hintId}
        placeholder={RECORDING_RENAME_PLACEHOLDER}
        enterKeyHint="done"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            finish(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            finish(false);
          }
        }}
        onBlur={(e) => {
          // Moving to Save/Cancel is handled by their clicks.
          if (e.relatedTarget && e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) return;
          finish(true);
        }}
        className="min-h-11 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring fine:min-h-9"
      />
      <span id={hintId} className="sr-only">{RECORDING_RENAME_HINT}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={RECORDING_RENAME_SAVE}
        title={RECORDING_RENAME_SAVE}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => finish(true)}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <CheckIcon />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={RECORDING_RENAME_CANCEL}
        title={RECORDING_RENAME_CANCEL}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => finish(false)}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <XIcon />
      </Button>
    </div>
  );
};
