// TrustBot's reads of the owner's feed cards and chats. Read only, through the owner's grant to TrustBot (areas.ts:
// `feed` and `chats`). The feed's agent registry is `home_feed`; each agent's cards sit in its own output database
// under `feed/`; chats are the `threads` database. Every statement is a fixed SELECT that projects and caps what it
// returns, and every database name is checked against those three places before a query is sent.
// Details: TC-3794

import type { DelegatedAccess } from "@tinyboilerplate/server";

export const APP_PREFIX = "xyz.tinycloud.tinychat";
export const THREADS_DATABASE = `${APP_PREFIX}/threads`;
export const HOME_FEED_DATABASE = `${APP_PREFIX}/home_feed`;
export const FEED_PREFIX = `${APP_PREFIX}/feed`;

export const LIST_DEFAULT = 20;
export const LIST_MAX = 50;
export const CHAT_MESSAGES_DEFAULT = 40;
export const CHAT_MESSAGES_MAX = 100;
const AGENTS_MAX = 50;
const TITLE_CHARS = 200;
const LABEL_CHARS = 100;
const KIND_CHARS = 64;
const TIME_CHARS = 64;
const ID_CHARS = 128;
const QUERY_CHARS = 100;
const CHOICES_MAX = 20;
export const CARD_BODY_CHARS = 20_000;
export const CARD_PAYLOAD_CHARS = 8_000;
export const MESSAGE_CHARS = 4_000;

const FEED_OUTPUT = /^feed_output_([A-Za-z0-9_-]+)$/;

/** One read-only SELECT against one database in the owner's applications space; rows as arrays. */
export interface FeedChatSql {
  query(database: string, sql: string, params: Array<string | number | null>): Promise<unknown[][]>;
}

export class FeedChatReadError extends Error {
  constructor(readonly code: "invalid" | "not_found" | "out_of_scope") {
    super(code);
    this.name = "FeedChatReadError";
  }
}

/** A feed agent's output database: `xyz.tinycloud.tinychat/feed/feed_output_<token>`, nothing else. */
export function isFeedOutputDatabase(database: string): boolean {
  if (!database.startsWith(`${FEED_PREFIX}/`)) return false;
  return FEED_OUTPUT.test(database.slice(FEED_PREFIX.length + 1));
}

/** The only databases these tools read. */
export function inFeedChatScope(database: string): boolean {
  return database === THREADS_DATABASE || database === HOME_FEED_DATABASE || isFeedOutputDatabase(database);
}

/** Refuses any database outside the three places and any statement that is not one SELECT. */
export function scopedFeedChatSql(inner: FeedChatSql): FeedChatSql {
  return {
    async query(database, sql, params) {
      if (!inFeedChatScope(database)) throw new FeedChatReadError("out_of_scope");
      if (!/^\s*SELECT\b/i.test(sql) || sql.includes(";")) throw new FeedChatReadError("out_of_scope");
      return inner.query(database, sql, params);
    },
  };
}

const text = (value: unknown, max: number): string => (typeof value === "string" ? value.slice(0, max) : "");
const id = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > ID_CHARS) throw new FeedChatReadError("invalid");
  return value;
};

function count(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new FeedChatReadError("invalid");
  return Math.min(value, max);
}

interface FeedAgent { agentId: string; label: string; output: string }

async function feedAgents(sql: FeedChatSql): Promise<FeedAgent[]> {
  const rows = await sql.query(
    HOME_FEED_DATABASE,
    `SELECT agent_id, substr(label, 1, ${LABEL_CHARS}), output_resource FROM feed_agents ORDER BY agent_id LIMIT ${AGENTS_MAX}`,
    [],
  );
  const agents: FeedAgent[] = [];
  for (const [agentId, label, output] of rows) {
    // A registry row naming anything but a feed output database is skipped, never read.
    if (typeof agentId !== "string" || agentId.length > ID_CHARS || typeof output !== "string" || !isFeedOutputDatabase(output)) continue;
    agents.push({ agentId, label: text(label, LABEL_CHARS), output });
  }
  return agents;
}

const LATEST = "sequence IN (SELECT max(sequence) FROM feed_cards GROUP BY card_id)";
const field = (path: string, chars: number) => `substr(json_extract(card_json, '$.${path}'), 1, ${chars})`;

export interface FeedCardSummary {
  agent: string;
  agent_label: string;
  card: string;
  kind: string;
  title: string;
  needs_response: boolean;
  urgency: number | null;
  created_at: string;
}

