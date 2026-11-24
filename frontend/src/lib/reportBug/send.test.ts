import { expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { sendReport, signingString, type ReportSigner, type SendInput } from "./send";
import type { ReportContext } from "./context";

const ORIGIN = "https://feedback.example";
const SESSION_DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const privateKey = ed25519.utils.randomPrivateKey();
const publicKey = ed25519.getPublicKey(privateKey);

const signer: ReportSigner = {
  sessionDid: SESSION_DID,
  siwe: "example.com wants you to sign in…",
  siweSignature: "0xsig",
  sign: async (bytes) => ed25519.sign(bytes, privateKey),
};

const context: ReportContext = {
  app: "TinyCloud One 0.20.4 · ios · beta · abc1234",
  platform: "ios",
  os: "18",
  screen: "settings",
  client_time: "2026-11-24T10:00:00.000Z",
  online: true,
  trigger: "screenshot",
};

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

interface Call { url: string; init: RequestInit }

function fakeFetch(responses: Array<Response | Error>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const created = (body: object) => new Response(JSON.stringify(body), { status: 201, headers: { "content-type": "application/json" } });

function input(over: Partial<SendInput> = {}): SendInput {
  return {
    origin: ORIGIN,
    happened: "The Library list went blank after I tapped Sync.",
    context,
    recentErrors: [{ age_s: 4, msg: "TypeError: x is undefined" }],
    screenshot: null,
    signer,
    fetch: fakeFetch([]).fetch,
    now: () => 1_763_980_000_000,
    ...over,
  };
}

test("a signed report: the session key signs aud, session DID, iat, nonce and the report's hash; the SIWE goes along as proof", async () => {
  const { fetch, calls } = fakeFetch([created({ id: "01J0000000000000000000000A" })]);
  expect(await sendReport(input({ fetch }))).toEqual({ kind: "sent" });
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe(`${ORIGIN}/reports/app`);
  const envelope = JSON.parse(String(calls[0].init.body));
  expect(envelope.v).toBe(1);
  expect(envelope.iat).toBe(1_763_980_000);
  expect(envelope.proof).toEqual({ siwe: signer.siwe, siwe_signature: "0xsig", session_did: SESSION_DID });
  const report = JSON.parse(envelope.report);
  expect(report).toEqual({
    area: "one-app",
    kind: "bug",
    happened: "The Library list went blank after I tapped Sync.",
    context,
    recent_errors: [{ age_s: 4, msg: "TypeError: x is undefined" }],
  });
  const message = signingString({
    aud: ORIGIN,
    sessionDid: SESSION_DID,
    iat: envelope.iat,
    nonce: envelope.nonce,
    reportSha256: bytesToHex(sha256(new TextEncoder().encode(envelope.report))),
  });
  expect(message.split("\n")[0]).toBe("tinycloud-feedback.v1");
  const sig = Buffer.from(envelope.sig, "base64url");
  expect(ed25519.verify(sig, new TextEncoder().encode(message), publicKey)).toBe(true);
  // A tampered report no longer matches the signature.
  const tampered = signingString({ aud: ORIGIN, sessionDid: SESSION_DID, iat: envelope.iat, nonce: envelope.nonce, reportSha256: bytesToHex(sha256(new TextEncoder().encode(envelope.report + " "))) });
  expect(ed25519.verify(sig, new TextEncoder().encode(tampered), publicKey)).toBe(false);
  expect(Buffer.from(envelope.nonce, "base64url")).toHaveLength(16);
});

test("each send uses a fresh nonce", async () => {
  const { fetch, calls } = fakeFetch([created({ id: "A1" }), created({ id: "A2" })]);
  await sendReport(input({ fetch }));
  await sendReport(input({ fetch }));
  const [a, b] = calls.map((call) => JSON.parse(String(call.init.body)).nonce);
  expect(a).not.toBe(b);
});

test("signed out: no proof, no signature, no screenshot (unverified reports can't carry one)", async () => {
  const { fetch, calls } = fakeFetch([created({ id: "A1", attach_token: "t" })]);
  expect(await sendReport(input({ fetch, signer: null, screenshot: JPEG }))).toEqual({ kind: "sent" });
  expect(calls).toHaveLength(1);
  const envelope = JSON.parse(String(calls[0].init.body));
  expect(envelope.proof).toBeUndefined();
  expect(envelope.sig).toBeUndefined();
  expect(JSON.parse(envelope.report).screenshot).toBeUndefined();
});

test("the screenshot: its hash is inside the signed report, the bytes go with the report's attach token", async () => {
  const { fetch, calls } = fakeFetch([created({ id: "01J0000000000000000000000A", attach_token: "tok" }), new Response(null, { status: 201 })]);
  expect(await sendReport(input({ fetch, screenshot: JPEG }))).toEqual({ kind: "sent" });
  const report = JSON.parse(JSON.parse(String(calls[0].init.body)).report);
  expect(report.screenshot).toEqual({ sha256: bytesToHex(sha256(JPEG)), bytes: JPEG.length, type: "image/jpeg" });
  expect(calls[1].url).toBe(`${ORIGIN}/reports/01J0000000000000000000000A/screenshot`);
  const headers = new Headers(calls[1].init.headers);
  expect(headers.get("authorization")).toBe("Bearer tok");
  expect(headers.get("content-type")).toBe("image/jpeg");
  expect(calls[1].init.body).toEqual(JPEG);
});

test("a refused or failed screenshot upload still counts the report as sent, without the screenshot", async () => {
  const refused = fakeFetch([created({ id: "A1", attach_token: "tok" }), new Response("{}", { status: 413 })]);
  expect(await sendReport(input({ fetch: refused.fetch, screenshot: JPEG }))).toEqual({ kind: "sent_without_screenshot" });
  const noToken = fakeFetch([created({ id: "A1" })]);
  expect(await sendReport(input({ fetch: noToken.fetch, screenshot: JPEG }))).toEqual({ kind: "sent_without_screenshot" });
  const offline = fakeFetch([created({ id: "A1", attach_token: "tok" }), new TypeError("Failed to fetch")]);
  expect(await sendReport(input({ fetch: offline.fetch, screenshot: JPEG }))).toEqual({ kind: "sent_without_screenshot" });
});

test("429 is too many; a network error or other refusal is failed", async () => {
  expect(await sendReport(input({ fetch: fakeFetch([new Response("{}", { status: 429 })]).fetch }))).toEqual({ kind: "too_many" });
  expect(await sendReport(input({ fetch: fakeFetch([new TypeError("Failed to fetch")]).fetch }))).toEqual({ kind: "failed" });
  expect(await sendReport(input({ fetch: fakeFetch([new Response("{}", { status: 400 })]).fetch }))).toEqual({ kind: "failed" });
});

test("the typed text is redacted before it is signed and sent; the session's private key is never in the request", async () => {
  const { fetch, calls } = fakeFetch([created({ id: "A1" })]);
  await sendReport(input({ fetch, happened: "my wallet 0xd559CCd9EB87c530A9a349262669386dE93cf412 broke" }));
  const body = String(calls[0].init.body);
  expect(body).not.toContain("0xd559");
  expect(body).not.toContain(Buffer.from(privateKey).toString("base64url"));
  expect(body).not.toContain(bytesToHex(privateKey));
});
