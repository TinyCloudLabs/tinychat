import { DEFAULT_REQUEST_HEADER_NAME, DEFAULT_REQUEST_HEADER_VALUE } from "@tinyboilerplate/client";

import { isBotKey, SIBLING_BOT_KEY } from "./botHistoryPath";
import { BOT_COLOUR_IDS, BOT_SHAPES, type ColourId, type ShapeId } from "./botShapes";
import type { BotsApiOptions } from "./botsApi";

export const BOT_NAME_MAX = 24;

export function isBotName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= BOT_NAME_MAX && !/\p{Cc}/u.test(value);
}

export interface CreateBotInput {
  name: string;
  shape: ShapeId;
  colour: ColourId;
}

export type BotEnvironment = "regular" | "private";
interface BotLimit { max: number; used: number }

export interface RosterBot extends CreateBotInput {
  key: string;
  environment: BotEnvironment;
  state: "active" | "suspended" | "deleting";
  createdAt: string;
  deletingSince?: string;
}

export interface BotRoster {
  bots: RosterBot[];
  deleted: Array<{ key: string; name: string }>;
  capMode: "flat3" | "table";
  limits: Record<BotEnvironment, BotLimit> | null;
  canCreate: Record<BotEnvironment, boolean>;
}

export interface BotRosterApi {
  list(signal?: AbortSignal): Promise<BotRoster>;
  create(input: CreateBotInput, signal?: AbortSignal): Promise<RosterBot>;
  update(key: string, input: Partial<CreateBotInput>, signal?: AbortSignal): Promise<RosterBot>;
  remove(key: string, signal?: AbortSignal): Promise<RosterBot>;
}

const ERROR_CODES = [
  "unauthenticated", "not_found", "bots_unavailable", "invalid", "invalid_name",
  "invalid_shape", "invalid_colour", "name_taken", "bot_limit", "bot_deleting", "main_fixed", "delete_limit",
] as const;

export class BotRosterError extends Error {
  constructor(
    readonly code: (typeof ERROR_CODES)[number] | "invalid_response",
    readonly environment?: BotEnvironment,
  ) {
    super(code);
    this.name = "BotRosterError";
  }
}

function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function isIsoUtc(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
}
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseBot(value: unknown): RosterBot {
  const { key, name, environment, state, createdAt, deletingSince, shape, colour } = fields(value);
  const shapeId = BOT_SHAPES.find(id => id === shape);
  const colourId = BOT_COLOUR_IDS.find(id => id === colour);
  if (!isBotKey(key) || !isBotName(name) || !shapeId || !colourId || !isIsoUtc(createdAt)
    || (environment !== "regular" && environment !== "private")
    || (state !== "active" && state !== "suspended" && state !== "deleting")
    || (state === "deleting" && !isIsoUtc(deletingSince))) throw new BotRosterError("invalid_response");

  return {
    key, name: name.trim(), shape: shapeId, colour: colourId, environment, state, createdAt,
    ...(state === "deleting" && typeof deletingSince === "string" ? { deletingSince } : {}),
  };
}

function parseLimit(value: unknown): BotLimit {
  const { max, used } = fields(value);
  if (!isCount(max) || !isCount(used)) throw new BotRosterError("invalid_response");
  return { max, used };
}

function parseRoster(value: unknown): BotRoster {
  const { bots, deleted, limits, canCreate, capMode } = fields(value);
  const { private: createPrivate, regular: createRegular } = fields(canCreate);
  if (!Array.isArray(bots) || !Array.isArray(deleted)
    || (capMode !== "flat3" && capMode !== "table")
    || typeof createPrivate !== "boolean" || typeof createRegular !== "boolean"
    || (limits === null && (createPrivate || createRegular))) {
    throw new BotRosterError("invalid_response");
  }
  const parsedBots = bots.map(parseBot);
  const parsedDeleted = deleted.map((entry: unknown) => {
    const { key, name } = fields(entry);
    if (typeof key !== "string" || !SIBLING_BOT_KEY.test(key) || !isBotName(name)) throw new BotRosterError("invalid_response");
    return { key, name: name.trim() };
  });
  const keys = [...parsedBots, ...parsedDeleted].map(bot => bot.key);
  if (parsedBots[0]?.key !== "main" || new Set(keys).size !== keys.length) throw new BotRosterError("invalid_response");
  const { private: privateLimit, regular: regularLimit } = fields(limits);
  return {
    bots: parsedBots, deleted: parsedDeleted, capMode,
    limits: limits === null ? null : { private: parseLimit(privateLimit), regular: parseLimit(regularLimit) },
    canCreate: { private: createPrivate, regular: createRegular },
  };
}

function botPath(key: string): string {
  if (!isBotKey(key)) throw new BotRosterError("not_found");
  return `/api/bots/${key}`;
}

export function createBotRosterApi({ baseUrl, getToken, fetch: fetchImpl = (input, init) => globalThis.fetch(input, init) }: BotsApiOptions): BotRosterApi {
  const base = baseUrl.replace(/\/$/, "");

  async function request(method: string, path: string, status: number, signal?: AbortSignal, input?: Partial<CreateBotInput>) {
    const token = getToken();
    if (!token) throw new BotRosterError("unauthenticated");
    const body = input && JSON.stringify({ name: input.name?.trim(), shape: input.shape, colour: input.colour });
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method, signal, body,
        headers: {
          Authorization: `Bearer ${token}`,
          [DEFAULT_REQUEST_HEADER_NAME]: DEFAULT_REQUEST_HEADER_VALUE,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
      });
    } catch {
      signal?.throwIfAborted();
      throw new BotRosterError("bots_unavailable");
    }
    if (response.status === 401) throw new BotRosterError("unauthenticated");
    if (response.status === 404) throw new BotRosterError("not_found");
    const payload: unknown = await response.json().catch(() => null);
    if (response.status === status) return payload;
    const { error, environment } = fields(payload);
    const code = ERROR_CODES.find(known => known === error);
    throw new BotRosterError(
      code ?? (response.ok ? "invalid_response" : "bots_unavailable"),
      code === "bot_limit" && (environment === "private" || environment === "regular") ? environment : undefined,
    );
  }

  return {
    async list(signal) {
      return parseRoster(await request("GET", "/api/bots", 200, signal));
    },
    async create(input, signal) {
      const bot = parseBot(fields(await request("POST", "/api/bots", 201, signal, input)).bot);
      if (bot.key === "main" || bot.state !== "active") throw new BotRosterError("invalid_response");
      return bot;
    },
    async update(key, input, signal) {
      const bot = parseBot(fields(await request("PATCH", botPath(key), 200, signal, input)).bot);
      if (bot.key !== key) throw new BotRosterError("invalid_response");
      return bot;
    },
    async remove(key, signal) {
      const bot = parseBot(fields(await request("DELETE", botPath(key), 202, signal)).bot);
      if (bot.key !== key || bot.state !== "deleting") throw new BotRosterError("invalid_response");
      return bot;
    },
  };
}
