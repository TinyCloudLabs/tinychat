// Main's chat, over Home: a full-height sheet on a phone, a dialog on a wider screen. Main's reply is
// shown as plain text, never as HTML.
import { useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { ResponsiveSheet, ResponsiveSheetBody } from "@/components/ui/responsive-sheet";
import { MAX_MESSAGE_LENGTH, SendButton, sendOnEnter, useDraft } from "./AskBox";
import { BotAvatar, MAIN_BOT } from "./BotAvatar";
import { BOTS_STRINGS } from "./botsStrings";
import { isWorking, type ChatLine, type MainChatState } from "./useMainChat";

function Line({ role, text }: Pick<ChatLine, "role" | "text">) {
  return role === "user" ? (
    <p className="max-w-[80%] self-end whitespace-pre-wrap break-words rounded-3xl bg-muted px-4 py-2.5 text-body">{text}</p>
  ) : (
    <p className="max-w-[36rem] whitespace-pre-wrap break-words text-body">{text}</p>
  );
}

function Failure({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 text-callout text-muted-foreground">
      <p>{text}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        {BOTS_STRINGS.tryAgain}
      </Button>
    </div>
  );
}

function Composer({ working, onSend }: { working: boolean; onSend: (text: string) => void }) {
  const { draft, setDraft, ready, send, submit } = useDraft(onSend, working);
  return (
    <form
      onSubmit={submit}
      className="mx-auto flex w-full max-w-2xl items-end gap-2 rounded-3xl border border-border bg-card py-1.5 pl-5 pr-1.5 focus-within:ring-2 focus-within:ring-ring"
    >
      <label className="min-w-0 flex-1 self-center">
        <span className="sr-only">{BOTS_STRINGS.messageMain}</span>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => sendOnEnter(event, send)}
          placeholder={BOTS_STRINGS.messageMain}
          maxLength={MAX_MESSAGE_LENGTH}
          rows={1}
          className="block max-h-40 min-h-11 w-full resize-none bg-transparent py-2.5 text-body text-foreground [field-sizing:content] placeholder:text-muted-foreground focus:outline-none"
        />
      </label>
      <SendButton label={BOTS_STRINGS.sendToMain} disabled={!ready} />
    </form>
  );
}

export interface MainChatProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: MainChatState;
  onSend: (text: string) => void;
  onRetry: () => void;
  onRetryHistory: () => void;
}

export function MainChat({ open, onOpenChange, state, onSend, onRetry, onRetryHistory }: MainChatProps) {
  const { lines, history, turn } = state;
  const working = isWorking(turn);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [open, lines.length, turn?.text, turn?.reply, turn?.state]);

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      height="full"
      contentProps={{ "data-bots-main-chat": "" }}
      title={
        <span className="flex items-center gap-3">
          <BotAvatar bot={MAIN_BOT} working={working} size={32} decorative />
          {MAIN_BOT.name}
        </span>
      }
      footer={<Composer working={working} onSend={onSend} />}
    >
      <ResponsiveSheetBody>
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 py-4">
          {history === "failed" && !working ? <Failure text={BOTS_STRINGS.historyFailed} onRetry={onRetryHistory} /> : null}
          {lines.map((line) => (
            <Line key={line.id} role={line.role} text={line.text} />
          ))}
          {turn ? (
            <>
              <Line role="user" text={turn.text} />
              {turn.reply ? <Line role="bot" text={turn.reply} /> : null}
              {working && !turn.reply ? <BotAvatar bot={MAIN_BOT} working size={28} /> : null}
              {turn.state === "error" ? <Failure text={BOTS_STRINGS.errors[turn.error ?? "failed"]} onRetry={onRetry} /> : null}
            </>
          ) : null}
          <div ref={end} data-bots-chat-end="" />
        </div>
      </ResponsiveSheetBody>
    </ResponsiveSheet>
  );
}
