// A bot's avatar: a line icon for its job on a soft tint of its hue (the icon style Sam and Monica
// picked on the mockups branch). While the bot works, a ring turns around it.
import { SparklesIcon, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { BOT_COLOURS, BotShape, type ColourId, type ShapeId } from "./botShapes";
import { BOTS_STRINGS } from "./botsStrings";

export interface BotFace {
  name: string;
  /** oklch hue in degrees. */
  hue: number;
  icon: LucideIcon;
}

export const MAIN_BOT: BotFace = { name: BOTS_STRINGS.mainName, hue: 250, icon: SparklesIcon };

export interface ShapedBotFace {
  name: string;
  shape: ShapeId;
  colour: ColourId;
}

interface BotAvatarProps {
  bot: BotFace | (ShapedBotFace & { key?: string });
  working?: boolean;
  size?: number;
  /** Hidden from screen readers where the bot's name is already said beside it. */
  decorative?: boolean;
  className?: string;
}

export function BotAvatar({ bot, working = false, size = 40, decorative = false, className }: BotAvatarProps) {
  const face = !("icon" in bot) && bot.key === "main" && bot.name === MAIN_BOT.name && bot.shape === "pebble" && bot.colour === "blue"
    ? MAIN_BOT : bot;
  const hue = "icon" in face ? face.hue : BOT_COLOURS[face.colour];
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
          ["--tint-light" as string]: `oklch(0.94 0.035 ${hue})`,
          ["--tint-dark" as string]: `oklch(0.32 0.04 ${hue})`,
        }}
      >
        {"icon" in face
          ? <face.icon style={{ width: size * 0.48, height: size * 0.48 }} strokeWidth={1.75} />
          : <BotShape shape={face.shape} size={size * 0.75} />}
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
