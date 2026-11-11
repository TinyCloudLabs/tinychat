import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalHashHex } from "@tinycloud/sdk-core";
import { sha256 } from "@noble/hashes/sha256";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { canonicalShareFilename, type AddressedSharePublishOptions, type PublishedShare } from "@tinycloud/share-sdk";
import type { OpenKeyError } from "@openkey/sdk";
import { debugErrorChain } from "./debugLog";
import {
  rawWrappedKeyDigest, transcriptShareSnapshot, prepareTranscriptShare, publishTranscriptShare,
  transcriptShareUnavailable, validateTranscriptShareOrigins,
} from "./exoTranscriptShare";

test("the registered wrapped-key digest matches Node's decoded-byte SHA-256, not the envelope string hash", () => {
  const wrapped = "AQIDBA==";
  const expectedByNode = createHash("sha256").update(Uint8Array.of(1, 2, 3, 4)).digest("hex");
  expect(rawWrappedKeyDigest(wrapped)).toBe(expectedByNode);
  expect(rawWrappedKeyDigest(wrapped)).toBe("9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a");
  expect(rawWrappedKeyDigest(wrapped)).not.toBe(canonicalHashHex(sha256, wrapped));
});

test("noncanonical or empty wrapped keys cannot become registered source digests", () => {
  for (const wrapped of ["", "AQIDBA", "AQIDBA===", "AQIDBA==\n", "AQIDBB==", "____", "not base64"]) {
    expect(() => rawWrappedKeyDigest(wrapped)).toThrow("Wrapped-key base64 is not canonical.");
  }
});

test("wrapped-key digests preserve arbitrary binary bytes, not a text decoding", () => {
  const wrapped = "/wCAfg==";
  const expectedByNode = createHash("sha256").update(Uint8Array.of(255, 0, 128, 126)).digest("hex");
  expect(rawWrappedKeyDigest(wrapped)).toBe(expectedByNode);
});

const SHARE_ID = "21920000-0000-4000-8000-000000000001";
const SPACE = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:applications";
const NETWORK = "urn:tinycloud:encryption:did:pkh:eip155:1:0x0000000000000000000000000000000000000001:default";
const HOLDER = "did:key:z6MktestOwnerSession";
const NOW = Date.parse("2026-10-28T12:00:00Z");
const NOTE = { id: "meeting-1", source: "fireflies", sourceId: "synthetic-1", title: "Synthetic transcript", startedAt: null, durationSecs: null };
const METADATA = { status: "ok" as const, metadata: {} };
const TRANSCRIPT = { status: "ok" as const, sentences: [{ index: 0, text: "Synthetic text <not HTML>.", speaker_name: "Speaker", start_time: 0, end_time: 0 }] };
const ORIGINS = { apiOrigin: "http://127.0.0.1:3001", shareOrigin: "http://127.0.0.1:3002", localOnly: true };

