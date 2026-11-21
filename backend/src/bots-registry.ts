// TC-3325: which bots an owner has. One record per owner in the backend's own space, at bots/registry/<address>.
//
// The backend is the authority: every route takes a bot's key from the signed-in owner's record here, never from a
// request body. Every write is conditional on the version that was read; a lost race reads again and decides again,
// so two backend processes cannot both act on the same stale record.

import { randomBytes } from "node:crypto";
import { assertKvResult } from "@tinyboilerplate/server";
import { isBotColour, isBotShape } from "./bot-catalog.js";
import { isKvPreconditionFailed, readVersionedKv, type ExoKvGetOptions, type ExoKvPutOptions } from "./exo/activated-grant.js";

/** The backend's own key-value space. Callers route `put` through the shared backend storage lane. */
export interface RegistryKv {
  get(key: string, options: ExoKvGetOptions): Promise<unknown>;
  put(key: string, value: unknown, options: ExoKvPutOptions): Promise<unknown>;
  /** One page of the keys under a prefix. Needed only to find every owner that has a record. */
  list?(options: { prefix: string; cursor?: string }): Promise<unknown>;
}

export type BotEnvironment = "private" | "regular";
export type BotState = "active" | "suspended" | "deleting";

export interface Bot {
  key: string;
  name: string;
  shape: string;
  colour: string;
  environment: BotEnvironment;
  state: BotState;
  createdAt: string;
  /** Deleting only: when the owner asked for the deletion. */
  deletingSince?: string;
  /** Deleting only: no permission to save history is accepted for this bot any more. Set before its stored one is removed. */
  grantClosed?: true;
  /** Deleting only: the delegation still to revoke, kept here so that removing the stored permission does not lose it. */
  revoke?: { cid: string };
}
export interface DeletedBot { key: string; name: string; revoke?: { cid: string } }
export interface OwnerBots { v: 1; seq: number; bots: Bot[]; deleted: DeletedBot[] }

/** `seq` is the counter of the write that stored the bot: the service is told the bot's state under it. */
export type CreateResult = { ok: true; bot: Bot; seq: number } | { ok: false; error: "invalid_name" | "invalid_shape" | "invalid_colour" | "name_taken" | "bot_limit" };
export type UpdateResult = { ok: true; bot: Bot } | { ok: false; error: "invalid" | "invalid_name" | "invalid_shape" | "invalid_colour" | "name_taken" | "bot_deleting" | "not_found" };
/** `seq` is the counter of the record that holds the bot as being deleted. */
export type DeleteResult = { ok: true; bot: Bot; seq: number } | { ok: false; error: "main_fixed" | "delete_limit" | "not_found" };

export const MAIN_BOT_KEY = "main";
/** Deletions in progress per owner, so deleting cannot be used to pile up working state. */
export const BOT_DELETING_MAX = 3;
export const BOT_NAME_MAX = 24;
/** How a bot other than Main is named. Checked before a key is looked up or becomes part of an address. */
export const BOT_KEY = /^[0-9a-f]{32}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_RECORD_RESPONSE_BYTES = 256 * 1024;
/** Compare-and-set attempts before a write is given up as unavailable. */
const MAX_ATTEMPTS = 8;

/** A record that cannot be read back exactly is refused. It is never treated as "no bots", which would drop an owner's other bots. */
export class RegistryUnavailable extends Error {
  constructor(cause: string) { super(`bots_registry_unavailable: ${cause}`); }
}

export const BOTS_REGISTRY_KEY_PREFIX = "bots/registry/";

/** Where an owner's record is stored. The address is checked before it becomes part of a key. */
export function registryKey(address: string): string {
  if (!ADDRESS.test(address)) throw new RegistryUnavailable("address");
  return `${BOTS_REGISTRY_KEY_PREFIX}${address.toLowerCase()}`;
}

