// The account's bots in the navigation (TC-3325): full rows under Chat in the sidebar (from 1024 px), avatars under
// Chat on the 64 px rail, and a strip of avatars above the conversation on a phone. Each ends with New bot, which is
// off at the cap with the reason. Nothing renders while the Chat slot shows the classic chat (botsNav.ts).
import { useId } from "react";
import { Link } from "react-router-dom";
import { PlusIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { BotAvatar } from "./BotAvatar";
import { botPath } from "./botPath";
import { BOT_VIEW_STRINGS as text } from "./botsStrings";
import { useBotsNav, type BotsNavState, type NavBot } from "./botsNav";
import { useBotChat, type BotChats } from "./useBotChat";
import { isWorking } from "./useMainChat";

function LiveFace({ chats, bot, size }: { chats: BotChats; bot: NavBot; size: number }) {
  const { turn, unseen } = useBotChat(chats, bot.key);
  return <Face bot={bot} size={size} working={isWorking(turn)} unseen={unseen} />;
}

function Face({ bot, size, working = false, unseen = false }: { bot: NavBot; size: number; working?: boolean; unseen?: boolean }) {
  return (
    <span className="relative inline-flex shrink-0" data-bot-unseen={unseen || undefined}>
      <BotAvatar bot={bot.face} size={size} working={working} decorative />
      {unseen ? <span aria-hidden className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-primary ring-2 ring-chrome" /> : null}
    </span>
  );
}

function BotFace({ nav, bot, size }: { nav: BotsNavState; bot: NavBot; size: number }) {
  return nav.chats ? <LiveFace chats={nav.chats} bot={bot} size={size} /> : <Face bot={bot} size={size} />;
}

/** The row's accessible name: the bot's name, and that it has a new reply. */
function UnseenLabel({ nav, bot }: { nav: BotsNavState; bot: NavBot }) {
  return nav.chats ? <LiveLabel chats={nav.chats} bot={bot} /> : <>{bot.name}</>;
}

function LiveLabel({ chats, bot }: { chats: BotChats; bot: NavBot }) {
  const { unseen } = useBotChat(chats, bot.key);
  return <>{unseen ? text.unseen(bot.name) : bot.name}</>;
}

const current = (nav: BotsNavState, bot: NavBot) => nav.chatShown && nav.selected === bot.key;

/** Under Chat in the sidebar: one full row per bot, then New bot and the count. */
export function SidebarBotRows() {
  const nav = useBotsNav();
  const reasonId = useId();
  if (!nav) return null;
  const { newBot } = nav;
  return (
    <ul aria-label={text.botsList} className="mt-0.5 flex flex-col gap-0.5 pl-[20px]" data-bot-rows="sidebar">
      {nav.bots.map((bot) => {
        const active = current(nav, bot);
        return (
          <li key={bot.key}>
            <Link
              to={botPath(bot.key)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "tap-transparent flex min-h-10 items-center gap-[10px] rounded-md px-[10px] text-callout transition-colors duration-150 fine:min-h-9",
                active ? "bg-selected font-semibold text-foreground" : "font-medium text-muted-foreground hover:bg-surface-2 hover:text-foreground",
              )}
            >
              <BotFace nav={nav} bot={bot} size={24} />
              <span className="min-w-0 flex-1 truncate"><UnseenLabel nav={nav} bot={bot} /></span>
            </Link>
          </li>
        );
      })}
      <li>
        <button
          type="button"
          disabled={!newBot.enabled}
          aria-describedby={newBot.reason ? reasonId : undefined}
          onClick={newBot.open}
          className="tap-transparent flex min-h-10 w-full items-center gap-[10px] rounded-md px-[10px] text-callout font-medium text-muted-foreground transition-colors duration-150 hover:bg-surface-2 hover:text-foreground disabled:pointer-events-none disabled:opacity-50 fine:min-h-9"
        >
          <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed border-border">
            <PlusIcon className="size-3.5" />
          </span>
          <span className="min-w-0 flex-1 truncate text-left">{text.newBot}</span>
        </button>
        {newBot.reason ? <p id={reasonId} className="px-[10px] pt-1 text-xs text-muted-foreground">{newBot.reason}</p> : null}
        {!newBot.reason && newBot.counter ? <p className="px-[10px] pt-1 text-xs text-muted-foreground">{newBot.counter}</p> : null}
      </li>
    </ul>
  );
}

/** Under Chat on the rail: each bot's avatar, then New bot. Names and the reason are in the accessible names. */
export function RailBotAvatars() {
  const nav = useBotsNav();
  const reasonId = useId();
  if (!nav) return null;
  const { newBot } = nav;
  return (
    <ul aria-label={text.botsList} className="flex w-full flex-col items-center gap-1 pb-1" data-bot-rows="rail">
      {nav.bots.map((bot) => {
        const active = current(nav, bot);
        return (
          <li key={bot.key}>
            <Link
              to={botPath(bot.key)}
              title={bot.name}
              aria-current={active ? "page" : undefined}
              className={cn("tap-transparent flex size-11 items-center justify-center rounded-full transition-colors duration-150",
                active ? "bg-selected" : "hover:bg-surface-2")}
            >
              <span className="sr-only"><UnseenLabel nav={nav} bot={bot} /></span>
              <BotFace nav={nav} bot={bot} size={30} />
            </Link>
          </li>
        );
      })}
      <li>
        <button
          type="button"
          disabled={!newBot.enabled}
          title={newBot.reason ?? newBot.counter ?? text.newBot}
          aria-label={text.newBot}
          aria-describedby={newBot.reason ? reasonId : undefined}
          onClick={newBot.open}
          className="tap-transparent flex size-11 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-surface-2 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <span aria-hidden className="flex size-[30px] items-center justify-center rounded-full border border-dashed border-border">
            <PlusIcon className="size-4" />
          </span>
        </button>
        {newBot.reason ? <span id={reasonId} className="sr-only">{newBot.reason}</span> : null}
      </li>
    </ul>
  );
}

/** Above the conversation on a phone: every bot's avatar in a row that scrolls, then New bot. */
export function PhoneBotStrip() {
  const nav = useBotsNav();
  const reasonId = useId();
  if (!nav) return null;
  const { newBot } = nav;
  return (
    <nav aria-label={text.botsList} data-bot-rows="phone" className="shrink-0 border-b border-border/70">
      <ul className="flex items-center gap-2 overflow-x-auto px-3 py-2 [scrollbar-width:none]">
        {nav.bots.map((bot) => {
          const active = current(nav, bot);
          return (
            <li key={bot.key} className="shrink-0">
              <Link
                to={botPath(bot.key)}
                aria-current={active ? "page" : undefined}
                className={cn("tap-transparent flex size-11 items-center justify-center rounded-full",
                  active ? "bg-selected" : "active:bg-surface-2")}
              >
                <span className="sr-only"><UnseenLabel nav={nav} bot={bot} /></span>
                <BotFace nav={nav} bot={bot} size={34} />
              </Link>
            </li>
          );
        })}
        <li className="shrink-0">
          <button
            type="button"
            disabled={!newBot.enabled}
            aria-label={text.newBot}
            aria-describedby={newBot.reason ? reasonId : undefined}
            onClick={newBot.open}
            className="tap-transparent flex size-11 items-center justify-center rounded-full text-muted-foreground active:bg-surface-2 disabled:opacity-50"
          >
            <span aria-hidden className="flex size-[34px] items-center justify-center rounded-full border border-dashed border-border">
              <PlusIcon className="size-4" />
            </span>
          </button>
        </li>
      </ul>
      {newBot.reason ? <p id={reasonId} className="px-3 pb-2 text-xs text-muted-foreground">{newBot.reason}</p> : null}
    </nav>
  );
}
