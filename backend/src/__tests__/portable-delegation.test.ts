import { describe, expect, it } from "bun:test";
import { once } from "node:events";
import type { Server } from "node:http";
import express from "express";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { activateSessionWithHost } from "@tinycloud/sdk-core";
import type { VerifiedTranscriptWriter } from "../delegation-verify.js";
import { activateVerifiedDelegation, DelegationActivationError, MAX_ACTIVATABLE_RESOURCES } from "../portable-delegation.js";

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
          put: async (key: string, _value: unknown, options?: { prefix?: string }) => {
            seen.push(`put:${key}:prefix=${options?.prefix}`);
            return { ok: true, data: {} };
          },
          list: async (options: { prefix?: string }) => { seen.push(`list:${options.prefix}`); return { ok: true, data: [] }; },
        },
      }),
    };
    const access = await activateVerifiedDelegation(node as unknown as TinyCloudNode, verifiedGrant(), { host: HOST });
    const good = "xyz.tinycloud.tinychat/connectors/tinycloud-transcriber/transcript/meeting";
    await access.kv.get(good);
    await access.kv.put(good, "body", { prefix: "xyz.tinycloud.tinychat/threads/" });
    await access.kv.withPrefix("xyz.tinycloud.tinychat/connectors/tinycloud-transcriber/")
      .put("transcript/nested", "body", { prefix: "xyz.tinycloud.tinychat/threads/" });
    expect(() => access.kv.get("xyz.tinycloud.tinychat/connectors/other/transcript/meeting")).toThrow();
    expect(() => access.kv.get("xyz.tinycloud.tinychat/connectors/tinycloud-transcriber/../secrets")).toThrow();
    expect(() => access.kv.list({ prefix: "xyz.tinycloud.tinychat/threads/" })).toThrow();
    expect(() => access.kv.put("xyz.tinycloud.tinychat/connectors/tinycloud-transcriber%2fthreads/secret", "body")).toThrow();
    expect(() => access.kv.put("xyz.tinycloud.tinychat/connectors/tinycloud-transcriber/%5csecrets", "body")).toThrow();
    expect(() => access.kv.put("xyz.tinycloud.tinychat/connectors/tinycloud-transcriber-other/transcript/meeting", "body")).toThrow();
    expect(seen).toEqual([
      good,
      `put:${good}:prefix=`,
      "put:xyz.tinycloud.tinychat/connectors/tinycloud-transcriber/transcript/nested:prefix=",
    ]);
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

/** The pinned SDK's activation step: its real request, and its exact status-less Error. */
function sdkShapedNode(before?: () => Promise<void>) {
  let session = 0;
  return {
    useDelegation: async (dto: DelegationDto) => {
      await before?.();
      const result = await activateSessionWithHost(dto.host!, { Authorization: `Bearer invoker-${++session}` });
      if (!result.success) throw new Error(`Failed to activate delegated session: ${result.error}`);
      return { kv: {}, sql: {} };
    },
  } as unknown as TinyCloudNode;
}

async function withNode<T>(statuses: Record<string, number>, run: (host: string) => Promise<T>): Promise<T> {
  const app = express();
  app.post(/.*/, (req, res) => { res.status(statuses[req.path] ?? 404).send(`answer for ${req.path}`); });
  const server: Server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as { port: number };
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    const closed = once(server, "close");
    server.close();
    await closed;
  }
}

describe("activation status at the SDK boundary", () => {
  it("rethrows a node rejection with the HTTP status the SDK's own Error drops", async () => {
    for (const status of [401, 403, 503]) {
      await withNode({ "/delegate": status }, async (host) => {
        const error = await activateVerifiedDelegation(sdkShapedNode(), verifiedGrant(), { host }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DelegationActivationError);
        expect((error as DelegationActivationError).status).toBe(status);
        // The SDK's message carried the body and no status — that is why this boundary exists.
        expect(((error as Error).cause as Error).message).toBe("Failed to activate delegated session: answer for /delegate");
        expect((error as Error).message).not.toContain("answer for");
      });
    }
  });

  it("succeeds unchanged on a 2xx activation", async () => {
    await withNode({ "/delegate": 200 }, async (host) => {
      await expect(activateVerifiedDelegation(sdkShapedNode(), verifiedGrant(), { host })).resolves.toBeDefined();
    });
  });

  it("ignores other requests, other hosts and requests outside the activation scope", async () => {
    await withNode({ "/delegate": 403, "/other": 403 }, async (host) => {
      // A rejected non-activation POST inside the scope, then a throw before any activation request.
      const otherPath = { useDelegation: async () => {
        await fetch(`${host}/other`, { method: "POST" });
        throw new Error("local failure");
      } } as unknown as TinyCloudNode;
      const error = await activateVerifiedDelegation(otherPath, verifiedGrant(), { host }).catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(DelegationActivationError);
      expect((error as Error).message).toBe("local failure");

      // The same /delegate on a host other than the configured one is not this activation.
      const otherHost = { useDelegation: async () => {
        await fetch(`${host.replace("127.0.0.1", "localhost")}/delegate`, { method: "POST" });
        throw new Error("other host");
      } } as unknown as TinyCloudNode;
      const second = await activateVerifiedDelegation(otherHost, verifiedGrant(), { host }).catch((e: unknown) => e);
      expect(second).not.toBeInstanceOf(DelegationActivationError);

      // Outside any activation the wrapper is transparent.
      const response = await fetch(`${host}/delegate`, { method: "POST" });
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("answer for /delegate");
    });
  });

  it("does not attribute one activation's rejection to a concurrent one on the same host", async () => {
    await withNode({ "/delegate": 403 }, async (host) => {
      const rejectedSeen = Promise.withResolvers<void>();
      const localFailure = { useDelegation: async () => {
        // Still inside its own activation when the other one's 403 arrives.
        await rejectedSeen.promise;
        throw new Error("local failure");
      } } as unknown as TinyCloudNode;
      const rejectedNode = sdkShapedNode();
      const rejecting = activateVerifiedDelegation(rejectedNode, verifiedGrant(), { host })
        .finally(() => rejectedSeen.resolve());
      const [rejected, local] = await Promise.allSettled([
        rejecting,
        activateVerifiedDelegation(localFailure, verifiedGrant(), { host }),
      ]);
      expect(((rejected as PromiseRejectedResult).reason as DelegationActivationError).status).toBe(403);
      expect((local as PromiseRejectedResult).reason).not.toBeInstanceOf(DelegationActivationError);
      expect(((local as PromiseRejectedResult).reason as Error).message).toBe("local failure");
    });
  });
});
