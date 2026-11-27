// The bot's panel (TC-3325), opened from the pill at the top of the bot view: the bot's avatar and name, what it did
// on its computer (the activity lines, newest first, with times) and where it runs. A right-hand column from 1024 px,
// a sheet below that. `ActivityPanel` is the recorder's panel, hence the name.
import type { ReactNode } from "react";
import { XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { BotAvatar } from "./BotAvatar";
import type { BotActivity } from "./botsApi";
import { BOT_ACTIVITY_STRINGS, BOT_MANAGE_STRINGS } from "./botsStrings";
import type { ViewBot } from "./BotView";
import { CourierThreads } from "./courier/CourierThreads";

/** "Ran 3 commands", "Changed 1 file": the line for one activity record. */
export function activityText({ verb, count }: Pick<BotActivity, "verb" | "count">): string {
  return verb === "ran_commands" ? BOT_ACTIVITY_STRINGS.ranCommands(count) : BOT_ACTIVITY_STRINGS.changedFiles(count);
}

const timeOf = (at: string) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export interface BotPanelProps {
  bot: ViewBot;
  activity: readonly BotActivity[];
  /** The bot's computer is running: a turn is in flight. */
  awake: boolean;
  /** In the column the panel carries its own name and Close; in a sheet the sheet's title is the name. */
  onClose?: () => void;
  /** Edit (name, shape, colour). Absent when the bot cannot be changed from here. */
  onEdit?: () => void;
  /** Delete bot. Absent on Main, and when the bot cannot be changed from here. */
  onDelete?: () => void;
  /** Main bot access, web, asks, Courier and New chat settings. */
  mainSettings?: ReactNode;
}

export function BotPanel({ bot, activity, awake, onClose, onEdit, onDelete, mainSettings }: BotPanelProps) {
  const newestFirst = [...activity].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return (
    <div data-bot-panel={bot.key} className="flex flex-col gap-6 px-5 pb-6 pt-4">
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          aria-label={BOT_ACTIVITY_STRINGS.closePanel}
          className="tap-transparent -mr-2 flex size-9 items-center justify-center self-end rounded-full text-muted-foreground hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <XIcon className="size-5" />
        </button>
      ) : null}
      <div className="flex flex-col items-center gap-3">
        <BotAvatar bot={bot.face} working={awake} size={88} decorative />
        {onClose ? <h2 className="max-w-full truncate font-display text-title-2">{bot.name}</h2> : null}
      </div>
      <section className="flex flex-col gap-2">
        <h3 className="text-meta font-medium text-muted-foreground">{BOT_ACTIVITY_STRINGS.activity}</h3>
        {newestFirst.length === 0 ? (
          <p className="text-callout text-muted-foreground">{BOT_ACTIVITY_STRINGS.noActivity}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {newestFirst.map((item) => (
              <li key={item.id} data-bot-activity-row={item.id} className="flex items-baseline justify-between gap-3 py-2 text-callout">
                <span>{activityText(item)}</span>
                <time dateTime={item.at} className="shrink-0 text-meta text-muted-foreground">{timeOf(item.at)}</time>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-meta font-medium text-muted-foreground">{BOT_ACTIVITY_STRINGS.environment}</h3>
        <p className="text-callout" data-bot-environment="">{BOT_ACTIVITY_STRINGS.environmentRow(bot.private ? "private" : "regular", awake)}</p>
      </section>
      {bot.key === "main" && bot.private ? <CourierThreads /> : null}
      {mainSettings ? (
        <section className="flex flex-col gap-5 border-t border-border pt-5" data-bots-main-settings="">
          {mainSettings}
        </section>
      ) : null}
      {onEdit || onDelete ? (
        <div className="flex flex-col gap-2">
          {onEdit ? <Button type="button" variant="outline" onClick={onEdit}>{BOT_MANAGE_STRINGS.edit}</Button> : null}
          {onDelete ? <Button type="button" variant="outline" className="text-destructive" onClick={onDelete}>{BOT_MANAGE_STRINGS.deleteBot}</Button> : null}
        </div>
      ) : null}
    </div>
  );
}
