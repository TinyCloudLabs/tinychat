// A click-or-drop file target, shared by Import (Claude exports) and Upload audio.

import { useState, type FC, type MutableRefObject } from "react";
import { Loader2Icon, UploadIcon } from "lucide-react";

export interface FilePickerProps {
  /** `accept` for the hidden input, e.g. ".json,.jsonl,.zip". */
  accept: string;
  /** The call to action, e.g. "Click or drop a Claude export". */
  label: string;
  /** The accepted formats, in words. */
  hint: string;
  onFile: (file: File) => void;
  /** Lets the owner reopen the system picker or clear the input. */
  fileInputRef?: MutableRefObject<HTMLInputElement | null>;
  /** Shows `busyLabel` with a spinner and ignores input. */
  busy?: boolean;
  busyLabel?: string;
  disabled?: boolean;
  error?: string | null;
}

export const FilePicker: FC<FilePickerProps> = ({
  accept,
  label,
  hint,
  onFile,
  fileInputRef,
  busy = false,
  busyLabel = "Reading file…",
  disabled = false,
  error = null,
}) => {
  const [dragging, setDragging] = useState(false);
  const inert = busy || disabled;
  return (
    <div className="flex flex-col gap-3">
      <label
        onDragOver={(e) => {
          e.preventDefault();
          if (!inert) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file && !inert) onFile(file);
        }}
        className={
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-border bg-muted/30 px-4 py-8 text-sm text-muted-foreground transition-colors hover:bg-muted/50" +
          (inert ? " pointer-events-none opacity-60" : "") +
          (dragging ? " border-primary bg-accent" : "")
        }
      >
        {busy ? (
          <>
            <Loader2Icon className="size-5 animate-spin" />
            {busyLabel}
          </>
        ) : (
          <>
            <UploadIcon className="size-5" />
            <span>{label}</span>
            <span className="text-xs">{hint}</span>
          </>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept={accept}
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Cleared so picking the same file again still fires a change.
            e.target.value = "";
            if (file) onFile(file);
          }}
          disabled={inert}
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
};
