// TrustBot's read grants (TC-3792): only a grant the owner signed to TrustBot's own read identity, read-only and
// short-lived, turns reading on, and every read checks it again.
import { describe, expect, test } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { APP_ID } from "@tinyboilerplate/core";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import { privateKeyToAccount } from "viem/accounts";
import { computeDelegationCid, makeSignedTranscriptGrant, type TranscriptAtt } from "./helpers/transcript-grant";
import { READ_ACTIONS, READ_AREAS } from "../trustbot-reads/areas";
import { READ_GRANT_MAX_MS, ReadGrantInvalid, ReadGrantRefused, type ReadGrantStore, TrustBotReadGrants } from "../trustbot-reads/grants";
import type { VerifiedTranscriptWriter } from "../delegation-verify";

const ownerKey = `0x${"11".repeat(32)}` as const;
const address = privateKeyToAccount(ownerKey).address;
const space = makePkhSpaceId(address, 1, "applications");
const TRUSTBOT_DID = "did:pkh:eip155:1:0x7777777777777777777777777777777777777777";
const OTHER_DID = "did:pkh:eip155:1:0x141f8c2b0fc5d114875f02627deb085e46ddd810";
const HOST = "http://127.0.0.1:9137";
const NOW = Date.parse("2026-11-20T12:00:00Z");
const DAY = 86_400_000;

const meetingsAtt = (): TranscriptAtt => ({
  [`${space}/sql/${APP_ID}/connectors`]: { "tinycloud.sql/read": [{}] },
  [`${space}/kv/${APP_ID}/connectors/`]: { "tinycloud.kv/get": [{}], "tinycloud.kv/list": [{}] },
});

async function grant(options: { att?: TranscriptAtt; audience?: string; days?: number; now?: number } = {}) {
  const now = options.now ?? NOW;
  const signed = await makeSignedTranscriptGrant({
    privateKey: ownerKey, now, att: options.att ?? meetingsAtt(), audience: options.audience ?? TRUSTBOT_DID,
    expiresAt: Math.floor((now + (options.days ?? 7) * DAY) / 1000),
  });
  return { serialized: signed.serialized, siwe: signed.siwe, signature: signed.signature };
}

function memoryStore(): ReadGrantStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get: async key => values.get(key),
    put: async (key, value) => void values.set(key, value),
    delete: async key => void values.delete(key),
  };
}

function setup(options: { did?: string; store?: ReturnType<typeof memoryStore> } = {}) {
  let now = NOW;
  const activated: VerifiedTranscriptWriter[] = [];
  const revoked: string[] = [];
  const store = options.store ?? memoryStore();
  const reader = {
    did: options.did ?? TRUSTBOT_DID, computeDelegationCid,
    useDelegation: async () => { throw new Error("unused"); },
    revokeDelegation: async (cid: string) => { revoked.push(cid); return { ok: true, data: undefined }; },
  } as unknown as Pick<TinyCloudNode, "did" | "useDelegation" | "computeDelegationCid" | "revokeDelegation">;
  const grants = new TrustBotReadGrants({
    reader, store, host: HOST, sealSecret: new Uint8Array(32).fill(7), now: () => now,
    activate: async verified => { activated.push(verified); return { access: verified.cid } as never; },
  });
  return { grants, store, activated, revoked, advance: (ms: number) => void (now += ms) };
}

const refusal = (promise: Promise<unknown>) => promise.then(() => "allowed", (error: unknown) => error instanceof ReadGrantRefused ? error.code : String(error));
const invalid = (promise: Promise<unknown>) => promise.then(() => "accepted", (error: unknown) => error instanceof ReadGrantInvalid ? error.code : String(error));

