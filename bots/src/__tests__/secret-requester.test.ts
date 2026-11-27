import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LinkSigner } from "@tinycloud/share-envelope/links";
import * as realLinks from "@tinycloud/share-envelope/links";
import type { Server } from "bun";
import { APPROVAL_REQUESTER_PATH, approvalRequesterSeedFromDstack, SEAL_KEY_PATH, sealKeyFromDstack } from "../dstack-key";
import { type ApprovalLinks, type ApprovalRequest, SecretGrants } from "../secret-grants";
import { secretRoute } from "../secret-routes";
import { startSecretGrants } from "../secret-start";
import type { GrantStore } from "../secret-store";

// Fake keys only.
const ORIGINS = { node: "https://node.example", linksApi: "https://links.example", openkey: "https://openkey.so", openkeyApi: "https://api.openkey.example" };
const OWNER = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
const ASK = { name: "OPENAI_API_KEY", sites: ["api.openai.com"], header: "authorization", why: "To transcribe a call.", ownerDid: OWNER };
const BOT = "b".repeat(64);
const ID1 = "9c41e0d2a7b3f6c18e5d2a90";
const ID2 = "0d2a7b3f6c18e5d2a909c41e";
const reader = { read: async () => "missing" as const, forget: () => undefined };

/** Links API played from a script: it keeps each request body and the key that signed the link. */
function fakeLinks() {
  const requests: ApprovalRequest[] = [];
  const signers: LinkSigner[] = [];
  const links = {
    generateRelayKey: realLinks.generateRelayKey,
    signerFromJwk: realLinks.signerFromJwk,
    isApprovalClientError: realLinks.isApprovalClientError,
    createApprovalRequest: async (input: { request: ApprovalRequest; issuerKey: LinkSigner; expiresAt: Date }) => {
      requests.push(input.request);
      signers.push(input.issuerKey);
      return { link: `https://openkey.so/a/req${requests.length}#k`, id: `req${requests.length}`, bodyCid: "bafy", expiresAt: input.expiresAt.toISOString(), record: { header: "h", signature: "s" } };
    },
  };
  return { links: links as unknown as ApprovalLinks, requests, signers };
}

const memoryStore = (): GrantStore => {
  const files = new Map<string, { botId: string; record: unknown }>();
  return { load: () => [], save: (id, botId, record) => void files.set(id, { botId, record }), remove: id => void files.delete(id) };
};

const seed = (byte: number) => new Uint8Array(32).fill(byte);
const stable = (byte: number) => realLinks.signerFromSeed(seed(byte));

describe("who signs the request", () => {
  test("a stable requester signs every request while the grant's audience is a fresh key each time", async () => {
    const { links, requests, signers } = fakeLinks();
    const requester = stable(7);
    const grants = new SecretGrants({ store: memoryStore(), reader, links, origins: ORIGINS, requester: () => requester });
    expect(await grants.ask(BOT, ID1, ASK)).toMatchObject({ approveUrl: "https://openkey.so/a/req1#k" });
    expect(await grants.ask(BOT, ID2, ASK)).toMatchObject({ approveUrl: "https://openkey.so/a/req2#k" });
    expect(requests.map(request => request.issuer)).toEqual([requester.did, requester.did]);
    expect(requests.map(request => request.requesterDid)).toEqual([requester.did, requester.did]);
    expect(signers).toEqual([requester, requester]);
    expect(requests[0]!.targetDid).not.toBe(requests[1]!.targetDid);
    for (const request of requests) {
      expect(request.targetDid).not.toBe(requester.did);
      expect(request.targetDid).toMatch(/^did:key:z6Mk/);
    }
  });

  test("without an injected requester the request is the one it was: the grant's own key signs and requesterDid is absent", async () => {
    const { links, requests } = fakeLinks();
    const grants = new SecretGrants({ store: memoryStore(), reader, links, origins: ORIGINS });
    await grants.ask(BOT, ID1, ASK);
    const request = requests[0]!;
    expect(request.issuer).toBe(request.targetDid);
    expect("requesterDid" in request).toBe(false);
  });

  test("a requester that is the grant's own key leaves requesterDid out", async () => {
    const { links, requests } = fakeLinks();
    const grants = new SecretGrants({ store: memoryStore(), reader, links, origins: ORIGINS, requester: target => target });
    await grants.ask(BOT, ID1, ASK);
    expect("requesterDid" in requests[0]!).toBe(false);
  });
});

