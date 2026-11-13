import { afterEach, describe, expect, it } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  AGENT_CONSENT_MANIFEST,
  AGENT_DELEGATION_EXPIRY_MS,
  clearAgentSessionCache,
  ensureAgentSession,
  ephemeralAgentSdkConfig,
  isActiveAgentBundle,
  MCP_CONSENT_MANIFEST,
  mintMcpSessionDelegation,
  revokeMcpGrants,
  TRANSCRIPT_PERMISSIONS,
} from "./agentDelegation.js";

const SERVICE_DID = "did:key:z6MkServiceDidForTests";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  clearAgentSessionCache();
});

function fakeTcw(): TinyCloudWeb {
  return { address: () => "0xUSER", chainId: () => 1, hosts: ["https://node.tinycloud.xyz"] } as unknown as TinyCloudWeb;
}

describe("the grant minted for the MCP", () => {
  it("delegates exactly SQL read and KV get/list on the connectors data to the service DID, for at most 29 days, and mints nothing else", async () => {
    const delegateCalls: Array<{ did: string; permissions: unknown; options: { expiry?: number } }> = [];
    let memoryMinted = false;
    const tcw = {
      address: () => "0xUSER", chainId: () => 1, hosts: ["https://node.tinycloud.xyz"],
      space: () => ({ delegations: { async create() { memoryMinted = true; return { ok: false, error: { message: "unexpected" } }; } } }),
      async delegateTo(did: string, permissions: unknown, options: { expiry?: number }) {
        delegateCalls.push({ did, permissions, options });
        return { delegation: { cid: "cid-1", delegateDID: did, expiry: new Date(Date.now() + AGENT_DELEGATION_EXPIRY_MS) } };
      },
    } as unknown as TinyCloudWeb;

    const minted = await mintMcpSessionDelegation(tcw, SERVICE_DID);

    expect(memoryMinted).toBe(false);
    expect(delegateCalls).toHaveLength(1);
    expect(delegateCalls[0]!.did).toBe(SERVICE_DID);
    expect(delegateCalls[0]!.options.expiry).toBe(AGENT_DELEGATION_EXPIRY_MS);
    expect(delegateCalls[0]!.permissions).toEqual([
      { service: "tinycloud.sql", space: "applications", path: "xyz.tinycloud.tinychat/connectors", actions: ["read"], skipPrefix: true },
      { service: "tinycloud.kv", space: "applications", path: "xyz.tinycloud.tinychat/connectors/", actions: ["get", "list"], skipPrefix: true },
    ]);
    expect(minted).toEqual({ mcp: { delegation: expect.any(String) } });
    expect(JSON.parse(minted.mcp.delegation)).toMatchObject({ cid: "cid-1", delegateDID: SERVICE_DID });
  });

  it("asks the fresh sign-in for transcript access only, never the memory database", () => {
    expect(MCP_CONSENT_MANIFEST.permissions).toEqual(TRANSCRIPT_PERMISSIONS);
    expect(JSON.stringify(MCP_CONSENT_MANIFEST)).not.toContain("xyz.tinycloud.eliza/memory");
    expect(MCP_CONSENT_MANIFEST.expiry).toBe(AGENT_CONSENT_MANIFEST.expiry);
    const config = ephemeralAgentSdkConfig({ web3Provider: {} as never, sessionStorage: {} as never, manifest: MCP_CONSENT_MANIFEST });
    expect(config.manifest).toBe(MCP_CONSENT_MANIFEST);
    expect(ephemeralAgentSdkConfig({ web3Provider: {} as never, sessionStorage: {} as never }).manifest).toBe(AGENT_CONSENT_MANIFEST);
  });
});