/** The latest revision of each card, newest first across the owner's feed agents. */
export async function listFeedCards(sql: FeedChatSql, args: { limit?: unknown }): Promise<{ cards: FeedCardSummary[]; partial: boolean }> {
  const limit = count(args.limit, LIST_DEFAULT, LIST_MAX);
  const agents = await feedAgents(sql);
  let partial = false;
  const perAgent = await Promise.all(agents.map(async agent => {
    try {
      const rows = await sql.query(
        agent.output,
        `SELECT card_id, ${field("kind", KIND_CHARS)}, ${field("title", TITLE_CHARS)}, json_extract(card_json, '$.needsResponse'), json_extract(card_json, '$.urgency'), ${field("createdAt", TIME_CHARS)}
FROM feed_cards WHERE json_valid(card_json) AND ${LATEST} ORDER BY sequence DESC LIMIT ?`,
        [limit],
      );
      return rows.flatMap(([card, kind, title, needs, urgency, created]): FeedCardSummary[] =>
        typeof card === "string" && card.length <= ID_CHARS
          ? [{
            agent: agent.agentId, agent_label: agent.label, card, kind: text(kind, KIND_CHARS), title: text(title, TITLE_CHARS),
            needs_response: needs === 1 || needs === true, urgency: typeof urgency === "number" ? urgency : null, created_at: text(created, TIME_CHARS),
          }]
          : []);
    } catch (error) {
      if (error instanceof FeedChatReadError) throw error;
      partial = true; // one agent's database unreadable (not created yet, or refused): the rest still list
      return [];
    }
  }));
  const cards = perAgent.flat().sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0)).slice(0, limit);
  return { cards, partial };
}

export interface FeedCardRead extends FeedCardSummary {
  body: string;
  body_truncated: boolean;
  choices: Array<{ id: string; label: string }>;
  payload?: string;
  payload_truncated?: boolean;
}

/** One card's latest revision. The agent must be in the owner's feed registry. */
export async function readCard(sql: FeedChatSql, args: { agent?: unknown; card?: unknown }): Promise<FeedCardRead> {
  const agentId = id(args.agent);
  const cardId = id(args.card);
  const agent = (await feedAgents(sql)).find(candidate => candidate.agentId === agentId);
  if (!agent) throw new FeedChatReadError("not_found");
  const rows = await sql.query(
    agent.output,
    `SELECT ${field("kind", KIND_CHARS)}, ${field("title", TITLE_CHARS)}, json_extract(card_json, '$.needsResponse'), json_extract(card_json, '$.urgency'), ${field("createdAt", TIME_CHARS)},
substr(json_extract(card_json, '$.body'), 1, ${CARD_BODY_CHARS + 1}),
CASE WHEN json_type(card_json, '$.choices') = 'array' THEN substr(json(json_extract(card_json, '$.choices')), 1, 16000) END,
CASE WHEN json_type(card_json, '$.payload') = 'object' THEN substr(json(json_extract(card_json, '$.payload')), 1, ${CARD_PAYLOAD_CHARS + 1}) END
FROM feed_cards WHERE card_id = ? AND json_valid(card_json) ORDER BY sequence DESC LIMIT 1`,
    [cardId],
  );
  const row = rows[0];
  if (!row) throw new FeedChatReadError("not_found");
  const [kind, title, needs, urgency, created, body, choicesJson, payload] = row;
  const fullBody = typeof body === "string" ? body : "";
  let choices: Array<{ id: string; label: string }> = [];
  if (typeof choicesJson === "string") {
    try {
      const parsed: unknown = JSON.parse(choicesJson);
      if (Array.isArray(parsed)) {
        choices = parsed.slice(0, CHOICES_MAX).flatMap(choice =>
          choice && typeof choice === "object" && "id" in choice && typeof choice.id === "string"
            ? [{ id: text(choice.id, ID_CHARS), label: text("label" in choice ? choice.label : undefined, TITLE_CHARS) }]
            : []);
      }
    } catch {
      choices = []; // cut short by the cap: the choices are left out rather than guessed
    }
  }
  const read: FeedCardRead = {
    agent: agent.agentId, agent_label: agent.label, card: cardId, kind: text(kind, KIND_CHARS), title: text(title, TITLE_CHARS),
    needs_response: needs === 1 || needs === true, urgency: typeof urgency === "number" ? urgency : null, created_at: text(created, TIME_CHARS),
    body: fullBody.slice(0, CARD_BODY_CHARS), body_truncated: fullBody.length > CARD_BODY_CHARS, choices,
  };
  if (typeof payload === "string") {
    read.payload = payload.slice(0, CARD_PAYLOAD_CHARS);
    read.payload_truncated = payload.length > CARD_PAYLOAD_CHARS;
  }
  return read;
}

export interface ChatSummary { chat: string; title: string; updated_at: string }

