// Main's chat, over Home: a full-height sheet on a phone, a dialog on a wider screen. Main's reply is
// shown as plain text, never as HTML.
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ResponsiveSheet, ResponsiveSheetBody } from "@/components/ui/responsive-sheet";
import { MAX_MESSAGE_LENGTH, SendButton, sendOnEnter, useDraft } from "./AskBox";
import { BotAvatar, MAIN_BOT } from "./BotAvatar";
import { acknowledgeHistoryNotice, historyNoticeDeadline, type HistoryNotice } from "./historyNotice";
import { BOTS_STRINGS, HISTORY_EXPIRY_NOTICE, HISTORY_RECONNECT_LABEL } from "./botsStrings";
import { isWorking, type ChatLine, type MainChatState } from "./useMainChat";

function Line({ role, text }: Pick<ChatLine, "role" | "text">) {
  return role === "user" ? (
    <p className="max-w-[80%] self-end whitespace-pre-wrap break-words rounded-3xl bg-muted px-4 py-2.5 text-body">{text}</p>
  ) : (
    <p className="max-w-[36rem] whitespace-pre-wrap break-words text-body">{text}</p>
  );
}

function ExpiryNotice({ notice, onReconnect }: { notice: HistoryNotice; onReconnect: () => void }) {
  const [renderedAt] = useState(Date.now);
  const deleteAt = historyNoticeDeadline(notice, renderedAt);
  const text = HISTORY_EXPIRY_NOTICE.replace("{expiryDate}", new Date(notice.expiresAt).toLocaleDateString(undefined, { dateStyle: "medium" }))
    .replace("{deletionDate}", new Date(deleteAt).toLocaleDateString(undefined, { dateStyle: "medium" }));
  useEffect(() => {
    if (notice.deliveredAt === undefined) void acknowledgeHistoryNotice(notice, renderedAt, deleteAt).catch(() => {});
  }, [notice, renderedAt, deleteAt]);
  return <div className="flex flex-col items-start gap-3" data-history-expiry-notice="">
    <Line role="bot" text={text} />
    <Button type="button" variant="outline" onClick={onReconnect}>{HISTORY_RECONNECT_LABEL}</Button>
  </div>;
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
  notice?: HistoryNotice | null;
  onReconnect?: () => void;
}

export function MainChat({ open, onOpenChange, state, onSend, onRetry, onRetryHistory, notice, onReconnect }: MainChatProps) {
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
          <p className="text-center text-callout text-muted-foreground">{BOTS_STRINGS.modelLine}</p>
          {open && notice && onReconnect ? <ExpiryNotice key={`${notice.id}:${notice.deliveredAt ?? notice.renderAttemptAt ?? "initial"}`} notice={notice} onReconnect={onReconnect} /> : null}
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
