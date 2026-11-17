import type { FeedSource } from "@tinycloud/sdk-services/feed";

export type FeedCard = {
  key: string;
  at: string;
  /** `via`: the agent whose connection posted a card for the named author. */
  author: { name: string; avatar?: string; via?: string };
  render: "post" | "image" | "thread" | "article" | "link" | "unknown";
  lead: { text: string; image?: string };
  replies?: { text: string }[];
  title?: string;
  body?: string;
  url?: string;
  source?: { label: string; url?: string; ref?: string };
  /** What kind of task the card is (`payload.type`); absent when the card names none or one this app doesn't know. */
  type?: CardType;
  /**
   * A message another team sent over Courier, drawn as the Courier mark: on a Home card, set only by courierMessage, so
   * only when the card's verified publisher is Courier. `from` is its sender (`payload.source.label`).
   */
  courier?: { from?: string };
};

/**
 * The task types a card can name in `payload.type`, in precedence order: when two fit, the earlier one wins. The first
 * ten need a tap; News and Alert need none.
 */
export const CARD_TYPES = [
  { id: "spend", label: "Spend" },
  { id: "publish", label: "Publish" },
  { id: "send", label: "Send" },
  { id: "access", label: "Access" },
  { id: "rule", label: "Rule" },
  { id: "ship", label: "Ship" },
  { id: "do", label: "Do" },
  { id: "review", label: "Review" },
  { id: "direction", label: "Direction" },
  { id: "answer", label: "Answer" },
  { id: "news", label: "News" },
  { id: "alert", label: "Alert" },
] as const;
export type CardType = (typeof CARD_TYPES)[number]["id"];
/** The types whose tap makes something leave the building: money, a public post, words to someone, access. */
export const OUTBOUND_TYPES: ReadonlySet<CardType> = new Set(["spend", "publish", "send", "access"]);
export const cardTypeLabel = (type: CardType): string => CARD_TYPES.find((entry) => entry.id === type)!.label;

/** `payload.type` when it is one of CARD_TYPES; anything else is ignored, never an error. */
export function parseCardType(value: unknown): CardType | undefined {
  return CARD_TYPES.find((entry) => entry.id === value)?.id;
}

/**
 * The registry token of the owner's Courier connection: the `agent_id` of its row in the owner's `feed_agents`, which
 * the store hands on as its FeedSource's `sourceId`. Only cards read through that source carry the Courier mark.
 */
export const COURIER_SOURCE_ID = "courier";
/**
 * The output database the store reads that connection's cards from: feedResourceNames("xyz.tinycloud.tinychat/feed",
 * COURIER_SOURCE_ID).outputResource, as feedStore readFeed builds and checks it (a test pins the two together).
 */
export const COURIER_OUTPUT_DATABASE = `xyz.tinycloud.tinychat/feed/feed_output_${COURIER_SOURCE_ID}`;

/**
 * Whether a card's verified publisher is Courier: the registered source the store read it through is Courier's on both
 * counts the owner's registry holds, its `agent_id` and the output database the card was read from. The owner sets the
 * token when they connect the agent, the registry binds it to one agent DID, and only that agent's grant writes that
 * database. Never the source's label, which is presentation only, and never anything a card says about itself.
 */
export function isCourierPublisher(source: Pick<FeedSource, "sourceId" | "output">): boolean {
  return source.sourceId === COURIER_SOURCE_ID && source.output.database === COURIER_OUTPUT_DATABASE;
}

/**
 * `payload.channel: "courier"`, with its sender from `payload.source.label` when there is one; any other channel is
 * ignored. This is only what the card says: any agent can write it. The Courier mark comes from courierMessage.
 */
export function parseCourier(payload: unknown): FeedCard["courier"] {
  if (!record(payload) || payload.channel !== "courier") return undefined;
  const from = record(payload.source) && text(payload.source.label) ? payload.source.label.trim() : undefined;
  return from ? { from } : {};
}

/**
 * A Home card's Courier mark and sender: only when its verified publisher is Courier (isCourierPublisher) and the card
 * says `channel: "courier"`. From any other source `payload.channel` is ignored, so the card shows as its own agent's.
 */
