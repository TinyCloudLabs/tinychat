import { describe, expect, test } from "bun:test";
import type { Conn, GuardDeps } from "../fetch-guard";
import { type ApprovedSecret, MAX_REPLY_CHARS, prepareCall, type PreparedCall, sendCall, sentence } from "../secret-call";
import { HIDDEN, redactor, redactThenTruncate } from "../secret-redact";

// A fake value: never a real key.
const VALUE = "sk-test-FAKE/value+with=odd chars~!'é";
const enc = new TextEncoder();

const OPENAI: ApprovedSecret = { name: "OPENAI_API_KEY", sites: ["api.openai.com"], header: "authorization", until: Date.UTC(2026, 10, 22, 13, 12) };
const UNKNOWN: ApprovedSecret = { name: "STRIPE_KEY", sites: ["api.stripe.com", "files.stripe.com"], header: "authorization", until: OPENAI.until };
const AUTH = { Authorization: "Bearer {{secret}}" };

function prepared(args: Record<string, unknown>, secret = OPENAI): PreparedCall {
  const call = prepareCall({ name: secret.name, method: "GET", ...args }, secret);
  if ("refused" in call) throw new Error(`refused: ${call.refused}`);
  return call;
}

const refusedFor = (args: Record<string, unknown>, secret = OPENAI) => {
  const call = prepareCall({ name: secret.name, method: "GET", headers: AUTH, ...args }, secret);
  return "refused" in call ? call.refused : "made";
};

