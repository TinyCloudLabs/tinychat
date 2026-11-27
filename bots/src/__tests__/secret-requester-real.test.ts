// Unmocked check of the stable requester against the real share-envelope (needs 1.7.0 or later installed).
// Only fetch is stubbed. To use: copy to bots/src/__tests__/ once the library is published and the dependency is bumped.
import { expect, test } from "bun:test";
import * as links from "@tinycloud/share-envelope/links";
import { type ApprovalLinks, type ApprovalRequest, SecretGrants } from "../secret-grants";

const ORIGINS = { node: "https://node.example", linksApi: "https://links.example", openkey: "https://openkey.so", openkeyApi: "https://api.openkey.example" };
const OWNER = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
const ASK = { name: "OPENAI_API_KEY", sites: ["api.openai.com"], header: "authorization", why: "To transcribe a call.", ownerDid: OWNER };
const BOT = "b".repeat(64);
const ID1 = "9c41e0d2a7b3f6c18e5d2a90";
const ID2 = "0d2a7b3f6c18e5d2a909c41e";
const reader = { read: async () => "missing" as const, forget: () => undefined };
const store = () => ({ load: () => [], save: () => undefined, remove: () => undefined });
const stable = links.signerFromSeed(new Uint8Array(32).fill(7));

/** The real library; its network call answers 201 for the record it was given. */
function realLinks() {
  const sent: Array<{ request: ApprovalRequest; signer: string; header: string }> = [];
  let made = 0;
  const fetch = (async (_url: string, init: { body: string }) => {
    const record = JSON.parse(init.body) as { header: { issuer: string; expiresAt: string } };
    sent[sent.length - 1]!.header = record.header.issuer;
    const id = `${"abcdefghijklmnopqrstuvwxyz".slice(0, 25)}${"ab"[made++ % 2]}`;
    return new Response(JSON.stringify({ id, expiresAt: record.header.expiresAt }), { status: 201, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  const wrapped = {
    ...links,
    createApprovalRequest: (input: Parameters<typeof links.createApprovalRequest>[0]) => {
      sent.push({ request: structuredClone(input.request) as ApprovalRequest, signer: input.issuerKey.did, header: "" });
      return links.createApprovalRequest({ ...input, fetch });
    },
  } as unknown as ApprovalLinks;
  return { wrapped, sent };
}

test("a request signed by the stable requester is accepted by the real library and its parser", async () => {
  const { wrapped, sent } = realLinks();
  const grants = new SecretGrants({ store: store(), reader, links: wrapped, origins: ORIGINS, requester: () => stable });
  expect(await grants.ask(BOT, ID1, ASK)).toHaveProperty("approveUrl");
  await grants.ask(BOT, ID2, ASK);
  const [first, second] = sent;
  expect(first!.header).toBe(stable.did);
  expect(first!.signer).toBe(stable.did);
  expect(first!.request.issuer).toBe(stable.did);
  expect(first!.request.requesterDid).toBe(stable.did);
  expect(first!.request.targetDid).not.toBe(stable.did);
  expect(second!.request.targetDid).not.toBe(first!.request.targetDid);
  expect(links.parseApprovalRequest(first!.request, { issuer: stable.did }).requesterDid).toBe(stable.did);
});

test("the default requester sends no requesterDid and parses as it did", async () => {
  const { wrapped, sent } = realLinks();
  const grants = new SecretGrants({ store: store(), reader, links: wrapped, origins: ORIGINS });
  expect(await grants.ask(BOT, ID1, ASK)).toHaveProperty("approveUrl");
  const { request } = sent[0]!;
  expect("requesterDid" in request).toBe(false);
  expect(request.issuer).toBe(request.targetDid);
  expect(links.parseApprovalRequest(request, { issuer: request.targetDid }).targetDid).toBe(request.targetDid);
});

test("the real parser refuses a body whose issuer is not the signer, and requesterDid equal to the audience", async () => {
  const { wrapped, sent } = realLinks();
  await new SecretGrants({ store: store(), reader, links: wrapped, origins: ORIGINS, requester: () => stable }).ask(BOT, ID1, ASK);
  const { request } = sent[0]!;
  const other = links.signerFromSeed(new Uint8Array(32).fill(9)).did;
  for (const [body, issuer] of [[{ ...request, issuer: other }, other], [request, other], [{ ...request, issuer: other }, stable.did], [{ ...request, requesterDid: request.targetDid, issuer: request.targetDid }, request.targetDid]] as const) {
    expect(() => links.parseApprovalRequest(body, { issuer })).toThrow();
  }
});
