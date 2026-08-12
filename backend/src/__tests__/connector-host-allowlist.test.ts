import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Request, Response } from "express";

import {
  ConnectorWebhookLimiters,
  createConnectorWebhookHostGuard,
  normalizeWebhookHost,
  resolveWebhookHostAllowlist,
  WEBHOOK_HOST_ALLOWLIST_ENV,
  WEBHOOK_HOST_ALLOWLIST_OFF,
} from "../routes/connector-webhooks.js";

/**
 * W9 — the **Host-header allowlist** on the public routes (backend-ingest plan §8.1 W9 and §10;
 * findings §6 control 6).
 *
 * Control 6 is called out as becoming *load-bearing the moment the server fetches on webhooks*:
 * under Option C an off-target delivery cost one enqueue, but for a cohort address it now costs a
 * credentialed upstream fetch and a server-side content row. So the cheapest possible rejection —
 * before the body is read, before any bucket keyed on request content, before any KV call — is a
 * request that did not arrive at the hostname we minted into the provider's dashboard.
 *
 * What it is NOT: an authentication boundary. The HMAC is. `docs/connector-webhooks-trust-proxy.md`
 * records that the ingress hop count is UNDETERMINED, so a forwarded host is only as trustworthy as
 * the proxy in front of it — this control removes untargeted surface (raw-IP probing, a wrong
 * domain pointed at the CVM), and the tests below say so rather than overclaiming.
 */

const INDEX = readFileSync(resolve(import.meta.dir, "../index.ts"), "utf8");
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// ── Test doubles ─────────────────────────────────────────────────────

function fakeRequest(headers: Record<string, string>): Request {
  const lowered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    lowered[key.toLowerCase()] = value;
  }
  return {
    headers: lowered,
    params: { source: "fireflies", token: "t".repeat(43) },
    ip: "192.0.2.10",
    socket: { remoteAddress: "192.0.2.10" },
    get(name: string) {
      return lowered[name.toLowerCase()];
    },
  } as unknown as Request;
}

function fakeResponse() {
  const state: { status: number | null; body: unknown; headersSent: boolean } = {
    status: null,
    body: null,
    headersSent: false,
  };
  const res = {
    get headersSent() {
      return state.headersSent;
    },
    status(code: number) {
      state.status = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      state.headersSent = true;
      return res;
    },
  };
  return { res: res as unknown as Response, state };
}

function runGuard(
  guard: ReturnType<typeof createConnectorWebhookHostGuard>,
  headers: Record<string, string>,
) {
  const { res, state } = fakeResponse();
  let nexted = false;
  guard(fakeRequest(headers), res, () => {
    nexted = true;
  });
  return { nexted, ...state };
}

// ── Resolution ───────────────────────────────────────────────────────

