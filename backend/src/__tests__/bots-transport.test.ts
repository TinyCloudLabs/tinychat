import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { botsFromEnv } from "../routes/bots";
import { botsConnectFetch } from "../bots-transport";

const env = { BOTS_ENABLED: "true", BOTS_SERVICE_URL: "https://bots.tinycloud.xyz", BOTS_SERVICE_SECRET: "test", BOTS_TEST_ACCOUNTS: "*" };
test("unset override retains fetch; unsafe route and HTTP fail at config load", () => {
  expect(botsFromEnv(env)?.fetchImpl).toBeUndefined();
  for (const host of ["foreign.example", `${"a".repeat(40)}-443.dstack-prod.phala.network`]) {
    expect(() => botsFromEnv({ ...env, BOTS_SERVICE_CONNECT_HOST: host })).toThrow();
  }
  expect(() => botsFromEnv({ ...env, BOTS_SERVICE_URL: "http://bots.tinycloud.xyz", BOTS_SERVICE_CONNECT_HOST: "localhost" })).toThrow();
});

// A child process loads the test CA at startup, just as the runtime loads its trust store.
for (const name of ["bots.tinycloud.xyz", "wrong.example", "localhost", "self-signed"]) {
  test(`TLS ${name === "bots.tinycloud.xyz" ? "accepts service identity" : `refuses ${name}`}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "bots-tls-"));
    const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
    try {
      openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "1", "-subj", "/CN=Test CA");
      const dns = name === "self-signed" ? "bots.tinycloud.xyz" : name;
      openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", `/CN=${dns}`);
      writeFileSync(join(dir, "ext"), `subjectAltName=DNS:${dns}\n`);
      if (name === "self-signed") openssl("x509", "-req", "-in", "leaf.csr", "-signkey", "leaf.key", "-out", "leaf.pem", "-days", "1", "-extfile", "ext");
      else openssl("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "1", "-extfile", "ext");
      let host = "";
      let sni = "";
      const server = createServer({ key: readFileSync(join(dir, "leaf.key")), cert: readFileSync(join(dir, "leaf.pem")) }, (req, res) => { host = req.headers.host!; sni = (req.socket as any).servername; res.end("pong"); });
      await new Promise<void>(resolve => server.listen(0, resolve));
      try {
        const port = (server.address() as any).port;
        const script = `import { botsConnectFetch } from ${JSON.stringify(join(import.meta.dir, "../bots-transport.ts"))}; try { const r = await botsConnectFetch("https://bots.tinycloud.xyz:${port}", "localhost")("https://bots.tinycloud.xyz:${port}/healthz"); process.exit((await r.text()) === "pong" ? 0 : 2); } catch { process.exit(1); }`;
        const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, NODE_EXTRA_CA_CERTS: join(dir, "ca.pem") }, stdout: "ignore", stderr: "ignore" });
        expect(await child.exited).toBe(name === "bots.tinycloud.xyz" ? 0 : 1);
        if (name === "bots.tinycloud.xyz") { expect(host).toBe(`bots.tinycloud.xyz:${port}`); expect(sni).toBe("localhost"); }
      } finally { server.closeAllConnections(); server.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
