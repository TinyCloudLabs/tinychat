export type FeedCard = {
  v: 1;
  id: string;
  at: string;
  author: { name: string; avatar?: string };
  render: "post" | "image" | "thread" | "article" | "link";
  lead: string;
  body?: string;
  image?: { src: string; alt: string };
  replies?: { author: string; text: string; at: string }[];
  title?: string;
  summary?: string;
  markdown?: string;
  url?: string;
  tldr?: string;
  source?: { label: string; url?: string };
};

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const iso = (value: unknown): value is string => text(value) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && !Number.isNaN(Date.parse(value));
const localImage = (value: unknown): value is string =>
  text(value) && /^\/home-feed-[a-z0-9-]+\.(?:svg|png)$/.test(value);
const safeUrl = (value: unknown): value is string => {
  if (!text(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

function parseCard(value: unknown): FeedCard | null {
  if (!record(value) || value.v !== 1 || !text(value.id) || !iso(value.at) ||
    !record(value.author) || !text(value.author.name) || !text(value.lead) ||
    !["post", "image", "thread", "article", "link"].includes(String(value.render))) return null;
  const author: FeedCard["author"] = { name: value.author.name };
  if (localImage(value.author.avatar)) author.avatar = value.author.avatar;
  const card: FeedCard = { v: 1, id: value.id, at: value.at, author, render: value.render as FeedCard["render"], lead: value.lead };
  if (text(value.body)) card.body = value.body;
  if (record(value.image) && localImage(value.image.src) && text(value.image.alt))
    card.image = { src: value.image.src, alt: value.image.alt };
  if (Array.isArray(value.replies)) card.replies = value.replies
    .filter((reply: unknown) => record(reply) && text(reply.author) && text(reply.text) && iso(reply.at))
    .map((reply: RecordValue) => ({ author: reply.author as string, text: reply.text as string, at: reply.at as string }));
  for (const field of ["title", "summary", "markdown", "tldr"] as const)
    if (text(value[field])) card[field] = value[field];
  if (safeUrl(value.url)) card.url = value.url;
  if (record(value.source) && text(value.source.label)) {
    card.source = { label: value.source.label };
    if (safeUrl(value.source.url)) card.source.url = value.source.url;
  }
  return card;
}

export function parseFeed(value: unknown): FeedCard[] {
  return Array.isArray(value) ? value.flatMap((entry) => {
    const card = parseCard(entry);
    return card ? [card] : [];
  }) : [];
}
