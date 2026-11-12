// Everything between the owner and one agent (from Hunter's bridge-feed design), from the feed the page already
// loaded: the agent's cards, the owner's answers, and the comments both ways, in time order (AgentConversation). The
// list of agents, each with its latest line, is the way in (AgentList). Nothing here is stored, loaded or sent: a
// card line opens that card in the feed, where its answers and comments go through the card's own paths.
import { ChevronLeftIcon } from "lucide-react";
import type { FeedResponse } from "@tinycloud/sdk-services/feed";
import { NAV_LABEL_HOME } from "@/lib/homeStrings";
import { AgentDetails, AgentMark, agentKey, agentProfile, cardAuthor, PlatformChip, type AgentProfile } from "./AgentMark";
import { cardTime, COMMENT_COPY, focusRing, optionText } from "./cardKit";
import type { HomeFeedEntry } from "./feedStoreTypes";
import type { ThreadItem } from "./HomeCardThread";
import type { TypedCardContext } from "./sitrepProjection";

export interface AgentLine {
  at: string;
  /** A card the agent posted, something the owner said, or something the agent said. */
  side: "card" | "you" | "agent";
  text: string;
  /** Under the line: who said it, when that is not the agent, or that the agent got it. */
  note?: string;
  entry: HomeFeedEntry;
}
export interface AgentThread {
  key: string;
  name: string;
  via?: string;
  lines: AgentLine[];
  /** Cards of this agent's that still need the owner. */
  needsYou: number;
  /** What the agent said about itself on its newest card that says anything. */
  profile?: AgentProfile;
}

function linesOf(entry: HomeFeedEntry, context: TypedCardContext | undefined, agent: string, comments: readonly ThreadItem[]): AgentLine[] {
  const card = entry.state.card;
  const lines: AgentLine[] = [{ at: card.createdAt, side: "card", text: card.title, entry }];
  const finished = (phase: string) => phase === "succeeded" ? `${entry.source.label} finished it.` : `${entry.source.label} couldn't finish it.`;
  if (context) {
    const { record, owner } = context;
    for (const { value } of owner.answers.filter((answer) => answer.card.kind === record.kind && answer.card.id === record.id)) {
      const label = value.choice && record.kind === "ask" ? record.options.find((option) => option.id === value.choice)?.label : undefined;
      const said = value.action === "code" ? "Code saved privately" : value.action === "drop" ? "Dropped" : value.action === "done" ? "Done"
        : label ? `Chose ${optionText(label)}` : value.choice ? "Chose an option no longer listed" : "";
      lines.push({ at: value.at, side: "you", text: [said, value.action !== "code" ? value.text : ""].filter(Boolean).join(" · "), entry });
    }
  } else {
    const answers = entry.responses?.filter((response) => response.kind !== "message") ?? (entry.state.response ? [entry.state.response] : []);
    for (const response of answers) {
      const label = response.choiceId && card.choices?.find((choice) => choice.id === response.choiceId)?.label;
      lines.push({ at: response.createdAt, side: "you", text: [label && `Chose ${optionText(label)}`, response.text].filter(Boolean).join(" · "), entry });
    }
  }
  const outcomes: FeedResponse[] = entry.responses?.filter((response) => response.kind !== "message") ?? (entry.state.response ? [entry.state.response] : []);
  for (const response of outcomes) {
    const outcome = entry.responseHandling?.[response.responseId]?.outcome ?? (entry.state.outcome?.responseId === response.responseId ? entry.state.outcome : null);
    if (!outcome) continue;
    const message = outcome.detail?.message;
    lines.push({ at: outcome.createdAt, side: "agent", text: typeof message === "string" ? message : finished(outcome.phase), entry });
  }
  for (const item of comments) {
    lines.push(item.mine
      ? { at: item.at, side: "you", text: item.text, entry }
      : { at: item.at, side: "agent", text: item.text, ...(item.speaker !== agent ? { note: item.speaker } : {}), entry });
  }
  return lines;
}

/** Every agent in the feed with its lines in time order, the one with the newest line first. */
export function agentThreads(entries: readonly HomeFeedEntry[], contextFor: (entry: HomeFeedEntry) => TypedCardContext | undefined, commentsOf: (entry: HomeFeedEntry) => readonly ThreadItem[], needsYou: (entry: HomeFeedEntry) => boolean): AgentThread[] {
  const agents = new Map<string, AgentThread>();
  const profiled = new Map<string, string>();
  for (const entry of entries) {
    const context = contextFor(entry);
    const author = cardAuthor(entry, context?.record);
    const key = agentKey(entry, context?.record);
    let agent = agents.get(key);
    if (!agent) { agent = { key, ...author, lines: [], needsYou: 0 }; agents.set(key, agent); }
    agent.lines.push(...linesOf(entry, context, author.name, commentsOf(entry)));
    if (needsYou(entry)) agent.needsYou++;
    const profile = agentProfile(entry.state.card.payload);
    if (profile && (profiled.get(key) ?? "") <= entry.state.card.createdAt) { agent.profile = profile; profiled.set(key, entry.state.card.createdAt); }
  }
  for (const agent of agents.values()) agent.lines.sort((a, b) => a.at.localeCompare(b.at));
  return [...agents.values()].sort((a, b) => (b.lines.at(-1)?.at ?? "").localeCompare(a.lines.at(-1)?.at ?? ""));
}