/** The trimmed name, or undefined when it is not 1 to 24 characters of text or holds a control character. */
export function checkedName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  // eslint-disable-next-line no-control-regex
  if (name.length < 1 || [...name].length > BOT_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) return undefined;
  return name;
}

/** One field of a stored object. Stored data is checked field by field; nothing about its shape is assumed. */
const field = (value: object, name: string): unknown => (name in value ? Reflect.get(value, name) : undefined);

/** The delegation still to revoke, if there is one. Anything but absent or a non-empty `cid` is refused. */
function parseRevoke(raw: unknown): { cid: string } | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) throw new RegistryUnavailable("revoke");
  const cid = field(raw, "cid");
  if (typeof cid !== "string" || cid === "") throw new RegistryUnavailable("revoke");
  return { cid };
}

function parseBot(raw: unknown): Bot {
  if (typeof raw !== "object" || raw === null) throw new RegistryUnavailable("bot");
  const key = field(raw, "key");
  const name = field(raw, "name");
  const shape = field(raw, "shape");
  const colour = field(raw, "colour");
  const environment = field(raw, "environment");
  const state = field(raw, "state");
  const createdAt = field(raw, "createdAt");
  const deletingSince = field(raw, "deletingSince");
  const grantClosed = field(raw, "grantClosed");
  const revoke = parseRevoke(field(raw, "revoke"));
  if (typeof key !== "string" || (key !== MAIN_BOT_KEY && !BOT_KEY.test(key))
    || typeof name !== "string" || typeof shape !== "string" || typeof colour !== "string"
    || (environment !== "private" && environment !== "regular")
    || (state !== "active" && state !== "suspended" && state !== "deleting")
    || typeof createdAt !== "string") throw new RegistryUnavailable("bot");
  // A bot's deletion bookkeeping must fit its state: all of it only while it is being deleted, and never on Main.
  if (state !== "deleting") {
    if (deletingSince !== undefined || grantClosed !== undefined || revoke !== undefined) throw new RegistryUnavailable("bot");
    return { key, name, shape, colour, environment, state, createdAt };
  }
  if (key === MAIN_BOT_KEY || typeof deletingSince !== "string" || (grantClosed !== undefined && grantClosed !== true)) throw new RegistryUnavailable("bot");
  return { key, name, shape, colour, environment, state, createdAt, deletingSince, ...(grantClosed ? { grantClosed: true as const } : {}), ...(revoke ? { revoke } : {}) };
}

function parseDeleted(raw: unknown): DeletedBot {
  if (typeof raw !== "object" || raw === null) throw new RegistryUnavailable("deleted");
  const key = field(raw, "key");
  const name = field(raw, "name");
  const revoke = parseRevoke(field(raw, "revoke"));
  if (typeof key !== "string" || !BOT_KEY.test(key) || typeof name !== "string") throw new RegistryUnavailable("deleted");
  return { key, name, ...(revoke ? { revoke } : {}) };
}

export function parseOwnerBots(raw: unknown): OwnerBots {
  if (typeof raw !== "object" || raw === null) throw new RegistryUnavailable("record");
  const seq = field(raw, "seq");
  const storedBots = field(raw, "bots");
  const storedDeleted = field(raw, "deleted");
  if (field(raw, "v") !== 1 || typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1
    || !Array.isArray(storedBots) || !Array.isArray(storedDeleted)) throw new RegistryUnavailable("record");
  const bots = storedBots.map(parseBot);
  const deleted = storedDeleted.map(parseDeleted);
  const keys = [...bots, ...deleted].map(entry => entry.key);
  if (new Set(keys).size !== keys.length || !bots.some(bot => bot.key === MAIN_BOT_KEY)) throw new RegistryUnavailable("keys");
  return { v: 1, seq, bots, deleted };
}

/** What a step decides from the record it was shown: its answer, and the bots and deleted list to store, if anything changes. */
interface Decision<T> { result: T; next?: Pick<OwnerBots, "bots" | "deleted"> }