/** The owner's chats with AI models, most recently updated first; `query` matches words in the title. */
export async function listChats(sql: FeedChatSql, args: { limit?: unknown; query?: unknown }): Promise<{ chats: ChatSummary[] }> {
  const limit = count(args.limit, LIST_DEFAULT, LIST_MAX);
  if (args.query !== undefined && (typeof args.query !== "string" || args.query.length > QUERY_CHARS)) throw new FeedChatReadError("invalid");
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const rows = await sql.query(
    THREADS_DATABASE,
    `SELECT id, substr(title, 1, ${TITLE_CHARS}), substr(updated_at, 1, ${TIME_CHARS}) FROM threads${query ? " WHERE instr(lower(title), lower(?)) > 0" : ""} ORDER BY updated_at DESC LIMIT ?`,
    query ? [query, limit] : [limit],
  );
  return {
    chats: rows.flatMap(([chat, title, updated]): ChatSummary[] =>
      typeof chat === "string" && chat.length <= ID_CHARS ? [{ chat, title: text(title, TITLE_CHARS), updated_at: text(updated, TIME_CHARS) }] : []),
  };
}

export interface ChatMessage { role: "user" | "assistant"; text: string; truncated: boolean; created_at: string }

const MESSAGE_TEXT = `(SELECT group_concat(json_extract(part.value, '$.text'), char(10)) FROM json_each(payload, '$.message.content') AS part WHERE json_extract(part.value, '$.type') = 'text')`;

/** One chat's latest messages, oldest first: the text the owner and the model wrote, nothing else. */
export async function readChat(sql: FeedChatSql, args: { chat?: unknown; limit?: unknown }): Promise<{ chat: string; title: string; updated_at: string; messages: ChatMessage[]; earlier_messages: boolean }> {
  const chat = id(args.chat);
  const limit = count(args.limit, CHAT_MESSAGES_DEFAULT, CHAT_MESSAGES_MAX);
  const head = await sql.query(THREADS_DATABASE, `SELECT substr(title, 1, ${TITLE_CHARS}), substr(updated_at, 1, ${TIME_CHARS}), (SELECT count(*) FROM messages WHERE thread_id = ?) FROM threads WHERE id = ?`, [chat, chat]);
  const thread = head[0];
  if (!thread) throw new FeedChatReadError("not_found");
  const rows = await sql.query(
    THREADS_DATABASE,
    `SELECT role, body, created FROM (
SELECT position, json_extract(payload, '$.message.role') AS role, substr(${MESSAGE_TEXT}, 1, ${MESSAGE_CHARS + 1}) AS body, substr(created_at, 1, ${TIME_CHARS}) AS created
FROM messages WHERE thread_id = ? AND json_valid(payload) AND json_type(payload, '$.message.content') = 'array' ORDER BY position DESC LIMIT ?
) ORDER BY position`,
    [chat, limit],
  );
  const messages = rows.flatMap(([role, body, created]): ChatMessage[] => {
    if ((role !== "user" && role !== "assistant") || typeof body !== "string" || body.length === 0) return [];
    return [{ role, text: body.slice(0, MESSAGE_CHARS), truncated: body.length > MESSAGE_CHARS, created_at: text(created, TIME_CHARS) }];
  });
  return { chat, title: text(thread[0], TITLE_CHARS), updated_at: text(thread[1], TIME_CHARS), messages, earlier_messages: Number(thread[2]) > limit };
}

/** The port over the owner's grant: each query runs in the named database through the activated delegation. */
export function delegatedFeedChatSql(access: DelegatedAccess): FeedChatSql {
  return scopedFeedChatSql({
    async query(database, sql, params) {
      const result = await access.sql.db(database).query<unknown>(sql, params);
      if (!result.ok) throw new Error(`feed_chat_query_failed:${result.error.code}`);
      return result.data.rows;
    },
  });
}

/** Which grant area each tool reads. */
export const FEED_CHAT_TOOL_AREAS = {
  list_feed_cards: "feed",
  read_card: "feed",
  list_chats: "chats",
  read_chat: "chats",
} as const;

export type FeedChatTool = keyof typeof FEED_CHAT_TOOL_AREAS;

export function isFeedChatTool(name: string): name is FeedChatTool {
  return Object.hasOwn(FEED_CHAT_TOOL_AREAS, name);
}

/** Runs one tool; the result is the JSON text the gateway wraps as untrusted. */
export async function runFeedChatTool(tool: FeedChatTool, args: Record<string, unknown>, sql: FeedChatSql): Promise<string> {
  switch (tool) {
    case "list_feed_cards": return JSON.stringify(await listFeedCards(sql, args));
    case "read_card": return JSON.stringify(await readCard(sql, args));
    case "list_chats": return JSON.stringify(await listChats(sql, args));
    case "read_chat": return JSON.stringify(await readChat(sql, args));
  }
}
