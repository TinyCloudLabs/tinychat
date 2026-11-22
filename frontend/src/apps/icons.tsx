// The One Apps icon family: every glyph is built from the TinyCloud cloud (cream), with an olive part that says what
// the app does, on a navy tile. `AppTileIcon` is the launcher's full-colour tile; `GLYPH_ICONS` are the same glyphs in
// one colour (currentColor), for the navigation.
import type { ComponentType, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/** A navigation or launcher icon: a lucide icon or a One Apps glyph. Both take a class and aria-hidden. */
export type AppIcon = LucideIcon | ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;

export type GlyphId = "recording" | "secrets" | "credentials" | "explorer" | "account" | "courier" | "ledger" | "share" | "contacts" | "connectors";

const n = (value: number) => Math.round(value * 100) / 100;

/** The cloud: three bumps on a flat base. At s=1 its box is x 9..42, y 11..35 from (ox, oy). */
function cloud(ox: number, oy: number, s: number): ReactNode {
  return (
    <>
      <circle cx={n(ox + 16 * s)} cy={n(oy + 28 * s)} r={n(7 * s)} />
      <circle cx={n(ox + 25 * s)} cy={n(oy + 21 * s)} r={n(10 * s)} />
      <circle cx={n(ox + 34 * s)} cy={n(oy + 27 * s)} r={n(8 * s)} />
      <rect x={n(ox + 16 * s)} y={n(oy + 24 * s)} width={n(18 * s)} height={n(11 * s)} />
    </>
  );
}

/** A cloud of scale s whose box is centred on cx with its top at `top`. */
const cloudAt = (cx: number, top: number, s: number) => cloud(cx - 25.5 * s, top - 11 * s, s);

const line = (d: string, width = 3.2) => (
  <path key={d} d={d} fill="none" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />
);

interface GlyphParts {
  /** The cream cloud. */
  cloud?: ReactNode;
  /** The olive part. */
  tool?: ReactNode;
  /** Olive strokes under everything. */
  underTool?: ReactNode;
  /** Navy fills on top. */
  overInk?: ReactNode;
  /** Navy strokes on top. */
  overInkLine?: ReactNode;
  /** A cream cloud on top. */
  overCloud?: ReactNode;
  /** Olive strokes on top. */
  overTool?: ReactNode;
}

const GLYPHS: Readonly<Record<GlyphId, GlyphParts>> = {
  // The cloud rains a waveform.
  recording: {
    cloud: cloudAt(24, 5.5, 0.82),
    overTool: ["M11 32v4.5", "M17.5 32v10", "M24 32v6", "M30.5 32v11", "M37 32v3.5"].map((d) => line(d, 3.4)),
  },
  // A key whose bow is the cloud.
  secrets: {
    tool: (
      <>
        <rect x="21.2" y="19" width="5.6" height="25" rx="2.8" />
        <rect x="25" y="30.5" width="9" height="5" rx="1.6" />
        <rect x="25" y="38" width="6.5" height="5" rx="1.6" />
      </>
    ),
    cloud: cloudAt(24, 4.5, 0.74),
    overInk: <circle cx="23.6" cy="14.4" r="2.8" />,
  },
  // A cloud seal with a tick and two ribbon tails.
  credentials: {
    tool: (
      <>
        <polygon points="14.5,24 22.5,24 20.5,43.5 16.8,39.6 12.2,42.5" />
        <polygon points="25.5,24 33.5,24 35.8,42.5 31.2,39.6 27.5,43.5" />
      </>
    ),
    cloud: cloudAt(24, 5, 0.9),
    overInkLine: line("M17.3 18.6l4.6 4.5 8.6-9", 3.3),
  },
  // A magnifier looking at the cloud.
  explorer: {
    tool: (
      <>
        <circle cx="21" cy="21" r="14.5" />
        <rect x="-3.4" y="0" width="6.8" height="14" rx="3.4" transform="translate(31 31) rotate(-45)" />
      </>
    ),
    overInk: <circle cx="21" cy="21" r="10.8" />,
    overCloud: cloudAt(21, 15.2, 0.48),
  },
  // A person whose shoulders are the cloud.
  account: {
    tool: <circle cx="24.6" cy="11.4" r="6.6" />,
    cloud: cloudAt(24, 20.6, 0.94),
  },
  // Two clouds talking.
  courier: {
    tool: (
      <>
        {cloud(21.6, -1.6, 0.54)}
        <polygon points="35,15 41.5,15 42.5,22" />
      </>
    ),
    cloud: (
      <>
        {cloud(-3.6, 8.2, 0.84)}
        <polygon points="8.5,35 17,35 8,43.5" />
      </>
    ),
    overInk: (
      <>
        <circle cx="10.4" cy="31" r="1.9" />
        <circle cx="17" cy="31" r="1.9" />
        <circle cx="23.6" cy="31" r="1.9" />
      </>
    ),
  },
  // A list card with the cloud as its clip.
  ledger: {
    tool: <rect x="11" y="15" width="26" height="30" rx="3" />,
    cloud: cloudAt(24, 3.5, 0.62),
    overInkLine: ["M16.5 27.5h15", "M16.5 33.5h15", "M16.5 39.5h9"].map((d) => line(d, 3)),
  },
  // The cloud hands out two links.
  share: {
    underTool: [line("M17 21.5L39 10.5", 3.2), line("M17 27L39 37.5", 3.2)],
    tool: (
      <>
        <circle cx="39" cy="10.5" r="5.4" />
        <circle cx="39" cy="37.5" r="5.4" />
      </>
    ),
    cloud: cloud(-2.6, 8.8, 0.66),
  },
  // A contact card: the cloud is the portrait, beside two lines of detail.
  contacts: {
    tool: <rect x="8" y="12" width="32" height="25" rx="3" />,
    cloud: cloudAt(17.5, 16.5, 0.38),
    overInkLine: ["M26 21h9", "M26 27h9", "M13 32h22"].map((d) => line(d, 3)),
  },
  // A plug on the cloud's lead.
  connectors: {
    tool: (
      <>
        <rect x="22" y="20" width="4" height="12" />
        <rect x="15.5" y="29.5" width="17" height="8.5" rx="3" />
        <rect x="18.6" y="36" width="3.8" height="8.6" rx="1.7" />
        <rect x="25.6" y="36" width="3.8" height="8.6" rx="1.7" />
      </>
    ),
    cloud: cloudAt(24, 4.5, 0.8),
  },
};

/** The family's colours: navy tile, cream cloud, olive detail, deep navy shadow. */
const NAVY = "#282f4b";
const CREAM = "#fdf9d2";
const OLIVE = "#cdd48e";
const DEEP = "#171b30";

interface Palette {
  cloud: string;
  tool: string;
  /** The keyline around each part and the navy details on top. */
  ink: string;
  shadow: string | null;
  keyWidth: number;
}

const COLOUR: Palette = { cloud: CREAM, tool: OLIVE, ink: NAVY, shadow: DEEP, keyWidth: 2.4 };
// One colour for the navigation: the parts in the text colour, keylines in the surface behind them (--mono-bg), wider
// so the parts stay apart at nav size.
const MONO: Palette = { cloud: "currentColor", tool: "currentColor", ink: "var(--mono-bg, hsl(var(--chrome)))", shadow: null, keyWidth: 3.2 };

/** The glyph alone, on a 48 × 48 box. Back to front: under-lines, shadows, each part over its keyline, then details. */
export function AppGlyph({ id, mono = false, className }: { id: GlyphId; mono?: boolean; className?: string }) {
  const glyph = GLYPHS[id];
  const colours = mono ? MONO : COLOUR;
  const part = (shape: ReactNode, fill: string) =>
    shape ? (
      <>
        <g fill={colours.ink} stroke={colours.ink} strokeWidth={colours.keyWidth} strokeLinejoin="round">{shape}</g>
        <g fill={fill} stroke="none">{shape}</g>
      </>
    ) : null;
  const shadow = (shape: ReactNode) =>
    shape && colours.shadow ? (
      <g transform="translate(1.5 2)" fill={colours.shadow} stroke={colours.shadow} strokeWidth={2.4} strokeLinejoin="round">{shape}</g>
    ) : null;
  const tool = part(glyph.tool, colours.tool);
  const body = part(glyph.cloud, colours.cloud);
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false" className={cn("overflow-visible", className)}>
      {glyph.underTool ? <g stroke={colours.tool}>{glyph.underTool}</g> : null}
      {shadow(glyph.tool)}
      {shadow(glyph.cloud)}
      {tool}
      {body}
      {glyph.overInk ? <g fill={colours.ink}>{glyph.overInk}</g> : null}
      {glyph.overInkLine ? <g stroke={colours.ink}>{glyph.overInkLine}</g> : null}
      {glyph.overCloud ? <g fill={colours.cloud}>{glyph.overCloud}</g> : null}
      {glyph.overTool ? <g stroke={colours.tool}>{glyph.overTool}</g> : null}
    </svg>
  );
}

/** The app icon: the glyph on its navy tile. Size it with `size-*`; the glyph fills 74% of it. */
export function AppTileIcon({ id, className }: { id: GlyphId; className?: string }) {
  return (
    <span aria-hidden="true" data-icon={id} className={cn("tc-app-tile", className)}>
      <AppGlyph id={id} className="size-[74%]" />
    </span>
  );
}

function monoGlyph(id: GlyphId): AppIcon {
  function MonoGlyph({ className }: { className?: string }) {
    return <AppGlyph id={id} mono className={className} />;
  }
  MonoGlyph.displayName = `Glyph(${id})`;
  return MonoGlyph;
}

/** Each glyph in one colour, for the navigation. */
export const GLYPH_ICONS: Readonly<Record<GlyphId, AppIcon>> = {
  recording: monoGlyph("recording"),
  secrets: monoGlyph("secrets"),
  credentials: monoGlyph("credentials"),
  explorer: monoGlyph("explorer"),
  account: monoGlyph("account"),
  courier: monoGlyph("courier"),
  ledger: monoGlyph("ledger"),
  share: monoGlyph("share"),
  contacts: monoGlyph("contacts"),
  connectors: monoGlyph("connectors"),
};
