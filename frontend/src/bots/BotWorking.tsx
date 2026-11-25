// The working indicator (TC-4382): the bot's chosen icon, drawn without motion, inside a frame of this file's own.
// A light runs around the frame, a glow breathes behind it and a glare sweeps across the step text beside it. The
// avatar and the shapes are shared across the app, so none of the motion is theirs: it is all in botWorking.css.
import { useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";
import { MAIN_BOT, type BotFace, type ShapedBotFace } from "./BotAvatar";
import { BOT_COLOURS, BotShape } from "./botShapes";
import "./botWorking.css";

/** A bot's icon as the avatar takes it: the main bot's first icon or a shape and colour its owner picked. */
export type WorkingBot = BotFace | (ShapedBotFace & { key?: string });

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const watchMotion = (onChange: () => void) => {
  const query = globalThis.matchMedia?.(REDUCED_MOTION);
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
};
/** No motion wherever the reader's setting cannot be read. */
const motionReduced = () => globalThis.matchMedia?.(REDUCED_MOTION).matches ?? true;

/** True where the reader allows motion. The stylesheet checks the same setting itself. */
export function useWorkingMotion(): boolean {
  return !useSyncExternalStore(watchMotion, motionReduced, () => true);
}

/** The frame the light runs around: a rounded square in a 100 × 100 box, its length counted as 100. */
const FRAME = "M33 4H67A29 29 0 0 1 96 33V67A29 29 0 0 1 67 96H33A29 29 0 0 1 4 67V33A29 29 0 0 1 33 4Z";
/** How far the frame stands out from the icon's square, in CSS px. */
const REACH = 3;

interface BotWorkingMarkProps {
  bot: WorkingBot;
  size?: number;
  className?: string;
}

/** The icon with the running light. Decorative: the step text beside it or the bot's name says the rest. */
export function BotWorkingMark({ bot, size = 28, className }: BotWorkingMarkProps) {
  const motion = useWorkingMotion();
  // The avatar's rule for the main bot before its owner picks a shape.
  const face = !("icon" in bot) && bot.key === "main" && bot.name === MAIN_BOT.name && bot.shape === "pebble" && bot.colour === "blue"
    ? MAIN_BOT : bot;
  const hue = "icon" in face ? face.hue : BOT_COLOURS[face.colour];
  const stroke = (1.75 * 100) / (size + REACH * 2);
  return (
    <span
      aria-hidden
      data-bot-working=""
      {...(motion ? { "data-motion": "" } : {})}
      className={cn("tc-bot-working relative inline-flex shrink-0", className)}
      style={{ width: size, height: size, fontSize: size, ["--tc-working-hue" as string]: hue }}
    >
      <span className="tc-bot-working-glow absolute inset-0 rounded-[30%]" />
      <span className="tc-bot-working-plate relative flex size-full items-center justify-center rounded-[30%] text-foreground/80">
        {"icon" in face
          ? <face.icon style={{ width: size * 0.48, height: size * 0.48 }} strokeWidth={1.75} />
          : <BotShape shape={face.shape} size={size * 0.75} />}
      </span>
      <svg className="pointer-events-none absolute" style={{ inset: -REACH }} viewBox="0 0 100 100" fill="none" strokeWidth={stroke} strokeLinecap="round">
        <path className="tc-bot-working-track" d={FRAME} />
        <path className="tc-bot-working-run" d={FRAME} pathLength={100} strokeDasharray="22 78" />
        <path className="tc-bot-working-run" d={FRAME} pathLength={100} strokeDasharray="7 93" strokeDashoffset={-58} />
      </svg>
    </span>
  );
}

interface BotWorkingStatusProps extends BotWorkingMarkProps {
  /** The step in progress, in the owner's words (workingStep.ts). */
  step: string;
}

/** The waiting row: the mark, then the step text. A screen reader hears the text once each time it changes. */
export function BotWorkingStatus({ bot, size = 28, step, className }: BotWorkingStatusProps) {
  const motion = useWorkingMotion();
  return (
    <div data-bot-working-row="" className={cn("tc-bot-working-row flex min-w-0 items-center gap-3", className)}>
      <BotWorkingMark bot={bot} size={size} />
      <span
        role="status"
        aria-live="polite"
        {...(motion ? { "data-motion": "" } : {})}
        className="tc-bot-working-text min-w-0 text-callout"
      >
        {step}
      </span>
    </div>
  );
}
