import { describe, expect, test } from "bun:test";
import { asksFile, requestsFile } from "../asks";
import { botLayout } from "../layout";
import { type OciSpec, sandboxSpec } from "../oci";
import { botIdFor } from "../owner";
import { mcpJson } from "../sandbox";

const roots = { dataRoot: "/data/bots", runRoot: "/run/bots", egressRoot: "/egress" };
const owner = "did:pkh:eip155:1:0x00000000000000000000000000000000000000aa";
const limits = { memoryMb: 1536, cpus: 1, pids: 256, overlayMb: 512, tmpMb: 256, stateMb: 256 };
const base: OciSpec = {
  ociVersion: "1.0.0",
  process: { user: { uid: 0, gid: 0 }, args: ["sh"], env: ["PATH=/bin"], cwd: "/" },
  root: { path: "rootfs", readonly: true },
  hostname: "runsc",
  mounts: [
    { destination: "/proc", type: "proc", source: "proc" },
    { destination: "/dev", type: "tmpfs", source: "tmpfs" },
    { destination: "/var/run", type: "bind", source: "/var/run", options: ["rbind"] },
  ],
  linux: { namespaces: [{ type: "pid" }, { type: "network" }, { type: "mount" }] },
};

const layout = botLayout(botIdFor(owner), roots);
const spec = sandboxSpec(base, { rootfs: "/bot-rootfs", token: "1".repeat(64), egressDir: layout.egressDir, stateMount: layout.stateMount, cgroupsPath: `/bots/${layout.botId}`, limits, role: "main" });

const inside = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

describe("the owner's requests are out of the sandbox's reach", () => {
  test("the records are beside web.json in the bot's data directory", () => {
    expect(requestsFile(layout)).toBe(`${layout.dataDir}/requests.json`);
    expect(asksFile(layout)).toBe(`${layout.dataDir}/asks.json`);
  });

  test("no mount's source is the data directory, holds it, or lies inside it; the records are under none of them", () => {
    const sources = spec.mounts.filter(mount => mount.type === "bind").map(mount => mount.source);
    expect(sources.sort()).toEqual([layout.egressDir, layout.stateMount].sort());
    for (const source of sources) {
      expect(inside(source, layout.dataDir)).toBe(false);
      expect(inside(layout.dataDir, source)).toBe(false);
      for (const file of [requestsFile(layout), asksFile(layout)]) expect(inside(file, source)).toBe(false);
    }
  });

  test("the state that is copied into the sandbox does not take the records with it", () => {
    for (const file of [requestsFile(layout), asksFile(layout)]) {
      expect(inside(file, layout.stateSnapshot)).toBe(false);
      expect(inside(file, layout.stateMount)).toBe(false);
      expect(inside(file, layout.bundleDir)).toBe(false);
      expect(inside(file, layout.egressDir)).toBe(false);
    }
  });

  test("the sandbox's only way to ask is the app MCP server through the gateway, with the bot's own token", () => {
    const servers = JSON.parse(mcpJson()).mcpServers as Record<string, { url: string; headers: Record<string, string> }>;
    expect(servers.app!.url).toBe("http://127.0.0.1:8080/v1/mcp/app");
    expect(servers.app!.headers).toEqual({ Authorization: "Bearer ${BOT_TOKEN}" });
    expect(JSON.stringify(spec)).not.toContain(layout.dataDir);
  });
});

describe("the sandbox's tool list is written once", () => {
  test("both servers are always configured, whatever the owner's setting; the setting is the gateway's to apply", () => {
    // Nothing is passed in, so nothing the owner chose can change what a sandbox starts with.
    expect(mcpJson.length).toBe(0);
    expect(Object.keys(JSON.parse(mcpJson()).mcpServers)).toEqual(["web", "app"]);
    expect(mcpJson()).toBe(mcpJson());
  });
});
