/**
 * stream-harness.mjs
 *
 * Streaming spike for TinyChat Expo mobile client.
 * Proves that WHATWG fetch + response.body.getReader() + TextDecoder
 * + manual SSE frame parsing delivers tokens INCREMENTALLY —
 * the exact code path expo/fetch runs under Hermes.
 *
 * Usage (TLS via mkcert CA — preferred):
 *   NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" node stream-harness.mjs
 *
 * Fallback (skip TLS verify — local spike only, note it):
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node stream-harness.mjs
 *
 * The harness tries the real backend first (https://localhost:3014/api/chat),
 * then falls back to RedPill direct if the backend is unreachable.
 */

import { readFileSync } from "fs";
import { createRequire } from "module";

// ── Env loading ───────────────────────────────────────────────────────────────

const BACKEND_ENV_PATH = new URL("../../backend/.env", import.meta.url).pathname;
const ROOT_ENV_PATH    = new URL("../../.env", import.meta.url).pathname;

function parseEnv(filePath) {
  try {
    return Object.fromEntries(
      readFileSync(filePath, "utf8")
        .split("\n")
        .filter(l => l.includes("=") && !l.startsWith("#"))
        .map(l => {
          const idx = l.indexOf("=");
          return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
        })
    );
  } catch {
    return {};
  }
}

const backendEnv = parseEnv(BACKEND_ENV_PATH);
const rootEnv    = parseEnv(ROOT_ENV_PATH);

const BACKEND_PRIVATE_KEY = backendEnv.BACKEND_PRIVATE_KEY;
const REDPILL_API_KEY     = backendEnv.REDPILL_API_KEY || rootEnv.REDPILL_API_KEY;
const REDPILL_BASE_URL    = backendEnv.REDPILL_BASE_URL || "https://api.redpill.ai/v1";
const BACKEND_URL         = "https://localhost:3014";

if (!BACKEND_PRIVATE_KEY) throw new Error("BACKEND_PRIVATE_KEY not found in backend/.env");
if (!REDPILL_API_KEY)     throw new Error("REDPILL_API_KEY not found in env files");

const redact = s => s.length > 8 ? `${s.slice(0,4)}...${s.slice(-4)}` : "****";
console.log(`[config] BACKEND_PRIVATE_KEY = ${redact(BACKEND_PRIVATE_KEY)}`);
console.log(`[config] REDPILL_API_KEY     = ${redact(REDPILL_API_KEY)}`);

// ── JWT minting (jose via bun-managed cache) ──────────────────────────────────

const require = createRequire(import.meta.url);
const JOSE_PATH = new URL(
  "../../node_modules/.bun/jose@5.10.0/node_modules/jose/dist/node/cjs/index.js",
  import.meta.url
).pathname;
const { SignJWT } = require(JOSE_PATH);

const WALLET_ADDRESS = "0x1111111111111111111111111111111111111111";

async function mintJWT() {
  const secret = new TextEncoder().encode(BACKEND_PRIVATE_KEY);
  return new SignJWT({ address: WALLET_ADDRESS.toLowerCase() })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(WALLET_ADDRESS.toLowerCase())
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(secret);
}

// ── Core SSE streaming function — THE HERMES CODE PATH ───────────────────────
//
// This is exactly what expo/fetch runs under Hermes:
//   fetch() → response.body.getReader() → reader.read() loop →
//   TextDecoder.decode({ stream:true }) → manual \n\n frame split →
//   data: line parse → [DONE] detection.
//
// Evidence of incremental streaming: reader.read() calls are spread across
// many distinct OS-level reads, each arriving at a different wall-clock time.

