// The text field every composer in the feed uses (Sam, 23:35Z): one bordered field in the iMessage style, with its
// controls inside the border, not in a row below. The text grows with what you write (`field-sizing: content`, as the
// bots' chat does) up to about eight lines, then scrolls. Cancel, when there is one, is a quiet X at the bottom left;
// Send sits at the bottom right. The whole field shows the focus ring, whichever part of it has focus.
import type { ReactNode, Ref } from "react";
import { XIcon } from "lucide-react";

export function ComposerField({ value, onValue, label, placeholder, id, name, disabled = false, autoFocus = false, inputRef, onCancel, send }: {
  value: string;
  onValue: (value: string) => void;
  /** The field's accessible name. */
  label: string;
  placeholder?: string;
  id?: string;
  name?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  inputRef?: Ref<HTMLTextAreaElement>;
  /** Shows Cancel inside the field. */
  onCancel?: () => void;
  /** The send control, a compact StatefulSendButton; nothing while Send steps aside. */
  send?: ReactNode;
}) {
  // Each control is a 44px target on touch (36px plus a 4px margin with a mouse), so a one-line field is 44px tall
  // either way and its controls stay level with the last line as it grows.
  return <div className="flex items-end rounded-[22px] border border-border bg-background focus-within:ring-2 focus-within:ring-ring">
    {onCancel && <button type="button" aria-label="Cancel" onClick={onCancel} className="group flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground focus-visible:outline-none fine:m-1 fine:size-9 fine:hover:text-foreground">
      <span className="flex size-7 items-center justify-center rounded-full group-focus-visible:ring-2 group-focus-visible:ring-ring"><XIcon aria-hidden className="size-4" /></span>
    </button>}
    <textarea ref={inputRef} id={id} name={name} rows={1} autoFocus={autoFocus} aria-label={label} placeholder={placeholder} value={value} disabled={disabled} onInput={(event) => onValue(event.currentTarget.value)}
      className={`block max-h-[13.25rem] min-h-11 min-w-0 flex-1 resize-none bg-transparent py-2.5 text-base leading-6 [field-sizing:content] placeholder:text-muted-foreground focus:outline-none disabled:opacity-60 ${onCancel ? "" : "pl-4"} ${send ? "" : "pr-4"}`} />
    {send && <div className="shrink-0 fine:m-1">{send}</div>}
  </div>;
}
