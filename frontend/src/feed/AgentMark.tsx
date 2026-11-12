// Which agent is acting, and on which platform (from Hunter's bridge-feed design). Each agent has its own mark, its
// first letter in its own colour, the same on its cards, its rows, its page and the Agents list. The platform comes
// only from what the agent says about itself, an optional `agent` object in a card's payload ({ kind, model, runsOn });
// without one there is no platform chip, and nothing is guessed from a name. Platforms show by name only: the makers'
// own marks need each owner's permission before Home may show them.
import type { ReactNode } from "react";
import type { BoardRecord } from "@tinyboilerplate/core/feed/sitrep";
import type { HomeFeedEntry } from "./feedStoreTypes";

/** What an agent says it is: its platform (`kind`), its model and where it runs, each as the agent reports it. */
export interface AgentProfile { platform?: string; model?: string; runsOn?: string }

// The usual names of the platforms on agents.tinycloud.xyz, by the `kind` an agent reports.
const PLATFORMS: Record<string, string> = {
  claude: "Claude", "claude-code": "Claude Code", chatgpt: "ChatGPT", codex: "Codex", cursor: "Cursor", gemini: "Gemini",
  grok: "Grok", hermes: "Hermes", muse: "Muse", openclaw: "OpenClaw", opencode: "OpenCode", perplexity: "Perplexity",
};

/** A reported platform by its usual name, or by the name the agent gave. */
export function platformName(kind: string): string {
  return PLATFORMS[kind.trim().toLowerCase().replace(/[\s_]+/g, "-")] ?? kind.trim();
}

const reported = (value: unknown) => typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : undefined;
/** The card's `payload.agent`, or undefined when the agent said nothing about itself. */
export function agentProfile(payload: Record<string, unknown> | undefined): AgentProfile | undefined {
  const agent = payload?.agent;
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) return undefined;
  const fields = agent as Record<string, unknown>;
  const kind = reported(fields.kind), model = reported(fields.model), runsOn = reported(fields.runsOn);
  if (!kind && !model && !runsOn) return undefined;
  return { ...(kind ? { platform: platformName(kind) } : {}), ...(model ? { model } : {}), ...(runsOn ? { runsOn } : {}) };
}

/** Who a card is from: a typed card's crew member (`from`), which may post through another agent's connection. */
export function cardAuthor(entry: HomeFeedEntry, record?: BoardRecord): { name: string; via?: string } {
  const from = record?.from.trim();
  return from && from !== entry.source.label ? { name: from, via: entry.source.label } : { name: entry.source.label };
}
/** One agent: the crew member named on its cards, within the connection that posts them. */
export function agentKey(entry: HomeFeedEntry, record?: BoardRecord): string {
  return JSON.stringify([entry.source.sourceId, cardAuthor(entry, record).name]);
}

// White letters on each of these pass 4.5:1, and each stands out on the light and the dark background.
const MARK_COLOURS = ["bg-sky-700", "bg-emerald-700", "bg-violet-700", "bg-amber-700", "bg-rose-700", "bg-teal-700", "bg-indigo-700", "bg-fuchsia-700"] as const;
/** An agent's colour, from its key (agentKey): the same agent always gets the same one. */
export function markColour(key: string): string {
  // FNV-1a, with its high bits folded in: a plain multiply-by-31 hash leaves the low bits to only a few characters.
  let hash = 0x811c9dc5;
  for (const char of key) hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193) >>> 0;
  return MARK_COLOURS[((hash ^ (hash >>> 16)) >>> 0) % MARK_COLOURS.length]!;
}
export const markLetter = (name: string) => (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toLocaleUpperCase();

/** The agent's mark. Its name is always written beside it, so the mark itself is not read out. */
export function AgentMark({ agentKey, name, size = "sm" }: { agentKey: string; name: string; size?: "sm" | "md" }) {
  return <span aria-hidden data-agent-mark className={`grid shrink-0 select-none place-items-center rounded-full font-semibold text-white ${size === "md" ? "size-9 text-sm" : "size-7 text-[12.5px]"} ${markColour(agentKey)}`}>{markLetter(name)}</span>;
}

/** The platform as a small chip beside the agent's name. */
export function PlatformChip({ name }: { name: string }) {
  return <span data-platform={name} className="inline-flex h-6 min-w-0 max-w-full shrink items-center truncate rounded-full px-2 text-[12.5px] font-medium shadow-[inset_0_0_0_1px_hsl(var(--border))]">{name}</span>;
}

/**
 * What the page knows about an agent, in plain rows: what it is, its model and where it runs as the agent reports
 * them, and what its connection lets it do. A fact the page does not have is left out. Home records neither when an
 * agent was connected nor when its access ends, and an agent is disconnected outside Home, so neither shows here.
 */
export function AgentDetails({ name, via, profile, onOpen }: { name: string; via?: string; profile?: AgentProfile; onOpen?: () => void }) {
  const rows: [string, ReactNode][] = [];
  if (profile?.platform) rows.push(["What it is", profile.platform]);
  if (profile?.model) rows.push(["Model", profile.model]);
  if (profile?.runsOn) rows.push(["Runs on", profile.runsOn]);
  if (via) rows.push(["Posts through", via]);
  rows.push(["It can", via ? `Reach you on cards ${via} posts, and read your answers to them` : "Post cards to your Home and read your answers to them"]);
  return <section aria-label={`About ${name}`} className="mt-3 space-y-2 rounded-xl bg-muted px-3 py-2.5 text-sm leading-[1.45]">
    <dl>{rows.map(([term, value]) => <div key={term} className="flex items-baseline justify-between gap-4 border-t border-border py-2 first:border-t-0 first:pt-0">
      <dt className="shrink-0 text-muted-foreground">{term}</dt><dd className="min-w-0 break-words text-right">{value}</dd>
    </div>)}</dl>
    {!profile && <p className="text-[13px] text-muted-foreground">{name} has not said what it is or where it runs.</p>}
    {onOpen && <button type="button" onClick={onOpen} className="inline-flex h-11 items-center rounded-full bg-background px-5 text-[13.5px] font-bold shadow-[inset_0_0_0_1px_hsl(var(--muted-foreground))] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground">Open conversation</button>}
  </section>;
}
