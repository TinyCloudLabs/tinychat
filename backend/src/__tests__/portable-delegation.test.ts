import { describe, expect, it } from "bun:test";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import express from "express";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { activateSessionWithHost } from "@tinycloud/sdk-core";
import { EXO_SYNC_RESOURCES, type VerifiedTranscriptWriter } from "../delegation-verify.js";
import { activateVerifiedDelegation, DelegationActivationError, MAX_ACTIVATABLE_RESOURCES } from "../portable-delegation.js";

const ADDRESS = "0x7d033300000000000000000000000000000073f2";
const SPACE = `tinycloud:pkh:eip155:1:${ADDRESS}:applications`;
const HOST = "https://node.tinycloud.xyz";
type DelegationDto = Parameters<TinyCloudNode["useDelegation"]>[0];
const EXO_REQUESTS = { service: "kv", space: SPACE, path: "xyz.tinycloud.tinychat/exo/v1/requests/", actions: ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/del"] };
const EXO_JOBS = { service: "kv", space: SPACE, path: "xyz.tinycloud.tinychat/exo/v1/jobs/", actions: ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/del"] };

function verifiedGrant(): VerifiedTranscriptWriter {
  return {
    cid: "bafkverified",
    authorization: "Bearer signed.jwt.bytes",
    ownerAddress: ADDRESS,
    chainId: 1,
    spaceId: SPACE,
    sessionDid: "did:key:z6MkSession",
    backendDid: `did:pkh:eip155:1:${ADDRESS}`,
    policy: "transcript-writer",
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

  it("activates an exact exo grant on its two KV prefixes, governing each write first", async () => {
    const calls: string[] = [];
    const node = { useDelegation: async (dto: DelegationDto) => { calls.push(`activate:${dto.path}`); return { kv: {} }; } };
    await activateVerifiedDelegation(node as unknown as TinyCloudNode, {
      ...verifiedGrant(), policy: "exo-sync", resources: [EXO_REQUESTS, EXO_JOBS],
    }, { host: HOST, beforeNodeWrite: async () => { calls.push("govern"); } });
    expect(calls).toEqual(["govern", `activate:${EXO_REQUESTS.path}`, "govern", `activate:${EXO_JOBS.path}`]);
  });

  it("refuses any non-exact exo shape before a governed write or any node call", async () => {
    const calls: string[] = [];
    const node = { useDelegation: async () => { calls.push("node"); return { kv: {} }; } };
    const connector = verifiedGrant().resources;
    for (const resources of [
      [],
      [EXO_REQUESTS],
      [EXO_REQUESTS, EXO_REQUESTS],
      [{ ...EXO_REQUESTS, path: "xyz.tinycloud.tinychat/exo/v1/" }, EXO_JOBS],
      [{ ...EXO_REQUESTS, actions: [...EXO_REQUESTS.actions, "tinycloud.kv/put"] }, EXO_JOBS],
      [EXO_REQUESTS, { ...EXO_JOBS, actions: ["tinycloud.kv/get", "tinycloud.kv/put"] }],
      [{ ...EXO_REQUESTS, actions: ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/del"] }, EXO_JOBS],
      [EXO_REQUESTS, { ...EXO_JOBS, actions: ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/del"] }],
      [EXO_REQUESTS, EXO_JOBS, connector[0]],
      connector,
    ]) {
      await expect(activateVerifiedDelegation(node as unknown as TinyCloudNode, {
        ...verifiedGrant(), policy: "exo-sync", resources,
      }, { host: HOST, beforeNodeWrite: async () => { calls.push("govern"); } })).rejects.toThrow("Exo sync delegation");
    }
    expect(calls).toEqual([]);
  });

  it("pins the shared exo table to the literal grant, and activation accepts exactly that table", async () => {
    expect(EXO_SYNC_RESOURCES).toEqual([
      { service: "kv", path: EXO_REQUESTS.path, actions: EXO_REQUESTS.actions },
      { service: "kv", path: EXO_JOBS.path, actions: EXO_JOBS.actions },
    ]);
    const calls: string[] = [];
    const node = { useDelegation: async (dto: DelegationDto) => { calls.push(`activate:${dto.path}`); return { kv: {} }; } };
    await activateVerifiedDelegation(node as unknown as TinyCloudNode, {
      ...verifiedGrant(), policy: "exo-sync",
      resources: EXO_SYNC_RESOURCES.map((resource) => ({ ...resource, space: SPACE, actions: [...resource.actions] })),
    }, { host: HOST, beforeNodeWrite: async () => { calls.push("govern"); } });
    expect(calls).toEqual(["govern", `activate:${EXO_REQUESTS.path}`, "govern", `activate:${EXO_JOBS.path}`]);
  });
});

/**
 * SDK 3.1's activation step, verbatim: the real (single-flighted) `activateSessionWithHost`, and
 * `useDelegation()`'s exact throw. `header` lets two activations send byte-identical headers.
 */
function sdkShapedNode(options: { before?: () => Promise<void>; header?: () => string } = {}) {
  let session = 0;
  return {
    useDelegation: async (dto: DelegationDto) => {
      await options.before?.();
      const authorization = options.header?.() ?? `Bearer invoker-${++session}`;
      const activateResult = await activateSessionWithHost(dto.host!, { Authorization: authorization });
      if (!activateResult.success) {
        const text = activateResult.error?.trim();
        throw Object.assign(
          new Error(`Failed to activate delegated session: ${text ? `${activateResult.status} - ${text}` : `${activateResult.status}`}`),
          { cause: activateResult },
        );
      }
      return { kv: {}, sql: {} };
    },
  } as unknown as TinyCloudNode;
}

async function withNode<T>(statuses: Record<string, number>, run: (host: string, posts: string[]) => Promise<T>,
  hold?: Promise<void>): Promise<T> {
  const app = express();
  const posts: string[] = [];
  app.post(/.*/, async (req, res) => {
    posts.push(req.path);
    await hold;
    res.status(statuses[req.path] ?? 404).send(`answer for ${req.path}`);
  });
  const server: Server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as { port: number };
    return await run(`http://127.0.0.1:${port}`, posts);
  } finally {
    const closed = once(server, "close");
    server.close();
    await closed;
  }
}

describe("activation status at the SDK boundary", () => {
  it("the installed node-sdk still throws the activation shape this boundary reads", () => {
    const dist = dirname(fileURLToPath(import.meta.resolve("@tinycloud/node-sdk")));
    const shape = /throw Object\.assign\(\s*new Error\(`Failed to activate delegated session: \$\{describeHostFailure\d*\(activateResult\)\}`\),\s*\{ cause: activateResult \}\s*\)/;
    for (const file of ["index.js", "index.cjs", "core.js", "core.cjs"]) {
      expect(readFileSync(join(dist, file), "utf8")).toMatch(shape);
    }
  });

  it("rethrows a node rejection with the status from the SDK error's cause", async () => {
    for (const status of [401, 403, 503]) {
      await withNode({ "/delegate": status }, async (host) => {
        const error = await activateVerifiedDelegation(sdkShapedNode(), verifiedGrant(), { host }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DelegationActivationError);
        expect((error as DelegationActivationError).status).toBe(status);
        expect(((error as Error).cause as Error).message)
          .toBe(`Failed to activate delegated session: ${status} - answer for /delegate`);
        expect((error as Error).message).not.toContain("answer for");
      });
    }
  });

  it("succeeds unchanged on a 2xx activation", async () => {
    await withNode({ "/delegate": 200 }, async (host) => {
      await expect(activateVerifiedDelegation(sdkShapedNode(), verifiedGrant(), { host })).resolves.toBeDefined();
    });
  });

  it("a network failure, a local throw, or a look-alike error is never a refusal", async () => {
    // Nothing listens here: the SDK's fetch rejects, and that error is kept as it is.
    const closed = await withNode({}, async (host) => host);
    const network = await activateVerifiedDelegation(sdkShapedNode(), verifiedGrant(), { host: closed }).catch((e: unknown) => e);
    expect(network).not.toBeInstanceOf(DelegationActivationError);
    expect((network as Error).message).not.toStartWith("Failed to activate delegated session");
    const thrower = (error: unknown) => ({ useDelegation: async () => { throw error; } }) as unknown as TinyCloudNode;
    for (const error of [
      new Error("local failure"),
      // The 2.x shape: a status-less message.
      new Error("Failed to activate delegated session: answer for /delegate"),
      // A host-result cause on some other operation.
      Object.assign(new Error("Failed to host space: 403"), { cause: { success: false, status: 403 } }),
      // A cause that is not a failed host result.
      Object.assign(new Error("Failed to activate delegated session: 403"), { cause: { success: true, status: 403 } }),
      Object.assign(new Error("Failed to activate delegated session: 403"), { cause: { success: false, status: "403" } }),
      Object.assign(new Error("Failed to activate delegated session: 200"), { cause: { success: false, status: 200 } }),
    ]) {
      const caught = await activateVerifiedDelegation(thrower(error), verifiedGrant(), { host: HOST }).catch((e: unknown) => e);
      expect(caught).toBe(error);
    }
  });

  it("callers joined to one single-flighted activation each get its refusal status", async () => {
    const release = Promise.withResolvers<void>();
    await withNode({ "/delegate": 403 }, async (host, posts) => {
      const header = () => "Bearer identical-invoker";
      const first = activateVerifiedDelegation(sdkShapedNode({ header }), verifiedGrant(), { host }).catch((e: unknown) => e);
      const second = activateVerifiedDelegation(sdkShapedNode({ header }), verifiedGrant(), { host }).catch((e: unknown) => e);
      await new Promise((resolve) => setTimeout(resolve, 50));
      release.resolve();
      const [a, b] = await Promise.all([first, second]);
      // One POST answered both callers; the joined one saw no request of its own.
      expect(posts).toEqual(["/delegate"]);
      for (const error of [a, b]) {
        expect(error).toBeInstanceOf(DelegationActivationError);
        expect((error as DelegationActivationError).status).toBe(403);
      }
    }, release.promise);
  });

  it("does not attribute one activation's rejection to a concurrent local failure", async () => {
    await withNode({ "/delegate": 403 }, async (host) => {
      const rejectedSeen = Promise.withResolvers<void>();
      const localFailure = { useDelegation: async () => {
        await rejectedSeen.promise;
        throw new Error("local failure");
      } } as unknown as TinyCloudNode;
      const rejecting = activateVerifiedDelegation(sdkShapedNode(), verifiedGrant(), { host })
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
