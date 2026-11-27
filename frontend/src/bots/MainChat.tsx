// Main's chat, over Home: a full-height sheet on a phone, a dialog on a wider screen. Main's reply is
// shown as plain text, never as HTML.
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ArrowLeftIcon, SlidersHorizontalIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ResponsiveSheet, ResponsiveSheetBody } from "@/components/ui/responsive-sheet";
import { MAX_MESSAGE_LENGTH, SendButton, sendOnEnter, useDraft } from "./AskBox";
import { focusSdkPrompt, useSdkPromptOpen } from "./useSdkPromptOpen";
import { BotAvatar, MAIN_BOT } from "./BotAvatar";
import { BotWorkingMark, BotWorkingStatus, type WorkingBot } from "./BotWorking";
import { acknowledgeHistoryNotice, historyNoticeDeadline, type HistoryNotice } from "./historyNotice";
import { BOTS_STRINGS, botsErrorText, HISTORY_EXPIRY_NOTICE, HISTORY_RECONNECT_LABEL, WEB_ACCESS_STRINGS } from "./botsStrings";
import { isWorking, type ChatLine, type MainChatState } from "./useMainChat";
import { workingStepText } from "./workingStep";
import { WebAccess, type WebAccessApi } from "./WebAccess";
import { FeedChatsAccess, MeetingsAccess, TelegramAccess, type MeetingsAccessApi } from "./MeetingsAccess";
import { NewChat, type NewChatApi } from "./NewChat";
import { AppLine, AskCards, AsksToggle } from "./AskCards";
import { clearHistoryDecline } from "./historyAuthorization";
import { LazyEarlierHistoryAction } from "./LazyEarlierHistoryAction";
import type { EarlierHistoryMove } from "./earlierHistory";
import { SecretCards } from "./SecretCard";
import type { Asks } from "./useAsks";
import type { ReadSettings } from "./trustbotReadGrant";
import type { ReadArea } from "./trustbotReadAreas";
import { CourierSetup } from "./courier/CourierSetup";

export function Line({ role, text }: Pick<ChatLine, "role" | "text">) {
  return role === "user" ? (
    <p className="max-w-[80%] self-end whitespace-pre-wrap break-words rounded-3xl bg-muted px-4 py-2.5 text-body">{text}</p>
  ) : (
    <p className="max-w-[36rem] whitespace-pre-wrap break-words text-body">{text}</p>
  );
}

function ExpiryNotice({ notice, onReconnect }: { notice: HistoryNotice; onReconnect: () => void }) {
  const [renderedAt] = useState(Date.now);
  const [acknowledged, setAcknowledged] = useState<HistoryNotice | null>(null);
  const deleteAt = historyNoticeDeadline(acknowledged ?? notice, renderedAt);
  const text = HISTORY_EXPIRY_NOTICE.replace("{expiryDate}", new Date(notice.expiresAt).toLocaleDateString(undefined, { dateStyle: "medium" }))
    .replace("{deletionDate}", new Date(deleteAt).toLocaleDateString(undefined, { dateStyle: "medium" }));
  useEffect(() => {
    if (notice.deliveredAt === undefined) void acknowledgeHistoryNotice(notice, renderedAt).then(setAcknowledged).catch(() => {});
  }, [notice, renderedAt]);
  return <div className="flex flex-col items-start gap-3" data-history-expiry-notice="">
    <Line role="bot" text={text} />
    <Button type="button" variant="outline" onClick={onReconnect}>{HISTORY_RECONNECT_LABEL}</Button>
  </div>;
}

function Failure({ text, onRetry, declined = false }: { text: string; onRetry: () => void; declined?: boolean }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 text-callout text-muted-foreground">
      <p>{text}</p>
      <Button type="button" variant="outline" size="sm" onClick={declined ? () => { clearHistoryDecline(); onRetry(); } : onRetry}>
        {declined ? BOTS_STRINGS.reviewRequest : BOTS_STRINGS.tryAgain}
      </Button>
    </div>
  );
}

