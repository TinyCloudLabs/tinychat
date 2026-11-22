import { describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import {
  DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL,
  signLocationRecordV2,
  type LocationRecordV2,
  type LocationRecordV2Payload,
} from "@tinycloud/sdk-core";
import {
  canonicalizeRegistryChangeRequest,
  canRequestRegistryChange,
  canRequestRegistryUndo,
  countRecordChanges,
  createRegistryEditorAdapter,
  deriveOpenKeyApiHost,
  displayCanonicalHost,
  fetchRegistryChangeHistory,
  readCurrentLocationRecord,
} from "./adapter";

const TEST_ACCOUNT = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const OTHER_ACCOUNT = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const OWNER_DID = `did:pkh:eip155:1:${TEST_ACCOUNT.address}`;
const OTHER_DID = `did:pkh:eip155:1:${OTHER_ACCOUNT.address}`;
const NODE_A_DID = "did:key:z6MkjHi79SMX4doJyo2w7jDTM6Fa7iX6EVZWXNbJ6RzBm3Wi";
const NODE_B_DID = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";
const SPACE_DEFAULT = `tinycloud:pkh:eip155:1:${TEST_ACCOUNT.address.toLowerCase()}:default`;
const SPACE_FEED = `tinycloud:pkh:eip155:1:${TEST_ACCOUNT.address.toLowerCase()}:feed`;

async function makeSignedRecord(
  overrides: Partial<LocationRecordV2Payload> = {},
  account = TEST_ACCOUNT,
): Promise<LocationRecordV2> {
  const addrLower = account.address.toLowerCase();
  const payload: LocationRecordV2Payload = {
    version: 2,
    subject: `did:pkh:eip155:1:${account.address}`,
    nodes: [
      { did: NODE_A_DID, url: "https://node.tinycloud.xyz" },
      { did: NODE_B_DID, url: "https://vault.example.com:8443" },
    ],
    spaces: [
      { space: `tinycloud:pkh:eip155:1:${addrLower}:default`, nodes: [{ did: NODE_A_DID, mode: "read-write" }] },
      { space: `tinycloud:pkh:eip155:1:${addrLower}:feed`, nodes: [{ did: NODE_B_DID, mode: "read-only" }] },
    ],
    encryptionNode: NODE_B_DID,
    updated_at: "2026-11-22T15:00:00.000Z",
    sequence: 3,
    ...overrides,
  };
  return signLocationRecordV2(payload, {
    type: "did:pkh",
    signMessage: (message) => account.signMessage({ message }),
  });
}

describe("registryEditor adapter", () => {
  test("readCurrentLocationRecord fetches GET /v2/locations/{ownerKey} and cryptographically verifies the record", async () => {
    const signed = await makeSignedRecord();
    const seenUrls: string[] = [];
    const fakeFetch = (async (input: RequestInfo | URL) => {
      seenUrls.push(String(input));
      return new Response(JSON.stringify({ record: signed }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await readCurrentLocationRecord(OWNER_DID, { fetch: fakeFetch });
    expect(seenUrls).toEqual([
      `${DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL}/v2/locations/${encodeURIComponent(TEST_ACCOUNT.address)}`,
    ]);
    expect(result).toEqual({ status: "found", record: signed });
  });

  test("readCurrentLocationRecord returns missing on 404, unreachable on network/5xx, invalid on bad signature or wrong owner", async () => {
    const signed = await makeSignedRecord();

    const notFound = await readCurrentLocationRecord(OWNER_DID, {
      fetch: (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch,
    });
    expect(notFound).toEqual({ status: "missing" });

    const serverDown = await readCurrentLocationRecord(OWNER_DID, {
      fetch: (async () => new Response("boom", { status: 503 })) as unknown as typeof fetch,
    });
    expect(serverDown).toEqual({ status: "error", reason: "unreachable" });

    const networkErr = await readCurrentLocationRecord(OWNER_DID, {
      fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch,
    });
    expect(networkErr).toEqual({ status: "error", reason: "unreachable" });

    const tampered: LocationRecordV2 = { ...signed, sequence: signed.sequence + 1 };
    const badSig = await readCurrentLocationRecord(OWNER_DID, {
      fetch: (async () => new Response(JSON.stringify({ record: tampered }), { status: 200 })) as unknown as typeof fetch,
    });
    expect(badSig).toEqual({ status: "error", reason: "invalid" });

    const otherSigned = await makeSignedRecord({ subject: OTHER_DID }, OTHER_ACCOUNT);
    const wrongOwner = await readCurrentLocationRecord(OWNER_DID, {
      fetch: (async () => new Response(JSON.stringify({ record: otherSigned }), { status: 200 })) as unknown as typeof fetch,
    });
    expect(wrongOwner).toEqual({ status: "error", reason: "invalid" });
  });

  test("fetchRegistryChangeHistory verifies every row's previousRecord signature and owner key, and rejects unexpected shapes", async () => {
    const previousRecord = await makeSignedRecord({ sequence: 2 });
    const entry = {
      id: "chg_1",
      requestingOrigin: "https://tinycloud.one",
      previousRecord,
      newRecordHash: "0xabc123",
      newSequence: 3,
      createdAt: "2026-11-22T15:00:00.000Z",
    };

    const requests: Array<{ url: string; credentials?: RequestCredentials }> = [];
    const okResult = await fetchRegistryChangeHistory("https://openkey.so", OWNER_DID, {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), credentials: init?.credentials });
        return new Response(JSON.stringify({ history: [entry] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(requests).toEqual([
      { url: "https://api.openkey.so/api/registry-change/history?limit=10", credentials: "include" },
    ]);
    expect(okResult).toEqual({ status: "ok", history: [entry] });

    // Tampered previousRecord signature fails verification -> whole list invalid.
    const tamperedEntry = {
      ...entry,
      previousRecord: { ...previousRecord, sequence: previousRecord.sequence + 10 },
    };
    const tamperedRes = await fetchRegistryChangeHistory("https://openkey.so", OWNER_DID, {
      fetch: (async () => new Response(JSON.stringify({ history: [entry, tamperedEntry] }), { status: 200 })) as unknown as typeof fetch,
    });
    expect(tamperedRes).toEqual({ status: "error", reason: "invalid" });

    // Valid signature but different owner -> whole list invalid.
    const otherOwnerRecord = await makeSignedRecord({ subject: OTHER_DID, sequence: 1 }, OTHER_ACCOUNT);
    const wrongOwnerRes = await fetchRegistryChangeHistory("https://openkey.so", OWNER_DID, {
      fetch: (async () =>
        new Response(JSON.stringify({ history: [{ ...entry, previousRecord: otherOwnerRecord }] }), { status: 200 })) as unknown as typeof fetch,
    });
    expect(wrongOwnerRes).toEqual({ status: "error", reason: "invalid" });

    // Unexpected shapes must all fail with reason: "invalid" (no defensive multi-shape fallback).
    for (const badBody of [[entry], { items: [entry] }, { history: [{ id: "only-id" }] }, "nope"]) {
      const res = await fetchRegistryChangeHistory("https://openkey.so", OWNER_DID, {
        fetch: (async () => new Response(JSON.stringify(badBody), { status: 200 })) as unknown as typeof fetch,
      });
      expect(res).toEqual({ status: "error", reason: "invalid" });
    }

    const down = await fetchRegistryChangeHistory("https://openkey.so", OWNER_DID, {
      fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch,
    });
    expect(down).toEqual({ status: "error", reason: "unreachable" });
  });

  test("canonicalizeRegistryChangeRequest canonicalizes URLs, drops stale DIDs on host change, and keeps encryptionNode as canonical URL or null", () => {
    const existingNodes = [
      { did: NODE_A_DID, url: "https://node.tinycloud.xyz" },
      { did: NODE_B_DID, url: "https://vault.example.com:8443" },
    ];

    const canonical = canonicalizeRegistryChangeRequest(
      {
        nodes: [{ url: "  HTTPS://NEW.EXAMPLE.COM:443/  " }],
        spaces: [
          { space: SPACE_DEFAULT, nodes: [{ url: "https://NEW.example.com/", mode: "read-write" }] },
          { space: SPACE_FEED, nodes: [{ url: "https://node.tinycloud.xyz/", mode: "read-only" }] },
        ],
        encryptionNode: "https://VAULT.example.com:8443/",
      },
      existingNodes,
    );

    expect(canonical).toEqual({
      nodes: [
        { url: "https://new.example.com" },
        { url: "https://node.tinycloud.xyz", did: NODE_A_DID },
        { url: "https://vault.example.com:8443", did: NODE_B_DID },
      ],
      spaces: [
        { space: SPACE_DEFAULT, nodes: [{ url: "https://new.example.com", mode: "read-write" }] },
        { space: SPACE_FEED, nodes: [{ url: "https://node.tinycloud.xyz", mode: "read-only" }] },
      ],
      encryptionNode: "https://vault.example.com:8443",
    });

    // Rejects path, query, or non-https non-loopback URLs.
    expect(() => canonicalizeRegistryChangeRequest({ nodes: [{ url: "https://bad.example.com/path" }] })).toThrow();
    expect(() => canonicalizeRegistryChangeRequest({ nodes: [{ url: "http://remote.example.com" }] })).toThrow();
    expect(() => canonicalizeRegistryChangeRequest({ nodes: [{ url: "not-a-url" }] })).toThrow();
  });

  test("createRegistryEditorAdapter derives canEdit and canUndo from the OpenKey client and forwards calls", async () => {
    const noMethods = createRegistryEditorAdapter({ openkey: {} });
    expect(noMethods.canEdit).toBe(false);
    expect(noMethods.canUndo).toBe(false);
    await expect(noMethods.requestChange({ nodes: [{ url: "https://node.tinycloud.xyz" }] })).rejects.toThrow();
    await expect(noMethods.requestUndo({ historyId: "chg_1" })).rejects.toThrow();

    const changeOnly = createRegistryEditorAdapter({
      openkey: { requestRegistryChange: async () => ({ status: "cancelled" }) },
    });
    expect(changeOnly.canEdit).toBe(true);
    expect(changeOnly.canUndo).toBe(false);

    const undoOnly = createRegistryEditorAdapter({
      openkey: { requestRegistryUndo: async () => ({ status: "cancelled" }) },
    });
    expect(undoOnly.canEdit).toBe(false);
    expect(undoOnly.canUndo).toBe(true);

    const undoCalls: Array<{ historyId: string }> = [];
    const full = createRegistryEditorAdapter({
      openkey: {
        requestRegistryChange: async () => ({ status: "published", sequence: 2, recordHash: "0x2" }),
        requestRegistryUndo: async (req) => {
          undoCalls.push(req);
          return { status: "published", sequence: 3, recordHash: "0x3" };
        },
      },
    });
    expect(full.canEdit).toBe(true);
    expect(full.canUndo).toBe(true);
    expect(await full.requestUndo({ historyId: "chg_42" })).toEqual({
      status: "published",
      sequence: 3,
      recordHash: "0x3",
    });
    expect(undoCalls).toEqual([{ historyId: "chg_42" }]);
  });

  test("feature detection and host display helpers behave as contracted", async () => {
    expect(canRequestRegistryChange(null)).toBe(false);
    expect(canRequestRegistryChange({})).toBe(false);
    expect(canRequestRegistryChange({ requestRegistryChange: "no" as never })).toBe(false);
    expect(canRequestRegistryChange({ requestRegistryChange: async () => ({ status: "cancelled" }) })).toBe(true);

    expect(canRequestRegistryUndo(null)).toBe(false);
    expect(canRequestRegistryUndo({})).toBe(false);
    expect(canRequestRegistryUndo({ requestRegistryUndo: "no" as never })).toBe(false);
    expect(canRequestRegistryUndo({ requestRegistryUndo: async () => ({ status: "cancelled" }) })).toBe(true);

    expect(deriveOpenKeyApiHost("https://openkey.so")).toBe("https://api.openkey.so");
    expect(deriveOpenKeyApiHost("http://localhost:5183")).toBe("http://localhost:5183");
    expect(displayCanonicalHost("https://node.tinycloud.xyz:443")).toBe("node.tinycloud.xyz");
    expect(displayCanonicalHost("https://vault.example.com:8443")).toBe("vault.example.com:8443");

    const prev = await makeSignedRecord({ sequence: 1, encryptionNode: NODE_A_DID });
    const next = await makeSignedRecord({ sequence: 2, encryptionNode: NODE_B_DID });
    expect(countRecordChanges(prev, next)).toBe(1);
  });
});
