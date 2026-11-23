import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { didKeyFromEd25519PublicKey, toBase64Url } from "@tinycloud/share-envelope";

import { debugErrorChain } from "../lib/debugLog";
import { decodeHandoffFragment } from "./codec";
import { openHandoff, verifyHandoff } from "./readHandoff";

const vector = "#tch1000G40R40M30E209185GR38E1W8124GK2GAHC5RR34D1P70X3RFM2G9E8912WGT3";
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function pack(bytes: Uint8Array): string {
  let result = "#tch1";
  let bits = 0;
  let tail = 0;
  for (const byte of bytes) {
    tail = (tail << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(tail >> bits) & 31];
    }
  }
  if (bits > 0) result += alphabet[(tail << (5 - bits)) & 31];
  return result;
}

const seed = Uint8Array.from({ length: 32 }, (_, i) => i);
const signer = new Uint8Array(32).fill(87);
const encoder = new TextEncoder();
const publicKey = ed25519.getPublicKey(signer);
const issuer = didKeyFromEd25519PublicKey(publicKey);
const recipient = didKeyFromEd25519PublicKey(ed25519.getPublicKey(seed));
const parent = "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const space = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:applications";
const key = "xyz.tinycloud.one/handoff/v1/" + bytesToHex(sha256(encoder.encode(`${issuer}\n${parent}`))).slice(0, 32);
const resource = `${space}/kv/${key}`;
const machine = "Computer " + bytesToHex(sha256(encoder.encode(issuer))).slice(0, 6).toUpperCase();

function signedLink(overrides: Record<string, unknown> = {}, signingKey: Uint8Array = signer) {
  const payload = {
    iss: issuer, aud: recipient, exp: Math.floor(Date.now() / 1000) + 60,
    att: { [resource]: { "tinycloud.kv/get": [{}] } },
    prf: [parent],
    fct: [{ "xyz.tinycloud.policy/delegationMode": "terminal" }],
    ...overrides,
  };
  const header = { typ: "JWT", ucv: "0.10.0", alg: "EdDSA", jwk: { kty: "OKP", crv: "Ed25519", x: toBase64Url(publicKey) } };
  const input = [header, payload].map((part) => toBase64Url(encoder.encode(JSON.stringify(part)))).join(".");
  const compact = `${input}.${toBase64Url(ed25519.sign(encoder.encode(input), signingKey))}`;
  return pack(Uint8Array.of(...seed, ...encoder.encode(compact)));
}

const record = {
  version: 1, agent_name: "TinyCloud agent", machine_label: machine,
  connected_at: new Date().toISOString(),
  access_expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
  abilities: ["apps_data", "account_index"], app_ids: ["Alpha", "zeta"], apps_truncated: false,
};
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value));

describe("handoff fragment", () => {
  test("decodes the contract transport vector and preserves exact proof bytes", () => {
    const result = decodeHandoffFragment(vector);
    expect(result.seed).toEqual(seed);
    expect(result.authorization).toBe("AA.BB.CC");
  });

  test("rejects aliases, nonzero tail bits, extra symbols, padding and oversize", () => {
    const withTail = pack(Uint8Array.of(...seed, ...encoder.encode("AA.BB.CCC")));
    const changedTail = alphabet[alphabet.indexOf(withTail.at(-1)!) + 1];
    for (const input of [
      vector.toLowerCase(), vector.replace("G", "I"), vector.replace("0", "O"),
      withTail.slice(0, -1) + changedTail, vector + "0", vector + "=",
      vector.replace("G", "%47"), "#tch1" + "A".repeat(1800),
      pack(Uint8Array.of(...seed, 0xef, 0xbb, 0xbf, ...encoder.encode("AA.BB.CC"))),
    ]) expect(() => decodeHandoffFragment(input)).toThrow("Invalid handoff link");
  });

  test("the first inline script strips the fragment even for malformed links and never writes storage", () => {
    const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
    for (const hash of [vector, "#tch1!", "#other"]) {
      const state = {};
      const location = { pathname: "/handoff", search: "?from=chat", hash };
      const boot: { takeHandoffFragment?: () => string } = {};
      const sideEffects: string[] = [];
      const unexpected = () => { sideEffects.push("persistent storage"); };
      runInNewContext(script, {
        window: Object.assign(boot, {
          location, history: {
            state,
            replaceState: (current: unknown, title: string, target: string) => {
              expect(current === state).toBe(true);
              expect(title).toBe("");
              expect(target).toBe("/handoff?from=chat");
              location.hash = "";
            },
          },
        }),
        document: { documentElement: {
          classList: { toggle() {} }, setAttribute() {}, removeAttribute() {},
        } },
        localStorage: { getItem() { expect(location.hash).toBe(""); return null; }, setItem: unexpected },
        sessionStorage: { setItem: unexpected },
        indexedDB: { open: unexpected },
      });
      expect(location.hash).toBe("");
      if (hash.startsWith("#tch1")) expect(boot.takeHandoffFragment?.()).toBe(hash);
      expect(boot.takeHandoffFragment).toBeUndefined();
      expect(sideEffects).toEqual([]);
    }
  });
});

