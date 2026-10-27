import { CONNECTORS_KV_PREFIX, TINYCHAT_KEY_PREFIX } from "@tinyboilerplate/core";
import { extractRecapAttenuations, makePkhSpaceId, pkhDid } from "@tinycloud/sdk-core";
import { resolveSecretPath } from "@tinycloud/web-sdk";
import type { ConnectorDescriptor } from "./types";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { deleteConnectorKey as deleteLegacyConnectorKey, getConnectorKey as getLegacyConnectorKey, isSecretsUnlocked, saveConnectorKey as saveLegacyConnectorKey, unlockSecrets } from "./connectorSecrets";
import { usesNamedConnectorKeys } from "./connectorKeyMode";
import { secretsAvailable } from "../openkeyNative";

type ErrorValue = { code: string; message: string };
type Result<T> = { ok: true; data: T } | { ok: false; error: ErrorValue };
type Envelope = Awaited<ReturnType<TinyCloudWeb["keys"]["encrypt"]>>;

export type LegacyConnectorClient = Parameters<typeof getLegacyConnectorKey>[0];
export type RequestLegacyAccess = () => Promise<LegacyConnectorClient | null>;
export type SecretsErr = ErrorValue;

/** A signed, uncaveated decrypt grant is the authority for the connector prefix. */
export function isConnectorKeysReady(tcw: TinyCloudWeb): boolean {
  return secretsAvailable() && sessionHasConnectorKeyGrant(tcw);
}

export function sessionHasConnectorKeyGrant(tcw: TinyCloudWeb): boolean {
  const session = typeof tcw.session === "function" ? tcw.session() : undefined;
  if (!session) return false;
  try {
    const resource = `urn:tinycloud:encryption:${pkhDid(session.address, session.chainId)}:default/${TINYCHAT_KEY_PREFIX}`;
    const caveats = extractRecapAttenuations(session.siwe)[resource]?.["tinycloud.encryption/decrypt"];
    return Array.isArray(caveats) && caveats.some((caveat) => caveat && typeof caveat === "object" && !Array.isArray(caveat) && Object.keys(caveat).length === 0);
  } catch { return false; }
}

export function isOpenKeyUserDecline(caught: unknown): boolean {
  return caught !== null && typeof caught === "object" && "code" in caught && caught.code === "USER_CANCELLED";
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
  try { legacy = await requestLegacyAccess(); } catch (caught) {
    return isOpenKeyUserDecline(caught)
      ? { ok: false, error: { code: "CONNECTOR_MIGRATION_DECLINED", message: migrationDeclinedMessage(descriptor) } }
      : failure(caught, descriptor);
  }
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
    if (!verified.ok) {
      const removed = await deleteNamedConnectorKey(client, descriptor);
      return removed.ok ? verified : removed;
    }
    if (verified.data !== old.data) {
      const removed = await deleteNamedConnectorKey(client, descriptor);
      if (!removed.ok) return removed;
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

/** A session's secrets-space KV grant can remove the old record while its vault is locked. */
export async function deleteConnectorCredentials(
  client: TinyCloudWeb,
  descriptor: ConnectorDescriptor,
): Promise<Result<void>> {
  if (!usesNamedConnectorKeys()) return deleteLegacyConnectorKey<ErrorValue>(client, descriptor);
  try {
    const session = client.session();
    if (!session) return { ok: false, error: { code: "SESSION_MISSING", message: "Your session expired. Sign in again to continue." } };
    const space = makePkhSpaceId(session.address, session.chainId, "secrets");
    const options = descriptor.secretScope ? { scope: descriptor.secretScope } : undefined;
    const path = resolveSecretPath(descriptor.secretName, options).permissionPaths.vault;
    const old = await client.kvForSpace(space).delete(path);
    if (!old.ok && old.error.code !== "KV_NOT_FOUND") return old;
    const named = await deleteNamedConnectorKey(client, descriptor);
    return !named.ok && named.error.code === "KV_NOT_FOUND" ? { ok: true, data: undefined } : named;
  } catch (caught) { return failure(caught, descriptor); }
}

/** Production connector call sites keep their Result-based interface. */
export async function saveConnectorKey<E>(
  tcw: TinyCloudWeb,
  descriptor: ConnectorDescriptor,
  secret: string,
): Promise<{ ok: true; data: void } | { ok: false; error: E }> {
  if (!usesNamedConnectorKeys()) return saveLegacyConnectorKey<E>(tcw, descriptor, secret);
  return saveNamedConnectorKey(tcw, descriptor, secret) as Promise<{ ok: true; data: void } | { ok: false; error: E }>;
}

export async function getConnectorKey<E>(
  tcw: TinyCloudWeb,
  descriptor: ConnectorDescriptor,
): Promise<{ ok: true; data: string } | { ok: false; error: E }> {
  if (!usesNamedConnectorKeys()) return getLegacyConnectorKey<E>(tcw, descriptor);
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
  if (!usesNamedConnectorKeys()) return deleteLegacyConnectorKey<E>(tcw, descriptor);
  return deleteNamedConnectorKey(tcw, descriptor) as Promise<{ ok: true; data: void } | { ok: false; error: E }>;
}
