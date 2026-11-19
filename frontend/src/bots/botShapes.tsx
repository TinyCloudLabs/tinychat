// Original avatar silhouettes in a common 48 × 48 frame.
const contours = {
  pebble: "M24 5C34 5 43 12 43 24C43 36 35 43 23 43C11 43 5 36 5 25C5 14 12 5 24 5Z",
  sprout: "M19 17C18 10 23 5 33 5C32 13 29 17 26 19C37 18 43 26 41 34C39 43 29 44 21 43C11 43 5 38 6 30C7 24 12 19 19 17Z",
  drop: "M24 4C28 4 29 11 35 17C40 23 43 27 42 33C41 41 33 44 24 44C14 44 6 40 6 32C6 26 12 20 16 15C20 10 20 4 24 4Z",
  clover: "M24 12C29 3 42 7 41 17C47 22 45 33 38 35C35 44 28 46 23 40C15 46 7 41 8 34C1 30 2 20 9 17C8 8 20 4 24 12Z",
  bloom: "M24 8C30 2 38 6 38 14C46 16 48 25 41 29C46 36 39 43 31 39C27 46 19 46 15 39C7 42 2 35 7 29C0 23 4 15 11 14C10 7 19 2 24 8Z",
  cloud: "M9 19C8 12 14 8 20 11C24 4 36 7 37 16C44 17 46 24 42 29C47 36 42 42 34 40C29 44 21 44 17 40C9 43 2 37 5 30C1 25 4 21 9 19Z",
  ghost: "M24 5C37 5 42 15 42 25V39C42 45 36 45 33 40C30 36 27 46 23 44C19 43 18 37 15 40C11 45 5 44 6 38V25C6 14 12 5 24 5Z",
  bean: "M31 6C41 7 45 17 41 26C37 38 28 43 16 42C6 42 2 34 6 27C10 20 16 22 20 15C23 10 25 6 31 6Z",
  comet: "M26 6C38 6 44 14 42 27C41 38 33 43 23 42C16 42 13 36 5 34C2 33 3 29 7 26C14 21 11 6 26 6Z",
  petal: "M25 5C34 1 37 11 35 17C45 18 46 27 39 31C42 39 34 45 27 41C21 47 13 43 13 37C4 36 2 29 8 23C3 15 10 9 17 13C18 9 22 6 25 5Z",
  squish: "M22 7C27 7 30 12 35 11C43 9 46 16 42 24C39 29 45 34 41 39C37 45 30 40 24 41C18 42 10 46 6 39C2 33 8 29 6 23C1 13 14 6 22 7Z",
  moon: "M32 6C38 8 38 13 34 15C27 19 27 24 30 28C33 32 36 33 40 32C44 31 45 35 41 39C32 48 14 45 8 34C1 23 8 10 19 6C23 4 28 4 32 6Z",
  star: "M24 3C28 3 29 14 33 15C37 17 45 14 45 19C45 24 37 28 37 32C37 37 42 44 37 45C33 46 28 40 24 39C19 39 15 46 10 44C6 42 12 33 10 29C8 25 2 23 3 19C4 14 13 17 16 15C20 12 20 3 24 3Z",
} as const;

export type ShapeId = keyof typeof contours;
export const BOT_SHAPES = Object.keys(contours) as ShapeId[];

export const BOT_COLOURS = {
  blue: 248,
  teal: 186,
  green: 155,
  lime: 125,
  yellow: 96,
  orange: 63,
  red: 26,
  pink: 352,
  purple: 308,
  indigo: 275,
  slate: 226,
} as const;

export type ColourId = keyof typeof BOT_COLOURS;
export const BOT_COLOUR_IDS = Object.keys(BOT_COLOURS) as ColourId[];

export function BotShape({ shape, size }: { shape: ShapeId; size: number }) {
  const eyeX = shape === "moon" ? 17 : shape === "bean" ? 27 : 24;
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 48 48">
      <path d={contours[shape]} fill="currentColor" fillOpacity=".14" stroke="currentColor" strokeWidth="1.8" />
      <ellipse cx={eyeX - 4.5} cy="27" rx="1.55" ry="2.35" fill="currentColor" />
      <ellipse cx={eyeX + 4.5} cy="27" rx="1.55" ry="2.35" fill="currentColor" />
    </svg>
  );
}
