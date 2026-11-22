// Sealed records for secret requests: one file per request under the gateway's own volume, AES-256-GCM with the key
// from dstack (dstack-key.ts), a random 96-bit nonce per write, and the request id and bot id as associated data,
// so a file can't be renamed onto another request or bot. Writes go through a temporary file, fsync and rename, as
// the budget file does. Deleting a request unlinks its file; nothing else holds a copy (the volume has no backups).

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "./guards";
import { BOT_ID } from "./owner";

export const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** A file found at start. `record` is missing when it no longer opens (another key, or damaged). */
export interface SealedEntry {
  id: string;
  botId: string;
  record?: unknown;
}

export interface GrantStore {
  load(): SealedEntry[];
  save(id: string, botId: string, record: unknown): void;
  remove(id: string): void;
}

const aad = (id: string, botId: string) => Buffer.from(`${id}\n${botId}`);

export function sealedGrantStore(dir: string, key: Uint8Array): GrantStore {
  if (key.length !== 32) throw new Error("the sealing key must be 32 bytes");
  const file = (id: string) => join(dir, `${id}.json`);
  return {
    load() {
      if (!existsSync(dir)) return [];
      const entries: SealedEntry[] = [];
      for (const name of readdirSync(dir)) {
        const id = name.endsWith(".json") ? name.slice(0, -5) : "";
        if (!REQUEST_ID.test(id)) continue;
        let sealed: unknown;
        try {
          sealed = JSON.parse(readFileSync(file(id), "utf8"));
        } catch {
          continue; // a write cut short never renamed into place; anything else here is not ours
        }
        if (!isRecord(sealed) || typeof sealed.botId !== "string" || !BOT_ID.test(sealed.botId)) continue;
        const botId = sealed.botId;
        try {
          const nonce = Buffer.from(String(sealed.nonce), "base64");
          const data = Buffer.from(String(sealed.data), "base64");
          const decipher = createDecipheriv("aes-256-gcm", key, nonce);
          decipher.setAAD(aad(id, botId));
          decipher.setAuthTag(data.subarray(data.length - 16));
          const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
          entries.push({ id, botId, record: JSON.parse(plain.toString("utf8")) });
        } catch {
          entries.push({ id, botId });
        }
      }
      return entries;
    },
    save(id, botId, record) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aad(id, botId));
      const data = Buffer.concat([cipher.update(JSON.stringify(record), "utf8"), cipher.final(), cipher.getAuthTag()]);
      const fresh = `${file(id)}.new`;
      const handle = openSync(fresh, "w", 0o600);
      try {
        writeSync(handle, JSON.stringify({ v: 1, botId, nonce: nonce.toString("base64"), data: data.toString("base64") }));
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      renameSync(fresh, file(id));
      syncDir(dir);
    },
    remove(id) {
      if (!existsSync(file(id))) return;
      rmSync(file(id), { force: true });
      syncDir(dir);
    },
  };
}

function syncDir(dir: string): void {
  const handle = openSync(dir, "r");
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}