const backClass = `inline-flex h-11 items-center gap-1 rounded-full pl-3 pr-4 text-[13.5px] font-bold shadow-[inset_0_0_0_1px_hsl(var(--muted-foreground))] hover:bg-muted ${focusRing}`;

export function AgentList({ agents, now, onOpen, onBack }: { agents: readonly AgentThread[]; now: number; onOpen: (key: string) => void; onBack: () => void }) {
  return <section aria-labelledby="home-agents-title" className="mt-6 space-y-3">
    <button type="button" onClick={onBack} className={backClass}><ChevronLeftIcon aria-hidden className="size-4" />{NAV_LABEL_HOME}</button>
    <h2 id="home-agents-title" className="text-[17px] font-semibold">Your agents</h2>
    {!agents.length && <p className="text-[15px] text-muted-foreground">No agent has posted yet.</p>}
    <ul className="grid grid-cols-[minmax(0,1fr)] gap-3">{agents.map((agent) => {
      const last = agent.lines.at(-1);
      return <li key={agent.key}><button type="button" onClick={() => onOpen(agent.key)} className={`flex w-full min-w-0 items-start gap-3 rounded-[20px] bg-card py-3.5 pl-[18px] pr-4 text-left text-sm shadow-[inset_0_0_0_1px_hsl(var(--border))] hover:bg-muted ${focusRing}`}>
        <AgentMark agentKey={agent.key} name={agent.name} size="md" />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2"><span className="min-w-0 flex-1 break-words font-semibold">{agent.name}{agent.via && <span className="font-normal text-muted-foreground"> · via {agent.via}</span>}</span>{last && <time dateTime={last.at} className="shrink-0 text-[13px] tabular-nums text-muted-foreground">{cardTime(last.at, now)}</time>}</span>
          {agent.profile?.platform && <span className="mt-1 flex"><PlatformChip name={agent.profile.platform} /></span>}
          {agent.needsYou > 0 && <span className="mt-1 block text-[13px] font-semibold">Needs you <span className="tabular-nums">{agent.needsYou}</span></span>}
          {last && <span className="mt-1 line-clamp-2 block break-words text-muted-foreground">{last.side === "you" ? `${COMMENT_COPY.you}: ${last.text}` : last.text}</span>}
        </span>
      </button></li>;
    })}</ul>
  </section>;
}

export function AgentConversation({ agent, now, onBack, onOpenCard }: { agent: AgentThread; now: number; onBack: () => void; onOpenCard: (entry: HomeFeedEntry) => void }) {
  return <section aria-label={`Conversation with ${agent.name}`} className="mt-6 space-y-4">
    <button type="button" onClick={onBack} className={backClass}><ChevronLeftIcon aria-hidden className="size-4" />Agents</button>
    <div className="rounded-[20px] bg-card py-4 pl-[18px] pr-4 shadow-[inset_0_0_0_1px_hsl(var(--border))]">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <AgentMark agentKey={agent.key} name={agent.name} size="md" />
        <h2 className="min-w-0 flex-1 break-words text-[17px] font-semibold">{agent.name}{agent.via && <span className="text-sm font-normal text-muted-foreground"> · via {agent.via}</span>}</h2>
        {agent.profile?.platform && <PlatformChip name={agent.profile.platform} />}
      </div>
      <AgentDetails name={agent.name} via={agent.via} profile={agent.profile} />
    </div>
    <ol aria-label="Everything in time order" className="space-y-2 text-[15px] leading-[1.45]">
      {agent.lines.map((line, index) => <li key={`${line.at}:${index}`} className={line.side === "you" ? "ml-8 rounded-xl bg-muted px-3 py-2.5" : line.side === "agent" ? "mr-8 rounded-xl px-3 py-2.5 shadow-[inset_0_0_0_1px_hsl(var(--border))]" : ""}>
        {line.side === "card"
          ? <button type="button" onClick={() => onOpenCard(line.entry)} className={`block min-h-11 w-full rounded-xl px-3 py-2 text-left shadow-[inset_0_0_0_1px_hsl(var(--muted-foreground))] hover:bg-muted ${focusRing}`}><span className="block text-[13px] text-muted-foreground">Card · <time dateTime={line.at}>{cardTime(line.at, now)}</time></span><span className="break-words font-semibold">{line.text}</span></button>
          : <><p className="whitespace-pre-wrap break-words">{line.text}</p><p className="mt-0.5 text-[13px] text-muted-foreground"><time dateTime={line.at}>{cardTime(line.at, now)}</time>{line.note && ` · ${line.note}`}</p></>}
      </li>)}
    </ol>
  </section>;
}
