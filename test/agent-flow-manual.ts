// Milestone E live e2e driver (headed; operator taps passkey).
// Reuses the real-auth support layer (mkcert CA detection, local-HTTPS URLs,
// persistent profile, session-token extraction). Drives:
//   load → Sign in (operator taps) → wait chat UI → wait "Enable agent…" banner
//   → click Enable (operator taps) → capture POST /api/agent/session (the
//   serialized delegation) → observe status → web-search chat → tool chip + receipt.
//
// CRUCIAL diagnostic for Bug B: every /api/agent/session POST body is captured and
// its delegationHeader.Authorization is decoded — we print whether it is a real
// signed UCAN JWT (eyJ… with 3 dot-segments + an `att` claim) or a bare `Bearer <cid>`.

import { chromium, type BrowserContext, type Page, type Request } from "playwright";

import {
  extractStoredSession,
  resolveRealAuthCommandEnv,
  resolveRealAuthConfig,
  type PlaywrightStorageState,
  type RealAuthConfig,
  type StoredSession,
} from "./real-auth-support.ts";

const repoRoot = new URL("..", import.meta.url).pathname;
const env = resolveRealAuthCommandEnv({ cwd: repoRoot, env: process.env });
const config = resolveRealAuthConfig({ cwd: repoRoot, env });

const marker = `eliza-${Date.now().toString(36)}`;

console.log("=== Milestone E agent-flow live e2e (headed) ===");
console.log(`Frontend: ${config.frontendUrl}`);
console.log(`Backend:  ${config.backendUrl}`);
console.log(`Profile:  ${config.userDataDir ?? "<ephemeral>"}`);
console.log("");

function b64urlDecode(input: string): string {
  let b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad) b64 += "=".repeat(4 - pad);
  return Buffer.from(b64, "base64").toString("utf8");
}

// Inspect a delegationHeader.Authorization string: is it a signed JWT or a CID?
function inspectAuthorization(auth: string | undefined): string {
  if (!auth) return "MISSING";
  const tok = auth.replace(/^Bearer\s+/i, "");
  const parts = tok.split(".");
  if (parts.length >= 3 && tok.startsWith("eyJ")) {
    try {
      const payload = JSON.parse(b64urlDecode(parts[1]));
      const att = payload?.att ? Object.keys(payload.att) : [];
      return `SIGNED-JWT ✅  segments=${parts.length}  att-resources=${JSON.stringify(att)}  exp=${payload?.exp}`;
    } catch {
      return `JWT-like (3 segments) but payload undecodable: ${tok.slice(0, 40)}…`;
    }
  }
  return `NOT-A-JWT ❌  value="${tok.slice(0, 80)}"  (looks like a CID / opaque token)`;
}

function captureAgentSessionPost(req: Request): void {
  if (req.method() !== "POST" || !req.url().includes("/api/agent/session")) return;
  console.log("");
  console.log("  ┌── captured POST /api/agent/session ──────────────────");
  let post: string | undefined;
  try {
    post = req.postData() ?? undefined;
  } catch {
    /* ignore */
  }
  if (!post) {
    console.log("  │ (no post body)");
    console.log("  └──────────────────────────────────────────────────");
    return;
  }
  try {
    const body = JSON.parse(post);
    const serialized = body.serialized;
    console.log(`  │ roomId: ${body.roomId ?? "<none>"}`);
    if (typeof serialized === "string") {
      const d = JSON.parse(serialized);
      const auth = d?.delegationHeader?.Authorization;
      console.log(`  │ top-level actions: ${JSON.stringify(d?.actions)}`);
      console.log(`  │ delegateDID: ${d?.delegateDID}`);
      console.log(`  │ cid: ${d?.cid}`);
      console.log(`  │ authHeader (raw field on delegation): ${d?.authHeader ?? "<absent>"}`);
      console.log(`  │ delegationHeader.Authorization → ${inspectAuthorization(auth)}`);
      // Dump the full serialized delegation for the record.
      console.log("  │ --- full serialized delegation ---");
      console.log(JSON.stringify(d, null, 2).split("\n").map((l) => "  │   " + l).join("\n"));
    } else {
      console.log(`  │ serialized is not a string: ${JSON.stringify(serialized).slice(0, 200)}`);
    }
  } catch (e) {
    console.log(`  │ failed to parse post body: ${(e as Error).message}`);
    console.log(`  │ raw: ${post.slice(0, 300)}`);
  }
  console.log("  └──────────────────────────────────────────────────");
}