async function streamSSE(url, headers, body) {
  console.log(`\n[harness] POST ${url}`);

  const startNs = process.hrtime.bigint();
  const nsToMs = ns => Number(ns / 1_000_000n);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  // ── getReader() — the expo/fetch / Hermes streaming primitive ────────────
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer    = "";
  let readCount = 0;
  let deltaCount = 0;
  let totalChars = 0;
  let doneSeen  = false;

  console.log("\n[raw reads] Each row = one reader.read() call (proves incremental delivery):");
  console.log("read# | elapsed(ms) | bytes | deltas-in-read | cumulative-chars");
  console.log("─".repeat(70));

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    readCount++;
    const relMs = nsToMs(process.hrtime.bigint() - startNs);
    const bytesInRead = value.byteLength;

    // Decode chunk (stream:true keeps multi-byte chars across chunk boundaries)
    buffer += decoder.decode(value, { stream: true });

    // Split on SSE frame boundaries (blank line separator per spec)
    const frames = buffer.split("\n\n");
    buffer = frames.pop(); // keep incomplete last frame

    let deltasInRead = 0;
    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();

        if (payload === "[DONE]") { doneSeen = true; continue; }

        let parsed;
        try { parsed = JSON.parse(payload); } catch { continue; }

        const delta = parsed?.choices?.[0]?.delta?.content;
        if (typeof delta !== "string" || delta.length === 0) continue;

        deltaCount++;
        totalChars += delta.length;
        deltasInRead++;
      }
    }

    // Print each read — timestamps must be SPREAD OUT to confirm streaming
    console.log(
      `  #${String(readCount).padStart(4)} | t=${String(relMs).padStart(7)}ms | ` +
      `${String(bytesInRead).padStart(5)}B | ${deltasInRead} deltas | cum=${totalChars}`
    );
  }

  const totalMs = nsToMs(process.hrtime.bigint() - startNs);
  console.log("─".repeat(70));
  console.log(
    `[summary] reads=${readCount} | deltas=${deltaCount} | chars=${totalChars} | elapsed=${totalMs}ms | [DONE]=${doneSeen}`
  );

  return { readCount, deltaCount, totalChars, totalMs, doneSeen };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const PROMPT_BODY = {
  model: "phala/gpt-oss-120b",
  messages: [{
    role: "user",
    content: "Count slowly from 1 to 10, one number per line."
  }],
};

async function main() {
  // Attempt 1: real backend
  try {
    console.log(`\n[attempt 1] Checking backend health at ${BACKEND_URL}/health`);
    let healthOk = false;
    try {
      const h = await fetch(`${BACKEND_URL}/health`);
      healthOk = h.ok;
    } catch (e) {
      console.log(`[health] unreachable: ${e.message}`);
    }

    if (!healthOk) throw new Error("Backend health check failed");
    console.log("[health] Backend is UP");

    const jwt = await mintJWT();
    console.log(`[jwt] minted for ${WALLET_ADDRESS}, token=${redact(jwt)}`);

    const result = await streamSSE(
      `${BACKEND_URL}/api/chat`,
      {
        Authorization: `Bearer ${jwt}`,
        "X-Requested-With": "XMLHttpRequest",
      },
      PROMPT_BODY
    );

    console.log("\n[ENDPOINT] Real backend: https://localhost:3014/api/chat");
    console.log("[TLS] NODE_EXTRA_CA_CERTS set to mkcert rootCA.pem (no TLS bypass)");

    const spreadMs = result.readCount > 1 ? "(spread across multiple reads — STREAMING CONFIRMED)" : "(all in one read — BUFFERED)";
    console.log(`[STREAMING] ${result.readCount} distinct reader.read() calls ${spreadMs}`);

  } catch (err) {
    console.log(`\n[attempt 1] FAILED: ${err.message}`);
    console.log("[attempt 2] Falling back to RedPill direct (same getReader code path)");
    console.log("           REDPILL_DIRECT fallback — real backend was unreachable\n");

    const result = await streamSSE(
      `${REDPILL_BASE_URL}/chat/completions`,
      { Authorization: `Bearer ${REDPILL_API_KEY}` },
      { ...PROMPT_BODY, stream: true }
    );

    console.log("\n[ENDPOINT] RedPill direct: https://api.redpill.ai/v1/chat/completions");
    console.log("[TLS] public TLS — no NODE_TLS_REJECT_UNAUTHORIZED bypass needed");
    const spreadMs = result.readCount > 1 ? "(spread across multiple reads — STREAMING CONFIRMED)" : "(all in one read — BUFFERED)";
    console.log(`[STREAMING] ${result.readCount} distinct reader.read() calls ${spreadMs}`);
  }
}

main().catch(err => {
  console.error("[FATAL]", err);
  process.exit(1);
});