export class BotsRegistry {
  readonly #kv: RegistryKv;
  readonly #now: () => Date;
  readonly #newKey: () => string;

  constructor(kv: RegistryKv, deps: { now?: () => Date; newKey?: () => string } = {}) {
    this.#kv = kv;
    this.#now = deps.now ?? (() => new Date());
    this.#newKey = deps.newKey ?? (() => randomBytes(16).toString("hex"));
  }

  /**
   * Read, decide, write, under compare-and-set. `step` always sees the record read in this attempt. An owner with no
   * record yet is shown one that holds only Main, and that first write goes through the same conditional path as any
   * other. `seq` goes up by one on every write.
   */
  async #mutate<T>(address: string, step: (current: OwnerBots) => Decision<T>): Promise<{ result: T; row: OwnerBots }> {
    const key = registryKey(address);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const found = readVersionedKv(await this.#kv.get(key, { source: "network", maxResponseBytes: MAX_RECORD_RESPONSE_BYTES }), key);
      const main: Bot = { key: MAIN_BOT_KEY, name: "Main", shape: "pebble", colour: "blue", environment: "private", state: "active", createdAt: this.#now().toISOString() };
      const current: OwnerBots = found === undefined ? { v: 1, seq: 0, bots: [main], deleted: [] } : parseOwnerBots(found.value);
      const { result, next } = step(current);
      if (next === undefined && found !== undefined) return { result, row: current };
      const row: OwnerBots = { v: 1, seq: current.seq + 1, bots: next?.bots ?? current.bots, deleted: next?.deleted ?? current.deleted };
      const write = await this.#kv.put(key, row, found === undefined ? { ifNoneMatch: "*" } : { ifMatch: found.etag });
      // Another process wrote in between: read again and decide again.
      if (isKvPreconditionFailed(write)) continue;
      assertKvResult(write);
      return { result, row };
    }
    throw new RegistryUnavailable("conflict");
  }

  /** The owner's record, created with Main in it on the first call. */
  async read(address: string): Promise<OwnerBots> {
    return (await this.#mutate(address, () => ({ result: undefined }))).row;
  }

  /** Creates a private bot. `privateLimit` is how many private bots this owner may have, Main included. */
  async create(address: string, input: { name?: unknown; shape?: unknown; colour?: unknown }, privateLimit: number): Promise<CreateResult> {
    const name = checkedName(input.name);
    if (name === undefined) return { ok: false, error: "invalid_name" };
    const { shape, colour } = input;
    if (!isBotShape(shape)) return { ok: false, error: "invalid_shape" };
    if (!isBotColour(colour)) return { ok: false, error: "invalid_colour" };
    const { result, row } = await this.#mutate<{ ok: true; bot: Bot } | Extract<CreateResult, { ok: false }>>(address, current => {
      if (current.bots.some(bot => bot.name.toLowerCase() === name.toLowerCase())) return { result: { ok: false, error: "name_taken" } };
      // Counted on every attempt, against the record just read: a count taken earlier may already be out of date.
      if (current.bots.filter(bot => bot.environment === "private" && bot.state !== "deleting").length >= privateLimit) return { result: { ok: false, error: "bot_limit" } };
      // A key is never used twice, and what the generator returns is checked like any other key.
      const taken = new Set([...current.bots, ...current.deleted].map(entry => entry.key));
      let key = this.#newKey();
      for (let tries = 1; taken.has(key) || !BOT_KEY.test(key); tries += 1) {
        if (tries >= MAX_ATTEMPTS) throw new RegistryUnavailable("key");
        key = this.#newKey();
      }
      const bot: Bot = { key, name, shape, colour, environment: "private", state: "active", createdAt: this.#now().toISOString() };
      return { result: { ok: true, bot }, next: { bots: [...current.bots, bot], deleted: current.deleted } };
    });
    return result.ok ? { ok: true, bot: result.bot, seq: row.seq } : result;
  }

