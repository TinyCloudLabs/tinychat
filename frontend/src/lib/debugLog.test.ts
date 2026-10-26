import { expect, test } from "bun:test";
import { authFailureCode, debugErrorChain, redactDebugText } from "./debugLog";

test("auth diagnostics retain only a bounded error code", async () => {
  const response = new Response(JSON.stringify({ error: "invalid_origin", message: "private SIWE material" }), { status: 400 });
  expect(await authFailureCode(response, "backend/api/auth/verify")).toBe("invalid_origin");
  expect(await response.json()).toEqual({ error: "invalid_origin", message: "private SIWE material" });
  expect(await authFailureCode(new Response(JSON.stringify({ error: "secret=private" }), { status: 400 }), "backend/api/auth/nonce")).toBeUndefined();
  expect(await authFailureCode(response, "tinycloud/api/auth/verify")).toBeUndefined();
});

test("debug error chains retain each cause but redact URLs and credentials", () => {
  const cause = Object.assign(new TypeError("Fetch API cannot load https://tee.node.tinycloud.xyz/kv?token=private due to access control checks."),
    { code: "NETWORK_ERROR" });
  const error = Object.assign(new Error("upload failed; authorization: Bearer abc123", { cause }), { code: "UPLOAD_FAILED" });
  const chain = debugErrorChain(error);
  expect(chain).toHaveLength(2);
  expect(chain.map((part) => part.code)).toEqual(["UPLOAD_FAILED", "NETWORK_ERROR"]);
  expect(JSON.stringify(chain)).not.toContain("private");
  expect(JSON.stringify(chain)).not.toContain("abc123");
  expect(JSON.stringify(chain)).not.toContain("tee.node.tinycloud.xyz");
  expect(debugErrorChain(new Error('session {"d":"ed25519-private"}'))[0]?.message).not.toContain("ed25519-private");
});

test("redactor removes JWT, private key, SIWE and authorization patterns", () => {
  const samples = [
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
    "private_key=0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    "-----BEGIN PRIVATE KEY-----\nsecret-key-material\n-----END PRIVATE KEY-----",
    "example.com wants you to sign in with your Ethereum account: 0xabc",
    "refresh_token=rt_secret",
    "access_token=at_secret",
    'privateKey="key-secret"',
  ];
  for (const sample of samples) {
    const redacted = redactDebugText(sample) ?? "";
    expect(redacted).not.toContain("eyJ");
    expect(redacted).not.toContain("1234567890abcdef");
    expect(redacted).not.toContain("secret-key-material");
    expect(redacted).not.toContain("sign in with");
    expect(redacted).not.toContain("rt_secret");
    expect(redacted).not.toContain("at_secret");
    expect(redacted).not.toContain("key-secret");
  }
});

test("redactor removes complete auth headers, base64url, truncated JWTs and session keys", () => {
  const base64url = "Ab-_".repeat(25);
  const samples: [string, string][] = [
    ["Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA=="],
    ['{"authorization":"TinyCloud uAiJ…"}', "uAiJ"],
    ["Cookie: session=private-cookie; other=value", "private-cookie"],
    [`"cookie":"session=private-cookie"`, "private-cookie"],
    [base64url, base64url],
    ["jwt=eyJhbGci….eyJpc3Mi…", "eyJhbGci"],
    ["eyJhbGci.eyJpc3Mi", "eyJhbGci"],
    ["eyJhbGci.", "eyJhbGci"],
    ['{"sessionKey":"k_live_123456"}', "k_live_123456"],
  ];
  for (const [sample, secret] of samples) {
    expect(redactDebugText(sample)).not.toContain(secret);
  }
});

test("debug error chains stop after 12 causes", () => {
  let error: Error = new Error("root");
  for (let i = 0; i < 20; i++) error = new Error(`cause ${i}`, { cause: error });
  expect(debugErrorChain(error)).toHaveLength(12);
});