describe("W9 — resolving the public host allowlist", () => {
  test("an explicit allowlist wins, comma-separated and case/port-normalized", () => {
    const allowlist = resolveWebhookHostAllowlist({
      [WEBHOOK_HOST_ALLOWLIST_ENV]: "API.TinyCloud.Chat, hooks.example.com:443 ",
      CONNECTOR_WEBHOOK_PUBLIC_ORIGIN: "https://ignored.example",
    } as NodeJS.ProcessEnv);

    expect(allowlist).not.toBeNull();
    expect([...(allowlist ?? [])].sort()).toEqual([
      "api.tinycloud.chat",
      "hooks.example.com",
    ]);
  });

  test("with no explicit list it DERIVES from the pinned public origin — one source of truth for the callback URL and the host we answer on", () => {
    const allowlist = resolveWebhookHostAllowlist({
      CONNECTOR_WEBHOOK_PUBLIC_ORIGIN: "https://api.tinycloud.chat",
    } as NodeJS.ProcessEnv);

    expect([...(allowlist ?? [])]).toEqual(["api.tinycloud.chat"]);
  });

  test("unset everywhere = no enforcement (local QA), and that is a null, never an empty set", () => {
    // An empty SET would reject every request — a config omission must not take the route down.
    expect(resolveWebhookHostAllowlist({} as NodeJS.ProcessEnv)).toBeNull();
    expect(
      resolveWebhookHostAllowlist({
        CONNECTOR_WEBHOOK_PUBLIC_ORIGIN: "",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  test("an ingress that rewrites Host has ONE explicit, documented escape hatch", () => {
    // Loud and deliberate. The alternative — silently degrading when a value looks wrong — is
    // exactly the fallback-that-hides-an-error this build refuses.
    expect(
      resolveWebhookHostAllowlist({
        [WEBHOOK_HOST_ALLOWLIST_ENV]: WEBHOOK_HOST_ALLOWLIST_OFF,
        CONNECTOR_WEBHOOK_PUBLIC_ORIGIN: "https://api.tinycloud.chat",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  test("a junk public origin does not silently become an allowlist entry", () => {
    expect(
      resolveWebhookHostAllowlist({
        CONNECTOR_WEBHOOK_PUBLIC_ORIGIN: "not-a-url",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  test("host normalization strips the default ports and the case, and refuses everything else", () => {
    expect(normalizeWebhookHost("API.Example.com:443")).toBe("api.example.com");
    expect(normalizeWebhookHost("api.example.com:80")).toBe("api.example.com");
    expect(normalizeWebhookHost("api.example.com:8443")).toBe(
      "api.example.com:8443",
    );
    expect(normalizeWebhookHost("")).toBeNull();
    expect(normalizeWebhookHost(undefined)).toBeNull();
    // A header is attacker-controlled: no CRLF, no path, no whitespace smuggling.
    expect(normalizeWebhookHost("api.example.com\r\nX-Evil: 1")).toBeNull();
    expect(normalizeWebhookHost("api.example.com/../evil")).toBeNull();
  });
});

// ── Enforcement ──────────────────────────────────────────────────────

describe("W9 — the public-route host guard", () => {
  test("passes a delivery that arrived at the minted hostname", () => {
    const guard = createConnectorWebhookHostGuard({
      allowlist: new Set(["api.tinycloud.chat"]),
      limiters: new ConnectorWebhookLimiters(),
    });

    const result = runGuard(guard, { host: "api.tinycloud.chat" });

    expect(result.nexted).toBe(true);
    expect(result.status).toBeNull();
  });

  test("rejects a wrong host with the SAME generic 401 every other pre-verify path returns", () => {
    const guard = createConnectorWebhookHostGuard({
      allowlist: new Set(["api.tinycloud.chat"]),
      limiters: new ConnectorWebhookLimiters(),
    });

    // A raw-IP probe and a wrong domain pointed at the CVM. Both are the scanner case.
    for (const host of ["203.0.113.9", "evil.example.com", "api.tinycloud.chat.evil.com"]) {
      const result = runGuard(guard, { host });
      expect({ host, nexted: result.nexted, status: result.status }).toEqual({
        host,
        nexted: false,
        status: 401,
      });
      // Never a distinguishable answer: a host-shaped oracle is still an oracle.
      expect(result.body).toEqual({ error: "invalid_signature" });
    }
  });

  test("a MISSING Host header is a rejection, not a pass", () => {
    const guard = createConnectorWebhookHostGuard({
      allowlist: new Set(["api.tinycloud.chat"]),
      limiters: new ConnectorWebhookLimiters(),
    });

    expect(runGuard(guard, {}).status).toBe(401);
  });

  test("the forwarded host is what is checked when the ingress sets one", () => {
    const guard = createConnectorWebhookHostGuard({
      allowlist: new Set(["api.tinycloud.chat"]),
      limiters: new ConnectorWebhookLimiters(),
    });

    // `trust proxy 1` is already this route's operating assumption (index.ts), so the client-facing
    // host is X-Forwarded-Host when the ingress sets it — the same value express's `req.hostname`
    // would resolve to. An internal Host behind a rewriting ingress therefore still passes.
    expect(
      runGuard(guard, {
        host: "tinychat-backend.internal:3000",
        "x-forwarded-host": "api.tinycloud.chat",
      }).nexted,
    ).toBe(true);

    // …and a spoofed forwarded host is still checked, not trusted-because-forwarded.
    expect(
      runGuard(guard, {
        host: "api.tinycloud.chat",
        "x-forwarded-host": "evil.example.com",
      }).status,
    ).toBe(401);
  });

  test("only the FIRST forwarded host is read — a comma-list cannot smuggle an allowed value", () => {
    const guard = createConnectorWebhookHostGuard({
      allowlist: new Set(["api.tinycloud.chat"]),
      limiters: new ConnectorWebhookLimiters(),
    });

    expect(
      runGuard(guard, {
        "x-forwarded-host": "evil.example.com, api.tinycloud.chat",
      }).status,
    ).toBe(401);
  });

  test("a null allowlist is a pure pass-through — the flag-off/local-QA path costs nothing", () => {
    const guard = createConnectorWebhookHostGuard({
      allowlist: null,
      limiters: new ConnectorWebhookLimiters(),
    });

    expect(runGuard(guard, { host: "anything.example" }).nexted).toBe(true);
    expect(runGuard(guard, {}).nexted).toBe(true);
  });

  test("a rejected host counts into the scanner buckets, like every other pre-verify failure", () => {
    const limiters = new ConnectorWebhookLimiters();
    const guard = createConnectorWebhookHostGuard({
      allowlist: new Set(["api.tinycloud.chat"]),
      limiters,
    });

    const before = limiters.stats();
    runGuard(guard, { host: "evil.example.com" });
    const after = limiters.stats();

    // §4.4's accounting hole is the precedent: a rejection that reaches no bucket is free traffic.
    expect(after.globalFailures).toBeGreaterThan(before.globalFailures);
    expect(after.ipKeys).toBeGreaterThanOrEqual(1);
  });

  test("the rejected host never reaches the world-readable log stream raw", () => {
    const limiters = new ConnectorWebhookLimiters();
    const guard = createConnectorWebhookHostGuard({
      allowlist: new Set(["api.tinycloud.chat"]),
      limiters,
    });
    const lines: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    console.warn = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    try {
      runGuard(guard, { host: "attacker-chosen-marker.example.com" });
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }

    const stream = lines.join("\n");
    expect(stream).toContain("reason=host");
    expect(stream).not.toContain("attacker-chosen-marker");
  });
});

// ── Wiring ───────────────────────────────────────────────────────────

describe("W9 — the guard is live on the public mount", () => {
  test("it runs FIRST on the public delivery mount — before the pre-limiter and before express.raw", () => {
    const mountIndex = INDEX.indexOf('"/api/connectors/webhooks/:source/:token"');
    const guardIndex = INDEX.indexOf("createConnectorWebhookHostGuard(");
    const preLimiterIndex = INDEX.indexOf("connectorWebhookIpPreLimiter,");
    const rawIndex = INDEX.indexOf('express.raw({ type: "application/json", limit: "64kb"');

    expect(guardIndex).toBeGreaterThan(mountIndex);
    expect(guardIndex).toBeLessThan(preLimiterIndex);
    expect(guardIndex).toBeLessThan(rawIndex);
  });

  test("the allowlist is resolved from the environment, not hard-coded", () => {
    expect(INDEX).toContain("resolveWebhookHostAllowlist(");
  });
});
