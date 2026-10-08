import { describe, expect, it } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import type { VerifiedTranscriptWriter } from "../delegation-verify.js";
import { activateVerifiedDelegation, MAX_ACTIVATABLE_RESOURCES } from "../portable-delegation.js";

const ADDRESS = "0x7d033300000000000000000000000000000073f2";
const SPACE = `tinycloud:pkh:eip155:1:${ADDRESS}:applications`;
const HOST = "https://node.tinycloud.xyz";
type DelegationDto = Parameters<TinyCloudNode["useDelegation"]>[0];

function verifiedGrant(): VerifiedTranscriptWriter {
  return {
    cid: "bafkverified",
    authorization: "Bearer signed.jwt.bytes",
    ownerAddress: ADDRESS,
    chainId: 1,
    spaceId: SPACE,
    sessionDid: "did:key:z6MkSession",
    backendDid: `did:pkh:eip155:1:${ADDRESS}`,
    expiresAt: new Date(Date.now() + 86_400_000),
    resources: [
      { service: "sql", space: SPACE, path: "xyz.tinycloud.tinychat/connectors", actions: ["tinycloud.sql/read", "tinycloud.sql/write"] },
      { service: "kv", space: SPACE, path: "xyz.tinycloud.tinychat/connectors/tinycloud-transcriber/", actions: ["tinycloud.kv/get", "tinycloud.kv/put"] },
    ],
  };
}

describe("activateVerifiedDelegation", () => {
  it("derives the entire DTO from the verified projection and host, metering sequential node calls", async () => {
    const verified = verifiedGrant();
    const calls: DelegationDto[] = [];
    const order: string[] = [];
    let active = 0;
    let peak = 0;
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const node = {
      useDelegation: async (dto: DelegationDto) => {
        active++;
        peak = Math.max(peak, active);
        calls.push(dto);
        order.push(`activate:${dto.path}`);
        if (calls.length === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        active--;
        return { sql: { db: () => ({}) }, kv: { get: async () => ({ ok: true }) } };
      },
    };
    const pending = activateVerifiedDelegation(node as unknown as TinyCloudNode, verified, {
      host: HOST,
      beforeNodeWrite: async () => { order.push("govern"); },
    });
    await firstStarted.promise;
    expect(calls).toHaveLength(1);
    releaseFirst.resolve();
    await pending;
    expect(peak).toBe(1);
    expect(order).toEqual([
      "govern", `activate:${verified.resources[0].path}`,
      "govern", `activate:${verified.resources[1].path}`,
    ]);
    expect(calls).toHaveLength(2);
    for (let i = 0; i < calls.length; i++) {
      const resource = verified.resources[i];
      const { delegationHeader, ...safeDto } = calls[i];
      expect(delegationHeader?.Authorization === verified.authorization).toBe(true);
      expect(Object.keys(delegationHeader ?? {})).toEqual(["Authorization"]);
      expect(safeDto).toEqual({
        cid: verified.cid,
        // Authorization is compared above without exposing its bytes on assertion failure.
        spaceId: verified.spaceId,
        path: resource.path,
        actions: resource.actions,
        resources: [{ ...resource, space: verified.spaceId }],
        expiry: verified.expiresAt,
        delegateDID: verified.backendDid,
        ownerAddress: verified.ownerAddress,
        chainId: verified.chainId,
        host: HOST,
      });
      expect(Object.keys(calls[i]).sort()).toEqual(
        ["cid", "delegationHeader", "spaceId", "path", "actions", "resources", "expiry", "delegateDID", "ownerAddress", "chainId", "host"].sort(),
      );
    }
  });

  it("refuses KV keys and list prefixes outside the verified transcriber scope before node I/O", async () => {
    const seen: string[] = [];
    const node = {
      useDelegation: async (_dto: DelegationDto) => ({
        sql: {},
        kv: {
          get: async (key: string) => { seen.push(key); return { ok: true, data: { data: "body" } }; },
          list: async (options: { prefix?: string }) => { seen.push(`list:${options.prefix}`); return { ok: true, data: [] }; },
        },
      }),
    };
    const access = await activateVerifiedDelegation(node as unknown as TinyCloudNode, verifiedGrant(), { host: HOST });
    const good = "xyz.tinycloud.tinychat/connectors/tinycloud-transcriber/transcript/meeting";
    await access.kv.get(good);
    expect(() => access.kv.get("xyz.tinycloud.tinychat/connectors/other/transcript/meeting")).toThrow();
    expect(() => access.kv.get("xyz.tinycloud.tinychat/connectors/tinycloud-transcriber/../secrets")).toThrow();
    expect(() => access.kv.list({ prefix: "xyz.tinycloud.tinychat/threads/" })).toThrow();
    expect(seen).toEqual([good]);
  });

  it("rejects unexpected resource shapes before any governor token or activation", async () => {
    const calls: string[] = [];
    const node = { useDelegation: async () => { calls.push("node"); return { kv: {} }; } };
    for (const resources of [
      [],
      Array.from({ length: MAX_ACTIVATABLE_RESOURCES + 1 }, (_, index) => ({
        service: "kv", space: SPACE, path: `xyz.tinycloud.tinychat/connectors/${index}/`, actions: ["tinycloud.kv/get"],
      })),
      [verifiedGrant().resources[0], verifiedGrant().resources[0]],
    ]) {
      await expect(activateVerifiedDelegation(node as unknown as TinyCloudNode, {
        ...verifiedGrant(), resources,
      }, { host: HOST, beforeNodeWrite: async () => { calls.push("govern"); } })).rejects.toThrow();
    }
    expect(calls).toEqual([]);
  });
});