function fixture(title = NOTE.title) {
  const effects: string[] = [];
  const stored = new Map<string, Uint8Array>();
  const encryptedInputs: string[] = [];
  let holder = HOLDER;
  const envelope = {
    v: 2, networkId: NETWORK, keyPath: `share/${SHARE_ID}`, alg: "X25519-HKDF-SHA256-AES-256-GCM", keyVersion: 3,
    encryptedSymmetricKey: "AQIDBA==", encryptedSymmetricKeyHash: canonicalHashHex(sha256, "AQIDBA=="),
    ciphertext: Buffer.alloc(28, 1).toString("base64"), aad: "AA==",
    metadata: { contentType: "text/plain;charset=utf-8" },
  };
  const client = {
    session: () => ({ address: "0x0000000000000000000000000000000000000001", walletAddress: "0x0000000000000000000000000000000000000001", chainId: 1 }),
    spaceId: SPACE,
    hosts: ["http://127.0.0.1:3003"],
    get sessionDid() { return holder; },
    get credentialHolderDid() { return holder; },
    credentialSpaceOwnerDid: () => "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
    sessionRestoreStatus: "idle", isSessionOnly: false, isWalletConnected: true,
    hasPermissions: () => true,
    getEncryptionNetwork: async () => ({ networkId: NETWORK, ownerDid: NETWORK.slice(25, -8), state: "active" }),
    activeNodeIdentity: async () => ({ origin: "http://127.0.0.1:3003", nodeDid: "did:key:z6MktestNode" }),
    requestPermissions: async (_entries: unknown, _options: unknown) => { effects.push("consent"); return { approved: true }; },
    keys: {
      getPublicKey: async () => { effects.push("public-key"); return { networkId: NETWORK, keyPath: `share/${SHARE_ID}`, keyVersion: 3 }; },
      createKey: async () => { effects.push("key.create"); return { networkId: NETWORK, keyPath: `share/${SHARE_ID}`, keyVersion: 3, state: "active" }; },
      encrypt: async (_path: string, bytes: Uint8Array) => { effects.push("encrypt"); encryptedInputs.push(new TextDecoder().decode(bytes)); return envelope; },
    },
    kv: {
      put: async (path: string, bytes: Uint8Array, options: { ifNoneMatch?: string }) => {
        effects.push("put");
        if (stored.has(path) || options.ifNoneMatch !== "*") throw new Error("immutable write violated");
        stored.set(path, bytes.slice());
        return { ok: true };
      },
    },
    createUnifiedOwnerRoot: async () => { effects.push("root"); throw new Error("No SDK authority operation belongs in this offline fixture"); },
    signSessionBytes: async () => { effects.push("sign"); throw new Error("No signing belongs in this offline fixture"); },
    registerPolicy: async () => { effects.push("register"); throw new Error("No Node call belongs in this offline fixture"); },
  };
  const tcw = client as unknown as TinyCloudWeb;
  const snapshot = transcriptShareSnapshot({ ...NOTE, title }, METADATA, TRANSCRIPT)!;
  const review = prepareTranscriptShare(tcw, snapshot, "alice@example.test", NOW, SHARE_ID);
  let publishedInput: AddressedSharePublishOptions | undefined;
  const operations = {
    assertFits: async () => {},
    publish: async (input: AddressedSharePublishOptions): Promise<PublishedShare> => {
      effects.push("publish"); publishedInput = input;
      const result = {
        protocol: "tinycloud-share" as const, version: 1 as const,
        link: { kind: "policy" as const, cid: "synthetic-envelope" },
        metadata: {
          protocol: "tinycloud-share" as const, version: 1 as const, shareId: input.shareId, origin: ORIGINS.shareOrigin,
          target: { kind: "email" as const, origin: "http://127.0.0.1:3003", nodeAudience: "did:key:z6MktestNode", spaceId: SPACE },
          resource: input.resource, actions: input.policyActions, expiresAt: input.expiresAt.toISOString(),
          display: { filename: input.filename }, recipientMatcher: { kind: "exactEmail" as const, value: "alice@example.test" },
          ownerDid: HOLDER, ownerDelegationCid: "owner-root", enforcementDelegationCid: "enforcement-root", policyCid: "policy",
        },
      };
      Object.defineProperty(result, "url", { value: `${ORIGINS.shareOrigin}/s/full#synthetic-private-fragment` });
      Object.defineProperty(result, "deliveryMaterial", { value: { envelope: {}, shareCid: "synthetic-envelope", sealedEnvelope: "private", envelopeKey: "private" } });
      return result as PublishedShare;
    },
  };
  const input = { tcw, review, origins: ORIGINS, isCurrent: () => true, readPersisted: async () => snapshot, now: () => NOW };
  return { client, tcw, input, review, snapshot, effects, stored, envelope, operations, encryptedInputs,
    publishedInput: () => publishedInput, changeAccount: () => { holder = "did:key:z6MkAnotherSession"; } };
}

