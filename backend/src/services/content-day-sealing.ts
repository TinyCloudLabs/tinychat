import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { utcDay } from "./connector-key-store.js";
import { slotFor } from "./connector-retention-keys.js";

export const CONTENT_DAY_MS = 86_400_000;
const FUTURE_SKEW_MS = 5 * 60_000;

export function contentSlotForDelivery(
  sourceTimestamp: string | undefined,
  receivedAt: string,
  now: number,
  ttlMs: number,
): { slot: number; expiresAt: string } | null {
  const received = Date.parse(receivedAt);
  const provider = sourceTimestamp === undefined ? undefined : Date.parse(sourceTimestamp);
  if (!Number.isFinite(received) || received > now) return null;
  if (provider !== undefined && (!Number.isFinite(provider) || provider > received + FUTURE_SKEW_MS)) return null;
  const basis = provider === undefined ? received : provider - FUTURE_SKEW_MS;
  const slot = slotFor(basis + ttlMs);
  if (slot < utcDay(now)) return null;
  return { slot, expiresAt: new Date((slot + 1) * CONTENT_DAY_MS).toISOString().slice(0, 10) };
}

const CONTENT_PATH = /^content\/[a-f0-9]{64}$/;
export function isDayContentPath(path: unknown): path is string {
  return typeof path === "string" && CONTENT_PATH.test(path);
}

export function dayContentPath(dayKey: Buffer, sourceId: string): string {
  const digest = createHmac("sha256", dayKey).update("content:").update(sourceId).digest("hex");
  return `content/${digest}`;
}

export function dayContentKek(dayKey: Buffer, source: string, address: string, path: string): Buffer {
  return Buffer.from(hkdfSync("sha256", dayKey, "tinychat-content-v2", JSON.stringify([source, address, path]), 32));
}

export interface ContentCleanupLocation {
  path: string;
  slot: number;
  expiresAt: string;
}

export interface ContentCleanupEntry extends ContentCleanupLocation {
  mac: string;
}

export interface ContentCleanupIndex {
  version: 2;
  entries: unknown[];
}

function cleanupMac(master: string, source: string, address: string, entry: ContentCleanupLocation): Buffer {
  const key = Buffer.from(hkdfSync("sha256", master, "tinychat-content-cleanup-v2", JSON.stringify([source, address]), 32));
  return createHmac("sha256", key).update(JSON.stringify([entry.path, entry.slot, entry.expiresAt])).digest();
}

export function signContentCleanupEntry(master: string, source: string, address: string, entry: ContentCleanupLocation): ContentCleanupEntry {
  return { ...entry, mac: cleanupMac(master, source, address, entry).toString("hex") };
}

export function verifyContentCleanupEntry(master: string, source: string, address: string, value: unknown): ContentCleanupEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entry = value as Partial<ContentCleanupEntry>;
  if (!isDayContentPath(entry.path) || !Number.isSafeInteger(entry.slot) ||
      typeof entry.expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expiresAt) ||
      typeof entry.mac !== "string" || !/^[a-f0-9]{64}$/.test(entry.mac)) return null;
  const end = Date.parse(`${entry.expiresAt}T00:00:00.000Z`);
  if (!Number.isFinite(end) || new Date(end).toISOString().slice(0, 10) !== entry.expiresAt || slotFor(end) !== entry.slot) return null;
  const normalized = { path: entry.path, slot: entry.slot!, expiresAt: entry.expiresAt, mac: entry.mac };
  return timingSafeEqual(cleanupMac(master, source, address, normalized), Buffer.from(entry.mac, "hex")) ? normalized : null;
}

export function dayContentAad(source: string, address: string, entry: ContentCleanupLocation): Buffer {
  return Buffer.from(JSON.stringify(["tinychat-content-v2", source, address, entry.path, entry.slot, entry.expiresAt]));
}

export function dayReplayDigest(dayKey: Buffer, source: string, address: string, sourceId: string): string {
  return createHmac("sha256", dayKey).update(JSON.stringify(["tinychat-replay-v2", source, address, sourceId])).digest("hex");
}

export function dayReplayMac(dayKey: Buffer, digest: string, expiresAt: string): string {
  return createHmac("sha256", dayKey).update(JSON.stringify(["tinychat-replay-expiry-v2", digest, expiresAt])).digest("hex");
}
