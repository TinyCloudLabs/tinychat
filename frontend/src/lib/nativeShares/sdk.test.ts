// TC-3195: the adapter over the native-share SDK. An opened link's owner comes from the token's owner signature
// (inspectShareToken), never from what the link shows; a claim refused as REVOKED or AUTH_EXPIRED is the revoked or
// the expired state; a share's reader takes full keys whether it covers one resource or several.
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import type { DelegationError, InspectedShareToken, Result } from "@tinycloud/sdk-core";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import type { ReceivedRecordingShare } from "./receivedShares";

// The link reader and the token check stand in for the network and a signed root; every other export is real. Until a
// test sets them, both run the real SDK, so nothing else in the run sees a fake.
const realNativeLink = { ...(await import("@tinycloud/share-sdk/native-link")) };
const realCore = { ...(await import("@tinycloud/sdk-core")) };
let openLink: typeof realNativeLink.openNativeShareLink = realNativeLink.openNativeShareLink;
let inspectToken: typeof realCore.inspectShareToken = realCore.inspectShareToken;
mock.module("@tinycloud/share-sdk/native-link", () => ({ ...realNativeLink, openNativeShareLink: (...args: Parameters<typeof openLink>) => openLink(...args) }));
mock.module("@tinycloud/sdk-core", () => ({ ...realCore, inspectShareToken: (...args: Parameters<typeof inspectToken>) => inspectToken(...args) }));
afterAll(() => {
  mock.module("@tinycloud/share-sdk/native-link", () => realNativeLink);
  mock.module("@tinycloud/sdk-core", () => realCore);
});
const { readSharedTranscript } = await import("@/capture/share/SharedRecordingDetail");
const { sharedRowMeta } = await import("@/capture/share/shareCopy");
const { parseRecordingDisplay } = await import("./display");
const { claimShare, createShare, isShareRevokedError, openShareLink, openSharedKv, ShareLinkError, sharedKey } = await import("./sdk");

const TOKEN = "tc1:eyJzZWNyZXQiOiJ0b2tlbi1ib2R5In0";
const ACCOUNT = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
const TRANSCRIPT = "xyz.tinycloud.tinychat/connectors/fireflies/transcript/ff-1";
const AUDIO = "xyz.tinycloud.tinychat/connectors/fireflies/audio/ff-1";

function claimingTcw(result: unknown, calls: unknown[][] = []) {
  return {
    did: ACCOUNT,
    sharing: {
      delegateReceivedShare: async (...args: unknown[]) => {
        calls.push(args);
        return result;
      },
    },
  } as unknown as TinyCloudWeb;
}

describe("openShareLink", () => {
  const SIGNER = { address: "0xd5590000000000000000000000000000000ff412", chainId: 1, spaceId: "tinycloud:pkh:eip155:1:0xd5590000000000000000000000000000000ff412:default" };
  const ROOT_ENDS = new Date("2027-11-17T10:00:00.000Z");
  const LINK = "https://tinycloud.one/s/abc";
  // What a link's maker can write freely: a display naming someone else, and (from an older reader) an owner field.
  const spoofed = { kind: "recording", display: { title: "Board minutes", senderName: "Sam Lee" }, token: TOKEN, linkExpiresAt: new Date("2026-11-24T10:00:00.000Z"), owner: { address: "0x5a30000000000000000000000000000000000bad", chainId: 1, spaceId: "spoofed" } };
  const refused = (code: string) => async (): Promise<Result<InspectedShareToken, DelegationError>> => ({ ok: false, error: { code, message: "refused", service: "delegation" } as DelegationError });

  afterEach(() => {
    openLink = realNativeLink.openNativeShareLink;
    inspectToken = realCore.inspectShareToken;
  });

  test("the owner and the access end come from inspecting the token, not from the link", async () => {
    const inspected: string[] = [];
    openLink = async () => spoofed;
    inspectToken = async (token) => {
      inspected.push(token);
      return { ok: true, data: { owner: SIGNER, resources: [{ path: TRANSCRIPT, actions: ["tinycloud.kv/get"] }], accessExpiresAt: ROOT_ENDS, rootCid: "bafysignedroot" } };
    };
    const opened = await openShareLink(LINK);
    expect(inspected).toEqual([TOKEN]);
    expect(opened.owner).toEqual(SIGNER);
    expect(opened.accessExpiresAt).toBe(ROOT_ENDS.toISOString());
    expect(opened.rootCid).toBe("bafysignedroot");
    expect(opened.token).toBe(TOKEN);
    expect(opened.linkExpiresAt).toBe("2026-11-24T10:00:00.000Z");
  });

  test("a token its owner did not sign is an invalid link; an ended root is an expired one", async () => {
    openLink = async () => spoofed;
    for (const [code, expected] of [["INVALID_TOKEN", "invalid"], ["AUTH_EXPIRED", "expired"], ["NETWORK_ERROR", "invalid"]] as const) {
      inspectToken = refused(code);
      const caught = await openShareLink(LINK).catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(ShareLinkError);
      expect((caught as InstanceType<typeof ShareLinkError>).code).toBe(expected);
      expect(String((caught as Error).message)).not.toContain(TOKEN);
    }
  });

  test("a link of another kind is invalid before its token is inspected", async () => {
    let inspectedTimes = 0;
    openLink = async () => ({ ...spoofed, kind: "folder" });
    inspectToken = async () => {
      inspectedTimes += 1;
      return refused("INVALID_TOKEN")();
    };
    expect(((await openShareLink(LINK).catch((error: unknown) => error)) as InstanceType<typeof ShareLinkError>).code).toBe("invalid");
    expect(inspectedTimes).toBe(0);
  });
});