describe("turning meetings on", () => {
  test("accepts a read-only grant to TrustBot's read identity and each read gets only the meetings resources", async () => {
    const { grants, activated, store } = setup();
    expect((await grants.status(address)).areas.meetings).toBe("off");
    const status = await grants.enable(address, "meetings", await grant());
    expect(status).toEqual({ expiresAt: NOW + 7 * DAY, areas: { meetings: "on" } });
    expect(await refusal(grants.access(address, "meetings"))).toBe("allowed");
    expect(activated.at(-1)!.resources.map(({ service, path, actions }) => ({ service, path, actions }))).toEqual([
      { service: "sql", path: `${APP_ID}/connectors`, actions: ["tinycloud.sql/read"] },
      { service: "kv", path: `${APP_ID}/connectors/`, actions: ["tinycloud.kv/get", "tinycloud.kv/list"] },
    ]);
    // The stored copy is sealed: no part of the grant is readable in the backend's space.
    const [sealed] = [...store.values.values()];
    expect(sealed).not.toContain("tinycloud.sql");
    expect(sealed).not.toContain(address.slice(2).toLowerCase());
  });

  test("a read for one path of an area gets only that resource; a path outside the area is refused", async () => {
    const { grants, activated } = setup();
    await grants.enable(address, "meetings", await grant());
    expect(await refusal(grants.access(address, "meetings", `${APP_ID}/connectors/`))).toBe("allowed");
    expect(activated.at(-1)!.resources.map(({ service, path }) => ({ service, path }))).toEqual([
      { service: "kv", path: `${APP_ID}/connectors/` },
    ]);
    const count = activated.length;
    expect(await refusal(grants.access(address, "meetings", `${APP_ID}/threads`))).toBe("Error: trustbot_read_path_invalid");
    expect(activated.length).toBe(count);
  });

  test("refuses a grant made to another identity, such as the backend's own", async () => {
    const { grants, store } = setup();
    expect(await invalid(grants.enable(address, "meetings", await grant({ audience: OTHER_DID })))).toBe("wrong_delegatee");
    expect(store.values.size).toBe(0);
    expect(await refusal(grants.access(address, "meetings"))).toBe("none");
  });

  test("refuses a grant with a write, a decrypt, a wider path or a missing resource", async () => {
    const { grants, store } = setup();
    const sql = `${space}/sql/${APP_ID}/connectors`;
    const kv = `${space}/kv/${APP_ID}/connectors/`;
    for (const att of [
      { ...meetingsAtt(), [sql]: { "tinycloud.sql/read": [{}], "tinycloud.sql/write": [{}] } },
      { ...meetingsAtt(), [kv]: { "tinycloud.kv/get": [{}], "tinycloud.kv/list": [{}], "tinycloud.kv/put": [{}] } },
      { ...meetingsAtt(), [`urn:tinycloud:encryption:did:pkh:eip155:1:${address}:default`]: { "tinycloud.encryption/decrypt": [{}] } },
      { [sql]: { "tinycloud.sql/read": [{}] }, [`${space}/kv/${APP_ID}/`]: { "tinycloud.kv/get": [{}], "tinycloud.kv/list": [{}] } },
      { [sql]: { "tinycloud.sql/read": [{}] } },
    ]) expect(await invalid(grants.enable(address, "meetings", await grant({ att })))).not.toBe("accepted");
    expect(store.values.size).toBe(0);
  });

  test("refuses a grant that lasts longer than 7 days", async () => {
    const { grants } = setup();
    expect(await invalid(grants.enable(address, "meetings", await grant({ days: 8 })))).toBe("expiry_too_long");
    expect(READ_GRANT_MAX_MS).toBe(7 * DAY);
  });

  test("names only read abilities in every area", () => {
    for (const resources of Object.values(READ_AREAS)) {
      for (const resource of resources) for (const action of resource.actions) expect(READ_ACTIONS as readonly string[]).toContain(action);
    }
  });
});

describe("each read", () => {
  test("is refused once the grant has expired, and the area shows as ended", async () => {
    const { grants, advance } = setup();
    await grants.enable(address, "meetings", await grant({ days: 2 }));
    expect(await refusal(grants.access(address, "meetings"))).toBe("allowed");
    advance(2 * DAY);
    expect(await refusal(grants.access(address, "meetings"))).toBe("ended");
    expect((await grants.status(address)).areas.meetings).toBe("ended");
  });

  test("checks the stored grant again: a reader with another identity cannot use it", async () => {
    const first = setup();
    await first.grants.enable(address, "meetings", await grant());
    const other = setup({ did: OTHER_DID, store: first.store });
    expect(await refusal(other.grants.access(address, "meetings"))).toBe("rejected");
    expect(other.activated).toEqual([]);
  });

  test("is refused once the owner turns meetings off, and the grant is revoked and deleted", async () => {
    const { grants, store, revoked, activated } = setup();
    await grants.enable(address, "meetings", await grant());
    const cid = activated[0]!.cid;
    expect(await grants.disable(address, "meetings")).toEqual({ expiresAt: null, areas: { meetings: "off" } });
    expect(revoked).toEqual([cid]);
    expect(store.values.size).toBe(0);
    expect(await refusal(grants.access(address, "meetings"))).toBe("none");
  });

  test("a new grant replaces the old one, which is revoked", async () => {
    const { grants, revoked, activated } = setup();
    await grants.enable(address, "meetings", await grant());
    const old = activated[0]!.cid;
    await grants.enable(address, "meetings", await grant());
    expect(revoked).toEqual([old]);
  });
});
