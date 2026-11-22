import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { DSTACK_SOCKET, SEAL_KEY_PATH, sealKeyFromDstack } from "../dstack-key";

interface Compose {
  services: Record<string, { volumes?: string[]; user?: string; group_add?: unknown }>;
}
const compose = Bun.YAML.parse(readFileSync(new URL("../../docker-compose.phala.yml", import.meta.url), "utf8")) as Compose;

test("only the gateway and the TLS ingress mount the key service; the sandboxes' supervisor and the page reader don't", () => {
  const mounting = Object.entries(compose.services)
    .filter(([, service]) => (service.volumes ?? []).some(volume => volume.startsWith(`${DSTACK_SOCKET}:`)))
    .map(([name]) => name)
    .sort();
  expect(mounting).toEqual(["bots-gateway", "dstack-ingress"]);
});

// The gateway runs as uid 65532 with no extra group. That reaches the key service only because the pinned OS creates
// the socket world-writable: dstack-0.5.12 (meta-dstack v0.5.12 → dstack 43f69f4) has `SocketMode=0777` in
// basefiles/dstack-guest-agent.socket, and the guest agent doesn't check the caller's uid. Another OS image must be
// checked again before this pin moves (bots/README.md, Deploying).
test("the gateway's user reaches the key service on the OS image it was checked against", () => {
  expect(compose.services["bots-gateway"]).toMatchObject({ user: "65532:65532" });
  expect(compose.services["bots-gateway"]!.group_add).toBeUndefined();
  const workflow = readFileSync(new URL("../../../.github/workflows/deploy-bots-phala.yml", import.meta.url), "utf8");
  expect(workflow).toContain("PHALA_OS_IMAGE: dstack-0.5.12\n");
});

let server: Server<undefined> | undefined;
let dir: string | undefined;
afterEach(() => {
  server?.stop(true);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("asks the key service for one key, on the sealing path, and derives 32 bytes from it", async () => {
  dir = mkdtempSync(join(tmpdir(), "dstack-"));
  const seen: Array<{ method: string; path: string; body: unknown }> = [];
  server = Bun.serve({
    unix: join(dir, "dstack.sock"),
    fetch: async req => {
      seen.push({ method: req.method, path: new URL(req.url).pathname, body: await req.json() });
      return Response.json({ key: "ab".repeat(32), signature_chain: [] });
    },
  });
  const key = await sealKeyFromDstack(join(dir, "dstack.sock"));
  expect(seen).toEqual([{ method: "POST", path: "/GetKey", body: { path: SEAL_KEY_PATH, purpose: "secret-seal" } }]);
  expect(SEAL_KEY_PATH).toBe("tinychat-bots/secret-seal");
  expect(key.length).toBe(32);
  // The raw key is never used as is.
  expect(Buffer.from(key).toString("hex")).not.toBe("ab".repeat(32));
  expect(await sealKeyFromDstack(join(dir, "dstack.sock"))).toEqual(key);
});

test("fails when the key service answers without a key", async () => {
  dir = mkdtempSync(join(tmpdir(), "dstack-"));
  server = Bun.serve({ unix: join(dir, "dstack.sock"), fetch: () => Response.json({}) });
  await expect(sealKeyFromDstack(join(dir, "dstack.sock"))).rejects.toThrow("no key");
});
