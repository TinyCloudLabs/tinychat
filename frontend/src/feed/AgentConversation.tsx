// Everything between the person and one agent, from the feed the page already loaded: the agent's cards, the
// person's answers and the messages both ways, in time order, with one reply box (AgentConversation). The list of
// agents with each one's latest line is the way in (AgentList). Nothing here is stored or loaded separately.
import { ChevronLeftIcon } from "lucide-react";
import type { FeedResponse } from "@tinycloud/sdk-services/feed";
import type { BoardRecord } from "@tinyboilerplate/core/feed/sitrep";
import { answerSummary } from "./AnswerOptions";
import { answerHandling } from "./AnswerSteps";
import { cardAuthor, ReplyBox, replyRoute, usePostReply } from "./CardReply";
import type { HomeFeedEntry, HomeFeedSource } from "./feedStoreTypes";
import { cardThread, messageRecipient } from "./HomeCardThread";
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
  /** The newest card that can take a reply. */
  replyCard?: { entry: HomeFeedEntry; record: BoardRecord };
}

/** One agent: the crew member named on its cards, within the connection that posts them. */
export function agentKey(entry: HomeFeedEntry, record?: BoardRecord): string {
  return JSON.stringify([entry.source.sourceId, cardAuthor(entry, record).name]);
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
    return [...lines, ...outcomes(answers)];
  }
  const { record, owner } = context;
  for (const { value } of owner.answers.filter((answer) => answer.card.kind === record.kind && answer.card.id === record.id)) {
    const label = record.kind === "ask" ? record.options.find((option) => option.id === value.choice)?.label ?? value.choice : value.choice;
    const text = value.action === "drop" ? "You dropped this question" : value.action === "code" ? "You saved the approval code" : value.action === "done" ? "You gave the go" : answerSummary(label, value.text);
    lines.push({ at: value.at, side: "you", text, note: `Sent to ${agent}`, entry });
  }
  for (const decision of owner.claimDecisions.filter((row) => row.card.kind === record.kind && row.card.id === record.id)) lines.push({ at: decision.value.at, side: "you", text: `You chose to ${decision.value.choice} this claim`, entry });
  for (const { message, header } of cardThread(entry, record, owner)) {
    if (message.side === "officer") { lines.push({ at: message.at, side: "agent", text: message.text, ...(message.from !== agent ? { note: message.from } : {}), entry }); continue; }
    const to = messageRecipient(entry, record, message);
    const { acknowledgement, outcome } = header ? answerHandling(entry, header.responseId) : { acknowledgement: null, outcome: null };
    lines.push({ at: message.at, side: "you", text: message.text, note: acknowledgement || outcome ? `${to} received it` : `Sent to ${to}`, entry });
  }
  return [...lines, ...outcomes(answers)];
}