test("only a supported persisted transcript is eligible, never a device-only or failed read", () => {
  expect(transcriptShareSnapshot(NOTE, METADATA, TRANSCRIPT)?.text).toBe("Speaker: Synthetic text <not HTML>.");
  for (const item of [{ ...NOTE, onPhone: true as const }, { ...NOTE, saving: true as const }, { ...NOTE, source: "foreign-app" }]) {
    expect(transcriptShareSnapshot(item, METADATA, TRANSCRIPT)).toBeNull();
  }
  expect(transcriptShareSnapshot(NOTE, METADATA, { status: "failed" })).toBeNull();
  expect(transcriptShareSnapshot(NOTE, { status: "failed" }, TRANSCRIPT)).toBeNull();
  expect(transcriptShareSnapshot(NOTE, { status: "ok", metadata: { transcription_outcome: "no_speech" } }, TRANSCRIPT)).toBeNull();
});

test("review fixes the exact mailbox, source text, scope and expiry before any effect", () => {
  const f = fixture();
  expect(f.review.recipient).toBe("alice@example.test");
  expect(f.review.snapshot).toEqual(f.snapshot);
  expect(f.review.snapshot.text).toBe("Speaker: Synthetic text <not HTML>.");
  expect(f.review.expiresAt).toBeGreaterThan(NOW);
  expect(f.effects).toEqual([]);
  for (const email of ["", "@example.test", "alice@example.test,bob@example.test", "alice@*.test"]) {
    expect(() => prepareTranscriptShare(f.tcw, f.snapshot, email, NOW, SHARE_ID)).toThrow();
  }
});

test("denial and unsupported named keys produce no mutation or publication", async () => {
  const declined = fixture();
  declined.client.requestPermissions = async () => { declined.effects.push("consent"); return { approved: false }; };
  expect(await publishTranscriptShare(declined.input, declined.operations)).toEqual({ status: "declined" });
  expect(declined.effects).toEqual(["public-key", "consent"]);
  const unsupported = fixture();
  unsupported.client.keys.getPublicKey = async () => { throw Object.assign(new Error("unsupported"), { code: "NAMED_KEYS_UNSUPPORTED" }); };
  await expect(publishTranscriptShare(unsupported.input, unsupported.operations)).rejects.toThrow("NAMED_KEYS_UNSUPPORTED");
  expect(unsupported.effects).toEqual([]);
});

test("consent cancellation cannot hide an account change or retired source", async () => {
  for (const transition of ["account", "source"] as const) {
    const f = fixture();
    let current = true;
    f.client.requestPermissions = async () => {
      f.effects.push("consent");
      if (transition === "account") f.changeAccount();
      else current = false;
      throw { code: "USER_CANCELLED", message: "User cancelled the request" } satisfies OpenKeyError;
    };
    await expect(publishTranscriptShare({ ...f.input, isCurrent: () => current }, f.operations)).rejects.toThrow("changed");
    expect(f.effects).toEqual(["public-key", "consent"]);
    expect(f.stored.size).toBe(0);
  }
});

test("only USER_CANCELLED at exact-key consent is a clean decline", async () => {
  const cancellation: OpenKeyError = { code: "USER_CANCELLED", message: "User cancelled the request" };
  const key = fixture();
  key.client.keys.createKey = async () => { throw cancellation; };
  await expect(publishTranscriptShare(key.input, key.operations)).rejects.toThrow("creating the exact named-key (USER_CANCELLED)");
  expect(key.stored.size).toBe(0);
  const policy = fixture();
  policy.operations.publish = async () => { throw cancellation; };
  await expect(publishTranscriptShare(policy.input, policy.operations)).rejects.toThrow("publishing the exact-recipient policy (USER_CANCELLED)");
  const timeout = fixture();
  timeout.client.requestPermissions = async () => { throw { code: "TIMEOUT", message: "Request timed out" } satisfies OpenKeyError; };
  await expect(publishTranscriptShare(timeout.input, timeout.operations)).rejects.toThrow("requesting exact-key consent (TIMEOUT)");
  expect(timeout.effects).toEqual(["public-key"]);
  expect(timeout.stored.size).toBe(0);
});