function Composer({ composer, inputRef }: { composer: ReturnType<typeof useDraft>; inputRef: RefObject<HTMLTextAreaElement | null> }) {
  const { draft, setDraft, ready, send, submit } = composer;
  return (
    <form
      onSubmit={submit}
      className="mx-auto flex w-full max-w-2xl items-end gap-2 rounded-3xl border border-border bg-card py-1.5 pl-5 pr-1.5 focus-within:ring-2 focus-within:ring-ring"
    >
      <label className="min-w-0 flex-1 self-center">
        <span className="sr-only">{BOTS_STRINGS.messageMain}</span>
        <textarea
          ref={inputRef}
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
  onShowHistory?: () => void;
  notice?: HistoryNotice | null;
  onReconnect?: () => void;
  /** When given, the sheet offers Main's web access setting. */
  webAccess?: WebAccessApi;
  /** When given, the sheet offers Main's read settings: Meetings, and Feed and chats. */
  meetings?: MeetingsAccessApi;
  /** When true, the sheet offers Courier setup for the signed-in owner; it stays hidden while Courier is off. */
  courier?: boolean;
  /** When given, the sheet shows Main's questions as cards and offers the setting for them. */
  asks?: Asks;
  /** When given, the sheet offers the owner's "Start a new chat". */
  newChat?: NewChatApi;
  /** When given, earlier history is held back and the sheet offers to move it (TC-4225). */
  earlierHistory?: EarlierHistoryMove;
  /** The main bot's icon as its owner picked it. Absent: the first icon. */
  face?: WorkingBot;
  /** "Not now" on an access card under a reply. */
  onNotNow?: (lineId: string, area: ReadArea) => void;
  /** Access given from a card under a reply: its question may go again. */
  onAskAgain?: (lineId: string) => void;
}

const ACCESS = { meetings: MeetingsAccess, feed_chats: FeedChatsAccess, telegram: TelegramAccess } as const;

/** Services that answered 404 for web access, so reopening Main's chat does not show the button again. */
const WITHOUT_WEB_ACCESS = new WeakSet<WebAccessApi>();

/**
 * Main's web access setting, behind one button so the chat stays the first thing in the sheet. When the service has
 * no web access route yet (404), opening it removes the button too, for as long as this page lives.
 */
export function WebAccessToggle({ api }: { api: WebAccessApi }) {
  const [shown, setShown] = useState(false);
  const [missing, setMissing] = useState(() => WITHOUT_WEB_ACCESS.has(api));
  const onMissing = useCallback(() => { WITHOUT_WEB_ACCESS.add(api); setMissing(true); }, [api]);
  if (missing) return null;
  return (
    <div className="flex flex-col items-start gap-3">
      <Button type="button" variant="outline" size="sm" aria-expanded={shown} onClick={() => setShown((value) => !value)}>
        {WEB_ACCESS_STRINGS.title}
      </Button>
      {shown ? <WebAccess api={api} onMissing={onMissing} /> : null}
    </div>
  );
}

const StandingReadsCard = lazy(() => import("./StandingReadsCard"));

export function MainChat({ open, onOpenChange, state, onSend, onRetry, onRetryHistory, onShowHistory, notice, onReconnect, webAccess, meetings, courier, asks, newChat, earlierHistory, face = MAIN_BOT, onNotNow, onAskAgain }: MainChatProps) {
  const [readSettings, setReadSettings] = useState<ReadSettings | null>(null);
  // A read area changed in a card remounts the settings view's sections, and one changed there remounts the cards, so
  // each reads the stored settings again once and neither shows a state the other replaced.
  const [revision, setRevision] = useState({ settings: 0, cards: 0 });
  const changedInSettings = useCallback((stored: ReadSettings) => {
    setReadSettings(stored);
    setRevision((current) => ({ ...current, cards: current.cards + 1 }));
  }, []);
  // The settings stay mounted while the conversation shows (and the conversation while they show), so what each loads
  // and holds is the same as when both were one list; the header button only switches which one is visible.
  const [settings, setSettings] = useState(false);
  useEffect(() => { if (!open) setSettings(false); }, [open]);
  const { lines, history, turn } = state;
  const working = isWorking(turn);
  // The newest reply's cards: one for each area its turn tried that is off or ended, until the owner writes again.
  const last = lines.at(-1);
  const cards = open && meetings && readSettings && !turn && last?.role === "bot"
    ? (last.areas ?? []).filter((area) => readSettings.areas[area] === "off" || readSettings.areas[area] === "ended") : [];
  // A question, a proposal or a secret request the owner has not decided: the bot waits on them.
  const awaitingOwner = !!asks && (asks.pending.some((request) => request.state === "pending") || asks.secrets.some((secret) => secret.state === "pending"));
  const sdkPromptOpen = useSdkPromptOpen();
  // Modal content remounts when yielding to the SDK; keep the draft above that boundary.
  const composer = useDraft(onSend, working);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const promptHadFocus = useRef(false);
  const setDraft = composer.setDraft;
  useEffect(() => { if (!open) setDraft(""); }, [open, setDraft]);
  const end = useRef<HTMLDivElement>(null);
  const settingsTop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!settings) end.current?.scrollIntoView({ block: "end" });
  }, [settings, open, lines.length, turn?.text, turn?.reply, turn?.state, asks?.pending.length, asks?.secrets.length]);
  useEffect(() => {
    if (settings) settingsTop.current?.scrollIntoView({ block: "start" });
  }, [settings]);

  return (
    <ResponsiveSheet
      open={open}
      modal={!sdkPromptOpen}
      dismissible={!sdkPromptOpen}
      onOpenAutoFocus={(event) => {
        if (sdkPromptOpen) {
          event.preventDefault();
          promptHadFocus.current = true;
          focusSdkPrompt();
        } else if (promptHadFocus.current) {
          event.preventDefault();
          promptHadFocus.current = false;
          composerInput.current?.focus({ preventScroll: true });
        }
      }}
      onOpenChange={onOpenChange}
      height="full"
      contentProps={{ "data-bots-main-chat": "" }}
      title={
        <span className="flex items-center gap-3">
          {working ? <BotWorkingMark bot={face} size={32} /> : <BotAvatar bot={face} size={32} decorative />}
          {MAIN_BOT.name}
        </span>
      }
      headerActions={
        <button
          type="button"
          aria-label={settings ? BOTS_STRINGS.backToChat : BOTS_STRINGS.mainSettings}
          onClick={() => setSettings((value) => !value)}
          className="tap-transparent flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-surface-2 fine:size-9"
        >
          {settings ? <ArrowLeftIcon className="size-5" /> : <SlidersHorizontalIcon className="size-5" />}
        </button>
      }
      footer={settings ? undefined : <Composer composer={composer} inputRef={composerInput} />}
    >
      <ResponsiveSheetBody>
        <div ref={settingsTop} className={cn("mx-auto w-full max-w-2xl flex-col gap-5 py-4", settings ? "flex" : "hidden")} data-bots-main-settings="">
          <p className="text-center text-callout text-muted-foreground">{BOTS_STRINGS.modelLine}</p>
          {open && webAccess ? <WebAccessToggle api={webAccess} /> : null}
          {open && meetings ? <MeetingsAccess key={`meetings-${revision.settings}`} api={meetings} onSettings={setReadSettings} onChanged={changedInSettings} /> : null}
          {open && meetings ? <FeedChatsAccess key={`feed-${revision.settings}`} api={meetings} onSettings={setReadSettings} onChanged={changedInSettings} /> : null}
          {open && meetings ? <TelegramAccess key={`telegram-${revision.settings}`} api={meetings} onChanged={changedInSettings} /> : null}
          {open && readSettings?.standingAvailable && meetings?.stopStandingArea ? <Suspense fallback={null}><StandingReadsCard settings={readSettings} revoke={meetings.revokeReadGrant} /></Suspense> : null}
          {open && courier ? <CourierSetup /> : null}
          {open && asks ? <AsksToggle asks={asks} /> : null}
          {open && newChat ? <NewChat api={newChat} /> : null}
        </div>
        <div className={cn("mx-auto w-full max-w-2xl flex-col gap-5 py-4", settings ? "hidden" : "flex")}>
          {open && notice && onReconnect ? <ExpiryNotice key={`${notice.id}:${notice.deliveredAt ?? notice.renderAttemptAt ?? "initial"}`} notice={notice} onReconnect={onReconnect} /> : null}
          {onShowHistory && (history === "idle" || history === "declined") ? <div className="flex flex-col items-start gap-3 text-callout text-muted-foreground">
            {history === "declined" ? <p>Older messages stay hidden until you approve access.</p> : null}
            <Button type="button" variant="outline" size="sm" onClick={onShowHistory}>Show older messages</Button>
          </div> : null}
          {history === "loading" ? <p role="status" className="text-callout text-muted-foreground">{BOTS_STRINGS.historyLoading}</p> : null}
          {history === "failed" && !working ? <Failure text={BOTS_STRINGS.historyFailed} onRetry={onShowHistory ?? onRetryHistory} /> : null}
          {history === "declined" && !onShowHistory && !working ? <Failure text={botsErrorText("history_declined", MAIN_BOT.name)} onRetry={onRetryHistory} declined /> : null}
          {open && earlierHistory ? <LazyEarlierHistoryAction move={earlierHistory} /> : null}
          {lines.map((line) => (
            line.unreadableHistory ? <p key={line.id} className="text-callout text-muted-foreground">{line.text}</p>
              : line.app ? <AppLine key={line.id} decision={line.app} names={line.names} live={line.id.startsWith("local-")} secret={line.secret} /> : <Line key={line.id} role={line.role} text={line.text} />
          ))}
          {last && meetings ? cards.map((area) => {
            const Access = ACCESS[area];
            return (
              <div key={`${last.id}:${area}:${revision.cards}`} className="flex flex-col rounded-2xl border border-border bg-card p-4 empty:hidden" data-bots-access-card={area}>
                <Access api={meetings} chatList={false} onNotNow={onNotNow ? () => onNotNow(last.id, area) : undefined} onChanged={(stored) => {
                  setReadSettings(stored);
                  setRevision((current) => ({ ...current, settings: current.settings + 1 }));
                  if (stored.areas[area] === "on") onAskAgain?.(last.id);
                }} />
              </div>
            );
          }) : null}
          {turn ? (
            <>
              {turn.appReply ? <AppLine decision={turn.appReply.decision} names={turn.appReply.names} live secret={turn.appReply.secret} /> : <Line role="user" text={turn.text} />}
              {turn.reply ? <Line role="bot" text={turn.reply} /> : null}
              {working ? <BotWorkingStatus bot={face} step={workingStepText(turn.step, awaitingOwner)} /> : null}
              {turn.state === "error" ? <Failure text={botsErrorText(turn.error ?? "failed", MAIN_BOT.name)} onRetry={onRetry} declined={turn.error === "history_declined"} /> : null}
            </>
          ) : null}
          {open && asks ? <AskCards asks={asks} outcomes /> : null}
          {open && asks ? <SecretCards asks={asks} chat onMessage={() => composerInput.current?.focus()} /> : null}
          <div ref={end} data-bots-chat-end="" />
        </div>
      </ResponsiveSheetBody>
    </ResponsiveSheet>
  );
}
