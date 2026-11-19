import { markColour, markLetter } from "./AgentMark";

/** Agents' marks overlapping in a row, as on the Agents pill and the Pending card. */
export function StackedMarks({ agents, size = "md" }: { agents: readonly { key: string; name: string }[]; size?: "sm" | "md" }) {
  return <span aria-hidden className="flex shrink-0">
    {agents.slice(0, 3).map((agent, index) => <span key={agent.key}
      className={`flex items-center justify-center rounded-full font-semibold text-white ring-2 ring-background ${markColour(agent.key)} ${size === "sm" ? "size-[22px] text-[11px]" : "size-[26px] text-[11px]"} ${index ? (size === "sm" ? "-ml-1.5" : "-ml-2") : ""}`}>{markLetter(agent.name)}</span>)}
  </span>;
}

/** The way into the agent view, at the right of Home's title line: the agents' marks, and a dot for unseen replies. */
export function AgentsPill({ agents, unread, open, onOpen }: { agents: readonly { key: string; name: string }[]; unread: boolean; open: boolean; onOpen: () => void }) {
  return <button type="button" onClick={onOpen} aria-pressed={open} aria-label={unread ? "Agents, new replies" : "Agents"}
    className="relative flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-border px-1.5 pr-3 text-sm font-medium aria-pressed:border-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <StackedMarks agents={agents} />
    <span>Agents</span>
    {unread && <span aria-hidden className="absolute right-1 top-1 size-2 rounded-full bg-foreground ring-2 ring-background" />}
  </button>;
}

