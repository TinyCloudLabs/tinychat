// The owner's read setting for Main (TrustBot): which areas of their data it may read, off until the owner turns
// one on. The backend holds the grant and checks it on every read; this file only decides whether the gateway offers
// the tools. Each conversation has an id, kept in the data directory: a new id means a fresh conversation, which
// ends the web pause that reading owner data starts (gateway.ts, meeting-reads.ts).
// Details: TC-3792

import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "./guards";
import type { BotLayout } from "./layout";
import { OWNER_DID } from "./owner";

/** The areas the backend's registry names (backend/src/trustbot-reads/areas.ts). */
export const READ_AREAS = ["meetings"] as const;
export type ReadArea = (typeof READ_AREAS)[number];
const CONVERSATION_ID = /^[0-9a-f]{32}$/;

export interface ReadsSetting {
  areas: ReadArea[];
  /** The owner's DID, signed into each read the gateway makes; set once the owner has turned an area on. */
  owner?: string;
}

/** What the supervisor gives the gateway: the setting and the id of the conversation it applies to. */
export interface ReadsPush extends ReadsSetting {
  conversation: string;
}

const isReadArea = (value: unknown): value is ReadArea => READ_AREAS.some(area => area === value);

export function parseAreas(value: unknown): ReadArea[] | undefined {
  if (!Array.isArray(value) || value.length > READ_AREAS.length || !value.every(isReadArea)) return undefined;
  return READ_AREAS.filter(area => value.includes(area));
}

export function parseReadsPush(input: unknown): ReadsPush | undefined {
  if (!isRecord(input) || typeof input.conversation !== "string" || !CONVERSATION_ID.test(input.conversation)) return undefined;
  const areas = parseAreas(input.areas);
  if (!areas) return undefined;
  if (input.owner !== undefined && (typeof input.owner !== "string" || !OWNER_DID.test(input.owner))) return undefined;
  if (areas.length > 0 && input.owner === undefined) return undefined;
  return { areas, ...(typeof input.owner === "string" ? { owner: input.owner } : {}), conversation: input.conversation };
}

export const readsFile = (layout: BotLayout): string => join(layout.dataDir, "reads.json");
export const conversationFile = (layout: BotLayout): string => join(layout.dataDir, "conversation-id");

function writeAtomic(layout: BotLayout, file: string, content: string): void {
  mkdirSync(layout.dataDir, { recursive: true, mode: 0o700 });
  const fresh = `${file}.new`;
  const handle = openSync(fresh, "w", 0o600);
  try {
    writeSync(handle, content);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(fresh, file);
}

function readText(file: string): string | undefined {
  try {
    return lstatSync(file, { throwIfNoEntry: false })?.isFile() ? readFileSync(file, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/** The saved setting. A missing, unreadable or malformed file is off. */
export function readReads(layout: BotLayout): ReadsSetting {
  const text = readText(readsFile(layout));
  if (text === undefined) return { areas: [] };
  try {
    const saved: unknown = JSON.parse(text);
    const areas = isRecord(saved) ? parseAreas(saved.areas) : undefined;
    const owner = isRecord(saved) && typeof saved.owner === "string" && OWNER_DID.test(saved.owner) ? saved.owner : undefined;
    return areas && areas.length > 0 && owner ? { areas, owner } : { areas: [] };
  } catch {
    return { areas: [] };
  }
}

export function writeReads(layout: BotLayout, setting: ReadsSetting): void {
  writeAtomic(layout, readsFile(layout), JSON.stringify(setting));
}

/** This conversation's id, made when the conversation's data directory has none. */
export function conversationId(layout: BotLayout): string {
  const saved = readText(conversationFile(layout))?.trim();
  if (saved && CONVERSATION_ID.test(saved)) return saved;
  const fresh = randomBytes(16).toString("hex");
  writeAtomic(layout, conversationFile(layout), fresh);
  return fresh;
}

/** The push for this bot: its saved setting and its conversation id. */
export function readsPush(layout: BotLayout): ReadsPush {
  return { ...readReads(layout), conversation: conversationId(layout) };
}
