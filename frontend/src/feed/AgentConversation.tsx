// The agent view (Sam, 11-13: "there is no agent view i find"), ported from the feed lab's bridge-feed branch.
// Everything between the person and one agent, from the feed the page already loaded: the agent's cards, the
// person's answers and the messages both ways, in time order (AgentConversation). The list of agents with each one's
// latest line is the way in (AgentList), opened from the Agents pill on Home's title line or an agent's name on a
// card. Nothing here is stored or loaded separately. Replies stay on the cards: a card line opens its card.
import { ChevronLeftIcon } from "lucide-react";
import { NAV_LABEL_HOME } from "@/lib/homeStrings";
import type { FeedResponse } from "@tinycloud/sdk-services/feed";
import type { BoardRecord } from "@tinyboilerplate/core/feed/sitrep";
import { AgentDetails, AgentMark, agentProfile, PlatformName, type AgentProfile } from "./AgentMark";
import { answerSummary } from "./AnswerOptions";
import { answerHandling } from "./AnswerSteps";
import { plainConversation } from "./CardConversation";
import type { HomeFeedEntry } from "./feedStoreTypes";
import { ShortTime } from "./ShortTime";
import type { TypedCardContext } from "./sitrepProjection";

export interface AgentLine {
  at: string;
  /** A card the agent posted, something the person said, or something the agent said. */
  side: "card" | "you" | "agent";
  text: string;
  /** Under the line: who got it, or what came of it. */
  note?: string;
  entry: HomeFeedEntry;
}
export interface AgentThread {
  key: string;
  name: string;
  via?: string;
  lines: AgentLine[];
  /** Cards of this agent's that still need the person. */
  needsYou: number;
  /** Agent replies the person has not opened yet. */
  unread: number;
  /** What the agent said about itself on its newest card that says anything. */
  profile?: AgentProfile;
}

function linesOf(entry: HomeFeedEntry, context: TypedCardContext | undefined, agent: string): AgentLine[] {
  const card = entry.state.card;
  const lines: AgentLine[] = [{ at: card.createdAt, side: "card", text: card.title, entry }];
  const answers = entry.responses?.filter((response) => response.kind !== "message") ?? (entry.state.response ? [entry.state.response] : []);
  // What the agent reported back on an answer: its outcome's message.
  const outcomes = (responses: FeedResponse[]) => responses.flatMap((response) => {
    const { outcome } = answerHandling(entry, response.responseId);
    const message = outcome?.detail?.message;
    return outcome ? [{ at: outcome.createdAt, side: "agent" as const, text: typeof message === "string" ? message : outcome.phase === "failed" ? "It could not be done." : "Done.", note: outcome.phase === "failed" ? "Failed" : "Done", entry }] : [];
  });
  if (!context) {
    for (const response of answers) lines.push({ at: response.createdAt, side: "you", text: answerSummary(response.choiceId && (card.choices?.find((choice) => choice.id === response.choiceId)?.label ?? response.choiceId), response.text), note: `Sent to ${agent}`, entry });
    for (const line of plainConversation(entry)) lines.push({ at: line.at, side: line.mine ? "you" : "agent", text: line.text, ...(line.mine ? { note: line.received ? `${agent} received it` : `Sent to ${agent}` } : {}), entry });
    return [...lines, ...outcomes(answers)];
  }
  const { record, owner } = context;
  const mine = (row: { card: { kind: string; id: string } }) => row.card.kind === record.kind && row.card.id === record.id;
  for (const { value } of owner.answers.filter(mine)) {
    const label = record.kind === "ask" ? record.options.find((option) => option.id === value.choice)?.label ?? value.choice : value.choice;
    const text = value.action === "drop" ? "You dropped this question" : value.action === "code" ? "You saved the approval code" : value.action === "done" ? "You gave the go" : answerSummary(label, value.text);
    lines.push({ at: value.at, side: "you", text, note: `Sent to ${agent}`, entry });
  }
  for (const decision of owner.claimDecisions.filter(mine)) lines.push({ at: decision.value.at, side: "you", text: `You chose to ${decision.value.choice} this claim`, entry });
  for (const message of owner.threads.filter((item) => item.kind === record.kind && item.id === record.id)) {
    lines.push(message.side === "officer"
      ? { at: message.at, side: "agent", text: message.text, ...(message.from !== agent ? { note: message.from } : {}), entry }
      : { at: message.at, side: "you", text: message.text, note: `Sent to ${agent}`, entry });
  }
  return [...lines, ...outcomes(answers)];
}

/** Every agent in the feed with its lines in time order, newest activity first. `key` is the page's agent key. */
export function agentThreads(entries: readonly HomeFeedEntry[], options: {
  contextFor: (entry: HomeFeedEntry) => TypedCardContext | undefined;
  author: (entry: HomeFeedEntry, record?: BoardRecord) => { name: string; via?: string };
  key: (entry: HomeFeedEntry, record?: BoardRecord) => string;
  needsYou: (entry: HomeFeedEntry) => boolean;
  unread: (entry: HomeFeedEntry) => number;
}): AgentThread[] {
  const agents = new Map<string, AgentThread>();
  const profiled = new Map<string, string>();
  for (const entry of entries) {
    const context = options.contextFor(entry);
    const author = options.author(entry, context?.record);
    const key = options.key(entry, context?.record);
    const agent = agents.get(key) ?? agents.set(key, { key, ...author, lines: [], needsYou: 0, unread: 0 }).get(key)!;
    agent.lines.push(...linesOf(entry, context, author.name));
    if (options.needsYou(entry)) agent.needsYou++;
    agent.unread += options.unread(entry);
    const profile = agentProfile(entry.state.card.payload);
    if (profile && (profiled.get(key) ?? "") <= entry.state.card.createdAt) { agent.profile = profile; profiled.set(key, entry.state.card.createdAt); }
  }
  for (const agent of agents.values()) agent.lines.sort((a, b) => a.at.localeCompare(b.at));
  return [...agents.values()].sort((a, b) => (b.lines.at(-1)?.at ?? "").localeCompare(a.lines.at(-1)?.at ?? ""));
}

