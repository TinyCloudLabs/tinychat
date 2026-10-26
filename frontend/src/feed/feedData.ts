export type FeedCard = {
  key: string;
  at: string;
  author: { name: string; avatar?: string };
  render: "post" | "image" | "thread" | "article" | "link" | "unknown";
  lead: { text: string; image?: string };
  replies?: { text: string }[];
  title?: string;
  body?: string;
  url?: string;
  source?: { label: string; url?: string; ref?: string };
};

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