test("consent contains only this owner's exact share key and a bounded expiry", async () => {
  const f = fixture();
  let requested: unknown;
  f.client.requestPermissions = async (entries, options) => { requested = { entries, options }; return { approved: false }; };
  await publishTranscriptShare(f.input, f.operations);
  expect(requested).toEqual({ entries: [{ service: "tinycloud.encryption", path: `${NETWORK}/share/${SHARE_ID}`, actions: ["tinycloud.encryption/key.create"] }],
    options: { expiryMs: f.review.expiresAt - NOW } });
});

test("account change during consent, stale source, missing existing capability and key collision fail closed", async () => {
  const changed = fixture();
  changed.client.requestPermissions = async () => { changed.changeAccount(); return { approved: true }; };
  await expect(publishTranscriptShare(changed.input, changed.operations)).rejects.toThrow("account");
  expect(changed.effects).not.toContain("key.create");
  const stale = fixture();
  await expect(publishTranscriptShare({ ...stale.input, readPersisted: async () => ({ ...stale.snapshot, text: "Changed body" }) }, stale.operations)).rejects.toThrow("transcript changed");
  expect(stale.effects).toEqual([]);
  const missing = fixture();
  missing.client.hasPermissions = () => false;
  expect(transcriptShareUnavailable(missing.tcw)).toContain("existing");
  await expect(publishTranscriptShare(missing.input, missing.operations)).rejects.toThrow("existing");
  expect(missing.effects).toEqual([]);
  const collision = fixture();
  collision.client.keys.createKey = async () => { throw Object.assign(new Error("exists"), { code: "KEY_EXISTS" }); };
  await expect(publishTranscriptShare(collision.input, collision.operations)).rejects.toThrow("KEY_EXISTS");
  expect(collision.effects).not.toContain("encrypt");
  expect(collision.stored.size).toBe(0);
});

test("a persisted alias-map change is rejected even when transcript text and raw body are unchanged", async () => {
  const f = fixture();
  const before = transcriptShareSnapshot(NOTE, { status: "ok", metadata: { speaker_names: { Unused: "Before" } } }, TRANSCRIPT)!;
  const after = transcriptShareSnapshot(NOTE, { status: "ok", metadata: { speaker_names: { Unused: "After" } } }, TRANSCRIPT)!;
  expect(before.text).toBe(after.text);
  expect(before.rawText).toBe(after.rawText);
  const review = prepareTranscriptShare(f.tcw, before, "alice@example.test", NOW, SHARE_ID);
  await expect(publishTranscriptShare({ ...f.input, review, readPersisted: async () => after }, f.operations))
    .rejects.toThrow("The persisted transcript changed. Review it again.");
  expect(f.effects).toEqual([]);
});

test("offline controller binds the entire immutable v2 byte object and saves explicit non-enumerable owner receipts", async () => {
  const f = fixture();
  const outcome = await publishTranscriptShare(f.input, f.operations);
  expect(outcome.status).toBe("published");
  const input = f.publishedInput()!;
  expect(input.target).toEqual({ kind: "email", address: "alice@example.test" });
  expect(input.actions).toEqual(["read"]);
  expect(input.policyActions).toEqual(["tinycloud.kv/get"]);
  expect(input.deliveryEmail).toBeUndefined();
  expect(input.credentialRequirement?.profile.id).toBe("tinycloud.email-proof/v1");
  expect(input.contentSource).toMatchObject({ encryptionNetwork: NETWORK, encryptionKeyPath: `share/${SHARE_ID}`, keyVersion: 3,
    selector: "exact", mode: "immutable", encryptedSymmetricKeyDigestHex: rawWrappedKeyDigest(f.envelope.encryptedSymmetricKey) });
  const body = f.stored.get(input.resource.path)!;
  expect(input.contentSource.initialCiphertextDigestHex).toBe(createHash("sha256").update(body).digest("hex"));
  expect(input.contentSource.kvResource).toBe(`${SPACE}/kv/${input.resource.path}`);
  expect(JSON.parse(new TextDecoder().decode(body))).toEqual(f.envelope);
  expect(input.resource.path).toBe(`xyz.tinycloud.tinychat/connectors/share-snapshots/${SHARE_ID}/transcript.txt.enc.json`);
  expect(f.effects).toEqual(["public-key", "consent", "key.create", "encrypt", "put", "publish", "encrypt", "put"]);
  expect(f.stored.size).toBe(2);
  const ownerRecord = JSON.parse(f.encryptedInputs[1]!);
  expect(ownerRecord.ownerDelegationCid).toBe("owner-root");
  expect(ownerRecord.enforcementDelegationCid).toBe("enforcement-root");
  expect(ownerRecord.link).toBe(`${ORIGINS.shareOrigin}/s/full#synthetic-private-fragment`);
  expect(ownerRecord.deliveryMaterial.envelopeKey).toBe("private");
});