/** "6 min", "3 h", "2 d": how long ago, for the list of agents. */
export function ago(at: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(at)) / 60_000));
  return minutes < 1 ? "now" : minutes < 60 ? `${minutes} min` : minutes < 24 * 60 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / (24 * 60))} d`;
}
const lineText = (line: AgentLine) => line.side === "card" ? `Card · ${line.text}` : line.side === "you" ? `You: ${line.text}` : line.text;

export function AgentList({ agents, now, onOpen, onBack }: { agents: AgentThread[]; now: number; onOpen: (key: string) => void; onBack: () => void }) {
  return <section aria-label="Your agents" className="space-y-3">
    <button type="button" onClick={onBack} className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-xl border border-border px-3 text-[13px] font-medium fine:min-h-10"><ChevronLeftIcon aria-hidden className="size-4" />{NAV_LABEL_HOME}</button>
    <h2 className="font-display text-xl font-semibold">Your agents</h2>
    {!agents.length && <p className="text-sm text-muted-foreground">No agent has posted yet.</p>}
    <ul className="space-y-2">{agents.map((agent) => {
      const last = agent.lines.at(-1);
      return <li key={agent.key}><button type="button" onClick={() => onOpen(agent.key)} className="flex min-h-11 w-full items-start gap-3 rounded-2xl border border-border bg-card px-3.5 py-3 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <AgentMark agentKey={agent.key} name={agent.name} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2"><span className="min-w-0 flex-1 break-words font-semibold">{agent.name}{agent.via && <span className="font-normal text-muted-foreground"> · via {agent.via}</span>}</span>{last && <time dateTime={last.at} className="shrink-0 text-xs text-muted-foreground">{ago(last.at, now)}</time>}</span>
          {agent.profile?.platform && <span className="mt-1 flex text-xs text-muted-foreground"><PlatformName platform={agent.profile.platform} /></span>}
          {(agent.needsYou > 0 || agent.unread > 0) && <span className="mt-1 block text-xs font-medium">{[agent.needsYou > 0 && `Needs you: ${agent.needsYou} ${agent.needsYou > 1 ? "cards" : "card"}`, agent.unread > 0 && `${agent.unread} new ${agent.unread > 1 ? "replies" : "reply"}`].filter(Boolean).join(" · ")}</span>}
          {last && <span className="mt-1 line-clamp-2 block break-words text-muted-foreground">{lineText(last)}</span>}
        </span>
      </button></li>;
    })}</ul>
  </section>;
}

export function AgentConversation({ agent, onBack, onOpenCard }: { agent: AgentThread; onBack: () => void; onOpenCard: (entry: HomeFeedEntry) => void }) {
  return <section aria-label={`Conversation with ${agent.name}`} className="space-y-4">
    <button type="button" onClick={onBack} className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-xl border border-border px-3 text-[13px] font-medium fine:min-h-10"><ChevronLeftIcon aria-hidden className="size-4" />Agents</button>
    <div className="space-y-3 rounded-2xl border border-foreground/20 bg-card p-4 shadow-float">
      <div className="flex min-w-0 items-center gap-3">
        <AgentMark agentKey={agent.key} name={agent.name} />
        <h2 className="min-w-0 flex-1 break-words font-display text-xl font-semibold">{agent.name}{agent.via && <span className="font-sans text-sm font-normal text-muted-foreground"> · via {agent.via}</span>}</h2>
        {agent.profile?.platform && <PlatformName platform={agent.profile.platform} chip />}
      </div>
      <AgentDetails name={agent.name} via={agent.via} profile={agent.profile} />
    </div>
    <ol aria-label="Everything in time order" className="space-y-2 text-sm">
      {agent.lines.map((line, index) => <li key={`${line.at}:${index}`} className={line.side === "you" ? "ml-8 rounded-xl bg-muted/50 p-3" : line.side === "agent" ? "mr-8 rounded-xl border border-border bg-card p-3" : ""}>
        {line.side === "card"
          ? <button type="button" onClick={() => onOpenCard(line.entry)} className="block min-h-11 w-full rounded-xl border border-dashed border-border px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><span className="block text-xs text-muted-foreground">Card · <ShortTime at={line.at} /></span><span className="break-words font-medium">{line.text}</span></button>
          : <><p className="whitespace-pre-wrap break-words">{line.text}</p><p className="mt-1 text-xs text-muted-foreground"><ShortTime at={line.at} />{line.note && ` · ${line.note}`}</p></>}
      </li>)}
    </ol>
    <p className="text-sm text-muted-foreground">To reply to {agent.name}, open one of its cards.</p>
  </section>;
}
