import { Capacitor, registerPlugin } from "@capacitor/core";
import { appPlatform, type AppPlatform } from "../platform";

/**
 * TC-2862: the phone app's local TinyCloud copy, kept by the native `TinyCloudReplicaStore` plugin
 * (mobile/ios/Packages/ReplicaStore, mobile/android/.../replica) in SQLite outside the WebView, so iOS can't evict it.
 *
 * `createNativeReplicaStorage` is the KV half of the proposed SDK `ReplicaStorage` contract: IndexedDB-like object
 * stores (the SDK's kv-storage `meta`, `entries`, `blobs`, `pending`, …) with atomic multi-op writes. Nothing reads or
 * writes it until the SDK adapter consumes it; `VITE_EXO_NATIVE_REPLICA=true` is the switch for that. The sign-out
 * wipe (`wipeNativeReplicaOnSignOut`) runs whenever the plugin exists, flag or not, so no build strands a copy.
 *
 * Native contract (iOS and Android are identical):
 * - One SQLite file and one 256-bit secret per account (file named by SHA-256 of the account, never the account).
 *   iOS: Application Support, excluded from backup, readable after first unlock, secret in the Keychain
 *   (AfterFirstUnlockThisDeviceOnly). Android: noBackupFilesDir, secret wrapped by an Android Keystore key.
 * - Rows are sealed: lookup column HMAC-SHA256(store ‖ 0 ‖ key), value AES-256-GCM(key ‖ value) bound to the store
 *   and row. A row that fails authentication rejects `CORRUPT` after wiping that account (it is only a copy).
 * - One open account at a time; opening another closes the first. `wipe` deletes an account's files and secret
 *   (crypto-shred); `wipeAll` every account's. Values cross the bridge as base64 strings.
 * - `list` sorts by the key's UTF-8 bytes (the node feed's order) after a byte-prefix match, then applies `limit`.
 * - Errors: NOT_OPEN, STORAGE_BUDGET (write over `maxBytes`, rolled back), STORAGE_FULL, CORRUPT, INVALID_ARGUMENT, IO.
 */

export const NATIVE_REPLICA_PLUGIN = "TinyCloudReplicaStore";

export type NativeReplicaOp =
  | { op: "put"; store: string; key: string; value: string }
  | { op: "delete"; store: string; key: string }
  | { op: "clear"; store: string };

export interface TinyCloudReplicaStorePlugin {
  open(options: { account: string; maxBytes?: number }): Promise<{ schemaVersion: number; created: boolean }>;
  close(): Promise<void>;
  get(options: { store: string; key: string }): Promise<{ value: string | null }>;
  getMany(options: { store: string; keys: string[] }): Promise<{ values: (string | null)[] }>;
  list(options: { store: string; prefix?: string; limit?: number }): Promise<{ entries: { key: string; value: string }[] }>;
  write(options: { ops: NativeReplicaOp[] }): Promise<void>;
  estimate(): Promise<{ usedBytes: number; freeBytes: number | null }>;
  wipe(options: { account: string }): Promise<void>;
  wipeAll(): Promise<void>;
}

export type ReplicaStorageErrorCode =
  | "NOT_OPEN" | "STORAGE_BUDGET" | "STORAGE_FULL" | "CORRUPT" | "INVALID_ARGUMENT" | "ACCOUNT_MISMATCH" | "IO";

export class ReplicaStorageError extends Error {
  constructor(readonly code: ReplicaStorageErrorCode, message: string) {
    super(message);
    this.name = "ReplicaStorageError";
  }
}

export type ReplicaWriteOp =
  | { op: "put"; store: string; key: string; value: Uint8Array }
  | { op: "delete"; store: string; key: string }
  | { op: "clear"; store: string };

export interface ReplicaStorageHandle {
  readonly account: string;
  readonly schemaVersion: number;
  /** True when this open created the file (first use, or the old copy was dropped). */
  readonly created: boolean;
  get(store: string, key: string): Promise<Uint8Array | null>;
  getMany(store: string, keys: string[]): Promise<(Uint8Array | null)[]>;
  list(store: string, options?: { prefix?: string; limit?: number }): Promise<{ key: string; value: Uint8Array }[]>;
  write(ops: ReplicaWriteOp[]): Promise<void>;
  estimate(): Promise<{ usedBytes: number; freeBytes: number | null }>;
  close(): Promise<void>;
}

export interface ReplicaStorage {
  readonly kind: "native-sqlite";
  open(binding: { account: string; maxBytes?: number }): Promise<ReplicaStorageHandle>;
  wipe(account: string): Promise<void>;
  wipeAll(): Promise<void>;
}

let registered: TinyCloudReplicaStorePlugin | null = null;

/** The plugin on the phone apps when the shell has it (older shells don't); null on the web and desktop. */
export function nativeReplicaPlugin(
  platform: AppPlatform = appPlatform(),
  available: (name: string) => boolean = (name) => Capacitor.isPluginAvailable(name),
): TinyCloudReplicaStorePlugin | null {
  if ((platform !== "ios" && platform !== "android") || !available(NATIVE_REPLICA_PLUGIN)) return null;
  // Capacitor warns on a second registration of the same name.
  registered ??= registerPlugin<TinyCloudReplicaStorePlugin>(NATIVE_REPLICA_PLUGIN);
  return registered;
}

