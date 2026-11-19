import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, mkdirSync,
  openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
// Bun provides flock through libc, as in the hosted upload store.
// @ts-expect-error runtime-provided module
import { dlopen, FFIType } from "bun:ffi";

const KEY_BYTES = 32;
const DAY_MS = 86_400_000;
const LIVE_DAYS = 14;
const KEY_FILE = "connector-keys.json";
const TEMP_FILE = "connector-keys.new";
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const LOCK_EXCLUSIVE = 2;
const LOCK_NONBLOCKING = 4;
const UNAVAILABLE = "Connector key store unavailable";
const LOCKED = "Connector key store writer lock unavailable";
const INVALID_FILE = "Connector key store file invalid";
const INVALID_CLOCK = "Connector key store clock invalid";
const CREDENTIAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CREDENTIAL_SCOPE = /^[0-9a-f]{64}$/;

interface ScopedCredentialKey {
  scope: string;
  key: string;
}

interface KeyFile {
  version: 1;
  erasedThrough: number;
  // Ordered by UTC day, starting at erasedThrough + 1.
  days: string[];
  credentials: Record<string, string | ScopedCredentialKey>;
}

/** UTC epoch day. A slot is live through the end of its UTC day. */
export function utcDay(timestamp: number): number {
  return Math.floor(timestamp / DAY_MS);
}

function keyString(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

function isKeyString(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 44) return false;
  const key = Buffer.from(value, "base64");
  return key.length === KEY_BYTES && key.toString("base64") === value;
}

function isCredentialKey(value: unknown): boolean {
  return isKeyString(value) || (
    typeof value === "object" && value !== null &&
    "scope" in value && typeof value.scope === "string" && CREDENTIAL_SCOPE.test(value.scope) &&
    "key" in value && isKeyString(value.key)
  );
}

function decodeFile(raw: string): KeyFile {
  try {
    const file = JSON.parse(raw);
    if (
      file?.version === 1 && Number.isSafeInteger(file.erasedThrough) &&
      Array.isArray(file.days) && file.days.length === LIVE_DAYS && file.days.every(isKeyString) &&
      file.credentials && typeof file.credentials === "object" && !Array.isArray(file.credentials) &&
      Object.entries(file.credentials).every(([id, key]) => CREDENTIAL_ID.test(id) && isCredentialKey(key))
    ) return file;
  } catch {
    // A parser error can quote bytes from the file.
  }
  throw new Error(INVALID_FILE);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function openWriterLock(directory: string): number {
  const lock = openSync(join(directory, ".writer.lock"),
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
  try {
    // The Linux image needs glibc. A missing libc leaves the store unavailable.
    const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });
    try {
      // The stable lock inode must survive replacement of the key file.
      if (libc.symbols.flock(lock, LOCK_EXCLUSIVE | LOCK_NONBLOCKING) !== 0) {
        throw new Error(LOCKED);
      }
    } finally {
      libc.close();
    }
    return lock;
  } catch (error) {
    closeSync(lock);
    throw error;
  }
}

/** Rotate independently of queue traffic and node availability. */
export function startConnectorKeyRotation(store: ConnectorKeyStore): void {
  let day: number | undefined;
  let failed = false;
  const schedule = (retry = false) => {
    const now = Date.now();
    const midnight = (utcDay(now) + 1) * DAY_MS;
    setTimeout(tick, retry ? 1_000 : Math.min(60_000, midnight - now)).unref();
  };
  const tick = () => {
    const current = utcDay(Date.now());
    try {
      if (current !== day) {
        store.advance();
        day = current;
      }
      failed = false;
      schedule();
    } catch {
      if (!failed) console.warn("[connector-retention] op=key-rotation result=failed");
      failed = true;
      schedule(true);
    }
  };
  tick();
}

/** A single writer on a dedicated local volume. Each operation reads the durable key file. */
export class ConnectorKeyStore {
  #lock: number | null;
  #directory: string;
  #now: () => number;
  #lastTime = -Infinity;
  #writeFailed = false;

  private constructor(directory: string, lock: number, now: () => number) {
    this.#directory = directory;
    this.#lock = lock;
    this.#now = now;
  }

