// A bot's avatar: a line icon for its job on a soft tint of its hue (the icon style Sam and Monica
// picked on the mockups branch). While the bot works, a ring turns around it.
import { SparklesIcon, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { BOTS_STRINGS } from "./botsStrings";

export interface BotFace {
  name: string;
  /** oklch hue in degrees. */
  hue: number;
  icon: LucideIcon;
}

export const MAIN_BOT: BotFace = { name: BOTS_STRINGS.mainName, hue: 250, icon: SparklesIcon };

interface BotAvatarProps {
  bot: BotFace;
  working?: boolean;
  size?: number;
  /** Hidden from screen readers where the bot's name is already said beside it. */
  decorative?: boolean;
  className?: string;
}

export function BotAvatar({ bot, working = false, size = 40, decorative = false, className }: BotAvatarProps) {
  const Icon = bot.icon;
  return (
    <span
      className={cn("relative inline-flex shrink-0", className)}
      style={{ width: size, height: size }}
      {...(decorative
        ? { "aria-hidden": true }
        : { role: "img", "aria-label": working ? BOTS_STRINGS.working(bot.name) : bot.name })}
    >
      <span
        aria-hidden
        className="flex size-full items-center justify-center rounded-[30%] text-foreground/80 [background:var(--tint-light)] dark:[background:var(--tint-dark)]"
        style={{
          ["--tint-light" as string]: `oklch(0.94 0.035 ${bot.hue})`,
          ["--tint-dark" as string]: `oklch(0.32 0.04 ${bot.hue})`,
        }}
      >
        <Icon style={{ width: size * 0.48, height: size * 0.48 }} strokeWidth={1.75} />
      </span>
      {working ? (
        <span
          aria-hidden
          data-bot-working=""
          className="pointer-events-none absolute -inset-[3px] rounded-[30%] border-[1.5px] border-foreground/10 border-t-foreground/60 motion-safe:animate-[spin_1.6s_linear_infinite]"
        />
      ) : null}
    </span>
  );
}
