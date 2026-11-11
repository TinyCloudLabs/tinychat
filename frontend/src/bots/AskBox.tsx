// Home's "What do you want done?" box (layout C on the mockups branch). In slice 1 only Main exists,
// so the box shows Main's chip (which opens Main's chat) and no other bots or suggestions.
import { useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUpIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { BotAvatar, MAIN_BOT } from "./BotAvatar";
import { BOTS_STRINGS } from "./botsStrings";

/** The service takes messages of 1 to 8,000 characters. */
export const MAX_MESSAGE_LENGTH = 8000;

export function SendButton({ label, disabled }: { label: string; disabled: boolean }) {
  return (
    <button
      type="submit"
      aria-label={label}
      disabled={disabled}
      className={cn(
        "tap-transparent flex size-[var(--tc-control-height)] shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        disabled ? "bg-surface-2 text-muted-foreground" : "bg-primary text-primary-foreground",
      )}
    >
      <ArrowUpIcon aria-hidden className="size-5" />
    </button>
  );
}

/** Enter sends; Shift+Enter (or an IME composing) adds a line. */
export function sendOnEnter(event: KeyboardEvent<HTMLTextAreaElement>, send: () => void) {
  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
  event.preventDefault();
  send();
}

/** A draft and its send: trimmed, never empty, and not while `blocked`. */
export function useDraft(onSend: (text: string) => void, blocked: boolean) {
  const [draft, setDraft] = useState("");
  const ready = !blocked && draft.trim().length > 0;
  const send = () => {
    if (!ready) return;
    onSend(draft.trim());
    setDraft("");
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    send();
  };
  return { draft, setDraft, ready, send, submit };
}

interface AskBoxProps {
  /** Main is answering: the chip's ring turns and sending waits. */
  working: boolean;
  onSend: (text: string) => void;
  onOpenMain: () => void;
}

export function AskBox({ working, onSend, onOpenMain }: AskBoxProps) {
  const { draft, setDraft, ready, send, submit } = useDraft(onSend, working);
  return (
    <form
      onSubmit={submit}
      data-bots-ask=""
      className="mb-6 rounded-3xl border border-border bg-card p-3 pl-5 focus-within:ring-2 focus-within:ring-ring"
    >
      <label className="block">
        <span className="sr-only">{BOTS_STRINGS.ask}</span>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => sendOnEnter(event, send)}
          placeholder={BOTS_STRINGS.ask}
          maxLength={MAX_MESSAGE_LENGTH}
          rows={2}
          className="block min-h-[4.5rem] w-full resize-none bg-transparent pt-2 text-headline font-normal text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
      </label>
      <div className="-ml-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onOpenMain}
          aria-label={BOTS_STRINGS.openMain}
          className="tap-transparent flex h-[var(--tc-control-height)] shrink-0 items-center gap-1.5 rounded-full bg-surface-2 pl-1.5 pr-3 text-meta font-medium text-foreground ring-1 ring-inset ring-border transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <BotAvatar bot={MAIN_BOT} working={working} size={26} decorative />
          <span>{BOTS_STRINGS.mainHandle}</span>
        </button>
        <span className="ml-auto" />
        <SendButton label={BOTS_STRINGS.send} disabled={!ready} />
      </div>
    </form>
  );
}