  /** May `sourceKey` message `targetKey`? Fails closed: any error is a refusal, never an exception and never a yes. */
  async admit(address: string, sourceKey: string, targetKey: string, callerEnvironment?: BotEnvironment): Promise<Admission> {
    try {
      return admission(await this.read(address), sourceKey, targetKey, callerEnvironment);
    } catch {
      return { admitted: false, reason: "unavailable" };
    }
  }

  /** The keys `sourceKey` may message in a turn that starts now: Main first, then oldest first. Empty on any error. */
  async listForTurn(address: string, sourceKey: string): Promise<string[]> {
    try {
      const row = await this.read(address);
      return orderedBots(row).map(bot => bot.key).filter(key => admission(row, sourceKey, key).admitted);
    } catch {
      return [];
    }
  }

  /** Renames or restyles a bot. Main too: its key, its id, its directory and its permission do not depend on its name or look. */
  async update(address: string, key: string, input: { name?: unknown; shape?: unknown; colour?: unknown }): Promise<UpdateResult> {
    if (input.name === undefined && input.shape === undefined && input.colour === undefined) return { ok: false, error: "invalid" };
    const name = input.name === undefined ? undefined : checkedName(input.name);
    if (input.name !== undefined && name === undefined) return { ok: false, error: "invalid_name" };
    const { shape, colour } = input;
    if (shape !== undefined && !isBotShape(shape)) return { ok: false, error: "invalid_shape" };
    if (colour !== undefined && !isBotColour(colour)) return { ok: false, error: "invalid_colour" };
    if (key !== MAIN_BOT_KEY && !BOT_KEY.test(key)) return { ok: false, error: "not_found" };
    return (await this.#mutate<UpdateResult>(address, current => {
      const bot = current.bots.find(candidate => candidate.key === key);
      if (!bot) return { result: { ok: false, error: "not_found" } };
      if (bot.state === "deleting") return { result: { ok: false, error: "bot_deleting" } };
      // Another bot's name, ignoring case. A bot may keep its own, or change only its case.
      if (name !== undefined && current.bots.some(other => other.key !== key && other.name.toLowerCase() === name.toLowerCase())) return { result: { ok: false, error: "name_taken" } };
      const changed: Bot = { ...bot, ...(name !== undefined ? { name } : {}), ...(shape !== undefined ? { shape } : {}), ...(colour !== undefined ? { colour } : {}) };
      if (changed.name === bot.name && changed.shape === bot.shape && changed.colour === bot.colour) return { result: { ok: true, bot } };
      return { result: { ok: true, bot: changed }, next: { bots: current.bots.map(other => (other.key === key ? changed : other)), deleted: current.deleted } };
    })).result;
  }

  /** Marks a bot as being deleted. Durable before the service is told anything. Asking again changes nothing. */
  async beginDelete(address: string, key: string): Promise<DeleteResult> {
    if (key === MAIN_BOT_KEY) return { ok: false, error: "main_fixed" };
    if (!BOT_KEY.test(key)) return { ok: false, error: "not_found" };
    const { result, row } = await this.#mutate<{ ok: true; bot: Bot } | Extract<DeleteResult, { ok: false }>>(address, current => {
      const bot = current.bots.find(candidate => candidate.key === key);
      if (!bot) return { result: { ok: false, error: "not_found" } };
      if (bot.state === "deleting") return { result: { ok: true, bot } };
      if (current.bots.filter(other => other.state === "deleting").length >= BOT_DELETING_MAX) return { result: { ok: false, error: "delete_limit" } };
      const changed: Bot = { ...bot, state: "deleting", deletingSince: this.#now().toISOString() };
      return { result: { ok: true, bot: changed }, next: { bots: current.bots.map(other => (other.key === key ? changed : other)), deleted: current.deleted } };
    });
    return result.ok ? { ok: true, bot: result.bot, seq: row.seq } : result;
  }

  /**
   * Deletion, once the bot's working state is gone: from here no permission is accepted for this bot. This is
   * written BEFORE its stored permission is removed, and records the delegation to revoke. Undefined when the bot
   * is not being deleted.
   */
  async closeGrant(address: string, key: string, cid: string | undefined): Promise<Bot | undefined> {
    if (!BOT_KEY.test(key)) return undefined;
    return (await this.#mutate<Bot | undefined>(address, current => {
      const bot = current.bots.find(candidate => candidate.key === key);
      if (!bot || bot.state !== "deleting") return { result: undefined };
      // Once closed, what was recorded stays: the first delegation is the one still to revoke.
      if (bot.grantClosed) return { result: bot };
      const changed: Bot = { ...bot, grantClosed: true, ...(cid ? { revoke: { cid } } : {}) };
      return { result: changed, next: { bots: current.bots.map(other => (other.key === key ? changed : other)), deleted: current.deleted } };
    })).result;
  }

  /** The delegation has been revoked, or never can be: nothing is left to retry. */
  async clearRevoke(address: string, key: string): Promise<void> {
    if (!BOT_KEY.test(key)) return;
    await this.#mutate<undefined>(address, current => {
      if (!current.bots.some(bot => bot.key === key && bot.revoke) && !current.deleted.some(entry => entry.key === key && entry.revoke)) return { result: undefined };
      const bots = current.bots.map((bot): Bot => (bot.key !== key ? bot : {
        key: bot.key, name: bot.name, shape: bot.shape, colour: bot.colour, environment: bot.environment, state: bot.state, createdAt: bot.createdAt,
        ...(bot.deletingSince !== undefined ? { deletingSince: bot.deletingSince } : {}),
        ...(bot.grantClosed ? { grantClosed: true as const } : {}),
      }));
      const deleted = current.deleted.map((entry): DeletedBot => (entry.key === key ? { key: entry.key, name: entry.name } : entry));
      return { result: undefined, next: { bots, deleted } };
    });
  }

  /** The last step: the bot leaves `bots`, and its key and name are remembered in `deleted`. Only after `closeGrant`. */
  async finishDelete(address: string, key: string): Promise<boolean> {
    if (!BOT_KEY.test(key)) return false;
    return (await this.#mutate<boolean>(address, current => {
      if (current.deleted.some(entry => entry.key === key)) return { result: true };
      const bot = current.bots.find(candidate => candidate.key === key);
      if (!bot || bot.state !== "deleting" || !bot.grantClosed) return { result: false };
      const entry: DeletedBot = { key, name: bot.name, ...(bot.revoke ? { revoke: bot.revoke } : {}) };
      return { result: true, next: { bots: current.bots.filter(other => other.key !== key), deleted: [...current.deleted, entry] } };
    })).result;
  }

  /**
   * Every owner that has a record. A listing that is cut short with no way to continue is an error, never a shorter
   * list: an owner left out would have work that is never picked up.
   */
  async owners(): Promise<string[]> {
    if (!this.#kv.list) throw new RegistryUnavailable("list");
    const owners: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const listed = listPage(assertKvResult(await this.#kv.list({ prefix: BOTS_REGISTRY_KEY_PREFIX, ...(cursor === undefined ? {} : { cursor }) })));
      for (const key of listed.keys) {
        const address = /(?:^|\/)bots\/registry\/(0x[0-9a-f]{40})$/.exec(key)?.[1];
        if (address) owners.push(address);
      }
      if (listed.nextCursor === undefined) {
        if (listed.truncated) throw new RegistryUnavailable("list");
        return owners;
      }
      cursor = listed.nextCursor;
    }
    throw new RegistryUnavailable("list");
  }
}

export type AdmissionRefusal = "unknown_source" | "unknown_target" | "same_bot" | "source_not_active" | "target_not_active" | "different_environment" | "unavailable";
export type Admission = { admitted: true } | { admitted: false; reason: AdmissionRefusal };

/**
 * May `sourceKey` message `targetKey`? Both are looked up in this one owner's record. `callerEnvironment` is the
 * environment of the service that asks, when it is known.
 */
export function admission(row: OwnerBots, sourceKey: string, targetKey: string, callerEnvironment?: BotEnvironment): Admission {
  const source = row.bots.find(bot => bot.key === sourceKey);
  // A service may ask only about bots of its own environment. Any other bot is as good as unknown to it.
  if (!source || (callerEnvironment !== undefined && source.environment !== callerEnvironment)) return { admitted: false, reason: "unknown_source" };
  const target = row.bots.find(bot => bot.key === targetKey);
  if (!target) return { admitted: false, reason: "unknown_target" };
  if (source.key === target.key) return { admitted: false, reason: "same_bot" };
  if (source.state !== "active") return { admitted: false, reason: "source_not_active" };
  if (target.state !== "active") return { admitted: false, reason: "target_not_active" };
  if (source.environment !== target.environment) return { admitted: false, reason: "different_environment" };
  return { admitted: true };
}

/** An owner's bots in the order they are listed: Main first, then oldest first. */
export function orderedBots(row: OwnerBots): Bot[] {
  return [...row.bots].sort((a, b) => (a.key === MAIN_BOT_KEY ? -1 : b.key === MAIN_BOT_KEY ? 1 : a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key)));
}