describe("claimShare", () => {
  test("REVOKED is the revoked state", async () => {
    expect(await claimShare(claimingTcw({ ok: false, error: { code: "REVOKED", message: "Sharing link has been revoked" } }), TOKEN)).toEqual({ ok: false, reason: "revoked" });
  });

  test("a refusal that only mentions revocation in its text is a failure to retry, not the revoked state", async () => {
    expect(await claimShare(claimingTcw({ ok: false, error: { code: "NETWORK_ERROR", message: "403: ancestor_revoked" } }), TOKEN)).toEqual({ ok: false, reason: "failed" });
  });

  test("AUTH_EXPIRED is the expired state", async () => {
    expect(await claimShare(claimingTcw({ ok: false, error: { code: "AUTH_EXPIRED", message: "Sharing link has expired" } }), TOKEN)).toEqual({ ok: false, reason: "expired" });
  });

  test("any other refusal is a failure to retry", async () => {
    expect(await claimShare(claimingTcw({ ok: false, error: { code: "PERMISSION_DENIED", message: "no" } }), TOKEN)).toEqual({ ok: false, reason: "failed" });
    expect(await claimShare({ did: undefined } as unknown as TinyCloudWeb, TOKEN)).toEqual({ ok: false, reason: "failed" });
  });

  test("delegates to the account's did and keeps the child delegation, never the token", async () => {
    const calls: unknown[][] = [];
    const expiry = new Date("2027-11-17T10:00:00.000Z");
    const delegation = { cid: "bafychild", parentCid: "bafyroot", delegateDID: ACCOUNT, expiry, resources: [{ service: "kv", path: TRANSCRIPT, actions: ["tinycloud.kv/get"] }, { service: "kv", path: `${AUDIO}/`, actions: ["tinycloud.kv/get"] }] };
    const result = await claimShare(claimingTcw({ ok: true, data: { delegation, source: { parentCid: "bafyroot" } } }, calls), TOKEN);
    expect(calls).toEqual([[TOKEN, { delegateDID: ACCOUNT }]]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.share).toMatchObject({ rootCid: "bafyroot", paths: [TRANSCRIPT, `${AUDIO}/`], accessExpiresAt: expiry.toISOString() });
    expect(JSON.stringify(result.share)).not.toContain(TOKEN);
  });
});

describe("the revoked state after a claim", () => {
  test("isShareRevokedError matches the revocation codes exactly, never text", () => {
    for (const code of ["REVOKED", "AUTH_DELEGATION_REVOKED", "AUTH_DELEGATION_ANCESTOR_REVOKED", "GRANT_REVOKED"]) expect(isShareRevokedError({ code })).toBe(true);
    // useDelegation's activation refusal: the node's 401 body is the error's cause.
    for (const code of ["ancestor_revoked", "parent_revoked", "delegation_revoked"]) {
      const refusal = Object.assign(new Error("Failed to activate delegated session"), { cause: { status: 401, error: JSON.stringify({ code, error: "delegation-ancestor-revoked: ancestor=bafyroot" }) } });
      expect(isShareRevokedError(refusal)).toBe(true);
    }
    expect(isShareRevokedError(Object.assign(new Error("x"), { cause: { status: 401, error: JSON.stringify({ code: "lease_revoked" }) } }))).toBe(false);
    expect(isShareRevokedError(Object.assign(new Error("x"), { cause: { status: 500, error: JSON.stringify({ code: "ancestor_revoked" }) } }))).toBe(false);
    expect(isShareRevokedError({ code: "NETWORK_ERROR", message: "activation failed: ancestor_revoked" })).toBe(false);
    expect(isShareRevokedError("ancestor_revoked")).toBe(false);
    expect(isShareRevokedError({ code: "AUTH_EXPIRED", message: "expired" })).toBe(false);
    expect(isShareRevokedError({ code: "constructor" })).toBe(false);
    expect(isShareRevokedError(new Error("offline"))).toBe(false);
    expect(isShareRevokedError(null)).toBe(false);
  });

  test("a read refused as revoked is the revoked state; not found is absent; other errors fail", async () => {
    expect(await readSharedTranscript({ get: async () => ({ ok: false, error: { code: "AUTH_DELEGATION_ANCESTOR_REVOKED", message: "x" } }) } as never, TRANSCRIPT)).toEqual({ status: "revoked" });
    expect(await readSharedTranscript({ get: async () => { throw new Error("ancestor_revoked"); } } as never, TRANSCRIPT)).toEqual({ status: "failed" });
    expect(await readSharedTranscript({ get: async () => ({ ok: false, error: { code: "KV_NOT_FOUND", message: "x" } }) } as never, TRANSCRIPT)).toEqual({ status: "absent" });
    expect(await readSharedTranscript({ get: async () => ({ ok: false, error: { code: "NETWORK_ERROR", message: "x" } }) } as never, TRANSCRIPT)).toEqual({ status: "failed" });
  });

  test("a revoked record's Library row says it is no longer shared", () => {
    const display = parseRecordingDisplay({ title: "Customer call: Northwind", recordedAt: "2026-10-28T15:00:00.000Z", durationSeconds: 900, includes: ["transcript"], source: "meeting" })!;
    const record: ReceivedRecordingShare = { version: 1, id: "bafyroot", display, owner: { address: "0xd5590000000000000000000000000000000ff412", chainId: 1, spaceId: "s" }, delegation: "{}", paths: [TRANSCRIPT], claimedAt: "2026-10-29T00:00:00.000Z", accessExpiresAt: "2027-10-28T00:00:00.000Z", revokedAt: "2026-11-10T00:00:00.000Z" };
    expect(sharedRowMeta(record, new Date("2026-11-17T10:00:00.000Z"))).toBe("From 0xd559…f412 · No\u00a0longer\u00a0shared");
  });
});