let server: Server<undefined> | undefined;
let dir: string | undefined;
let seen: Array<{ path: string; purpose: string }>;
let logs: string[];
let errors: string[];
let logSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  seen = [];
  logs = [];
  errors = [];
  logSpy = spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
  errorSpy = spyOn(console, "error").mockImplementation((line: string) => void errors.push(line));
});
afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  server?.stop(true);
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A key service that answers the paths it is given, with the same hex for any path unless `keys` says otherwise. */
function dstack(keys: Record<string, string | "fail">): string {
  dir = mkdtempSync(join(tmpdir(), "dstack-"));
  const socket = join(dir, "dstack.sock");
  server = Bun.serve({
    unix: socket,
    fetch: async req => {
      const body = (await req.json()) as { path: string; purpose: string };
      seen.push(body);
      const key = keys[body.path];
      if (!key || key === "fail") return new Response("no", { status: 500 });
      return Response.json({ key, signature_chain: [] });
    },
  });
  return socket;
}

const SAME = "ab".repeat(32);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("the requester key from the key service", () => {
  test("the seed is deterministic, comes from its own path and is not the sealing key or the raw key", async () => {
    const socket = dstack({ [SEAL_KEY_PATH]: SAME, [APPROVAL_REQUESTER_PATH]: SAME });
    const first = await approvalRequesterSeedFromDstack(socket);
    expect(first.length).toBe(32);
    expect(await approvalRequesterSeedFromDstack(socket)).toEqual(first);
    expect(seen[0]).toEqual({ path: "tinychat-bots/approval-requester", purpose: "approval-requester" });
    // One answer for both paths gives two unrelated values: the info strings differ.
    expect(hex(first)).not.toBe(hex(await sealKeyFromDstack(socket)));
    expect(hex(first)).not.toBe(SAME);
    // The same DID every time, and another dstack key gives another one.
    expect(realLinks.signerFromSeed(first).did).toBe(realLinks.signerFromSeed(await approvalRequesterSeedFromDstack(socket)).did);
    const other = dstack({ [APPROVAL_REQUESTER_PATH]: "cd".repeat(32) });
    expect(realLinks.signerFromSeed(await approvalRequesterSeedFromDstack(other)).did).not.toBe(realLinks.signerFromSeed(first).did);
  });

  test("a failing or empty answer is an error, never a made-up seed", async () => {
    await expect(approvalRequesterSeedFromDstack(dstack({ [APPROVAL_REQUESTER_PATH]: "fail" }))).rejects.toThrow("HTTP 500");
    server?.stop(true);
    server = Bun.serve({ unix: join(dir!, "empty.sock"), fetch: () => Response.json({}) });
    await expect(approvalRequesterSeedFromDstack(join(dir!, "empty.sock"))).rejects.toThrow("no key");
  });
});

describe("opening the secret grants at start-up", () => {
  const open = (socket: string) => startSecretGrants({ grantsDir: join(dir!, "grants"), origins: ORIGINS, reader, socket });
  const put = async (grants: SecretGrants | undefined) =>
    secretRoute(new Request("http://x", { method: "PUT", body: JSON.stringify({}) }), BOT, ID1, grants, () => OWNER);

  test("with both keys it opens, logs the requester's DID once and never the seed", async () => {
    const socket = dstack({ [SEAL_KEY_PATH]: "11".repeat(32), [APPROVAL_REQUESTER_PATH]: "22".repeat(32) });
    const grants = await open(socket);
    expect(grants).toBeDefined();
    const expected = realLinks.signerFromSeed(await approvalRequesterSeedFromDstack(socket)).did;
    expect(logs.map(line => JSON.parse(line))).toEqual([{ gateway: "approval_requester", did: expected }, { gateway: "secrets_ready" }]);
    expect(logs.join("") + errors.join("")).not.toContain(hex(await approvalRequesterSeedFromDstack(socket)));
  });

  test("without the requester key the secrets are refused with the plain unavailable answer and nothing is made", async () => {
    const socket = dstack({ [SEAL_KEY_PATH]: "11".repeat(32), [APPROVAL_REQUESTER_PATH]: "fail" });
    const grants = await open(socket);
    expect(grants).toBeUndefined();
    expect(JSON.parse(errors[0]!)).toEqual({ gateway: "secrets_unavailable", reason: "dstack GetKey answered HTTP 500" });
    expect(logs.some(line => line.includes("secrets_ready"))).toBe(false);
    // The routes answer 503 for every request, as without the sealing key.
    expect((await put(grants)).status).toBe(503);
  });

  test("without the sealing key it is refused too, and the requester path alone does not open it", async () => {
    const grants = await open(dstack({ [SEAL_KEY_PATH]: "fail", [APPROVAL_REQUESTER_PATH]: "22".repeat(32) }));
    expect(grants).toBeUndefined();
    expect((await put(grants)).status).toBe(503);
  });

  test("a key service that is not there is a logged refusal, not a crash", async () => {
    dir = mkdtempSync(join(tmpdir(), "dstack-"));
    expect(await open(join(dir, "missing.sock"))).toBeUndefined();
    expect(JSON.parse(errors[0]!).gateway).toBe("secrets_unavailable");
  });
});
