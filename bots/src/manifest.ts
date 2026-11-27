// Which of an owner's bots the backend has announced, and in what state. The backend's registry is the authority;
// this is the service's own copy, checked before a request for a sibling may create anything. One file per owner,
// named by the owner's hash, on the supervisor's volume and outside everything a sandbox mounts.

import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "./guards";
import { BOT_KEY, botIdFor, MAIN_KEY } from "./owner";

/** `removed` is what `deleting` becomes once the bot's working state is gone. Neither can go back. */
export type BotState = "active" | "suspended" | "deleting" | "removed";
/** The states the backend may announce. */
export const ANNOUNCED_STATES = ["active", "suspended", "deleting"] as const;
export type AnnouncedState = (typeof ANNOUNCED_STATES)[number];

interface Entry { state: BotState; seq: number }
interface OwnerFile { v: 1; owner: string; bots: Record<string, Entry> }

const isState = (value: unknown): value is BotState =>
  value === "active" || value === "suspended" || value === "deleting" || value === "removed";

/** A new bot was announced for an owner who already has as many as this service allows one owner. */
export class OwnerBotLimit extends Error {
  constructor() { super("owner_bot_limit"); }
}

export class OwnerManifests {
  readonly #root: string;
  readonly #maxPerOwner: number;

  /**
   * `maxPerOwner` is this service's own limit on one owner's bots, Main included. The backend has its own; this one
   * holds even if that one is wrong, so one owner cannot be announced into every place the service has.
   */
  constructor(root: string, maxPerOwner: number = Number.POSITIVE_INFINITY) {
    this.#root = root;
    this.#maxPerOwner = maxPerOwner;
  }

  #path(ownerDid: string): string {
    return join(this.#root, `${botIdFor(ownerDid)}.json`);
  }

  #load(ownerDid: string): OwnerFile {
    const path = this.#path(ownerDid);
    if (!existsSync(path)) return { v: 1, owner: ownerDid, bots: {} };
    if (!lstatSync(path).isFile()) throw new Error("invalid_manifest");
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(value) || value.v !== 1 || value.owner !== ownerDid || !isRecord(value.bots)) throw new Error("invalid_manifest");
    for (const [key, entry] of Object.entries(value.bots)) {
      if ((key !== MAIN_KEY && !BOT_KEY.test(key)) || !isRecord(entry) || !isState(entry.state) || !Number.isSafeInteger(entry.seq)) {
        throw new Error("invalid_manifest");
      }
    }
    return value as unknown as OwnerFile;
  }

  #save(ownerDid: string, file: OwnerFile): void {
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    const path = this.#path(ownerDid);
    const fresh = openSync(`${path}.new`, "w", 0o600);
    try { writeSync(fresh, JSON.stringify(file)); fsyncSync(fresh); } finally { closeSync(fresh); }
    renameSync(`${path}.new`, path);
    const dir = openSync(this.#root, "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }

  /** Main exists without being announced; a sibling exists only once the backend has announced it. */
  stateOf(ownerDid: string, key: string): BotState | undefined {
    return this.#load(ownerDid).bots[key]?.state ?? (key === MAIN_KEY ? "active" : undefined);
  }

  /**
   * Records what the backend announced, and returns the state now held. An update older than the one held is
   * ignored, and so is anything after `deleting`: a late `active` must not reopen a bot that is on its way out.
   * Main is never deleted.
   */
  announce(ownerDid: string, key: string, state: AnnouncedState, seq: number): BotState {
    if (key === MAIN_KEY && state === "deleting") throw new Error("main_is_never_deleted");
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error("invalid_manifest_seq");
    const file = this.#load(ownerDid);
    const held = file.bots[key];
    const settled = held !== undefined && (held.state === "deleting" || held.state === "removed");
    if (held && (settled || seq <= held.seq)) return held.state;
    // A bot not seen before takes a place, unless it is announced as already on its way out. Main always has one,
    // announced or not. A bot already held is never refused here: its updates, a deletion above all, must get through.
    if (!held && key !== MAIN_KEY && state !== "deleting") {
      const others = Object.entries(file.bots).filter(([other, entry]) => other !== MAIN_KEY && (entry.state === "active" || entry.state === "suspended")).length;
      if (1 + others >= this.#maxPerOwner) throw new OwnerBotLimit();
    }
    file.bots[key] = { state, seq };
    this.#save(ownerDid, file);
    return state;
  }

  /** The bot's working state is gone. Only a bot that was being deleted can be removed. */
  markRemoved(ownerDid: string, key: string): void {
    const file = this.#load(ownerDid);
    const held = file.bots[key];
    if (!held || held.state !== "deleting") return;
    file.bots[key] = { state: "removed", seq: held.seq };
    this.#save(ownerDid, file);
  }

  /** Every sibling key the owner's file names, in any state. Throws for a file that is not valid. */
  siblingKeys(ownerDid: string): string[] {
    return Object.keys(this.#load(ownerDid).bots).filter(key => key !== MAIN_KEY);
  }

  /**
   * Account erase: the owner's file, and the temporary file a save leaves behind if it stopped part-way. Nothing is
   * created, so an owner who has no file is already erased.
   */
  erase(ownerDid: string): void {
    const path = this.#path(ownerDid);
    rmSync(path, { force: true });
    rmSync(`${path}.new`, { force: true });
    if (!existsSync(this.#root)) return;
    const dir = openSync(this.#root, "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
}