const launched = await launchManualContext(config);

try {
  const { context } = launched;
  const page = await context.newPage();
  page.on("console", (msg) => {
    const t = msg.type();
    const text = msg.text();
    if (t === "error" || t === "warning") {
      console.log(`  [browser console.${t}] ${text}`);
    } else if (/\[mint-debug\]|\[openkey\]|\[agent\]/.test(text)) {
      // Surface the source-level mint diagnostics (authHeader type/len, provider path).
      console.log(`  [browser console.${t}] ${text}`);
    }
  });
  page.on("pageerror", (err) => {
    console.log(`  [pageerror] ${err.message}`);
  });
  page.on("request", captureAgentSessionPost);
  page.on("response", (res) => {
    const url = res.url();
    if (url.includes("/api/agent/") || res.status() >= 400) {
      console.log(`  [net] ${res.status()} ${res.request().method()} ${url}`);
    }
  });

  await page.goto(config.frontendUrl, { waitUntil: "domcontentloaded" });
  await page.bringToFront();

  // Force a CLEAN, fresh sign-in so the restored tcw is WALLET-mode (can mint),
  // not session-only (Bug A). A persisted backend token would otherwise auto-
  // restore a session-only tcw → "Cannot createDelegation() in session-only mode".
  // Clearing localStorage does NOT remove the OS passkey, so sign-in still works.
  await page.evaluate(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      /* ignore */
    }
  });
  await page.reload({ waitUntil: "domcontentloaded" });

  // Landing page may need an "Open app" / "Launch" click before the chat UI.
  await page.getByRole("button", { name: /open app|launch|get started/i }).first()
    .click({ timeout: 4_000 }).catch(() => {});

  // Sign in (operator taps passkey).
  await page.getByRole("button", { name: "Sign in" }).first()
    .click({ timeout: 6_000 }).catch(() => {});
  console.log("");
  console.log(">>> OPERATOR: tap the passkey / Touch ID to SIGN IN.");
  const session = await waitForSignIn(context, config);
  console.log(`Signed in. Address: ${session.address ?? "<unknown>"}`);

  // Wait for the chat composer to confirm the app shell is up.
  await page.getByPlaceholder(/Message TinyCloud Chat/i).waitFor({ state: "visible", timeout: 30_000 })
    .catch(() => console.log("  (composer not found by placeholder — continuing)"));

  // Wait for the one-time Enable banner (capability must probe → "available").
  console.log("");
  console.log("Waiting for the 'Enable agent memory & tools' banner…");
  const enableBtn = page.getByRole("region", { name: "Agent tools" }).getByRole("button", { name: /^Enable$/ });
  await enableBtn.waitFor({ state: "visible", timeout: 30_000 }).catch(async () => {
    console.log("  ⚠ Enable banner did not appear in 30s. Capturing diagnostics:");
    await dumpDiagnostics(page);
    throw new Error("Enable banner never appeared (capability probe may be 'unavailable').");
  });
  console.log("  Enable banner is visible.");
  await page.screenshot({ path: "/tmp/eliza-e2e-before-enable.png", fullPage: true }).catch(() => {});

  // Click Enable → operator taps passkey for the MINT.
  await enableBtn.click();
  console.log("");
  console.log(">>> OPERATOR: tap the passkey / Touch ID to AUTHORIZE (mint the delegation).");

  // Wait for the POST /api/agent/session round-trip to resolve (operator-paced).
  const sessionResult = await waitForAgentSession(page, config, session.token);
  console.log("");
  console.log(`Agent session POST resolved: status=${sessionResult.httpStatus} body=${JSON.stringify(sessionResult.body)}`);
  await page.screenshot({ path: "/tmp/eliza-e2e-after-enable.png", fullPage: true }).catch(() => {});

  if (sessionResult.ok) {
    console.log("  ✅ Delegation registered with eliza (Bug B cleared).");
    await runWebSearchExchange(page);
  } else {
    console.log("  ❌ Agent session registration FAILED — see captured delegation + eliza log above.");
    await dumpDiagnostics(page);
  }

  console.log("");
  console.log("Holding the browser open for 60s for manual inspection…");
  await page.waitForTimeout(60_000);
} finally {
  await launched.close();
}

async function launchManualContext(config: RealAuthConfig): Promise<{
  close: () => Promise<void>;
  context: BrowserContext;
}> {
  const channel = config.browserChannel ?? "chrome";
  if (config.userDataDir) {
    const context = await chromium.launchPersistentContext(config.userDataDir, {
      channel,
      headless: false,
      viewport: { width: 1280, height: 900 },
    });
    return { context, close: () => context.close() };
  }
  const browser = await chromium.launch({ channel, headless: false });
  const context = await browser.newContext();
  return { context, close: () => browser.close() };
}

