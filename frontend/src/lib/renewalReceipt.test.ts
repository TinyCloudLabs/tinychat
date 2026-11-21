import { beforeEach, describe, expect, test } from "bun:test";
import { clearPersistedSession, saveRenewalReceipt } from "@tinyboilerplate/client";
import type { PersistedSessionData } from "@tinycloud/web-sdk";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { renewalRestoreFor, verifiedRenewalLease } from "./renewalReceipt";
import { OTHER_RENEWER, fixture, iso, originalEnd } from "./renewalReceipt.fixture";

// Real wallet-signed SIWE CACAOs (renewalReceipt.fixture.ts), so the receipt is checked the way the SDK checks a grant.

describe("a stored renewal receipt", () => {
  test("for the saved grant, signed by its owner for that grant's renewal alone, yields the lease", async () => {
    const { record, receipt, lease } = await fixture();
    expect(await verifiedRenewalLease(receipt, record)).toBe(lease.authorization);
  });

  test("naming another grant is not used", async () => {
    const { record, receipt } = await fixture();
    const other = await fixture();
    expect(await verifiedRenewalLease(other.receipt, record)).toBeNull();
    expect(await verifiedRenewalLease({ ...receipt, receipt: { ...receipt.receipt, originalCid: other.record.tinycloudSession!.delegationCid } }, record)).toBeNull();
  });

  test("whose lease another wallet signed is not used", async () => {
    const { record, receipt } = await fixture({ leaseSigner: privateKeyToAccount(generatePrivateKey()) });
    expect(await verifiedRenewalLease(receipt, record)).toBeNull();
  });

  test("for a grant whose owner is not the saved session's account is not used", async () => {
    const { record, receipt } = await fixture();
    const someoneElse = privateKeyToAccount(generatePrivateKey()).address;
    expect(await verifiedRenewalLease(receipt, { ...record, address: someoneElse })).toBeNull();
  });

  test("whose lease grants more than renewing that grant is not used", async () => {
    const { record, receipt } = await fixture({ extraAbility: true });
    expect(await verifiedRenewalLease(receipt, record)).toBeNull();
  });

  test("whose lease names a renewer other than the receipt's is not used", async () => {
    const { record, receipt } = await fixture({ leaseAudience: OTHER_RENEWER });
    expect(await verifiedRenewalLease(receipt, record)).toBeNull();
  });

  test("approved after the grant ended is not used", async () => {
    const late = iso(originalEnd + 1000);
    const { record, receipt } = await fixture({ approvedAt: late });
    expect(await verifiedRenewalLease({ ...receipt, approvedAt: late }, record)).toBeNull();
  });

  test("that is not a receipt at all is not used", async () => {
    const { record } = await fixture();
    expect(await verifiedRenewalLease({ version: 1 }, record)).toBeNull();
    expect(await verifiedRenewalLease(null, record)).toBeNull();
  });
});

describe("restoring through the lease", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    globalThis.localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
      clear: () => values.clear(),
      key: () => null,
      get length() { return values.size; },
    } as Storage;
  });

  function storage(status: "loaded" | "renewal-candidate" | "missing", record: PersistedSessionData, active?: string) {
    return {
      activeAddressForRenewal: () => active,
      loadRenewalCandidate: async () => status === "missing" ? { status, data: null } : { status, data: record },
    } as Parameters<typeof renewalRestoreFor>[1];
  }

  test("happens only once the saved session is past its end and its receipt checks out", async () => {
    const { owner, record, receipt, lease } = await fixture();
    saveRenewalReceipt(owner.address, receipt);
    expect(await renewalRestoreFor(owner.address, storage("renewal-candidate", record)))
      .toEqual({ address: owner.address, leaseAuthorization: lease.authorization });
    expect(await renewalRestoreFor(owner.address, storage("loaded", record))).toBeNull();
    expect(await renewalRestoreFor(owner.address, storage("missing", record))).toBeNull();
  });

  test("with the bearer gone, uses the account the SDK kept for renewal", async () => {
    const { owner, record, receipt, lease } = await fixture();
    saveRenewalReceipt(owner.address, receipt);
    expect(await renewalRestoreFor(null, storage("renewal-candidate", record, owner.address)))
      .toEqual({ address: owner.address, leaseAuthorization: lease.authorization });
    expect(await renewalRestoreFor(null, storage("renewal-candidate", record))).toBeNull();
  });

  test("never happens once the session was cleared, which takes the receipt with it", async () => {
    const { owner, record, receipt } = await fixture();
    saveRenewalReceipt(owner.address, receipt);
    clearPersistedSession(owner.address);
    expect(await renewalRestoreFor(owner.address, storage("renewal-candidate", record))).toBeNull();
  });
});
