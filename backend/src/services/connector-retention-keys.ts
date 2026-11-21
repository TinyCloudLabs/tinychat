import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { utcDay, type ConnectorKeyStore } from "./connector-key-store.js";

export type ConnectorRetentionKeys = Pick<ConnectorKeyStore, "getLiveDayKeys">;

export function assertConnectorPlaintextTestMode(): void {
  if (process.env.CONNECTOR_KEY_STORE_TEST_PLAINTEXT !== "1") {
    throw new Error("Connector key store required for writes");
  }
}

/** Slots end at midnight UTC. Use the latest slot that ends by the exact deadline. */
export function slotFor(expiresAt: number): number {
  return utcDay(expiresAt) - 1;
}

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface SealedQueueEntry {
  v: 1;
  slot: number;
  sealed: string;
}

function queueAad(storageKey: string, slot: number): Buffer {
  return Buffer.from(JSON.stringify(["tinychat-queue-v1", storageKey, slot]));
}

function queueKey(key: Buffer): Buffer {
  return createHmac("sha256", key).update("tinychat-queue-key-v1").digest();
}

export function sealQueueEntry(key: Buffer, storageKey: string, slot: number, value: unknown): SealedQueueEntry {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", queueKey(key), nonce);
  cipher.setAAD(queueAad(storageKey, slot));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { v: 1, slot, sealed: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url") };
}

export function isSealedQueueEntry(value: unknown): value is SealedQueueEntry {
  return typeof value === "object" && value !== null && "v" in value && value.v === 1 &&
    "slot" in value && Number.isSafeInteger(value.slot) && "sealed" in value && typeof value.sealed === "string";
}

export function openQueueEntry(key: Buffer, storageKey: string, entry: SealedQueueEntry): unknown {
  try {
    const bytes = Buffer.from(entry.sealed, "base64url");
    if (bytes.length <= NONCE_BYTES + TAG_BYTES) return null;
    const decipher = createDecipheriv("aes-256-gcm", queueKey(key), bytes.subarray(0, NONCE_BYTES));
    decipher.setAAD(queueAad(storageKey, entry.slot));
    decipher.setAuthTag(bytes.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
    const clear = Buffer.concat([decipher.update(bytes.subarray(NONCE_BYTES + TAG_BYTES)), decipher.final()]);
    return JSON.parse(clear.toString("utf8"));
  } catch {
    return null;
  }
}

export function ledgerIdCode(key: Buffer, storageKey: string, meetingId: string): string {
  return createHmac("sha256", key)
    .update(JSON.stringify(["tinychat-purge-ledger-v1", storageKey, meetingId]))
    .digest("base64url");
}

export interface LedgerIdCode {
  slot: number;
  addedAt: string;
  code: string;
  mac: string;
}

function ledgerCodeMac(key: Buffer, storageKey: string, entry: Omit<LedgerIdCode, "mac">): Buffer {
  return createHmac("sha256", key)
    .update(JSON.stringify(["tinychat-purge-ledger-entry-v1", storageKey, entry.slot, entry.addedAt, entry.code]))
    .digest();
}

export function makeLedgerIdCode(key: Buffer, storageKey: string, slot: number, addedAt: string, id: string): LedgerIdCode {
  const entry = { slot, addedAt, code: ledgerIdCode(key, storageKey, id) };
  return { ...entry, mac: ledgerCodeMac(key, storageKey, entry).toString("base64url") };
}

const CODE_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export function isLedgerIdCode(value: unknown): value is LedgerIdCode {
  return typeof value === "object" && value !== null && "slot" in value &&
    Number.isSafeInteger(value.slot) && "addedAt" in value && typeof value.addedAt === "string" &&
    "code" in value && typeof value.code === "string" && CODE_PATTERN.test(value.code) &&
    "mac" in value && typeof value.mac === "string" && CODE_PATTERN.test(value.mac);
}

export function verifyLedgerIdCode(key: Buffer, storageKey: string, entry: LedgerIdCode): boolean {
  return timingSafeEqual(Buffer.from(entry.mac, "base64url"), ledgerCodeMac(key, storageKey, entry));
}
