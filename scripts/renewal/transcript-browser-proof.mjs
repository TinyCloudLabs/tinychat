import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { closeSync, chmodSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const worktree = new URL("../../", import.meta.url).pathname;
const nodeBinary = "/var/tmp/tc2904-node-artifact/tinycloud";
const expectedNodeBinarySha256 = "58645b7c9bec9a0d45584c0aca7a8c37bb08ab7b9aad926af05763687d053edd";
const nodeSourceCommit = "3efdddc997eb112803166d6f45a99d8c25344715";
const sdkCommit = "255e1c7e74cab178698e3d3fae5bae5b69f0f7c0";
const frontendRequire = createRequire(join(worktree, "frontend/package.json"));
const [{ blake3 }, { ed25519 }, { bases }] = await Promise.all([
  import(pathToFileURL(frontendRequire.resolve("@noble/hashes/blake3")).href),
  import(pathToFileURL(frontendRequire.resolve("@noble/curves/ed25519")).href),
  import(pathToFileURL(join(dirname(frontendRequire.resolve("@tinycloud/sdk-core")), "../../../multiformats/dist/src/basics.js")).href),
]);


const proofId = randomBytes(6).toString("hex");
const root = `/var/tmp/tc2872-tinychat-proof-${sdkCommit.slice(0, 8)}-${proofId}`;
const privateDir = join(root, "private");
const evidencePath = join(root, "evidence.json");
mkdirSync(privateDir, { recursive: true, mode: 0o700 });
chmodSync(root, 0o700);
chmodSync(privateDir, 0o700);
const dataDir = join(privateDir, "data");
const home = join(privateDir, "home");
const tmp = join(privateDir, "tmp");
for (const dir of [dataDir, home, tmp]) mkdirSync(dir, { recursive: true, mode: 0o700 });

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function didFromSecret(secret, context) {
  const seed = blake3(Buffer.concat([secret, Buffer.from(context, "utf8")]));
  const publicKey = ed25519.getPublicKey(seed);
  const multicodec = Uint8Array.from([0xed, 0x01, ...publicKey]);
  return `did:key:${bases.base58btc.encode(multicodec)}`;
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve loopback port");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => server.close(() => resolve()));
}
async function waitForNode(child, origin, expected) {
  const deadline = Date.now() + 20_000;
  let lastStatus = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`owned node exited before readiness (exit=${child.exitCode}, signal=${child.signalCode ?? "none"})`);
    try {
      const response = await fetch(`${origin}/.well-known/tinycloud/node-keys`, { signal: AbortSignal.timeout(1_000) });
      lastStatus = response.status;
      if (response.ok) {
        const keys = await response.json();
        if (keys.nodeDid !== expected.nodeDid || keys.renewerDid !== expected.renewerDid) {
          throw new Error("loopback node identity did not match the synthetic key-derived identity");
        }
        if (!Number.isSafeInteger(keys.renewerEpoch) || keys.renewerEpoch < 0) throw new Error("invalid renewer epoch");
        return keys;
      }
    } catch (error) {
      if (String(error?.message ?? "").includes("identity did not match") || String(error?.message ?? "").includes("invalid renewer epoch")) throw error;
    }
    await delay(250);
  }
  throw new Error(`owned node readiness timeout (last status ${lastStatus ?? "none"})`);
}
function startNode(origin, port, configPath, logPath) {
  const logFd = openSync(logPath, "a", 0o600);
  const child = spawn(nodeBinary, [], {
    cwd: privateDir,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: home,
      TC_HOME: home,
      TMPDIR: tmp,
      TINYCLOUD_CONFIG_FILE: configPath,
      ROCKET_ADDRESS: "127.0.0.1",
      ROCKET_PORT: String(port),
    },
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  return child;
}
async function stopNode(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = once(child, "exit").then(() => true);
  if (await Promise.race([exited, delay(10_000).then(() => false)])) return;
  child.kill("SIGKILL");
  await Promise.race([once(child, "exit"), delay(2_000)]);
}

const evidence = {
  result: "FAIL",
  stage: "setup",
  proofId,
  nodeBinary: { path: nodeBinary, sha256: null, sourceCommit: nodeSourceCommit },
  sdk: { commit: sdkCommit, artifactsSha256: {} },
  contactedOrigins: [],
  httpTrace: [],
};
let nodeChild;
let registry;
let owner;
let restored;
let restoreDom;
let stage = "setup";
const progressPath = join(root, "progress.json");
const progressTimer = setInterval(() => { writeFileSync(progressPath, JSON.stringify({ stage, at: new Date().toISOString(), root }), { mode: 0o600 }); }, 5000);
const originalFetch = globalThis.fetch;
const ownerKey = randomBytes(32).toString("hex");
const staticSecret = randomBytes(32);
const expectedIdentity = {
  nodeDid: didFromSecret(staticSecret, "tinycloud/node/identity"),
  renewerDid: didFromSecret(staticSecret, "tinycloud/node/renewer/v1"),
};
let nodePort;
let registryPort;
let nodeOrigin;
let registryOrigin;
try {
  evidence.nodeBinary.sha256 = sha256(nodeBinary);
  if (evidence.nodeBinary.sha256 !== expectedNodeBinarySha256) throw new Error("supplied node binary SHA-256 mismatch");

  for (const pkg of ["@tinycloud/web-sdk", "@tinycloud/sdk-core", "@tinycloud/node-sdk"]) {
    evidence.sdk.artifactsSha256[pkg] = sha256(frontendRequire.resolve(pkg));
  }
  evidence.wrapperSha256 = sha256(join(worktree, "packages/client/src/tinycloud.ts"));
  stage = "loopback-listeners";
  nodePort = await freePort();
  registryPort = await freePort();
  nodeOrigin = `http://127.0.0.1:${nodePort}`;
  registryOrigin = `http://127.0.0.1:${registryPort}`;
  registry = createServer((_request, response) => {
    response.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"error":"location record not found"}');
  });
  await new Promise((resolve, reject) => {
    registry.once("error", reject);
    registry.listen(registryPort, "127.0.0.1", resolve);
  });

  const configPath = join(privateDir, "tinycloud.toml");
  const tomlString = (value) => JSON.stringify(value);
  const secretBase64 = staticSecret.toString("base64url");
  const toml = `[default]\naddress = "127.0.0.1"\nport = ${nodePort}\nlog_level = "critical"\n\n[default.storage]\ndatadir = ${tomlString(dataDir)}\ndatabase = ${tomlString(`sqlite:${join(dataDir, "caps.db")}?mode=rwc`)}\n\n[default.keys]\ntype = "Static"\nsecret = ${tomlString(secretBase64)}\n\n[default.telemetry]\nenabled = false\n\n[default.epoch_head_backfill]\nenabled = false\n`;
  writeFileSync(configPath, toml, { mode: 0o600 });
  chmodSync(configPath, 0o600);
  const nodeLog = join(privateDir, "node.log");

  stage = "first-node-start";
  nodeChild = startNode(nodeOrigin, nodePort, configPath, nodeLog);
  const initialIdentity = await waitForNode(nodeChild, nodeOrigin, expectedIdentity);
  evidence.node = { did: initialIdentity.nodeDid, renewerDid: initialIdentity.renewerDid, epoch: initialIdentity.renewerEpoch };

  stage = "sdk-network-guard";
  const allowedOrigins = new Set([nodeOrigin, registryOrigin]);
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    if (url.origin === "https://registry.tinycloud.xyz") { url.host = `127.0.0.1:${registryPort}`; url.protocol = "http:"; input = url.toString(); }
    if (!allowedOrigins.has(url.origin)) throw new Error("SDK attempted a non-loopback request; blocked by proof harness");
    const response = await originalFetch(input, init);
    evidence.contactedOrigins.push(url.origin);
    evidence.httpTrace.push({ origin: url.origin === nodeOrigin ? "loopback-node" : "loopback-registry", method: init?.method ?? (input instanceof Request ? input.method : "GET"), path: url.pathname, status: response.status });
    return response;
  };

  stage = "browser-sign-in";
  const { installDom } = await import("../../frontend/src/test/dom.ts");
  restoreDom = installDom();
  const { privateKeyToAccount } = await import(frontendRequire.resolve("viem/accounts"));
  const account = privateKeyToAccount(`0x${ownerKey}`);
  const provider = { request: async ({method, params}) => {
    if (method === "eth_accounts" || method === "eth_requestAccounts") return [account.address];
    if (method === "eth_chainId") return "0x1";
    if (method === "personal_sign") return account.signMessage({message: {raw: params[0]}});
    throw new Error(`Unsupported wallet method ${method}`);
  }};
  const { restoreTinyCloudWebSession } = await import("../../packages/client/src/tinycloud.ts");
  const { TinyCloudWeb, BrowserSessionStorage } = await import(frontendRequire.resolve("@tinycloud/web-sdk"));
  const { TRANSCRIPT_PERMISSIONS } = await import("../../frontend/src/lib/agentDelegation.ts");
  const storage = new BrowserSessionStorage({storage: window.localStorage});
  const config = { tinycloudHosts: [nodeOrigin], tinycloudRegistryUrl: registryOrigin, newUserHost: nodeOrigin,
    sessionStorage: storage, autoCreateSpace: true, domain: "localhost",
    manifest: {manifest_version: 1, app_id: "xyz.tinycloud.tinychat.renewal-proof", name: "Transcript renewal fixture", defaults: false, includePublicSpace: false, space: "applications", prefix: "", expiry: "16m", permissions: TRANSCRIPT_PERMISSIONS} };
  owner = new TinyCloudWeb({...config, provider, sessionExpirationMs: 960000, autoBootstrapAccount: false, includeAccountRegistryPermissions: false, ui: {button:false}});
  await owner.signIn();
  const saved = await storage.loadWithStatus(account.address);
  if (saved.status !== "loaded") throw new Error("browser session was not persisted");
  const originalExpiryMs = Date.parse(saved.data.expiresAt);
  if (originalExpiryMs > Date.now() + 1000000 || originalExpiryMs < Date.now() + 900000) throw new Error("unexpected fixture expiry");
  evidence.originalExpiresAt = saved.data.expiresAt;
  stage = "live-original-transcript-preflight";
  const preflight = await owner.kv.list({prefix: "xyz.tinycloud.tinychat/connectors/"});
  evidence.preflight = {ok: preflight.ok, code: preflight.error?.code, message: preflight.error?.message};
  if (!preflight.ok) throw new Error("live-original transcript preflight refused");
  if (process.argv.includes("--preflight")) {
    evidence.result = "PASS"; evidence.stage = "preflight-complete";
  } else {
    stage = "owner-lease-admission";
    const receipt = await owner.createRenewalLease(new Date(Date.now() + 1200000));
    evidence.leaseExpiresAt = receipt.leaseExpiresAt;
    owner.cleanup(); owner = null;
    stage = "wait-original-expiry";
    await delay(Math.max(0, originalExpiryMs - Date.now() + 1500));
    stage = "app-wrapper-restore";
    const result = await restoreTinyCloudWebSession(account.address, {...config, autoCreateSpace: false, renewalLeaseAuthorization: receipt.leaseAuthorization});
    if (result.status !== "restored" || !result.tcw) throw new Error("app wrapper refused renewal restore");
    restored = result.tcw;
    const read = await restored.kv.list({prefix: "xyz.tinycloud.tinychat/connectors/"});
    evidence.read = {ok: read.ok, code: read.error?.code, message: read.error?.message};
    if (!read.ok) throw new Error("transcript read refused");
    evidence.browser = {restoreAfterOriginalExpiry: true, transcriptList: true};
    evidence.result = "PASS"; evidence.stage = "complete";
  }
} catch (error) {
  evidence.result = "FAIL";
  evidence.stage = stage;
  evidence.errorName = error instanceof Error ? error.name : "Error";
  if (stage === "first-sdk-admission") evidence.admissionError = String(error?.message ?? "").replace(/[A-Za-z0-9_\-]{100,}/g,"[redacted]").slice(0,500);
  if (error?.code === "ERR_MODULE_NOT_FOUND" || error?.code === "MODULE_NOT_FOUND") evidence.moduleError = error.message;
  if (error instanceof Error) evidence.safeErrorPrefix = error.message.split(":")[0].slice(0, 100);
  if (
    error instanceof Error
    && /^(?:owned node exited before readiness \(exit=-?\d+, signal=(?:none|SIG[A-Z]+)\)|owned node readiness timeout \(last status (?:\d+|none)\)|loopback node identity did not match the synthetic key-derived identity|invalid renewer epoch)$/.test(error.message)
  ) evidence.safeError = error.message;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") evidence.errorCode = error.code;
} finally {
  clearInterval(progressTimer);
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(dataDir, "caps.db"), { readOnly: true });
    evidence.finalRenewalRows = { leases: db.prepare("SELECT count(*) AS total FROM renewal_lease").get().total, stamps: db.prepare("SELECT count(*) AS total FROM renewal_stamp").get().total };
    db.close();
  } catch {}
  globalThis.fetch = originalFetch;
  await stopNode(nodeChild);
  await closeServer(registry);
  owner?.cleanup?.();
  restored?.cleanup?.();
  restoreDom?.();
  const evidenceTmp = `${evidencePath}.tmp`;
  writeFileSync(evidenceTmp, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  chmodSync(evidenceTmp, 0o600);
  writeFileSync(`${evidenceTmp}.ready`, "", { mode: 0o600 });
  // Atomic finalization without exposing any private session/config material.
  const { renameSync } = await import("node:fs");
  renameSync(evidenceTmp, evidencePath);
  rmSync(`${evidenceTmp}.ready`, { force: true });
  if (evidence.result === "FAIL" && stage === "first-node-start") {
    try { renameSync(join(privateDir, "node.log"), join(root, "node-start.log")); } catch {}
  }
  rmSync(privateDir, { recursive: true, force: true });
}
console.log(JSON.stringify({ result: evidence.result, stage: evidence.stage, evidencePath }));
if (evidence.result !== "PASS") process.exitCode = 1;

process.exit(process.exitCode ?? 0);