test("a root-key envelope, wrong named path or key version cannot be registered", async () => {
  for (const mutation of [{ v: 1 }, { keyPath: "share/another-share" }, { keyVersion: 2 }, { networkId: `${NETWORK}wrong` }]) {
    const f = fixture();
    Object.assign(f.envelope, mutation);
    await expect(publishTranscriptShare(f.input, f.operations)).rejects.toThrow("named-key");
    expect(f.stored.size).toBe(0);
    expect(f.effects).not.toContain("publish");
  }
});

test("loopback local mode refuses production service origins before any SDK operation", () => {
  expect(validateTranscriptShareOrigins(ORIGINS, "http://127.0.0.1:3003")).toEqual(ORIGINS);
  for (const origins of [{ ...ORIGINS, apiOrigin: "https://api.tinycloud.xyz" }, { ...ORIGINS, shareOrigin: "https://share.tinycloud.xyz" }]) {
    expect(() => validateTranscriptShareOrigins(origins, "http://127.0.0.1:3003")).toThrow("loopback");
  }
  expect(() => validateTranscriptShareOrigins(ORIGINS, "https://node.tinycloud.xyz")).toThrow("loopback");
});

test("shared word fixes match the transcript surface without rewriting speaker names", () => {
  const snapshot = transcriptShareSnapshot(NOTE, METADATA, TRANSCRIPT, (text) => text.replaceAll("Speaker", "Changed speaker").replaceAll("Synthetic", "Corrected"));
  expect(snapshot?.rawText).toBe("Speaker: Synthetic text <not HTML>.");
  expect(snapshot?.text).toBe("Speaker: Corrected text <not HTML>.");
});

test("shared aliases match Copy projection and word fixes without rewriting stored sentences", () => {
  const metadata = { status: "ok" as const, metadata: { speaker_names: { Speaker: " Alice " } } };
  const snapshot = transcriptShareSnapshot(NOTE, metadata, TRANSCRIPT,
    (text) => text.replaceAll("Alice", "Wrong label").replaceAll("Synthetic", "Corrected"))!;
  expect(snapshot.text).toBe("Alice: Corrected text <not HTML>.");
  expect(snapshot.rawText).toBe("Speaker: Synthetic text <not HTML>.");
  expect(TRANSCRIPT.sentences[0]!.speaker_name).toBe("Speaker");
});

test("missing existing network, unsupported consent and snapshot write failure never publish", async () => {
  const missing = fixture();
  Object.defineProperty(missing.client, "getEncryptionNetwork", { value: async () => null });
  await expect(publishTranscriptShare(missing.input, missing.operations)).rejects.toThrow("missing or inactive");
  expect(missing.effects).toEqual([]);
  const unsupported = fixture();
  unsupported.client.requestPermissions = async () => { throw Object.assign(new Error("unsupported native"), { code: "RUNTIME_PERMISSION_UNSUPPORTED" }); };
  await expect(publishTranscriptShare(unsupported.input, unsupported.operations)).rejects.toThrow("RUNTIME_PERMISSION_UNSUPPORTED");
  expect(unsupported.effects).toEqual(["public-key"]);
  const refused = fixture();
  refused.client.kv.put = async () => ({ ok: false });
  await expect(publishTranscriptShare(refused.input, refused.operations)).rejects.toThrow("write was refused");
  expect(refused.effects).not.toContain("publish");
});

