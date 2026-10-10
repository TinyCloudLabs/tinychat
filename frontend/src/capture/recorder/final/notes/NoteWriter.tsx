import "./notes.css";
import {
  useEffect,
  useImperativeHandle,
  useRef,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { NOTES_COPY } from "../notesCopy";
import { BulletsIcon, ChecklistIcon, QuoteIcon } from "../notesIcons";
import {
  keyEdit,
  toolEdit,
  type FormatTool,
  type TextEdit,
} from "./writerEdits";

export interface NoteWriterProps {
  /** The text when the writer mounts; the textarea owns it from then on. */
  initialValue: string;
  onChange: (md: string) => void;
  textareaRef?: Ref<HTMLTextAreaElement>;
  /** Focus the field, caret at the end, when it mounts. */
  autoFocus?: boolean;
  /** Nothing can be typed or formatted (the note is not ready); `aria-disabled` keeps the field focusable. */
  disabled?: boolean;
  label?: string;
  placeholder?: string;
  /** Where the formatting bar renders, outside the writer: an element to portal into, or null while that element is not mounted yet (no bar until it is). Omitted: the bar sits under the field. */
  toolbarHost?: HTMLElement | null;
}

const TOOLS: { tool: FormatTool; glyph: ReactNode }[] = [
  { tool: "heading", glyph: <b className="nt-wt-h">H</b> },
  { tool: "bold", glyph: <b className="nt-wt-b">B</b> },
  { tool: "italic", glyph: <i className="nt-wt-i">I</i> },
  { tool: "bullets", glyph: <BulletsIcon /> },
  { tool: "checklist", glyph: <ChecklistIcon /> },
  { tool: "quote", glyph: <QuoteIcon /> },
];

/** A Markdown textarea with a formatting bar. Props in, no platform code: the host decides where it sits. */
export function NoteWriter({
  initialValue,
  onChange,
  textareaRef,
  autoFocus = false,
  disabled = false,
  label = NOTES_COPY.noteField,
  placeholder = NOTES_COPY.notePlaceholder,
  toolbarHost,
}: NoteWriterProps) {
  const field = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(textareaRef, () => field.current!, []);
  useEffect(() => {
    if (!autoFocus) return;
    const target = field.current!;
    target.focus({ preventScroll: true });
    target.setSelectionRange(target.value.length, target.value.length);
  }, [autoFocus]);
  const apply = (target: HTMLTextAreaElement, edit: TextEdit) => {
    target.setRangeText(edit.text, edit.from, edit.to, "end");
    target.setSelectionRange(edit.select[0], edit.select[1]);
    onChange(target.value);
  };
  const toolbar = (
    <div
      className="nt-wtools"
      role="toolbar"
      aria-label={NOTES_COPY.formatting}
      // A tap on the bar must not take focus (or the keyboard) from the field.
      onPointerDown={(event) => event.preventDefault()}
    >
      {TOOLS.map(({ tool, glyph }) => (
        <button
          key={tool}
          type="button"
          aria-label={NOTES_COPY.tools[tool]}
          title={NOTES_COPY.tools[tool]}
          aria-disabled={disabled || undefined}
          onClick={() => {
            if (disabled) return;
            const target = field.current!;
            target.focus();
            apply(
              target,
              toolEdit(
                tool,
                target.value,
                target.selectionStart,
                target.selectionEnd,
              ),
            );
          }}
        >
          {glyph}
        </button>
      ))}
      <span className="nt-wmd" aria-hidden="true">
        {NOTES_COPY.markdownHint}
      </span>
    </div>
  );
  return (
    <div className="nt-writer">
      <textarea
        ref={field}
        className="nt-wta"
        aria-label={label}
        placeholder={placeholder}
        spellCheck
        readOnly={disabled}
        aria-disabled={disabled || undefined}
        defaultValue={initialValue}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (disabled) return;
          const target = event.currentTarget;
          const edit = keyEdit(
            event.nativeEvent,
            target.value,
            target.selectionStart,
            target.selectionEnd,
          );
          if (!edit) return;
          event.preventDefault();
          apply(target, edit);
        }}
      />
      {toolbarHost === undefined
        ? toolbar
        : toolbarHost && createPortal(toolbar, toolbarHost)}
    </div>
  );
}
