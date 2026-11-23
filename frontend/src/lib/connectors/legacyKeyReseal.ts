// Connector keys saved before each had its own encryption key (TC-3284) are sealed to the owner's whole encryption
// network. The sign-in grant opens only the exact keys (so it can renew), which means opening an older key takes one
// separate approval of at most an hour, never renewed. That approval is also when each older key is moved onto its own
// encryption key, so Connectors needs only the exact-key grants afterwards.
//
// What decides whether the approval is needed is the stored envelope itself (a header read, no decrypt): a key that is
// already on its own key, or that was never saved, never asks. The marker below is a hint for the owner's other
// devices and diagnostics only; nothing here consults it.
import { CONNECTORS_KV_PREFIX } from "@tinyboilerplate/core";
import { parseSecretKeyPath, resolveSecretPath } from "@tinycloud/sdk-services";
import type { PermissionEntry, TinyCloudWeb } from "@tinycloud/web-sdk";
import { stepUpForApp, type StepUpConnect } from "../../apps/stepUp";
import { CONNECTOR_SECRET_KEYS, LEGACY_NETWORK_APPROVAL_MAX_MS, legacyNetworkDecryptRequest } from "./encryptionGrant";
import { connectorOwnKeyGrants } from "./namedKeyWrites";

/** "legacy": sealed to the whole network. "current": on its own key. "absent": never saved. "unknown": could not tell. */
export type ConnectorKeyState = "legacy" | "current" | "absent" | "unknown";

interface ConnectorKeyRef {
  keyPath: string;
  name: string;
  scope: string | undefined;
  /** The record in the secrets vault, as the SDK's reseal names it. */
  vaultKey: string;
}

/** The three connector secrets by exact key path (CONNECTOR_SECRET_KEYS); nothing else is ever listed or moved. */
function connectorKeyRefs(): ConnectorKeyRef[] {
  return CONNECTOR_SECRET_KEYS.map(({ keyPath }) => {
    const parsed = parseSecretKeyPath(keyPath);
    if (!parsed) throw new Error(`not a secret key path: ${keyPath}`);
    return { keyPath, name: parsed.name, scope: parsed.scope, vaultKey: resolveSecretPath(parsed.name, { scope: parsed.scope }).vaultKey };
  });
}

type SecretsTcw = Pick<TinyCloudWeb, "secrets">;

async function stateOf(tcw: SecretsTcw, ref: ConnectorKeyRef): Promise<ConnectorKeyState> {
  try {
    const result = await tcw.secrets.vault.resealToKey?.(ref.vaultKey, ref.keyPath, { dryRun: true });
    if (!result) return "unknown";
    if (result.status === "pending") return "legacy";
    if (result.status === "already") return "current";
    return result.status === "skipped" && result.reason === "not_found" ? "absent" : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Where each connector key stands, by key path. Reads only the stored header of each record: no decrypt, no prompt.
 * Empty when Connectors does not open its secrets with their own keys: nothing is probed, nothing is moved.
 */
export async function probeConnectorKeys(tcw: SecretsTcw): Promise<Record<string, ConnectorKeyState>> {
  const states: Record<string, ConnectorKeyState> = {};
  if (!connectorOwnKeyGrants()) return states;
  for (const ref of connectorKeyRefs()) states[ref.keyPath] = await stateOf(tcw, ref);
  return states;
}

export interface LegacyMoveFailure {
  keyPath: string;
  /** An error code or step name only: never a value, a key or any part of either. */
  code: string;
}

export interface LegacyMoveReport {
  moved: string[];
  failed: LegacyMoveFailure[];
}

function markerPath(keyPath: string): string {
  return `${CONNECTORS_KV_PREFIX}/legacy-key-moved/${keyPath}`;
}

/**
 * Moves each older connector key onto its own key, one at a time. Per key: read the value, have the SDK move it (it
 * reads the record with its ETag, seals to the exact key, opens the new copy and compares bytes, and writes only if the
 * record is unchanged), read it back through the exact key alone and compare, and only then leave the marker. A step
 * that fails leaves that key unmarked and goes on to the next; the SDK keeps the old copy in any failure before its
 * write. Needs the whole-network decrypt approval to be held.
 */
export async function moveLegacyConnectorKeys(tcw: Pick<TinyCloudWeb, "secrets" | "kv">): Promise<LegacyMoveReport> {
  const report: LegacyMoveReport = { moved: [], failed: [] };
  for (const ref of connectorKeyRefs()) {
    const fail = (code: string) => { report.failed.push({ keyPath: ref.keyPath, code }); };
    const state = await stateOf(tcw, ref);
    if (state === "current" || state === "absent") continue;
    if (state === "unknown") { fail("state_unknown"); continue; }
    const options = ref.scope ? { scope: ref.scope } : undefined;
    let before: string | undefined;
    try {
      const read = await tcw.secrets.get(ref.name, options);
      if (!read.ok) { fail(`read_${read.error.code ?? "failed"}`); continue; }
      before = read.data;
      const resealed = await tcw.secrets.vault.resealToKey?.(ref.vaultKey, ref.keyPath);
      if (!resealed) { fail("reseal_unavailable"); continue; }
      if (resealed.status === "skipped") { fail(`reseal_${resealed.reason}`); continue; }
      const after = await tcw.secrets.get(ref.name, { ...options, namedKeyOnly: true });
      if (!after.ok) { fail(`readback_${after.error.code ?? "failed"}`); continue; }
      if (after.data !== before) { fail("readback_mismatch"); continue; }
      report.moved.push(ref.keyPath);
    } catch {
      fail("step_threw");
      continue;
    } finally {
      before = undefined;
    }
    // A hint for other devices; losing it changes nothing, because the stored header decides.
    await tcw.kv.put(markerPath(ref.keyPath), { movedAt: new Date().toISOString() }).catch(() => undefined);
  }
  return report;
}

export type LegacyKeysOutcome = "nothing" | "declined" | "moved" | "failed";

/**
 * The whole older-keys step: nothing to do when no key is on the whole network; otherwise the separate approval (at most
 * an hour, never through the renewal client) and the move. Only a move with no failed key is "moved".
 */
export async function resolveLegacyConnectorKeys(
  tcw: Pick<TinyCloudWeb, "secrets" | "kv" | "session" | "setRuntimePermissionSigner" | "requestPermissions" | "hasPermissions">,
  address: string,
  connect?: StepUpConnect,
): Promise<LegacyKeysOutcome> {
  const states = await probeConnectorKeys(tcw);
  const values = Object.values(states);
  if (values.includes("unknown")) return "failed";
  if (!values.includes("legacy")) return "nothing";
  let approved: boolean;
  try {
    approved = await stepUpForApp(tcw as TinyCloudWeb, legacyNetworkDecryptRequest(address) as PermissionEntry[], connect, LEGACY_NETWORK_APPROVAL_MAX_MS);
  } catch {
    return "failed";
  }
  if (!approved) return "declined";
  return (await moveLegacyConnectorKeys(tcw)).failed.length === 0 ? "moved" : "failed";
}