test("closed or expired review cannot start effects; raw SDK error bodies never reach the user", async () => {
  const closed = fixture();
  await expect(publishTranscriptShare({ ...closed.input, isCurrent: () => false }, closed.operations)).rejects.toThrow("changed");
  expect(closed.effects).toEqual([]);
  const expired = fixture();
  await expect(publishTranscriptShare({ ...expired.input, now: () => expired.review.expiresAt }, expired.operations)).rejects.toThrow("expired");
  expect(expired.effects).toEqual([]);
  const failed = fixture();
  failed.client.keys.createKey = async () => { throw new Error("PRIVATE_SIGNED_URL_OR_BODY"); };
  try { await publishTranscriptShare(failed.input, failed.operations); throw new Error("expected refusal"); }
  catch (error) {
    expect(String(error)).toContain("creating the exact named-key");
    expect(String(error)).not.toContain("PRIVATE_SIGNED_URL_OR_BODY");
  }
});

test("SDK failures discard raw causes before diagnostic chaining", async () => {
  const f = fixture();
  const privateMessage = "Private transcript words: amber koala beneath cedar.";
  const privateBody = "Private request body: meeting notes for tomorrow.";
  const sdkError = new Error(privateMessage, { cause: new Error(privateBody) });
  f.client.keys.createKey = async () => { throw sdkError; };
  const failure = await publishTranscriptShare(f.input, f.operations).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toHaveProperty("cause");
  const messages = debugErrorChain(failure).map((entry) => entry.message);
  expect(messages).toEqual([(failure as Error).message]);
  expect(messages.join("\n")).not.toContain(privateMessage);
  expect(messages.join("\n")).not.toContain(privateBody);
});

test("restored, session-only and disconnected owner sessions require sign-in before any share effect", async () => {
  for (const state of [
    { sessionRestoreStatus: "restored" },
    { isSessionOnly: true },
    { isWalletConnected: false },
  ]) {
    const f = fixture();
    Object.assign(f.client, state);
    expect(transcriptShareUnavailable(f.tcw)).toBeNull();
    await expect(publishTranscriptShare(f.input, f.operations)).rejects.toThrow("Sign in again to share");
    expect(f.effects).toEqual([]);
    expect(f.stored.size).toBe(0);
  }
});

test("a session restored during consent cannot create the share key or publish", async () => {
  const f = fixture();
  f.client.requestPermissions = async () => {
    f.client.sessionRestoreStatus = "restored";
    return { approved: true };
  };
  await expect(publishTranscriptShare(f.input, f.operations)).rejects.toThrow("Sign in again to share");
  expect(f.effects).toEqual(["public-key"]);
  expect(f.stored.size).toBe(0);
});

for (const [kind, title, filename] of [
  ["slash", "  Q4 / Roadmap  ", "Q4 - Roadmap"],
  ["backslash", "Standup\\Review", "Standup-Review"],
  ["empty", "", "Transcript"],
  ["over-long", "Q".repeat(2048), "Q".repeat(128)],
  ["dot", " .. ", "Transcript"],
  ["control/invisible", "Plan\u0000\u202e/Now", "Plan---Now"],
  ["multibyte over-long", "\u{10437}".repeat(100), "\u{10437}".repeat(32)],
] as const) {
  test(`a ${kind} title gets one valid bounded filename for review and publication`, async () => {
    const f = fixture(title);
    expect(f.review.filename).toBe(filename);
    expect(canonicalShareFilename(f.review.filename)).toBe(filename);
    expect(new TextEncoder().encode(f.review.filename).byteLength).toBeLessThanOrEqual(128);
    expect(f.review.snapshot.title).toBe(title);
    expect(f.effects).toEqual([]);
    expect((await publishTranscriptShare(f.input, f.operations)).status).toBe("published");
    expect(f.publishedInput()?.filename).toBe(filename);
  });
}
