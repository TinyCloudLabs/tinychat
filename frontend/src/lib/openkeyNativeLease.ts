import { renewalVerifyProof, verifyRenewedSession } from "@tinyboilerplate/client";
import { CONNECTORS_KV_PREFIX } from "@tinyboilerplate/core";
import type { OpenKeyNative, NativeSession } from "@openkey/sdk-capacitor";
import type { ApprovalRenewal } from "@tinycloud/share-envelope/links";
import type { BrowserSessionStorage, PersistedSessionData, TinyCloudWeb } from "@tinycloud/web-sdk";
import { withAbortTimeout } from "./abortTimeout";
import { admitSignInRenewal, verifiedRenewalLease } from "./renewalReceipt";
import { browserIsOffline, isTransientRestoreError } from "./sessionRestore";

type SecureStorage = ReturnType<OpenKeyNative["sessionStorageAdapter"]>;
type SecureRecord = PersistedSessionData & { admittedRenewal?: ApprovalRenewal };

export async function admitNativeLease(
  storage: SecureStorage,
  session: NativeSession,
  tcw: TinyCloudWeb,
  renewal: unknown,
  arrivedAt: number | undefined,
): Promise<boolean> {
  return admitSignInRenewal({
    tcw,
    address: session.delegation.address!,
    renewal,
    arrivedAt,
    storage: {
      load: async (address) => {
        const record = await storage.load(address);
        return record?.tinycloudSession?.delegationCid === session.delegation.delegationCid ? record : null;
      },
    },
    persist: (record, admittedRenewal) => {
      const updated: SecureRecord = { ...record, admittedRenewal };
      // Native storage checks the active device key again inside its serialized write.
      return storage.save(record.address, updated);
    },
  });
}

export async function nativeLeaseAuthorization(
  storage: SecureStorage,
  session: NativeSession,
): Promise<string | null> {
  const record: SecureRecord | null = await storage.load(session.delegation.address!);
  return record?.admittedRenewal && record.tinycloudSession?.delegationCid === session.delegation.delegationCid
    ? verifiedRenewalLease(record.admittedRenewal, record)
    : null;
}

export function nativeLeaseStorage(storage: SecureStorage, cid: string) {
  const loadRenewalCandidate: BrowserSessionStorage["loadRenewalCandidate"] = async (address) => {
    const data: SecureRecord | null = await storage.load(address);
    return data?.admittedRenewal && data.tinycloudSession?.delegationCid === cid
      ? { status: "renewal-candidate", data }
      : { status: "missing", data: null };
  };
  return {
    load: storage.load.bind(storage),
    save: storage.save.bind(storage),
    clear: storage.clear.bind(storage),
    exists: storage.exists.bind(storage),
    isAvailable: storage.isAvailable.bind(storage),
    activeAddress: storage.activeAddress.bind(storage),
    loadRenewalCandidate,
  };
}

export function nativeLeaseFailure(error: unknown): Error {
  if (error instanceof Error && "code" in error && error.code === "STORAGE") return error;
  const response = error as { status?: number; meta?: { status?: number } } | null;
  const status = response?.status ?? response?.meta?.status;
  const unavailable = browserIsOffline() || isTransientRestoreError(error)
    || (status !== undefined && (status >= 500 || status === 408 || status === 429));
  return Object.assign(new Error("Could not restore the native renewal lease", { cause: error }), {
    code: unavailable ? "TEMPORARILY_UNAVAILABLE" : "LEASE_INACTIVE",
  });
}

export async function verifyNativeLease(
  tcw: TinyCloudWeb,
  requestNonce: (address: string) => Promise<string>,
  backendUrl: string,
  address: string,
  leaseAuthorization: string,
) {
  const read = await tcw.kv.list({ path: `${CONNECTORS_KV_PREFIX}/`, source: "network" });
  if (!read.ok) throw read.error;
  const nonce = await requestNonce(address);
  const proof = await renewalVerifyProof({ tcw, backendOrigin: new URL(backendUrl).origin, address, nonce });
  return withAbortTimeout(10_000, (signal) => verifyRenewedSession(backendUrl, {
    ...proof, address, nonce, leaseAuthorization,
  }, { signal }));
}