async function waitForSignIn(context: BrowserContext, config: RealAuthConfig): Promise<StoredSession> {
  const deadline = Date.now() + config.timeoutMs;
  let lastLogged = "";
  while (Date.now() < deadline) {
    const state = (await context.storageState()) as PlaywrightStorageState;
    const session = extractStoredSession(state, config.sessionStorageKey);
    let status: string;
    if (!session) status = "waiting for backend session token (complete passkey sign-in)…";
    else if (session.expiresAt <= Date.now() + 30_000) status = "session token expired/expiring…";
    else return session;
    if (status !== lastLogged) {
      console.log(`  ${status}`);
      lastLogged = status;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error("Timed out waiting for sign-in.");
}

interface AgentSessionResult {
  ok: boolean;
  httpStatus: number;
  body: unknown;
}

// Poll GET /api/agent/session until it reports active, OR detect the POST response.
// The operator paces the passkey tap, so we poll generously (3 min).
async function waitForAgentSession(
  page: Page,
  config: RealAuthConfig,
  token: string,
): Promise<AgentSessionResult> {
  // Prefer catching the actual POST response for the precise status/body.
  const postResp = await page
    .waitForResponse(
      (r) => r.url().includes("/api/agent/session") && r.request().method() === "POST",
      { timeout: 180_000 },
    )
    .catch(() => null);
  if (postResp) {
    const body = await postResp.json().catch(() => null);
    return { ok: postResp.ok(), httpStatus: postResp.status(), body };
  }
  // Fallback: poll status endpoint.
  const res = await fetch(`${config.backendUrl}/api/agent/session`, {
    headers: { Authorization: `Bearer ${token}`, "X-Requested-With": "XMLHttpRequest" },
  });
  return { ok: res.ok, httpStatus: res.status, body: await res.json().catch(() => null) };
}

async function runWebSearchExchange(page: Page): Promise<void> {
  const prompt = `Use web search to tell me one headline in the news today. Marker ${marker}`;
  const composer = page.getByPlaceholder(/Message TinyCloud Chat/i);
  await composer.waitFor({ state: "visible", timeout: 15_000 });
  console.log("");
  console.log(`Sending web-search prompt (marker ${marker})…`);
  await composer.click();
  await composer.pressSequentially(prompt, { delay: 5 });
  await composer.press("Enter");
  await page.getByRole("button", { name: "Send" }).click({ timeout: 2_000 }).catch(() => {});

  // Watch for the tool-activity chip (running → done).
  const chip = page.getByText(/search|tool|running/i).first();
  await chip.waitFor({ timeout: 30_000 }).then(
    () => console.log("  tool-activity chip appeared."),
    () => console.log("  (no obvious tool chip text matched — check screenshot)"),
  );
  await page.waitForTimeout(8_000);
  await page.screenshot({ path: "/tmp/eliza-e2e-tool-running.png", fullPage: true }).catch(() => {});

  // Wait for the streamed reply to settle.
  await page.waitForTimeout(20_000);
  await page.screenshot({ path: "/tmp/eliza-e2e-answer.png", fullPage: true }).catch(() => {});
  const text = await page.locator("body").innerText().catch(() => "<no text>");
  console.log("  --- visible page text after answer ---");
  console.log(text.split("\n").slice(-40).map((l) => "    " + l).join("\n"));
  console.log("  --- end ---");
}

async function dumpDiagnostics(page: Page): Promise<void> {
  await page.screenshot({ path: "/tmp/eliza-e2e-diagnostic.png", fullPage: true }).catch(() => {});
  const probe = await page
    .evaluate(async () => {
      try {
        const key = "xyz.tinycloud.tinychat:session";
        const raw = localStorage.getItem(key);
        const token = raw ? JSON.parse(raw).token : null;
        if (!token) return { error: "no token" };
        const res = await fetch("/api/agent/session", {
          headers: { Authorization: `Bearer ${token}`, "X-Requested-With": "XMLHttpRequest" },
        });
        return { status: res.status, body: await res.text() };
      } catch (e) {
        return { error: String(e) };
      }
    })
    .catch((e) => ({ error: String(e) }));
  console.log(`  [diag] GET /api/agent/session → ${JSON.stringify(probe)}`);
}
