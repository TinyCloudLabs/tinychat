import { expect, test } from "bun:test";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

// Reuse the VM entrypoint harness without registering its existing tests. This runs the
// actual compiled main with the real continuity method and controlled storage, not a no-op guard.
async function harness(kind: "empty" | "index" | "corrupt") {
  const dir = import.meta.dir;
  let source = readFileSync(resolve(dir, "index-wiring.test.ts"), "utf8")
    .replace('import { afterEach, describe, expect, test } from "bun:test";', 'import { expect } from "bun:test"; const afterEach = () => {}; const describe = () => {}; const test = Object.assign(() => {}, { each: () => () => {} });')
    .replaceAll("import.meta.dir", JSON.stringify(dir))
    .replace('    "./services/content-store.js": {\n      ...contentStore,', `    "./services/content-store.js": {
      ...contentStore,
      KvContentBlobStore: class {
        async readCanary() { return ${kind === "corrupt" ? '{ ciphertext: "invalid", wrappedDEK: "invalid", updatedAt: "" }' : 'null'}; }
        async findIndex() { return ${kind === "index" ? '{ source: "fireflies", address: "0x1111111111111111111111111111111111111111" }' : 'null'}; }
        async hasContent() { return false; }
        async writeCanary() { throw new Error("unexpected enrollment"); }
      },`)
    .replaceAll('      assertNoContentKey: async () => {},', '')
    .replace('        async assertContinuity() {}\n        async probeIndex()', '        async probeIndex()')
    .replace('"./services/ingest-instance.js": { ...ingestInstanceModule,', '"./services/ingest-instance.js": { ...ingestInstanceModule, IngestInstanceGuard: class { async claim() { return { status: "held" }; } },')
    .replace('      server = originalListen(0, "127.0.0.1", listener);', '      globalThis.__tc2843Listens++; server = originalListen(0, "127.0.0.1", listener);');
  source += '\nexport { bootIndex };';
  const path = resolve(dir, `.tc2843-harness-${randomBytes(8).toString("hex")}.mjs`);
  writeFileSync(path, new Bun.Transpiler({ loader: "ts" }).transformSync(source));
  try { return await import(path); } finally { unlinkSync(path); }
}

test("unset master with no content starts with sealed routes disabled and never enrolls", async () => {
  (globalThis as any).__tc2843Listens = 0;
  const { bootIndex } = await harness("empty");
  const boot = await bootIndex({ CONNECTOR_BACKEND_INGEST_ENABLED: "true" });
  try {
    expect(boot.exits).toEqual([]);
    expect((globalThis as any).__tc2843Listens).toBe(1);
    expect((await fetch(boot.url + "/health")).status).toBe(200);
    expect((await fetch(boot.url + "/api/connectors/meetings/fireflies")).status).toBe(404);
    expect((await fetch(boot.url + "/api/connectors/credentials")).status).toBe(404);
  } finally { await boot.close(); }
});

test("unset master with an existing sealed index refuses before listen", async () => {
  (globalThis as any).__tc2843Listens = 0;
  const { bootIndex } = await harness("index");
  await expect(bootIndex()).rejects.toThrow("refusing startup and writes");
  expect((globalThis as any).__tc2843Listens).toBe(0);
});

test("a real canary decrypt failure refuses the entrypoint before listen", async () => {
  (globalThis as any).__tc2843Listens = 0;
  const { bootIndex } = await harness("corrupt");
  await expect(bootIndex({
    CONNECTOR_WEBHOOKS_ENABLED: "true", CONNECTOR_BACKEND_INGEST_ENABLED: "true",
    CONNECTOR_CONTENT_MASTER: randomBytes(32).toString("hex"),
    CONNECTOR_CREDENTIAL_MASTER: randomBytes(32).toString("hex"),
    WEBHOOK_HMAC_MASTER: randomBytes(32).toString("hex"),
    CONNECTOR_LOG_SALT: randomBytes(32).toString("hex"),
    CONNECTOR_WEBHOOK_PUBLIC_ORIGIN: "https://app.invalid",
    FIREFLIES_OAUTH_CLIENT_ID: "test-client", FIREFLIES_OAUTH_CLIENT_SECRET: "test-secret", FIREFLIES_OAUTH_REDIRECT_URI: "https://app.invalid/callback",
  })).rejects.toThrow("refusing startup and writes");
  expect((globalThis as any).__tc2843Listens).toBe(0);
});