describe("createShare", () => {
  test("asks for one share of exactly the given resources, read only", async () => {
    const calls: unknown[] = [];
    const expiry = new Date("2027-11-17T10:00:00.000Z");
    const tcw = { sharing: { generate: async (params: unknown) => {
      calls.push(params);
      return { ok: true, data: { token: TOKEN, delegation: { cid: "bafyroot" }, expiresAt: expiry } };
    } } } as unknown as TinyCloudWeb;
    const share = await createShare(tcw, [TRANSCRIPT, `${AUDIO}/`], expiry);
    expect(calls).toEqual([{ resources: [{ path: TRANSCRIPT, actions: ["tinycloud.kv/get"] }, { path: `${AUDIO}/`, actions: ["tinycloud.kv/get"] }], expiry }]);
    expect(share).toEqual({ token: TOKEN, rootCid: "bafyroot", accessExpiresAt: expiry.toISOString() });
  });
});

describe("the key a share's reader is asked for", () => {
  test("several resources: full keys", () => {
    expect(sharedKey([TRANSCRIPT, `${AUDIO}/`], TRANSCRIPT)).toBe(TRANSCRIPT);
    expect(sharedKey([TRANSCRIPT, `${AUDIO}/`], `${AUDIO}/manifest`)).toBe(`${AUDIO}/manifest`);
  });

  test("one resource: relative to its path, \"\" for the shared key itself", () => {
    expect(sharedKey([TRANSCRIPT], TRANSCRIPT)).toBe("");
    expect(sharedKey([`${AUDIO}/`], AUDIO)).toBe("");
    expect(sharedKey([`${AUDIO}/`], `${AUDIO}/manifest`)).toBe("manifest");
    expect(sharedKey([`${AUDIO}/`], `${AUDIO}/parts/0`)).toBe("parts/0");
    expect(sharedKey([`${AUDIO}/`], "elsewhere/key")).toBe("elsewhere/key");
  });

  async function reader(paths: string[]) {
    const asked: string[] = [];
    const kv = {
      prefix: "kept",
      get: async (key: string) => {
        asked.push(key);
        return { ok: true, data: { data: key } };
      },
      list(this: { prefix: string }) {
        return this.prefix;
      },
    };
    const used: unknown[] = [];
    const tcw = { useDelegation: async (delegation: unknown) => {
      used.push(delegation);
      return { kv };
    } } as unknown as TinyCloudWeb;
    const delegation = JSON.stringify({ cid: "bafychild", expiry: "2027-11-17T10:00:00.000Z", resources: paths.map((path) => ({ service: "kv", path, actions: ["tinycloud.kv/get"] })) });
    return { kv: await openSharedKv(tcw, delegation), asked, used };
  }

  test("openSharedKv: the app always passes full keys; one resource is mapped, several pass through", async () => {
    const one = await reader([`${AUDIO}/`]);
    await one.kv.get(`${AUDIO}/manifest`);
    await one.kv.get(AUDIO);
    expect(one.asked).toEqual(["manifest", ""]);
    // Other members keep their own `this`.
    expect(Reflect.apply(Reflect.get(one.kv, "list"), one.kv, [])).toBe("kept");
    expect(Reflect.get(Object(one.used[0]), "expiry")).toBeInstanceOf(Date);

    const transcriptOnly = await reader([TRANSCRIPT]);
    await transcriptOnly.kv.get(TRANSCRIPT);
    expect(transcriptOnly.asked).toEqual([""]);

    const both = await reader([TRANSCRIPT, `${AUDIO}/`]);
    await both.kv.get(TRANSCRIPT);
    await both.kv.get(`${AUDIO}/manifest`);
    expect(both.asked).toEqual([TRANSCRIPT, `${AUDIO}/manifest`]);
  });
});