/** Every agent in the feed with its lines in time order, newest activity first. */
export function agentThreads(entries: readonly HomeFeedEntry[], contextFor: (entry: HomeFeedEntry) => TypedCardContext | undefined, source: HomeFeedSource, needsYou: (entry: HomeFeedEntry) => boolean): AgentThread[] {
  const agents = new Map<string, AgentThread>();
  for (const entry of entries) {
    const context = contextFor(entry);
    const author = cardAuthor(entry, context?.record);
    const key = agentKey(entry, context?.record);
    const agent = agents.get(key) ?? agents.set(key, { key, ...author, lines: [], needsYou: 0 }).get(key)!;
    agent.lines.push(...linesOf(entry, context, author.name));
    if (needsYou(entry)) agent.needsYou++;
    if (context && replyRoute(entry, context.record, source).to && (!agent.replyCard || agent.replyCard.entry.state.card.createdAt < entry.state.card.createdAt)) agent.replyCard = { entry, record: context.record };
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

export function AgentList({ agents, now, onOpen }: { agents: AgentThread[]; now: number; onOpen: (key: string) => void }) {
  return <section aria-label="Your agents" className="space-y-2">
    <h2 className="font-display text-xl font-semibold">Your agents</h2>
    {!agents.length && <p className="text-sm text-muted-foreground">No agent has posted yet.</p>}
    <ul className="space-y-2">{agents.map((agent) => {
      const last = agent.lines.at(-1);
      return <li key={agent.key}><button type="button" onClick={() => onOpen(agent.key)} className="block min-h-11 w-full rounded-xl border border-border bg-card px-3 py-2 text-left text-sm">
        <span className="flex items-baseline gap-2"><span className="min-w-0 flex-1 break-words font-semibold">{agent.name}{agent.via && <span className="font-normal text-muted-foreground"> · via {agent.via}</span>}</span>{last && <time dateTime={last.at} className="shrink-0 text-xs text-muted-foreground">{ago(last.at, now)}</time>}</span>
        {agent.needsYou > 0 && <span className="mt-1 block text-xs font-medium">Needs you: {agent.needsYou} {agent.needsYou > 1 ? "cards" : "card"}</span>}
        {last && <span className="mt-1 line-clamp-2 block break-words text-muted-foreground">{lineText(last)}</span>}
      </button></li>;
    })}</ul>
  </section>;
}

export function AgentConversation({ agent, source, onSaved, onBack, onOpenCard }: {
  agent: AgentThread;
  source: HomeFeedSource;
  onSaved: (entry: HomeFeedEntry, response: FeedResponse) => void;
  onBack: () => void;
  onOpenCard: (entry: HomeFeedEntry) => void;
}) {
  return <section aria-label={`Conversation with ${agent.name}`} className="space-y-4">
    <div className="flex items-center gap-2">
      <button type="button" onClick={onBack} className="inline-flex min-h-10 shrink-0 items-center gap-1 rounded-lg border border-border px-3 text-sm"><ChevronLeftIcon aria-hidden className="size-4" />Agents</button>
      <h2 className="min-w-0 break-words font-display text-xl font-semibold">{agent.name}{agent.via && <span className="font-sans text-sm font-normal text-muted-foreground"> · via {agent.via}</span>}</h2>
    </div>
    <ol aria-label="Everything in time order" className="space-y-2 text-sm">
      {agent.lines.map((line, index) => <li key={`${line.at}:${index}`} className={line.side === "you" ? "ml-8 rounded-xl bg-muted/50 p-3" : line.side === "agent" ? "mr-8 rounded-xl border border-border bg-card p-3" : ""}>
        {line.side === "card"
          ? <button type="button" onClick={() => onOpenCard(line.entry)} className="block min-h-10 w-full rounded-xl border border-dashed border-border px-3 py-2 text-left"><span className="block text-xs text-muted-foreground">Card · <time dateTime={line.at}>{new Date(line.at).toLocaleString()}</time></span><span className="break-words font-medium">{line.text}</span></button>
          : <><p className="whitespace-pre-wrap break-words">{line.text}</p><p className="mt-1 text-xs text-muted-foreground"><time dateTime={line.at}>{new Date(line.at).toLocaleString()}</time>{line.note && ` · ${line.note}`}</p></>}
      </li>)}
    </ol>
    {agent.replyCard ? <AgentReply key={agent.replyCard.entry.state.card.cardId} {...agent.replyCard} source={source} onSaved={onSaved} /> : <p role="status" className="text-sm text-muted-foreground">You can’t reply to {agent.name} here: none of its cards takes replies.</p>}
  </section>;
}

function AgentReply({ entry, record, source, onSaved }: { entry: HomeFeedEntry; record: BoardRecord; source: HomeFeedSource; onSaved: (entry: HomeFeedEntry, response: FeedResponse) => void }) {
  const route = replyRoute(entry, record, source);
  const post = usePostReply(entry, record, source, onSaved);
  return route.to ? <ReplyBox to={route.to} about={entry.state.card.title} onSend={(text) => post(text, route.delivery)} /> : null;
}
