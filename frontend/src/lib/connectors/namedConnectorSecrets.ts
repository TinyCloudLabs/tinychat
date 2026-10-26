import { CONNECTORS_KV_PREFIX, TINYCHAT_KEY_PREFIX } from "@tinyboilerplate/core";
import type { ConnectorDescriptor } from "./types";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { getConnectorKey as getLegacyConnectorKey, isSecretsUnlocked, unlockSecrets } from "./connectorSecrets";

type ErrorValue = { code: string; message: string };
type Result<T> = { ok: true; data: T } | { ok: false; error: ErrorValue };
type Envelope = Awaited<ReturnType<TinyCloudWeb["keys"]["encrypt"]>>;

export type LegacyConnectorClient = Parameters<typeof getLegacyConnectorKey>[0];
export type RequestLegacyAccess = () => Promise<LegacyConnectorClient | null>;
export type SecretsErr = ErrorValue;

/** Named-key reads need a signed session, not an unlocked legacy vault. */
export function isConnectorKeysReady(tcw: TinyCloudWeb): boolean {
  return typeof tcw.keys?.decrypt === "function";
}

export function connectorKeyPath(descriptor: Pick<ConnectorDescriptor, "id">): string {
  return `${TINYCHAT_KEY_PREFIX}connectors/${descriptor.id}`;
}

/** The existing connectors KV grant covers this app-owned envelope record. */
export function connectorEnvelopeKvPath(descriptor: Pick<ConnectorDescriptor, "id">): string {
  return `${CONNECTORS_KV_PREFIX}/credentials/${descriptor.id}`;
}

function failure(caught: unknown, descriptor: ConnectorDescriptor): { ok: false; error: ErrorValue } {
  const value = caught as { code?: unknown; message?: unknown } | null;
  return {
    ok: false,
    error: {
      code: typeof value?.code === "string" ? value.code : "CONNECTOR_KEY_ERROR",
      message: typeof value?.message === "string" ? value.message : `Something went wrong with your ${descriptor.name} key. Try again.`,
    },
  };
}

function parseEnvelope(value: unknown, expectedPath: string, descriptor: ConnectorDescriptor): Result<Envelope> {
  const invalid = (): Result<Envelope> => ({ ok: false, error: {
    code: "CONNECTOR_ENVELOPE_INVALID",
    message: `This saved ${descriptor.name} key can't be read. To fix it, disconnect ${descriptor.name} and connect it again.`,
  } });
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return invalid(); }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalid();
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope.v !== 2 || envelope.keyPath !== expectedPath) {
    return invalid();
  }
  return { ok: true, data: envelope as Envelope };
}

export async function saveNamedConnectorKey(
  client: TinyCloudWeb,
  descriptor: ConnectorDescriptor,
  secret: string,
): Promise<Result<void>> {
  try {
    const path = connectorKeyPath(descriptor);
    await client.keys.ensureKey(path);
    const envelope = await client.keys.encrypt(path, new TextEncoder().encode(secret));
    const saved = await client.kv.put(connectorEnvelopeKvPath(descriptor), JSON.stringify(envelope));
    return saved.ok ? { ok: true, data: undefined } : saved;
  } catch (caught) { return failure(caught, descriptor); }
}

export async function readNamedConnectorKey(
  client: TinyCloudWeb,
  descriptor: ConnectorDescriptor,
): Promise<Result<string | null>> {
  try {
    const stored = await client.kv.get(connectorEnvelopeKvPath(descriptor), { source: "network" });
    if (!stored.ok) {
      if (stored.error.code === "KV_NOT_FOUND") return { ok: true, data: null };
      return stored;
    }
    const envelope = parseEnvelope(stored.data.data, connectorKeyPath(descriptor), descriptor);
    if (!envelope.ok) return envelope;
    const bytes = await client.keys.decrypt(envelope.data);
    return { ok: true, data: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch (caught) { return failure(caught, descriptor); }
}

export function migrationDeclinedMessage(descriptor: ConnectorDescriptor): string {
  return `Not moved. Your ${descriptor.name} key is kept, but ${descriptor.name} won't work until you approve. You'll be asked again next time.`;
}

/** The old vault copy is retained after a verified migration. */
export async function readOrMigrateConnectorKey(
  client: TinyCloudWeb,
  descriptor: ConnectorDescriptor,
  requestLegacyAccess: RequestLegacyAccess,
): Promise<Result<string>> {
  const current = await readNamedConnectorKey(client, descriptor);
  if (!current.ok) return current;
  if (current.data !== null) return { ok: true, data: current.data };

  let legacy: LegacyConnectorClient | null;
  try { legacy = await requestLegacyAccess(); } catch (caught) { return failure(caught, descriptor); }
  if (legacy === null) {
    return { ok: false, error: { code: "CONNECTOR_MIGRATION_DECLINED", message: migrationDeclinedMessage(descriptor) } };
  }
  try {
    if (!isSecretsUnlocked(legacy)) {
      const unlocked = await unlockSecrets<ErrorValue>(legacy);
      if (!unlocked.ok) return unlocked;
    }
    const old = await getLegacyConnectorKey<ErrorValue>(legacy, descriptor);
    if (!old.ok) return old;
    const saved = await saveNamedConnectorKey(client, descriptor, old.data);
    if (!saved.ok) return saved;
    const verified = await readNamedConnectorKey(client, descriptor);
    if (!verified.ok) return verified;
    if (verified.data !== old.data) {
      return { ok: false, error: { code: "CONNECTOR_MIGRATION_MISMATCH", message: `Couldn't confirm the new copy, so your ${descriptor.name} key stays where it was.` } };
    }
    return { ok: true, data: old.data };
  } finally {
    if ("cleanup" in legacy && typeof legacy.cleanup === "function") legacy.cleanup();
  }
}

export async function deleteNamedConnectorKey(
  client: TinyCloudWeb,
  descriptor: ConnectorDescriptor,
): Promise<Result<void>> {
  try {
    const removed = await client.kv.delete(connectorEnvelopeKvPath(descriptor));
    return removed.ok ? { ok: true, data: undefined } : removed;
  } catch (caught) { return failure(caught, descriptor); }
}

/** Production connector call sites keep their Result-based interface. */
export async function saveConnectorKey<E>(
  tcw: TinyCloudWeb,
  descriptor: ConnectorDescriptor,
  secret: string,
): Promise<{ ok: true; data: void } | { ok: false; error: E }> {
  return saveNamedConnectorKey(tcw, descriptor, secret) as Promise<{ ok: true; data: void } | { ok: false; error: E }>;
}

export async function getConnectorKey<E>(
  tcw: TinyCloudWeb,
  descriptor: ConnectorDescriptor,
): Promise<{ ok: true; data: string } | { ok: false; error: E }> {
  const result = await readNamedConnectorKey(tcw, descriptor);
  if (!result.ok) return result as { ok: false; error: E };
  if (result.data === null) {
    return { ok: false, error: { code: "CONNECTOR_MIGRATION_REQUIRED", message: `Approve once to move your saved ${descriptor.name} key.` } as E };
  }
  return { ok: true, data: result.data };
}

export async function deleteConnectorKey<E>(
  tcw: TinyCloudWeb,
  descriptor: ConnectorDescriptor,
): Promise<{ ok: true; data: void } | { ok: false; error: E }> {
  return deleteNamedConnectorKey(tcw, descriptor) as Promise<{ ok: true; data: void } | { ok: false; error: E }>;
}
