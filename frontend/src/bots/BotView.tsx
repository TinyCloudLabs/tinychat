// The bot view (TC-3325): one bot's conversation, filling the Chat slot. A pill with the bot's avatar and name at the
// top, the messages (yours on the right, the bot's on the left, as Markdown that never becomes HTML), and Main's
// composer at the foot (8,000 characters, Enter sends, the draft kept per bot). Kept from Main's chat: the line for
// private bots, the history expiry notice with Reconnect, and the retry rows.
import { Fragment, lazy, Suspense, useCallback, useEffect, useId, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from "react";
import { SlidersHorizontalIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { useSizeClass } from "@/lib/sizeClass";
import { BriefMarkdown } from "@/feed/BriefMarkdown";
import { useOriginMoveDeferral } from "@/shell/OriginMoveNotice";
import { AppLine, AskCards, AsksToggle } from "./AskCards";
import { MAX_MESSAGE_LENGTH, SendButton, sendOnEnter } from "./AskBox";
import { BotAvatar } from "./BotAvatar";
import { BotWorkingMark, BotWorkingStatus } from "./BotWorking";
import { BOT_VIEW_STRINGS, BOTS_STRINGS, HISTORY_RECONNECT_LABEL } from "./botsStrings";
import { CourierSetup } from "./courier/CourierSetup";
import { clearHistoryDecline } from "./historyAuthorization";
import { LazyEarlierHistoryAction } from "./LazyEarlierHistoryAction";
import type { EarlierHistoryMove } from "./earlierHistory";
import { historyNoticeDeadline, type HistoryNotice } from "./historyNotice";
import { WebAccessToggle } from "./MainChat";
import { FeedChatsAccess, MeetingsAccess, TelegramAccess, type MeetingsAccessApi } from "./MeetingsAccess";
import { NewChat, type NewChatApi } from "./NewChat";
import { activityText, BotPanel } from "./BotPanel";
import { DeleteBotConfirm, EditBotDialog, type BotManagement } from "./BotManage";
import { SecretCards } from "./SecretCard";
import type { ReadArea } from "./trustbotReadAreas";
import type { ReadSettings } from "./trustbotReadGrant";
import type { Asks } from "./useAsks";
import { useBotActivity, useBotChat, type ActivityItem, type BotChats } from "./useBotChat";
import { isWorking, type ChatLine } from "./useMainChat";
import type { WebAccessApi } from "./WebAccess";
import { workingStepText } from "./workingStep";

const StandingReadsCard = lazy(() => import("./StandingReadsCard"));
const ACCESS = { meetings: MeetingsAccess, feed_chats: FeedChatsAccess, telegram: TelegramAccess } as const;

export interface MainBotControls {
  /** Whether the Chat slot is on screen (avoids duplicate AskCards while Feed is visible). */
  active: boolean;
  asks?: Asks;
  meetings?: MeetingsAccessApi;
  webAccess?: WebAccessApi;
  courier?: boolean;
  newChat?: NewChatApi;
  onNotNow?: (lineId: string, area: ReadArea) => void;
  onAskAgain?: (lineId: string) => void;
}

/** The bot on screen, as the view needs it. */
export interface ViewBot {
  key: string;
  name: string;
  /** Runs where Main runs today: the view says so under the pill. */
  private: boolean;
  face: ComponentProps<typeof BotAvatar>["bot"];
}

/** What the bot did on its computer: a small centred line between the messages. */
function ActivityLine({ item }: { item: ActivityItem }) {
  return <p data-bot-activity={item.id} className="text-center text-meta text-muted-foreground">{activityText(item)}</p>;
}

function Line({ role, text }: Pick<ChatLine, "role" | "text">) {
  return role === "user" ? (
    <p className="max-w-[80%] self-end whitespace-pre-wrap break-words rounded-3xl bg-muted px-4 py-2.5 text-body">{text}</p>
  ) : (
    <div className="max-w-[40rem]" data-bot-reply=""><BriefMarkdown markdown={text} /></div>
  );
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

function ExpiryNotice({ bot, notice, acknowledge, onReconnect }: {
  bot: ViewBot;
  notice: HistoryNotice;
  acknowledge: (notice: HistoryNotice, renderedAt: number) => Promise<HistoryNotice>;
  onReconnect: () => void;
}) {
  const [renderedAt] = useState(Date.now);
  const [acknowledged, setAcknowledged] = useState<HistoryNotice | null>(null);
  const deleteAt = historyNoticeDeadline(acknowledged ?? notice, renderedAt);
  const template = BOT_VIEW_STRINGS.historyExpiryNotice(bot.name);
  const text = template.replace("{expiryDate}", new Date(notice.expiresAt).toLocaleDateString(undefined, { dateStyle: "medium" }))
    .replace("{deletionDate}", new Date(deleteAt).toLocaleDateString(undefined, { dateStyle: "medium" }));
  useEffect(() => {
    if (notice.deliveredAt === undefined) void acknowledge(notice, renderedAt).then(setAcknowledged).catch(() => {});
  }, [acknowledge, notice, renderedAt]);
  return (
    <div className="flex flex-col items-start gap-3" data-history-expiry-notice="">
      <p className="max-w-[40rem] whitespace-pre-wrap break-words text-body">{text}</p>
      <Button type="button" variant="outline" onClick={onReconnect}>{HISTORY_RECONNECT_LABEL}</Button>
    </div>
  );
}

/** Main's composer, with the draft held by the conversations so it outlasts a switch to another bot. */
function Composer({ bot, chats, blocked, onSend, inputRef }: { bot: ViewBot; chats: BotChats; blocked: boolean; onSend: (text: string) => void; inputRef?: RefObject<HTMLTextAreaElement | null> }) {
  const [draft, setDraftState] = useState(() => chats.draft(bot.key));
  const setDraft = (text: string) => {
    setDraftState(text);
    chats.setDraft(bot.key, text);
  };
  // Typed words live only in this page: a held tinycloud.chat page does not move under them (originMove.ts).
  useOriginMoveDeferral(draft.trim() !== "");
  const ready = !blocked && draft.trim().length > 0;
  const send = () => {
    if (!ready) return;
    onSend(draft.trim());
    setDraft("");
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
      className="mx-auto flex w-full max-w-2xl items-end gap-2 rounded-3xl border border-border bg-card py-1.5 pl-5 pr-1.5 focus-within:ring-2 focus-within:ring-ring"
    >
      <label className="min-w-0 flex-1 self-center">
        <span className="sr-only">{BOT_VIEW_STRINGS.messageBot(bot.name)}</span>
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => sendOnEnter(event, send)}
          placeholder={BOT_VIEW_STRINGS.messageBot(bot.name)}
          maxLength={MAX_MESSAGE_LENGTH}
          rows={1}
          className="block max-h-40 min-h-11 w-full resize-none bg-transparent py-2.5 text-body text-foreground [field-sizing:content] placeholder:text-muted-foreground focus:outline-none"
        />
      </label>
      <SendButton label={BOT_VIEW_STRINGS.sendToBot(bot.name)} disabled={!ready} />
    </form>
  );
}

export interface BotViewProps {
  bot: ViewBot;
  chats: BotChats;
  /** This bot's history expiry notice, when its permission to save history has expired. */
  notice?: HistoryNotice | null;
  acknowledgeNotice: (notice: HistoryNotice, renderedAt: number) => Promise<HistoryNotice>;
  onReconnect?: () => void;
  /** Above the conversation: the other bots, on a phone. */
  strip?: ReactNode;
  /** Edit and Delete bot in the panel. Absent: the panel offers neither (the roster is not loaded). */
  manage?: BotManagement;
  /** When given, earlier history is held back and the view offers to move it (TC-4225). */
  earlierHistory?: EarlierHistoryMove;
  /** Main (TrustBot) access, settings, questions/proposals and New chat controls. */
  main?: MainBotControls;
}

export function BotView({ bot, chats, notice, acknowledgeNotice, onReconnect, strip, manage, earlierHistory, main }: BotViewProps) {
  const { lines, history, turn } = useBotChat(chats, bot.key);
  const activity = useBotActivity(chats, bot.key);
  const working = isWorking(turn);
  const errors = BOT_VIEW_STRINGS.errors;
  const titleId = useId();
  const composerInput = useRef<HTMLTextAreaElement>(null);

  const [readSettings, setReadSettings] = useState<ReadSettings | null>(null);
  const [revision, setRevision] = useState({ settings: 0, cards: 0 });
  const changedInSettings = useCallback((stored: ReadSettings) => {
    setReadSettings(stored);
    setRevision((current) => ({ ...current, cards: current.cards + 1 }));
  }, []);

  const meetingsApi = main?.meetings;
  useEffect(() => {
    if (!meetingsApi) { setReadSettings(null); return; }
    let alive = true;
    void meetingsApi.readSettings().then((stored) => {
      if (alive) setReadSettings(stored);
    }, () => {});
    return () => { alive = false; };
  }, [meetingsApi]);

  const last = lines.at(-1);
  const cards = main?.active && meetingsApi && readSettings && !turn && last?.role === "bot"
    ? (last.areas ?? []).filter((area) => readSettings.areas[area] === "off" || readSettings.areas[area] === "ended")
    : [];
  const awaitingOwner = !!main?.asks && (
    main.asks.pending.some((request) => request.state === "pending")
    || main.asks.secrets.some((secret) => secret.state === "pending")
  );

  useEffect(() => {
    chats.view(bot.key);
    void chats.ensureHistory(bot.key);
    return () => chats.view(null);
  }, [chats, bot.key]);

  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [bot.key, lines.length, activity.length, turn?.text, turn?.reply, turn?.state, main?.asks?.pending.length, main?.asks?.secrets.length]);

  // From 1024 px the panel is a column beside the conversation; below that, a sheet.
  const column = useSizeClass().size === "expanded";
  const [panelOpen, setPanelOpen] = useState(false);
  const panelId = useId();

  // The panel's sheet closes before a dialog opens, so the two never stack.
  const [dialog, setDialog] = useState<"edit" | "delete" | null>(null);
  const ask = (next: "edit" | "delete") => {
    if (!column) setPanelOpen(false);
    setDialog(next);
  };
  const mainSettings = main && (main.webAccess || main.meetings || main.courier || main.asks || main.newChat) ? (
    <>
      {main.webAccess ? <WebAccessToggle api={main.webAccess} /> : null}
      {main.meetings ? <MeetingsAccess key={`meetings-${revision.settings}`} api={main.meetings} onSettings={setReadSettings} onChanged={changedInSettings} /> : null}
      {main.meetings ? <FeedChatsAccess key={`feed-${revision.settings}`} api={main.meetings} onSettings={setReadSettings} onChanged={changedInSettings} /> : null}
      {main.meetings ? <TelegramAccess key={`telegram-${revision.settings}`} api={main.meetings} onChanged={changedInSettings} /> : null}
      {readSettings?.standingAvailable && main.meetings?.stopStandingArea ? (
        <Suspense fallback={null}><StandingReadsCard settings={readSettings} revoke={main.meetings.revokeReadGrant} /></Suspense>
      ) : null}
      {main.courier ? <CourierSetup /> : null}
      {main.asks ? <AsksToggle asks={main.asks} /> : null}
      {main.newChat ? <NewChat api={main.newChat} /> : null}
    </>
  ) : null;
  const panel = panelOpen ? (
    <BotPanel
      bot={bot}
      activity={activity}
      awake={working}
      onClose={column ? () => setPanelOpen(false) : undefined}
      onEdit={manage ? () => ask("edit") : undefined}
      onDelete={manage?.remove ? () => ask("delete") : undefined}
      mainSettings={mainSettings}
    />
  ) : null;
  return (
    <>
      <div className="flex h-full min-h-0">
        <section data-bot-view={bot.key} aria-labelledby={titleId} className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
          {strip}
          <div className="relative min-h-0 flex-1">
            <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-1.5 px-4 pt-3">
              <h1 id={titleId} className="pointer-events-auto max-w-full">
                <button
                  type="button"
                  aria-expanded={panelOpen}
                  aria-controls={panelId}
                  onClick={() => setPanelOpen((open) => !open)}
                  className="flex min-h-11 max-w-full items-center gap-2 rounded-full border border-border bg-card/90 py-1 pl-1 pr-4 text-callout font-medium shadow-sm backdrop-blur hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring fine:min-h-9"
                >
                  {working ? <BotWorkingMark bot={bot.face} size={28} /> : <BotAvatar bot={bot.face} size={28} decorative />}
                  <span className="truncate">{bot.name}</span>
                </button>
              </h1>
              {mainSettings ? (
                <button
                  type="button"
                  aria-label={BOTS_STRINGS.mainSettings}
                  aria-expanded={panelOpen}
                  aria-controls={panelId}
                  onClick={() => setPanelOpen((open) => !open)}
                  className="pointer-events-auto tap-transparent flex size-11 shrink-0 items-center justify-center rounded-full border border-border bg-card/90 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-card hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring fine:size-9"
                >
                  <SlidersHorizontalIcon className="size-4" />
                </button>
              ) : null}
            </div>
            <div className="h-full overflow-y-auto overscroll-contain px-4">
              <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 pb-4 pt-16">
                {bot.private ? <p className="text-center text-callout text-muted-foreground">{BOTS_STRINGS.modelLine}</p> : null}
                {notice && onReconnect ? (
                  <ExpiryNotice
                    key={`${bot.key}:${notice.id}:${notice.deliveredAt ?? notice.renderAttemptAt ?? "initial"}`}
                    bot={bot}
                    notice={notice}
                    acknowledge={acknowledgeNotice}
                    onReconnect={onReconnect}
                  />
                ) : null}
                {history === "failed" && !working ? <Failure text={BOT_VIEW_STRINGS.historyFailed(bot.name)} onRetry={() => void chats.loadHistory(bot.key)} /> : null}
                {history === "declined" && !working ? <Failure text={errors.history_declined(bot.name)} onRetry={() => void chats.loadHistory(bot.key)} declined /> : null}
                {earlierHistory ? <LazyEarlierHistoryAction move={earlierHistory} /> : null}
                {activity.filter((item) => !item.inTurn && item.after === null).map((item) => <ActivityLine key={item.id} item={item} />)}
                {lines.map((line) => (
                  <Fragment key={line.id}>
                    {line.unreadableHistory
                      ? <p className="text-callout text-muted-foreground">{BOT_VIEW_STRINGS.historyUnreadable(bot.name)}</p>
                      : line.app
                        ? <AppLine decision={line.app} names={line.names} live={line.id.startsWith("local-")} secret={line.secret} />
                        : <Line role={line.role} text={line.text} />}
                    {activity.filter((item) => !item.inTurn && item.after === line.id).map((item) => <ActivityLine key={item.id} item={item} />)}
                  </Fragment>
                ))}
                {last && meetingsApi ? cards.map((area) => {
                  const Access = ACCESS[area];
                  return (
                    <div key={`${last.id}:${area}:${revision.cards}`} className="flex flex-col rounded-2xl border border-border bg-card p-4 empty:hidden" data-bots-access-card={area}>
                      <Access api={meetingsApi} chatList={false} onNotNow={main?.onNotNow ? () => main.onNotNow!(last.id, area) : undefined} onChanged={(stored) => {
                        setReadSettings(stored);
                        setRevision((current) => ({ ...current, settings: current.settings + 1 }));
                        if (stored.areas[area] === "on") main?.onAskAgain?.(last.id);
                      }} />
                    </div>
                  );
                }) : null}
                {turn ? (
                  <>
                    {turn.appReply
                      ? <AppLine decision={turn.appReply.decision} names={turn.appReply.names} live secret={turn.appReply.secret} />
                      : <Line role="user" text={turn.text} />}
                    {activity.filter((item) => item.inTurn).map((item) => <ActivityLine key={item.id} item={item} />)}
                    {turn.reply ? <Line role="bot" text={turn.reply} /> : null}
                    {working ? <BotWorkingStatus bot={bot.face} step={workingStepText(turn.step, awaitingOwner)} /> : null}
                    {turn.state === "error" ? <Failure text={errors[turn.error ?? "failed"](bot.name)} onRetry={() => chats.retry(bot.key)} declined={turn.error === "history_declined"} /> : null}
                  </>
                ) : null}
                {main?.active && main.asks ? <AskCards asks={main.asks} outcomes /> : null}
                {main?.active && main.asks ? <SecretCards asks={main.asks} chat onMessage={() => composerInput.current?.focus()} /> : null}
                <div ref={end} data-bots-chat-end="" />
              </div>
            </div>
          </div>
          <div className="shrink-0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
            <Composer key={bot.key} bot={bot} chats={chats} blocked={working} onSend={(text) => void chats.send(bot.key, text)} inputRef={composerInput} />
          </div>
        </section>
        {column && panel ? (
          <aside id={panelId} aria-label={bot.name} className="w-80 shrink-0 overflow-y-auto overscroll-contain border-l border-border bg-background">
            {panel}
          </aside>
        ) : null}
      </div>
      {!column ? (
        <ResponsiveSheet open={panelOpen} onOpenChange={setPanelOpen} title={bot.name} contentProps={{ "data-bot-panel-sheet": "" }}>
          <div id={panelId}>{panel}</div>
        </ResponsiveSheet>
      ) : null}
      {dialog === "edit" && manage ? <EditBotDialog botKey={bot.key} name={bot.name} manage={manage} onClose={() => setDialog(null)} /> : null}
      {dialog === "delete" && manage?.remove ? <DeleteBotConfirm name={bot.name} remove={manage.remove} onClose={() => setDialog(null)} /> : null}
    </>
  );
}