/** Off unless the build sets `VITE_EXO_NATIVE_REPLICA=true` and the shell has the plugin. */
export function isNativeReplicaEnabled(inputs: {
  buildFlag?: string | undefined;
  plugin?: TinyCloudReplicaStorePlugin | null;
} = {}): boolean {
  const flag = "buildFlag" in inputs ? inputs.buildFlag : import.meta.env.VITE_EXO_NATIVE_REPLICA;
  if (flag !== "true") return false;
  return ("plugin" in inputs ? inputs.plugin : nativeReplicaPlugin()) != null;
}

/** The codes the plugin rejects with; anything else (bridge failures) reads as IO. */
const NATIVE_ERROR_CODES: Record<string, true> = {
  NOT_OPEN: true, STORAGE_BUDGET: true, STORAGE_FULL: true, CORRUPT: true, INVALID_ARGUMENT: true, IO: true,
};

function storageError(caught: unknown): ReplicaStorageError {
  if (caught instanceof ReplicaStorageError) return caught;
  const raw = (caught as { code?: unknown } | null)?.code;
  const code = typeof raw === "string" && NATIVE_ERROR_CODES[raw] === true ? (raw as ReplicaStorageErrorCode) : "IO";
  return new ReplicaStorageError(code, caught instanceof Error ? caught.message : String(caught));
}

async function native<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (caught) {
    throw storageError(caught);
  }
}

const BASE64_CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(start, start + BASE64_CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * The account the plugin has open, as far as JS knows. The native side holds one account per process, so this is
 * module-wide: every storage instance and the sign-out wipe share it.
 */
let activeBinding: { token: object; account: string } | null = null;

/**
 * The KV `ReplicaStorage` over the plugin. The plugin holds one account at a time, so a handle stops working once
 * another account opens, its account is wiped or it is closed (`ACCOUNT_MISMATCH`) instead of reading another
 * account's copy.
 */
export function createNativeReplicaStorage(plugin: TinyCloudReplicaStorePlugin): ReplicaStorage {
  const open = async (binding: { account: string; maxBytes?: number }): Promise<ReplicaStorageHandle> => {
    if (!binding.account) throw new ReplicaStorageError("INVALID_ARGUMENT", "account is required");
    const token = {};
    activeBinding = { token, account: binding.account };
    const opened = await native(() => plugin.open(
      binding.maxBytes === undefined ? { account: binding.account } : { account: binding.account, maxBytes: binding.maxBytes },
    ));
    const current = <T>(operation: () => Promise<T>): Promise<T> => {
      if (activeBinding?.token !== token) {
        return Promise.reject(new ReplicaStorageError("ACCOUNT_MISMATCH", "this replica handle is no longer open"));
      }
      return native(operation);
    };
    return {
      account: binding.account,
      schemaVersion: opened.schemaVersion,
      created: opened.created,
      get: (store, key) => current(async () => {
        const { value } = await plugin.get({ store, key });
        return value === null ? null : base64ToBytes(value);
      }),
      getMany: (store, keys) => current(async () => {
        const { values } = await plugin.getMany({ store, keys });
        return values.map((value) => (value === null ? null : base64ToBytes(value)));
      }),
      list: (store, options = {}) => current(async () => {
        const { entries } = await plugin.list({ store, ...options });
        return entries.map(({ key, value }) => ({ key, value: base64ToBytes(value) }));
      }),
      write: (ops) => current(() => plugin.write({
        ops: ops.map((op) => (op.op === "put" ? { ...op, value: bytesToBase64(op.value) } : op)),
      })),
      estimate: () => current(() => plugin.estimate()),
      close: async () => {
        if (activeBinding?.token !== token) return;
        activeBinding = null;
        await native(() => plugin.close());
      },
    };
  };

  return {
    kind: "native-sqlite",
    open,
    wipe: async (account) => {
      if (activeBinding?.account === account) activeBinding = null;
      await native(() => plugin.wipe({ account }));
    },
    wipeAll: async () => {
      activeBinding = null;
      await native(() => plugin.wipeAll());
    },
  };
}

export type NativeReplicaWipeResult = { ok: true; skipped: boolean } | { ok: false; code: ReplicaStorageErrorCode };

/**
 * Sign-out (TC-2785's rule: nothing of the previous account stays readable). The copy holds only data the node
 * already has, so it is deleted outright: the account's file and secret, then every account's as a guard. Never
 * throws; a shell without the plugin has nothing to delete.
 */
export async function wipeNativeReplicaOnSignOut(
  account: string | null,
  plugin?: TinyCloudReplicaStorePlugin | null,
): Promise<NativeReplicaWipeResult> {
  try {
    const target = plugin === undefined ? nativeReplicaPlugin() : plugin;
    if (!target) return { ok: true, skipped: true };
    activeBinding = null;
    if (account) await target.wipe({ account });
    await target.wipeAll();
    return { ok: true, skipped: false };
  } catch (caught) {
    return { ok: false, code: storageError(caught).code };
  }
}