describe("opening a handoff", () => {
  test("validates the SDK wire format and projects exactly one record", async () => {
    const result = await openHandoff(signedLink(), async (link) => {
      expect(link.key).toBe(key);
      expect(link.session.spaceId).toBe(space);
      expect(link.session.verificationMethod).toBe(recipient);
      return bytes(record);
    });
    expect(result).toMatchObject({ machineLabel: machine, appIds: ["Alpha", "zeta"] });
    expect(Object.keys(result!)).not.toContain("session");
  });

  test("rejects an invalid signature, audience, time, proof, fact or scope prior to any read", async () => {
    const now = Math.floor(Date.now() / 1000);
    const read = () => { throw new Error("read was called"); };
    for (const fragment of [
      vector, undefined, signedLink({}, seed), signedLink({ aud: issuer }),
      signedLink({ exp: now }), signedLink({ exp: now + 86401 }), signedLink({ nbf: now + 1 }),
      signedLink({ prf: ["invalid-cid"] }), signedLink({ prf: [parent, parent] }), signedLink({ fct: [] }),
      signedLink({ att: { [resource + "/sibling"]: { "tinycloud.kv/get": [{}] } } }),
      signedLink({ att: { [resource]: { "tinycloud.kv/list": [{}] } } }),
      signedLink({ att: { [resource]: { "tinycloud.kv/get": [{}], "tinycloud.kv/put": [{}] } } }),
    ]) {
      let reads = 0;
      expect(await openHandoff(fragment, async () => { reads++; return read(); })).toBeNull();
      expect(reads).toBe(0);
    }
  });

  test("fails soft for unavailable records and rejects data beyond the record schema", async () => {
    const fragment = signedLink();
    for (const response of [
      null, new Uint8Array(4097), encoder.encode("{"),
      bytes({ ...record, machine_label: "Unknown computer" }),
      bytes({ ...record, abilities: ["account_index", "apps_data"] }),
      bytes({ ...record, app_ids: ["zeta", "Alpha"] }),
      bytes({ ...record, app_ids: ["xyz.tinycloud.account"] }),
      bytes({ ...record, apps_truncated: true }),
      bytes({ ...record, connected_at: "2024-02-30T00:00:00Z" }),
      bytes({ ...record, other: true }),
    ]) expect(await openHandoff(fragment, async () => response)).toBeNull();
    expect(await openHandoff(fragment, async () => { throw new TypeError("offline"); })).toBeNull();
  });

  test("drops SDK errors and scrubs full and short handoff fragments in diagnostics", async () => {
    const fragment = signedLink();
    const failure = new Error(`Offline at /handoff${fragment}`, { cause: new Error("Breadcrumb #tch1ABC") });
    expect(await openHandoff(fragment, async () => { throw failure; })).toBeNull();
    const chain = debugErrorChain(failure);
    expect(chain.map((entry) => entry.message)).toEqual(["Offline at /handoff<redacted handoff>", "Breadcrumb <redacted handoff>"]);
    expect(() => verifyHandoff("#tch1SECRET")).toThrow("Invalid handoff link");
  });
});

test("only a Feed handoff links to the setup card for its verified record", async () => {
  const handoffId = key.slice(key.lastIndexOf("/") + 1);
  const cardId = handoffId.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
  const fragment = signedLink();
  const feed = await openHandoff(fragment, async () => bytes({ ...record, abilities: [...record.abilities, "feed"] }));
  const apps = await openHandoff(fragment, async () => bytes(record));
  expect(feed?.setupChoicePath).toBe(`/chat/feed/${cardId}?setup=1`);
  expect(apps?.setupChoicePath).toBeNull();
});
