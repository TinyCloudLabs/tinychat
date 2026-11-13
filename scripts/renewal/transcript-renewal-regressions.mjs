import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  TinyCloudNode,
  NodeWasmBindings,
  PrivateKeySigner,
} from "@tinycloud/node-sdk";
import { restoreTinyCloudWebSession } from "../../packages/client/src/tinycloud.ts";
import { installDom } from "../../frontend/src/test/dom.ts";
function encodeDagCbor(value) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  };
  if (typeof value === "string") {
    const b = Buffer.from(value);
    return Buffer.concat([head(3, b.length), b]);
  }
  if (typeof value === "number") return head(0, value);
  const entries = Object.entries(value)
    .map(([key, val]) => [encodeDagCbor(key), encodeDagCbor(val)])
    .sort((a, b) => a[0].length - b[0].length || Buffer.compare(a[0], b[0]));
  return Buffer.concat([head(5, entries.length), ...entries.flat()]);
}
const req = createRequire(
  new URL("../../frontend/package.json", import.meta.url),
);
const coreReq = createRequire(req.resolve("@tinycloud/sdk-core"));
const { ed25519 } = await import(coreReq.resolve("@noble/curves/ed25519"));
const { blake3 } = await import(coreReq.resolve("@noble/hashes/blake3"));
const { BrowserSessionStorage } = await import(
  req.resolve("@tinycloud/web-sdk")
);
const multiBase = join(
  dirname(req.resolve("@tinycloud/sdk-core")),
  "../../../multiformats/dist/src",
);
const { bases } = await import(join(multiBase, "basics.js"));
const { CID } = await import(join(multiBase, "cid.js"));
const { create: createDigest } = await import(
  join(multiBase, "hashes/digest.js")
);
const undo = installDom(),
  oldFetch = globalThis.fetch,
  oldNow = Date.now;
const host = "http://127.0.0.1:31801",
  registry = "http://127.0.0.1:31802";
const signer = new PrivateKeySigner(randomBytes(32).toString("hex")),
  wasm = new NodeWasmBindings(),
  manager = wasm.createSessionManager();
const address = await signer.getAddress(),
  chainId = await signer.getChainId(),
  spaceId = wasm.makeSpaceId(address, chainId, "default"),
  jwk = JSON.parse(manager.jwk("default"));
const expires = new Date(Date.now() + 3600000);
const prepared = wasm.prepareSession({
  abilities: {
    kv: {
      "xyz.tinycloud.tinychat/connectors/": [
        "tinycloud.kv/get",
        "tinycloud.kv/list",
      ],
    },
  },
  address,
  chainId,
  domain: "localhost",
  issuedAt: new Date().toISOString(),
  expirationTime: expires.toISOString(),
  spaceId,
  jwk,
});
const signature = await signer.signMessage(prepared.siwe),
  session = wasm.completeSessionSetup({ ...prepared, signature });
const proof = {
  ...session,
  jwk,
  spaceId,
  verificationMethod: manager.getDID("default"),
  address,
  chainId,
  siwe: prepared.siwe,
  signature,
  expiresAt: expires.toISOString(),
};
const record = {
  address,
  chainId,
  sessionKey: JSON.stringify(jwk),
  siwe: prepared.siwe,
  signature,
  tinycloudSession: {
    ...session,
    spaceId,
    verificationMethod: proof.verificationMethod,
  },
  expiresAt: expires.toISOString(),
  createdAt: new Date().toISOString(),
  version: "1.0",
};
const did = (seed) =>
  `did:key:${bases.base58btc.encode(Uint8Array.from([0xed, 1, ...ed25519.getPublicKey(seed)]))}`;
const nodeDid = did(randomBytes(32)),
  renewerSeed = randomBytes(32),
  renewerDid = did(renewerSeed);
const identity = {
  nodeDid,
  renewerDid,
  renewerPublicKey: Buffer.from(ed25519.getPublicKey(renewerSeed)).toString(
    "base64url",
  ),
  renewerEpoch: 1,
};
let history = [],
  stampEnd = Math.floor((expires.getTime() + 7200000) / 1000),
  mode = "valid",
  statusCalls = 0;
globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init),
    url = new URL(request.url);
  if (
    url.origin === registry ||
    url.origin === "https://registry.tinycloud.xyz"
  )
    return Response.json(
      { error: "location record not found" },
      { status: 404 },
    );
  if (url.origin !== host) throw new Error("Nonloopback request blocked");
  if (url.pathname === "/info")
    return Response.json({
      protocol: 1,
      version: "test",
      features: [],
      nodeId: nodeDid,
    });
  if (url.pathname === "/.well-known/tinycloud/node-keys")
    return Response.json(identity);
  if (url.pathname === "/delegate")
    return Response.json({ activated: [spaceId], skipped: [] });
  if (url.pathname === "/delegation/status") {
    statusCalls++;
    return Response.json({
      cid: proof.delegationCid,
      status: "active",
      exists: true,
      active: true,
      revoked: mode === "revoked",
      expired: false,
      effective_expiry: stampEnd,
      renewal_history: history,
    });
  }
  throw new Error("Unexpected synthetic endpoint");
};
const owner = new TinyCloudNode({
  host,
  signer,
  wasmBindings: wasm,
  tinycloudRegistryUrl: registry,
  autoDiscoverLocalNode: false,
});
try {
  await owner.restoreSession(proof);
  const lease = await owner.createRenewalLease(
    new Date(expires.getTime() + 10800000),
  );
  const makeStamp = (overrides = {}) => {
    const bytes = encodeDagCbor({
      domain: "tinycloud/node/renewal-stamp/v1",
      unsigned: {
        type: "TinyCloudRenewalStamp",
        newEnd: new Date(stampEnd * 1000).toISOString().replace(".000Z", "Z"),
        nodeDid,
        version: 1,
        leaseCid: lease.leaseCid,
        originalCid: proof.delegationCid,
        renewerEpoch: 1,
        leaseGeneration: 1,
        previousStampCid: lease.leaseCid,
        ...overrides,
      },
    });
    return {
      cid: CID.createV1(0x55, createDigest(0x1e, blake3(bytes))).toString(),
      lease_cid: lease.leaseCid,
      generation: 1,
      previous_stamp_cid: lease.leaseCid,
      new_end: stampEnd,
      signed_bytes: Buffer.from(bytes).toString("base64url"),
      signature: Buffer.from(ed25519.sign(bytes, renewerSeed)).toString(
        "base64url",
      ),
    };
  };
  const outcomes = [];
  const run = async (
    label,
    {
      requested = address,
      renewal = true,
      expected = "restore-failed",
      midFence = false,
    } = {},
  ) => {
    window.localStorage.clear();
    window.localStorage.setItem(
      `tinycloud:session:${requested.toLowerCase()}`,
      JSON.stringify(record),
    );
    const storage = new BrowserSessionStorage({ storage: window.localStorage });
    let fenceReads = 0;
    if (midFence) {
      const check = storage.isSignedOut.bind(storage);
      storage.isSignedOut = (a, s) => {
        const answer = check(a, s);
        if (++fenceReads === 1) storage.markSignedOut(a, s);
        return answer;
      };
    }
    const result = await restoreTinyCloudWebSession(requested, {
      sessionStorage: storage,
      tinycloudHosts: [host],
      tinycloudRegistryUrl: registry,
      ...(renewal
        ? { renewalLeaseAuthorization: lease.leaseAuthorization }
        : {}),
    });
    try {
      assert.equal(result.status, expected, label);
      if (expected === "restored")
        assert.equal(
          result.session.address.toLowerCase(),
          requested.toLowerCase(),
          label,
        );
      else assert.equal(result.tcw, null, label);
      if (label.includes("B-under-A"))
        assert.equal(result.error?.code, "ACCOUNT_MISMATCH", label);
      if (midFence) assert.ok(fenceReads >= 2, "persisted fence was rechecked");
      outcomes.push({
        label,
        status: result.status,
        ...(midFence ? { fenceReads } : {}),
      });
    } finally {
      result.tcw?.cleanup();
    }
  };
  history = [makeStamp()];
  await run("ordinary-same-account", { renewal: false, expected: "restored" });
  await run("ordinary-B-under-A", {
    requested: "0x1111111111111111111111111111111111111111",
    renewal: false,
  });
  await run("ordinary-fence-during-restore", {
    renewal: false,
    midFence: true,
    expected: "missing",
  });
  Date.now = () => expires.getTime() + 60000;
  await run("renewed-same-account", { expected: "restored" });
  await run("renewed-B-under-A", {
    requested: "0x1111111111111111111111111111111111111111",
  });
  await run("renewed-fence-during-restore", {
    midFence: true,
    expected: "missing",
  });
  history = [
    { ...makeStamp(), signature: Buffer.alloc(64).toString("base64url") },
  ];
  await run("invalid-stamp-signature");
  history = [makeStamp({ nodeDid: did(randomBytes(32)) })];
  await run("wrong-node-stamp");
  history = [makeStamp({ renewerEpoch: 2 })];
  await run("wrong-epoch-stamp");
  const otherOriginalCid = CID.createV1(
    0x55,
    createDigest(0x1e, blake3(Buffer.from("another-original"))),
  ).toString();
  history = [makeStamp({ originalCid: otherOriginalCid })];
  await run("wrong-original-cid");
  history = [makeStamp()];
  mode = "revoked";
  await run("revoked-parent-status");
  mode = "valid";
  stampEnd = Math.floor((expires.getTime() + 30000) / 1000);
  history = [makeStamp()];
  await run("lapsed-stamp");
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        realSdk: true,
        realSignedProofs: true,
        transport: "synthetic responses",
        outcomes,
      },
      null,
      2,
    ),
  );
} finally {
  Date.now = oldNow;
  globalThis.fetch = oldFetch;
  undo();
}
process.exit(0);