/**
 * The address inside an owner's DID, lower-case, or undefined. Only the one canonical form is taken:
 * did:pkh:eip155:1:<lower-case address>.
 */
export function addressFromOwnerDid(ownerDid: string): string | undefined {
  return /^did:pkh:eip155:1:(0x[0-9a-f]{40})$/.exec(ownerDid)?.[1];
}

/**
 * The list of bots a turn may message, for a caller that knows an owner by its DID. Empty for anything malformed.
 */
export function turnListHook(registry: BotsRegistry): (ownerDid: string, sourceKey: string) => Promise<string[]> {
  return async (ownerDid, sourceKey) => {
    const address = addressFromOwnerDid(ownerDid);
    return address === undefined ? [] : registry.listForTurn(address, sourceKey);
  };
}

/** A bot as its owner is shown it: with the time its deletion began, and none of the deletion's bookkeeping. */
export function publicBot(bot: Bot): Omit<Bot, "grantClosed" | "revoke"> {
  return {
    key: bot.key, name: bot.name, shape: bot.shape, colour: bot.colour, environment: bot.environment, state: bot.state, createdAt: bot.createdAt,
    ...(bot.deletingSince !== undefined ? { deletingSince: bot.deletingSince } : {}),
  };
}

/** A deleted bot as its owner is shown it: its key and its name. */
export const publicDeleted = (entry: DeletedBot): { key: string; name: string } => ({ key: entry.key, name: entry.name });

/** Pages a listing may take before it is given up as unavailable, so a store that never ends its listing cannot hold a pass up for ever. */
const MAX_LIST_PAGES = 1000;

/** One page of a listing, checked field by field. */
function listPage(result: unknown): { keys: string[]; nextCursor: string | undefined; truncated: boolean } {
  const data = typeof result === "object" && result !== null ? field(result, "data") : undefined;
  if (typeof data !== "object" || data === null) throw new RegistryUnavailable("list");
  const keys = field(data, "keys");
  const nextCursor = field(data, "nextCursor");
  if (!Array.isArray(keys) || !keys.every((key): key is string => typeof key === "string")) throw new RegistryUnavailable("list");
  if (nextCursor !== undefined && nextCursor !== null && typeof nextCursor !== "string") throw new RegistryUnavailable("list");
  return { keys, nextCursor: typeof nextCursor === "string" && nextCursor !== "" ? nextCursor : undefined, truncated: field(data, "truncated") === true };
}
