import { afterEach, expect, spyOn, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { courierIdentity } from "../courier/identity";

let fetchSpy: { mockRestore(): void } | undefined;
afterEach(() => fetchSpy?.mockRestore());

test("Courier identity is deterministic per lowercase owner and accepted by the SDK key manager", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => Response.json({ key: "42".repeat(32) })) as unknown as typeof fetch);
  const owner = `did:pkh:eip155:1:0x${"ab".repeat(20)}`;
  const a = await courierIdentity(owner);
  const b = await courierIdentity(owner.toUpperCase());
  const other = await courierIdentity(`did:pkh:eip155:1:0x${"cd".repeat(20)}`);
  expect(a.did).toBe(b.did);
  expect(a.did).not.toBe(other.did);
  expect(a.did).toMatch(/^did:key:z/);
  expect(a.publicJwk).toEqual(b.publicJwk);
  expect(a.publicJwk).not.toHaveProperty("d");
  const message = new TextEncoder().encode("courier identity proof");
  const signature = await a.signer.sign(message);
  const publicKey = createPublicKey({ key: a.publicJwk, format: "jwk" });
  expect(publicKey.asymmetricKeyType).toBe("ed25519");
  expect(verify(null, message, publicKey, signature)).toBe(true);
});

test("Courier identity refuses unavailable dstack instead of generating a key", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
  await expect(courierIdentity(`did:pkh:eip155:1:0x${"11".repeat(20)}`)).rejects.toThrow();
});