describe("ensureAgentSession for an MCP account", () => {
  it("mints for the service DID the backend names and couriers it under `mcp`, not `session`", async () => {
    const posted: unknown[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted.push(JSON.parse(init.body as string));
        return new Response(JSON.stringify({ status: "active", transcriptStatus: "active", revision: "mcp" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "none", transcriptStatus: "none", revision: "mcp", mcp: { serviceDid: SERVICE_DID } }), { status: 200 });
    }) as typeof fetch;
    const seen: Array<string | undefined> = [];
    await ensureAgentSession({
      tcw: fakeTcw(), backendUrl: "https://api.test", getToken: () => "tok", force: true,
      _mint: async (_tcw, snapshot) => { seen.push(snapshot?.mcp?.serviceDid); return { mcp: { delegation: "SERIALIZED" } }; },
    });
    expect(seen).toEqual([SERVICE_DID]);
    expect(posted).toEqual([{ revision: "mcp", mcp: { delegation: "SERIALIZED" } }]);
  });

  it("treats the MCP's active status as an active bundle", () => {
    expect(isActiveAgentBundle({ status: "active", transcriptStatus: "active", revision: "mcp" })).toBe(true);
    expect(isActiveAgentBundle({ status: "expired", transcriptStatus: "expired", revision: "mcp" })).toBe(false);
  });
});

describe("revokeMcpGrants", () => {
  const connectors = (service: string) => `tinycloud:pkh:eip155:1:0xUSER:applications/${service}/xyz.tinycloud.tinychat/connectors${service === "kv" ? "/" : ""}`;
  const item = (cid: string, delegateDid = SERVICE_DID) => ({ cid, delegateDid, status: "active", resources: [{ resource: connectors("kv") }, { resource: connectors("sql") }] });
  const tcwWith = (pages: Array<{ items: unknown[]; nextCursor?: string }>, revoked: string[], failOn?: string) => ({
    delegations: {
      query: async (options: { cursor?: string }) => ({ ok: true, data: pages[options.cursor ? Number(options.cursor) : 0] }),
    },
    revokeDelegation: async (cid: string) => { if (cid === failOn) return { ok: false, error: {} }; revoked.push(cid); return { ok: true, data: { revoked: true, cid } }; },
  }) as unknown as TinyCloudWeb;

  it("finds grants on every page and revokes each, one revoke per grant", async () => {
    const revoked: string[] = [];
    const tcw = tcwWith([{ items: [item("A"), item("OTHER", "did:key:z6MkOther")], nextCursor: "1" }, { items: [item("B")] }], revoked);
    expect(await revokeMcpGrants(tcw, SERVICE_DID)).toBe(2);
    expect(revoked).toEqual(["A", "B"]);
  });

  it("resolves with zero when no matching grant is active, and throws when a revoke fails", async () => {
    expect(await revokeMcpGrants(tcwWith([{ items: [item("OTHER", "did:key:z6MkOther")] }], []), SERVICE_DID)).toBe(0);
    await expect(revokeMcpGrants(tcwWith([{ items: [item("A")] }], [], "A"), SERVICE_DID)).rejects.toThrow("not confirmed");
  });

  it("leaves a grant to the same DID alone when it also covers data beyond the connectors", async () => {
    const revoked: string[] = [];
    const broad = { ...item("BROAD"), resources: [...item("BROAD").resources, { resource: "tinycloud:pkh:eip155:1:0xUSER:applications/kv/xyz.other.app/notes/" }] };
    expect(await revokeMcpGrants(tcwWith([{ items: [broad, item("A")] }], revoked), SERVICE_DID)).toBe(1);
    expect(revoked).toEqual(["A"]);
  });

  it("never reports a partial listing as done: a failed page or a listing that does not end throws before any revoke", async () => {
    const revoked: string[] = [];
    const failing = {
      delegations: { query: async (options: { cursor?: string }) => options.cursor ? { ok: false, error: {} } : { ok: true, data: { items: [item("A")], nextCursor: "1" } } },
      revokeDelegation: async (cid: string) => { revoked.push(cid); return { ok: true, data: { revoked: true, cid } }; },
    } as unknown as TinyCloudWeb;
    await expect(revokeMcpGrants(failing, SERVICE_DID)).rejects.toThrow("not confirmed");
    const endless = {
      delegations: { query: async () => ({ ok: true, data: { items: [item("A")], nextCursor: "again" } }) },
      revokeDelegation: async (cid: string) => { revoked.push(cid); return { ok: true, data: { revoked: true, cid } }; },
    } as unknown as TinyCloudWeb;
    await expect(revokeMcpGrants(endless, SERVICE_DID)).rejects.toThrow("not confirmed");
    expect(revoked).toEqual([]);
  });
});
