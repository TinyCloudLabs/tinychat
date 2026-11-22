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
  countRecordChanges,
  deriveOpenKeyApiHost,
  displayCanonicalHost,
  fetchRegistryChangeHistory,
  readCurrentLocationRecord,
  requestFromLocationRecord,
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

  test("fetchRegistryChangeHistory parses strictly { history: [...] } and rejects unexpected shapes", async () => {
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
    const okResult = await fetchRegistryChangeHistory("https://openkey.so", {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), credentials: init?.credentials });
        return new Response(JSON.stringify({ history: [entry] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(requests).toEqual([
      { url: "https://api.openkey.so/api/registry-change/history?limit=10", credentials: "include" },
    ]);
    expect(okResult).toEqual({ status: "ok", history: [entry] });

    // Unexpected shapes must all fail with reason: "invalid" (no defensive multi-shape fallback).
    for (const badBody of [[entry], { items: [entry] }, { history: [{ id: "only-id" }] }, "nope"]) {
      const res = await fetchRegistryChangeHistory("https://openkey.so", {
        fetch: (async () => new Response(JSON.stringify(badBody), { status: 200 })) as unknown as typeof fetch,
      });
      expect(res).toEqual({ status: "error", reason: "invalid" });
    }

    const down = await fetchRegistryChangeHistory("https://openkey.so", {
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

  test("requestFromLocationRecord maps a signed v2 record to canonical request inputs including encryptionNode URL", async () => {
    const record = await makeSignedRecord();
    expect(requestFromLocationRecord(record)).toEqual({
      nodes: [
        { url: "https://node.tinycloud.xyz", did: NODE_A_DID },
        { url: "https://vault.example.com:8443", did: NODE_B_DID },
      ],
      spaces: [
        { space: SPACE_DEFAULT, nodes: [{ url: "https://node.tinycloud.xyz", mode: "read-write" }] },
        { space: SPACE_FEED, nodes: [{ url: "https://vault.example.com:8443", mode: "read-only" }] },
      ],
      encryptionNode: "https://vault.example.com:8443",
    });

    const noEnc = await makeSignedRecord({ encryptionNode: null });
    expect(requestFromLocationRecord(noEnc).encryptionNode).toBeNull();
  });

  test("feature detection and host display helpers behave as contracted", async () => {
    expect(canRequestRegistryChange(null)).toBe(false);
    expect(canRequestRegistryChange({})).toBe(false);
    expect(canRequestRegistryChange({ requestRegistryChange: "no" as never })).toBe(false);
    expect(canRequestRegistryChange({ requestRegistryChange: async () => ({ status: "cancelled" }) })).toBe(true);

    expect(deriveOpenKeyApiHost("https://openkey.so")).toBe("https://api.openkey.so");
    expect(deriveOpenKeyApiHost("http://localhost:5183")).toBe("http://localhost:5183");
    expect(displayCanonicalHost("https://node.tinycloud.xyz:443")).toBe("node.tinycloud.xyz");
    expect(displayCanonicalHost("https://vault.example.com:8443")).toBe("vault.example.com:8443");

    const prev = await makeSignedRecord({ sequence: 1, encryptionNode: NODE_A_DID });
    const next = await makeSignedRecord({ sequence: 2, encryptionNode: NODE_B_DID });
    expect(countRecordChanges(prev, next)).toBe(1);
  });
});
