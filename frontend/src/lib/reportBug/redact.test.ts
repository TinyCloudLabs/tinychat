import { expect, test } from "bun:test";
import { redactForReport } from "./redact";

test("identity: DIDs, wallet addresses, space ids, UUIDs, emails, IPs and home folders go", () => {
  const input = [
    "signed in as did:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412",
    "session did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    "wallet 0xd559CCd9EB87c530A9a349262669386dE93cf412",
    "space tinycloud:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412:default",
    "note 3f2b8c1e-5d4a-4c2b-9e1f-0a1b2c3d4e5f",
    "mail sam@example.com",
    "from 203.0.113.9",
    "at /Users/sam/Library/x and C:\\Users\\sam\\x",
  ].join("\n");
  const out = redactForReport(input);
  for (const leaked of ["did:pkh", "did:key", "0xd559", "tinycloud:pkh", "3f2b8c1e", "sam@example.com", "203.0.113.9", "/Users/sam", "Users\\sam"]) {
    expect(out).not.toContain(leaked);
  }
  expect(out).toContain("[REDACTED:did]");
  expect(out).toContain("[REDACTED:email]");
});

test("secrets: sk_ API keys (C3), JWTs, bearer tokens, assignments, PEM keys and seed phrases go", () => {
  // Fixtures are built from repeated pieces, so the repo's secret scan doesn't read them as live credentials.
  const hexSk = `sk_${"a1".repeat(24)}`;
  const alnumSk = `sk_${"Ab3d".repeat(8)}`;
  const bearer = "abc123".repeat(3);
  const jwt = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
  const seed = "abandon ability able about above absent absorb abstract absurd abuse access accident";
  const input = `key ${hexSk} other ${alnumSk}\nAuthorization: Bearer ${bearer}\ntoken ${jwt}\npassword=hunter2hunter2\n-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----\n${seed}`;
  const out = redactForReport(input);
  for (const leaked of [hexSk, alnumSk, bearer, jwt, "hunter2hunter2", "MIIEvQ", "abandon ability"]) {
    expect(out).not.toContain(leaked);
  }
});

test("bare hex keys (32 and 40 characters), OAuth codes and Slack webhooks go; error codes stay", () => {
  const hex32 = "4f9c".repeat(8);
  const hex40 = "b7e2a".repeat(8);
  const code = "4/0Ab".repeat(4);
  const hook = `hooks.slack.com/services/T0${"AB".repeat(4)}/B0${"CD".repeat(4)}/${"xY9z".repeat(6)}`;
  const input = `transcription failed with ${hex32}\nstt ${hex40}\ncallback code=${code}\nposted to https://${hook}\nfetch failed: code=ERR_NETWORK`;
  const out = redactForReport(input);
  for (const leaked of [hex32, hex40, code, "services/T0"]) expect(out).not.toContain(leaked);
  expect(out).toContain("[REDACTED:webhook]");
  expect(out).toContain("code=ERR_NETWORK");
});

test("a web address keeps its host and path; the query string and fragment go", () => {
  const out = redactForReport("opened https://tinycloud.one/s/abc123#v=4&k=linkfragment and https://example.com/cb?state=x&token=y then stopped");
  expect(out).toBe("opened https://tinycloud.one/s/abc123[REDACTED:url_query] and https://example.com/cb[REDACTED:url_query] then stopped");
});

test("ordinary bug text, including the words delegation and SIWE, stays whole (C4: no session-data blanking, no 500-char cut)", () => {
  const text = `The delegation screen froze after the SIWE prompt. I tapped Retry twice. ${"More detail. ".repeat(60)}`;
  expect(text.length).toBeGreaterThan(500);
  expect(redactForReport(text)).toBe(text);
});
