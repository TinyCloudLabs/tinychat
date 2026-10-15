import { describe, expect, it } from "bun:test";
import { createNonceStore } from "../auth.js";

const ADDR_A = "0x1111111111111111111111111111111111111111";
const ADDR_B = "0x2222222222222222222222222222222222222222";

describe("createNonceStore", () => {
  it("validates a bound nonce under its address, then not again (single-use)", () => {
    const store = createNonceStore();
    const nonce = store.generate(ADDR_A.toUpperCase());
    expect(store.validate(ADDR_A, nonce)).toBe(true);
    expect(store.validate(ADDR_A, nonce)).toBe(false);
  });

  it("rejects a bound nonce under a different address", () => {
    const store = createNonceStore();
    const nonce = store.generate(ADDR_A);
    expect(store.validate(ADDR_B, nonce)).toBe(false);
  });

  it("validates an unbound (address-less) nonce under the recovered signer", () => {
    const store = createNonceStore();
    const nonce = store.generate();
    // Whatever address the SIWE recovered may claim the unbound nonce once.
    expect(store.validate(ADDR_A, nonce)).toBe(true);
    expect(store.validate(ADDR_A, nonce)).toBe(false);
  });

  it("lets only the first validation win an unbound nonce", () => {
    const store = createNonceStore();
    const nonce = store.generate();
    expect(store.validate(ADDR_B, nonce)).toBe(true);
    expect(store.validate(ADDR_A, nonce)).toBe(false);
  });

  it("never returns a nonce issued for nobody or for another address", () => {
    const store = createNonceStore();
    expect(store.validate(ADDR_A, "deadbeef")).toBe(false);
    const other = store.generate(ADDR_B);
    expect(store.validate(ADDR_A, other)).toBe(false);
  });

  it("rejects nonces older than the 5-minute TTL", () => {
    const store = createNonceStore();
    const bound = store.generate(ADDR_A);
    const unbound = store.generate();
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 6 * 60 * 1000;
      expect(store.validate(ADDR_A, bound)).toBe(false);
      expect(store.validate(ADDR_A, unbound)).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });
  it("rejects issuance when live outstanding nonces reach capacity without evicting them", () => {
    const store = createNonceStore();
    const issued = Array.from({ length: 2048 }, () => store.generate(ADDR_A));
    expect(() => store.generate(ADDR_A)).toThrow("Nonce store full");
    expect(store.validate(ADDR_A, issued[0])).toBe(true);
    expect(store.validate(ADDR_A, issued[0])).toBe(false);
    expect(store.generate(ADDR_A)).toMatch(/^[0-9a-f]{64}$/);
    expect(store.validate(ADDR_A, issued.at(-1)!)).toBe(true);
  });

  it("reclaims expired nonces when issuing after capacity is reached", () => {
    const store = createNonceStore();
    const first = store.generate(ADDR_A);
    for (let i = 1; i < 2048; i++) store.generate(ADDR_A);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 5 * 60 * 1000 + 1;
      expect(store.generate(ADDR_A)).toMatch(/^[0-9a-f]{64}$/);
      expect(store.validate(ADDR_A, first)).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });
});