export function courierMessage(source: Pick<FeedSource, "sourceId" | "output">, payload: unknown): FeedCard["courier"] {
  return isCourierPublisher(source) ? parseCourier(payload) : undefined;
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const utc = (value: unknown): value is string => text(value) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) &&
  !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
const botSlug = /^[a-z0-9-]+$/;
const cardKey = /^([a-z0-9-]+)\/(\d{4}-\d\d)\/(\d{4}-\d\d-\d\dT\d{6}Z-[a-z0-9-]+)$/;
const folderKey = (value: unknown, bot: string): value is string =>
  text(value) && value.startsWith(`${bot}/`) && /^[A-Za-z0-9/\-._~:+@=,]+$/.test(value) &&
  value.split("/").every((part) => part !== "." && part !== ".." && part.length > 0);

export const safeUrl = (value: unknown): value is string => {
  if (!text(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

function parseCard(key: string, value: unknown, profiles: Map<string, FeedCard["author"]>): FeedCard | null {
  const match = cardKey.exec(key);
  if (!match || !record(value) || value.v !== 1 || !utc(value.at) || !record(value.lead) || !text(value.lead.text)) return null;
  const bot = match[1]!;
  if (match[2] !== value.at.slice(0, 7)) return null;
  const render = ["post", "image", "thread", "article", "link"].includes(String(value.render))
    ? value.render as FeedCard["render"] : "unknown";
  const lead: FeedCard["lead"] = { text: value.lead.text };
  if (folderKey(value.lead.image, bot)) lead.image = value.lead.image;
  const card: FeedCard = { key, at: value.at, author: profiles.get(bot) ?? { name: bot }, render, lead };
  if (Array.isArray(value.replies) && render === "thread") card.replies = value.replies
    .filter((reply: unknown) => record(reply) && text(reply.text))
    .map((reply: RecordValue) => ({ text: reply.text as string }));
  if (render === "article") {
    if (text(value.title)) card.title = value.title;
    if (folderKey(value.body, bot) && value.body.endsWith(".md")) card.body = value.body;
  }
  if (render === "link" && text(value.url)) card.url = value.url;
  const source = parseSource(value.source);
  if (source) card.source = source;
  const type = parseCardType(value.type);
  if (type) card.type = type;
  // The sample feed's cards have no registered source to verify, so they never carry a Courier mark or sender.
  return card;
}

function parseSource(value: unknown): FeedCard["source"] | undefined {
  if (!record(value) || !text(value.label)) return undefined;
  if (safeUrl(value.url)) return { label: value.label, url: value.url };
  if (text(value.ref) && /^[A-Za-z0-9/\-._~:+@=,]+$/.test(value.ref)) return { label: value.label, ref: value.ref };
  return undefined;
}

export function parseFeed(value: unknown): FeedCard[] {
  if (!Array.isArray(value)) return [];
  const profiles = new Map<string, FeedCard["author"]>();
  for (const entry of value) {
    if (!record(entry) || !text(entry.key) || !entry.key.endsWith("/profile") || !record(entry.value)) continue;
    const bot = entry.key.slice(0, -"/profile".length);
    const profile = entry.value;
    if (!botSlug.test(bot) || profile.v !== 1 || !text(profile.name) || !text(profile.client) || !text(profile.about)) continue;
    const author: FeedCard["author"] = { name: profile.name };
    if (folderKey(profile.avatar, bot)) author.avatar = profile.avatar;
    profiles.set(bot, author);
  }
  const cards: FeedCard[] = [];
  for (const entry of value) {
    if (!record(entry) || !text(entry.key)) continue;
    const card = parseCard(entry.key, entry.value, profiles);
    if (card) cards.push(card);
  }
  return cards.sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key));
}

export function selectFeed(realEntries: unknown, sampleEntries: unknown): { cards: FeedCard[]; sample: boolean } {
  const real = parseFeed(realEntries);
  return real.length ? { cards: real, sample: false } : { cards: parseFeed(sampleEntries), sample: true };
}
