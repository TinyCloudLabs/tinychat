// Which agent is acting, and on which platform. Each agent has its own mark, its first letter in its own colour, the
// same on its cards, in the list, on its page and in the Agents list (AgentMark). The platform comes only from what
// the agent says about itself, an optional `agent` object in a card's payload ({ kind, model, runsOn }); without one
// there is no platform chip, and nothing is guessed from a name. A known platform shows its maker's mark, a file in
// public/platforms (see SOURCES.txt there), unchanged; any other shows its name alone.
import type { CSSProperties, ReactNode } from "react";
import { publicUrl } from "@/lib/basePath";

export interface Platform {
  name: string;
  /** A file in public/platforms. */
  logo?: string;
  /** The mark's own colour, where it reads on both themes; otherwise the mark takes the text colour. */
  colour?: string;
}
/** What an agent says it is: its platform (`kind`), its model and where it runs, each as the agent reports it. */
/** `job`: what the agent is working on, as it says (payload.agent.job; Hunter and Sam, 11-12). */
export interface AgentProfile { platform?: Platform; model?: string; runsOn?: string; job?: string }

// The platforms on agents.tinycloud.xyz, by the `kind` an agent reports. Those without a mark file show their name.
const PLATFORMS: Record<string, Platform> = {
  claude: { name: "Claude", logo: "claude.svg", colour: "#D97757" },
  "claude-code": { name: "Claude Code", logo: "claude.svg", colour: "#D97757" },
  chatgpt: { name: "ChatGPT" },
  codex: { name: "Codex" },
  cursor: { name: "Cursor", logo: "cursor.svg" },
  gemini: { name: "Gemini", logo: "gemini.svg", colour: "#8E75B2" },
  grok: { name: "Grok" },
  hermes: { name: "Hermes" },
  muse: { name: "Muse" },
  openclaw: { name: "OpenClaw" },
  opencode: { name: "OpenCode", logo: "opencode.svg" },
  perplexity: { name: "Perplexity", logo: "perplexity.svg", colour: "#1FB8CD" },
};

/** A reported platform: a known one by its usual name and mark, any other by the name the agent gave. */
export function platformOf(kind: string): Platform {
  return PLATFORMS[kind.trim().toLowerCase().replace(/[\s_]+/g, "-")] ?? { name: kind.trim() };
}

const reported = (value: unknown) => typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : undefined;
/** The card's `payload.agent`, or undefined when the agent said nothing about itself. */
export function agentProfile(payload: Record<string, unknown> | undefined): AgentProfile | undefined {
  const agent = payload?.agent;
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) return undefined;
  const fields = agent as Record<string, unknown>;
  const kind = reported(fields.kind), model = reported(fields.model), runsOn = reported(fields.runsOn), job = reported(fields.job);
  if (!kind && !model && !runsOn && !job) return undefined;
  return { ...(kind ? { platform: platformOf(kind) } : {}), ...(model ? { model } : {}), ...(runsOn ? { runsOn } : {}), ...(job ? { job } : {}) };
}

// White letters on each of these pass 4.5:1, and each stands out on the light and the dark background.
const MARK_COLOURS = ["bg-sky-700", "bg-emerald-700", "bg-violet-700", "bg-amber-700", "bg-rose-700", "bg-teal-700", "bg-indigo-700", "bg-fuchsia-700"] as const;
/**
 * An agent's colour, from its key (agentKey). Colours go out in order of first appearance on the page, so the first
 * eight agents shown never share one (design critique #11: a hash gave Studio and Kiln the same teal); the same
 * agent keeps its colour for as long as the page is open.
 */
const given = new Map<string, string>();
export function markColour(key: string): string {
  let colour = given.get(key);
  if (!colour) { colour = MARK_COLOURS[given.size % MARK_COLOURS.length]!; given.set(key, colour); }
  return colour;
}
export const markLetter = (name: string) => (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toLocaleUpperCase();

/** The agent's mark. Its name is always written beside it, so the mark itself is not read out. */
export function AgentMark({ agentKey, name, small = false }: { agentKey: string; name: string; small?: boolean }) {
  return <span aria-hidden data-agent-mark className={`inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white ${small ? "size-7 text-xs" : "size-9 text-sm"} ${markColour(agentKey)}`}>{markLetter(name)}</span>;
}

/** A platform's mark, drawn from its file as a mask so it keeps its exact shape on either theme. */
function PlatformLogo({ platform, logo }: { platform: Platform; logo: string }) {
  const url = `url("${publicUrl(`platforms/${logo}`)}")`;
  const style: CSSProperties = { maskImage: url, WebkitMaskImage: url, maskSize: "contain", WebkitMaskSize: "contain", maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat", maskPosition: "center", WebkitMaskPosition: "center", ...(platform.colour ? { backgroundColor: platform.colour } : {}) };
  return <span role="img" aria-label={platform.name} data-platform-logo={logo} className="inline-block size-3.5 shrink-0 bg-current" style={style} />;
}

/**
 * The platform: its mark and name. A screen reader hears the name once, from the mark when there is one.
 * `chip` draws it as the card's chip; otherwise it sits inline in a line of text. `logoOnly` (the compact card)
 * shows just the mark when there is one, its name as the tooltip.
 */
export function PlatformName({ platform, chip = false, logoOnly = false }: { platform: Platform; chip?: boolean; logoOnly?: boolean }) {
  return <span data-platform={platform.name} title={logoOnly && platform.logo ? platform.name : undefined} className={`inline-flex min-w-0 items-center gap-1.5 ${chip ? "max-w-full shrink-0 rounded-full border border-border px-2 py-0.5 text-xs font-medium" : ""}`}>
    {platform.logo && <PlatformLogo platform={platform} logo={platform.logo} />}
    {!(logoOnly && platform.logo) && <span aria-hidden={platform.logo ? true : undefined} className="truncate">{platform.name}</span>}
  </span>;
}

/**
 * What the page knows about an agent, in plain rows: what it is, its model and where it runs as the agent reports
 * them, and what its connection lets it do. A fact the page does not have is left out. Home records neither when an
 * agent was connected nor when its access ends, and an agent is disconnected outside Home, so neither shows here.
 */
export function AgentDetails({ name, via, profile, onOpen }: { name: string; via?: string; profile?: AgentProfile; onOpen?: () => void }) {
  const rows: [string, ReactNode][] = [];
  if (profile?.job) rows.push(["Working on", profile.job]);
  if (profile?.platform) rows.push(["What it is", <PlatformName platform={profile.platform} />]);
  if (profile?.model) rows.push(["Model", profile.model]);
  if (profile?.runsOn) rows.push(["Runs on", profile.runsOn]);
  if (via) rows.push(["Posts through", via]);
  rows.push(["It can", via ? `Reach you on cards ${via} posts, and read your answers to them` : "Post cards to your Home and read your answers to them"]);
  return <section aria-label={`About ${name}`} className="space-y-2 rounded-xl bg-muted/50 p-3 text-sm">
    <dl>{rows.map(([term, value]) => <div key={term} className="flex items-baseline justify-between gap-4 border-t border-border py-2 first:border-t-0 first:pt-0">
      <dt className="shrink-0 text-muted-foreground">{term}</dt><dd className="min-w-0 break-words text-right">{value}</dd>
    </div>)}</dl>
    {!profile && <p className="text-xs text-muted-foreground">{name} has not said what it is or where it runs.</p>}
    {onOpen && <button type="button" onClick={onOpen} className="min-h-11 rounded-lg border border-border bg-background px-3 fine:min-h-10">Open conversation</button>}
  </section>;
}