describe("hiding the value", () => {
  const hide = redactor(VALUE);
  const bytes = Buffer.from(VALUE);
  const forms: Record<string, string> = {
    exact: VALUE,
    base64: bytes.toString("base64"),
    base64url: bytes.toString("base64url"),
    "base64 after a prefix": Buffer.from(`user:${VALUE}`).toString("base64"),
    "base64url after a prefix": Buffer.from(`ab${VALUE}`).toString("base64url"),
    "percent-encoded": encodeURIComponent(VALUE),
    "form-encoded": new URLSearchParams({ k: VALUE }).toString().slice(2),
    "lower-case percent": encodeURIComponent(VALUE).replace(/%[0-9A-F]{2}/g, m => m.toLowerCase()),
    hex: bytes.toString("hex"),
    "upper-case hex": bytes.toString("hex").toUpperCase(),
    "JSON-escaped": JSON.stringify(VALUE).slice(1, -1),
    "JSON with escaped slashes": JSON.stringify(VALUE).slice(1, -1).replaceAll("/", "\\/"),
    "JSON with \\u escapes": JSON.stringify(VALUE).slice(1, -1).replace(/[^\x20-\x7e]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`),
  };
  test.each(Object.entries(forms))("%s is hidden", (_, form) => {
    const out = hide.redact(`before ${form} after`);
    expect(out).toContain(HIDDEN);
    expect(out).not.toContain(VALUE);
    expect(out).not.toContain(form);
  });

  test("redacts before cutting, so a cut never leaves part of the value", () => {
    const text = `${"x".repeat(95)}${VALUE}`;
    const shown = redactThenTruncate(text, hide, 100, false);
    expect(shown.truncated).toBe(true);
    expect(shown.text).toBe(`${"x".repeat(95)}${HIDDEN}`.slice(0, 100));
    expect(VALUE.startsWith(shown.text.slice(95))).toBe(false);
  });
});

describe("what a call may contain", () => {
  test("a call with the value in its own header is made", () => {
    expect(refusedFor({ url: "https://api.openai.com/v1/models" })).toBe("made");
    expect(refusedFor({ url: "https://API.OpenAI.com./v1/models" })).toBe("made");
  });

  test.each([
    ["the address", { url: "https://api.openai.com/v1?key={{secret}}" }],
    ["the address, percent-encoded", { url: "https://api.openai.com/v1?key=%7B%7Bsecret%7D%7D" }],
    ["the body", { method: "POST", url: "https://api.openai.com/v1", body: '{"key":"{{secret}}"}' }],
    ["another header", { url: "https://api.openai.com/v1", headers: { ...AUTH, "x-echo": "{{secret}}" } }],
    ["a header's name", { url: "https://api.openai.com/v1", headers: { ...AUTH, "{{secret}}": "x" } }],
    ["its header twice", { url: "https://api.openai.com/v1", headers: { Authorization: "Bearer {{secret}}{{secret}}" } }],
  ])("{{secret}} in %s is refused", (_, args) => {
    expect(refusedFor(args)).toBe("placeholder");
  });

  test("a known service's value goes only in that service's header", () => {
    const anthropic: ApprovedSecret = { name: "ANTHROPIC_API_KEY", sites: ["api.anthropic.com"], header: "x-api-key", until: OPENAI.until };
    expect(refusedFor({ url: "https://api.anthropic.com/v1/messages", headers: AUTH }, anthropic)).toBe("placeholder");
    expect(refusedFor({ url: "https://api.anthropic.com/v1/messages", headers: { "X-Api-Key": "{{secret}}" } }, anthropic)).toBe("made");
    expect(sentence("placeholder", { name: "ANTHROPIC_API_KEY", header: "x-api-key" })).toBe("{{secret}} can only go in a header. For ANTHROPIC_API_KEY use X-Api-Key: {{secret}}.");
  });

  test("a call without {{secret}} is refused with the design's sentence", () => {
    expect(refusedFor({ url: "https://api.openai.com/v1", headers: {} })).toBe("noPlaceholder");
    expect(sentence("noPlaceholder", { name: "OPENAI_API_KEY", header: "authorization" })).toBe("Put {{secret}} in a header, like Authorization: Bearer {{secret}}.");
  });

  test.each([
    ["http", "http://api.openai.com/v1", "invalid"],
    ["another port", "https://api.openai.com:8443/v1", "invalid"],
    ["port 80 on https", "https://api.openai.com:80/v1", "invalid"],
    ["user info", "https://user:pw@api.openai.com/v1", "invalid"],
    ["an IPv4 literal", "https://93.184.216.34/v1", "invalid"],
    ["an IPv6 literal", "https://[2606:4700::1]/v1", "invalid"],
    ["a sub-domain of the site", "https://evil.api.openai.com/v1", "site"],
    ["a look-alike", "https://api.openai.com.evil.example/v1", "site"],
    ["another site", "https://example.com/", "site"],
  ])("%s is refused", (_, url, refusal) => {
    expect(refusedFor({ url })).toBe(refusal);
  });

  test("names every approved site when the site is wrong", () => {
    expect(sentence("site", { name: UNKNOWN.name, sites: UNKNOWN.sites })).toBe("STRIPE_KEY is approved only for api.stripe.com and files.stripe.com.");
    expect(sentence("site", { name: OPENAI.name, sites: OPENAI.sites })).toBe("OPENAI_API_KEY is approved only for api.openai.com.");
  });

  test.each([
    ["a method outside the list", { method: "CONNECT", url: "https://api.openai.com/" }],
    ["a framing header", { url: "https://api.openai.com/", headers: { ...AUTH, "Content-Length": "5" } }],
    ["a host header", { url: "https://api.openai.com/", headers: { ...AUTH, Host: "example.com" } }],
    ["a line break in a header", { url: "https://api.openai.com/", headers: { ...AUTH, "x-a": "a\r\nx-b: b" } }],
    ["a body over 1 MiB", { method: "POST", url: "https://api.openai.com/", body: "x".repeat(1024 * 1024 + 1) }],
    ["an extra argument", { url: "https://api.openai.com/", follow: true }],
  ])("%s is refused", (_, args) => {
    expect(refusedFor(args)).toBe("invalid");
  });
});

interface Served {
  parts: Array<string | (() => Promise<void>)>;
}

function world(answers: Record<string, string[]>, served: Served) {
  const written: string[] = [];
  const connects: Array<{ ip: string; port: number; secure: boolean; servername: string }> = [];
  const deps: GuardDeps = {
    lookup: async host => {
      const found = answers[host];
      if (!found) throw new Error("NXDOMAIN");
      return found;
    },
    connect: async (ip, port, secure, servername): Promise<Conn> => {
      connects.push({ ip, port, secure, servername });
      let destroyed = false;
      return {
        write: data => void written.push(data),
        destroy: () => void (destroyed = true),
        read: () => ({
          async *[Symbol.asyncIterator]() {
            for (const part of served.parts) {
              if (destroyed) return;
              if (typeof part === "function") await part();
              else yield enc.encode(part);
            }
          },
        }),
      };
    },
  };
  return { deps, written, connects };
}

const reply = (status: string, headers: Record<string, string>, body = "") =>
  `HTTP/1.1 ${status}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n${body}`;
const json = (body: string, extra: Record<string, string> = {}) =>
  reply("200 OK", { "content-type": "application/json", "content-length": String(enc.encode(body).length), ...extra }, body);
const PUBLIC = { "api.openai.com": ["93.184.216.34"] };
const call = prepared({ method: "POST", url: "https://api.openai.com/v1/audio?x=1#frag", headers: AUTH, body: '{"a":1}' });

describe("making the call", () => {
  test("pins a public address, sends the value only in its header over TLS on 443, and hides it in the reply", async () => {
    const echoed = JSON.stringify({ auth: `Bearer ${VALUE}`, b64: Buffer.from(VALUE).toString("base64") });
    const w = world(PUBLIC, { parts: [json(echoed, { "x-echo": VALUE })] });
    const result = await sendCall(call, VALUE, w.deps);
    expect(w.connects).toEqual([{ ip: "93.184.216.34", port: 443, secure: true, servername: "api.openai.com" }]);
    const [request] = w.written;
    expect(request!.startsWith("POST /v1/audio?x=1 HTTP/1.1\r\nHost: api.openai.com\r\n")).toBe(true);
    expect(request!.split(VALUE).length).toBe(2);
    expect(request).toContain(`Authorization: Bearer ${VALUE}\r\n`);
    expect(request!.endsWith('\r\n\r\n{"a":1}')).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.text).not.toContain(VALUE);
    expect(result.text).not.toContain(Buffer.from(VALUE).toString("base64"));
    const shown = JSON.parse(result.text);
    expect(shown).toMatchObject({ status: 200, contentType: "application/json", truncated: false });
    expect(JSON.parse(shown.body)).toEqual({ auth: `Bearer ${HIDDEN}`, b64: HIDDEN });
  });

  test("hides the value in the content type it returns", async () => {
    const w = world(PUBLIC, { parts: [reply("200 OK", { "content-type": `application/json; echo=${VALUE}`, "content-length": "2" }, "{}")] });
    const result = await sendCall(call, VALUE, w.deps);
    if (!result.ok) throw new Error(result.reason);
    expect(result.text).not.toContain(VALUE);
    expect(JSON.parse(result.text).contentType).toContain(HIDDEN);
  });

  test("cuts a long reply only after hiding the value", async () => {
    const body = `${"y".repeat(MAX_REPLY_CHARS - 5)}${VALUE}${"z".repeat(50)}`;
    const w = world(PUBLIC, { parts: [reply("200 OK", { "content-type": "text/plain", "content-length": String(enc.encode(body).length) }, body)] });
    const result = await sendCall(call, VALUE, w.deps);
    if (!result.ok) throw new Error(result.reason);
    const shown = JSON.parse(result.text);
    expect(shown.truncated).toBe(true);
    expect(shown.body.length).toBe(MAX_REPLY_CHARS);
    expect(shown.body.endsWith(HIDDEN.slice(0, 5))).toBe(true);
    expect(shown.body).not.toContain(VALUE.slice(0, 5));
  });

  test.each([
    ["a private address", { "api.openai.com": ["10.0.0.5"] }],
    ["one private answer among public ones", { "api.openai.com": ["93.184.216.34", "127.0.0.1"] }],
    ["the metadata address", { "api.openai.com": ["169.254.169.254"] }],
    ["a name that doesn't resolve", {}],
  ])("never connects when the name resolves to %s", async (_, answers) => {
    const w = world(answers, { parts: [json("{}")] });
    expect(await sendCall(call, VALUE, w.deps)).toEqual({ ok: false, reason: "could not connect", bytes: 0 });
    expect(w.connects).toEqual([]);
    expect(w.written).toEqual([]);
  });

  test("does not follow a redirect, and hides the value in where it pointed", async () => {
    const w = world(PUBLIC, { parts: [reply("302 Found", { location: `https://evil.example/?k=${encodeURIComponent(VALUE)}`, "content-length": "0" })] });
    const result = await sendCall(call, VALUE, w.deps);
    expect(w.connects.length).toBe(1);
    expect(result).toEqual({ ok: false, reason: "redirect", address: `https://evil.example/?k=${HIDDEN}`, bytes: 0 });
    expect(sentence("redirect", { host: "api.openai.com", address: `https://evil.example/?k=${HIDDEN}` })).toBe(
      `api.openai.com answered with a redirect to https://evil.example/?k=${HIDDEN}. It wasn’t followed; the secret is only sent to approved sites.`,
    );
  });

  test("refuses a reply over 1 MiB as too large instead of cutting it", async () => {
    const big = "a".repeat(1024 * 1024 + 10);
    const w = world(PUBLIC, { parts: [reply("200 OK", { "content-type": "text/plain", "content-length": String(big.length) }, big)] });
    const result = await sendCall(call, VALUE, w.deps);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("reply too large");
  });

  test("times out a site that never finishes", async () => {
    const w = world(PUBLIC, { parts: ["HTTP/1.1 200 OK\r\n", () => new Promise(() => {})] });
    const result = await sendCall(call, VALUE, w.deps, { totalMs: 50, maxBodyBytes: 1024 });
    expect(result).toEqual({ ok: false, reason: "timeout", bytes: 0 });
  });

  test("refuses a compressed reply, which could hide the value from the search", async () => {
    const w = world(PUBLIC, { parts: [json("{}", { "content-encoding": "gzip" })] });
    expect(await sendCall(call, VALUE, w.deps)).toEqual({ ok: false, reason: "could not connect", bytes: 0 });
    expect(w.written[0]).toContain("Accept-Encoding: identity\r\n");
  });

  test("never sends a value that would break the request", async () => {
    const w = world(PUBLIC, { parts: [json("{}")] });
    expect(await sendCall(call, "a\r\nX-Injected: 1", w.deps)).toEqual({ ok: false, reason: "value", bytes: 0 });
    expect(await sendCall(call, "", w.deps)).toEqual({ ok: false, reason: "value", bytes: 0 });
    expect(w.connects).toEqual([]);
  });
});