  static open(directory: string, now: () => number = Date.now): ConnectorKeyStore {
    let store: ConnectorKeyStore | undefined;
    try {
      mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      store = new ConnectorKeyStore(directory, openWriterLock(directory), now);
      chmodSync(directory, PRIVATE_DIRECTORY_MODE);
      store.#discardTempFile();
      const today = store.#today();
      const file = store.#readFile();
      if (file === null) {
        store.#writeFile({
          version: 1,
          erasedThrough: today - 1,
          days: Array.from({ length: LIVE_DAYS }, keyString),
          credentials: {},
        });
      } else {
        store.#advance(file, today);
      }
      return store;
    } catch (error) {
      store?.close();
      // Only our fixed errors may leave this boundary.
      if (error instanceof Error && [LOCKED, INVALID_FILE, INVALID_CLOCK].includes(error.message)) {
        throw new Error(error.message);
      }
      throw new Error(UNAVAILABLE);
    }
  }

  close(): void {
    if (this.#lock === null) return;
    const lock = this.#lock;
    this.#lock = null;
    try {
      closeSync(lock);
    } catch {
      throw new Error(UNAVAILABLE);
    }
  }

  /** Persist the new UTC day and discard expired slots even when there is no read traffic. */
  advance(): void {
    this.#currentFile();
  }

  getDayKey(day: number): Buffer | null {
    const file = this.#currentFile();
    const offset = day - file.erasedThrough - 1;
    if (!Number.isInteger(offset) || offset < 0 || offset >= LIVE_DAYS) return null;
    return Buffer.from(file.days[offset]!, "base64");
  }

  getLiveDayKeys(): ReadonlyArray<{ day: number; key: Buffer }> {
    const file = this.#currentFile();
    return file.days.map((key, offset) => ({
      day: file.erasedThrough + 1 + offset,
      key: Buffer.from(key, "base64"),
    }));
  }

  createCredentialKey(): { id: string; key: Buffer } {
    return this.#allocateCredentialKey(this.#currentFile());
  }

  getOrCreateScopedCredentialKey(scope: string): { id: string; key: Buffer } {
    if (!CREDENTIAL_SCOPE.test(scope)) throw new Error(UNAVAILABLE);
    const file = this.#currentFile();
    for (const [id, entry] of Object.entries(file.credentials)) {
      if (typeof entry !== "string" && entry.scope === scope) return { id, key: Buffer.from(entry.key, "base64") };
    }
    return this.#allocateCredentialKey(file, scope);
  }

  #allocateCredentialKey(file: KeyFile, scope?: string): { id: string; key: Buffer } {
    const id = randomUUID();
    if (Object.hasOwn(file.credentials, id)) throw new Error(UNAVAILABLE);
    const key = keyString();
    file.credentials[id] = scope === undefined ? key : { scope, key };
    this.#writeFile(file);
    return { id, key: Buffer.from(key, "base64") };
  }

  getCredentialKey(id: string, scope?: string): Buffer | null {
    const { credentials } = this.#currentFile();
    if (!CREDENTIAL_ID.test(id) || !Object.hasOwn(credentials, id)) return null;
    const entry = credentials[id]!;
    if (scope !== undefined && (typeof entry === "string" || entry.scope !== scope)) return null;
    return Buffer.from(typeof entry === "string" ? entry : entry.key, "base64");
  }

  destroyCredentialKey(id: string): void {
    const file = this.#currentFile();
    if (!CREDENTIAL_ID.test(id) || !Object.hasOwn(file.credentials, id)) return;
    delete file.credentials[id];
    this.#writeFile(file);
  }

  destroyScopedCredentialKey(scope: string): void {
    const file = this.#currentFile();
    const matching = Object.entries(file.credentials)
      .filter(([, entry]) => typeof entry !== "string" && entry.scope === scope);
    if (matching.length === 0) return;
    for (const [id] of matching) delete file.credentials[id];
    this.#writeFile(file);
  }

  #today(): number {
    let now: number;
    try {
      now = this.#now();
    } catch {
      throw new Error(INVALID_CLOCK);
    }
    if (!Number.isSafeInteger(now) || now < 0 || now < this.#lastTime) {
      throw new Error(INVALID_CLOCK);
    }
    this.#lastTime = now;
    return utcDay(now);
  }

  #currentFile(): KeyFile {
    if (this.#lock === null || this.#writeFailed) throw new Error(UNAVAILABLE);
    const today = this.#today();
    const file = this.#readFile();
    if (file === null) throw new Error(UNAVAILABLE);
    // Record every observed day boundary before returning any key, even on a read.
    this.#advance(file, today);
    return file;
  }

  #advance(file: KeyFile, today: number): void {
    const elapsed = today - 1 - file.erasedThrough;
    if (elapsed < 0) throw new Error(INVALID_CLOCK);
    if (elapsed === 0) return;
    file.days = file.days.slice(elapsed);
    while (file.days.length < LIVE_DAYS) file.days.push(keyString());
    file.erasedThrough = today - 1;
    this.#writeFile(file);
  }

  #readFile(): KeyFile | null {
    let fd: number;
    try {
      fd = openSync(join(this.#directory, KEY_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (isMissing(error)) return null;
      throw new Error(UNAVAILABLE);
    }
    let raw: string;
    try {
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 0o7777) !== PRIVATE_FILE_MODE || stat.uid !== process.getuid?.() || stat.nlink !== 1) {
          throw new Error(INVALID_FILE);
        }
        raw = readFileSync(fd, "utf8");
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if (error instanceof Error && error.message === INVALID_FILE) throw new Error(INVALID_FILE);
      throw new Error(UNAVAILABLE);
    }
    return decodeFile(raw);
  }

  #discardTempFile(): void {
    try {
      unlinkSync(join(this.#directory, TEMP_FILE));
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    this.#syncDirectory();
  }

  #syncDirectory(): void {
    const fd = openSync(this.#directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  #writeFile(file: KeyFile): void {
    const temp = join(this.#directory, TEMP_FILE);
    try {
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, PRIVATE_FILE_MODE);
      try {
        fchmodSync(fd, PRIVATE_FILE_MODE);
        writeFileSync(fd, JSON.stringify(file));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, join(this.#directory, KEY_FILE));
      this.#syncDirectory();
    } catch {
      // A failed directory sync leaves the rename's durability unknown. Require a reopen.
      this.#writeFailed = true;
      try { this.#discardTempFile(); } catch { /* Startup cleans any remaining temp file. */ }
      throw new Error(UNAVAILABLE);
    }
  }
}
