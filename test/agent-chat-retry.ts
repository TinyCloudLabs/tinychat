// Milestone E DoD #2/#3 retry — the agent session is ALREADY registered server-side
// (Bug B fixed in agent-flow-manual.ts). This restores the persisted session (no
// passkey tap, no re-mint), then sends a web-search prompt to exercise the
// tool-calling turn: RedPill tool_calls → eliza /tools/web_search → streamed answer
// + receipt + verification badge. Run after the RedPill rate limit (429) clears.

import { chromium, type BrowserContext } from "playwright";
import {
  extractStoredSession,
  resolveRealAuthCommandEnv,
  resolveRealAuthConfig,
  type PlaywrightStorageState,
  type RealAuthConfig,
} from "./real-auth-support.ts";

const repoRoot = new URL("..", import.meta.url).pathname;
const env = resolveRealAuthCommandEnv({ cwd: repoRoot, env: process.env });
const config = resolveRealAuthConfig({ cwd: repoRoot, env });
const marker = `eliza-retry-${Date.now().toString(36)}`;

console.log("=== Milestone E agent-chat RETRY (tool turn; restored session, no re-mint) ===");
console.log(`Frontend: ${config.frontendUrl}`);

const channel = config.browserChannel ?? "chrome";
const context: BrowserContext = await chromium.launchPersistentContext(config.userDataDir!, {
  channel,
  headless: false,
  viewport: { width: 1280, height: 900 },
});

try {
  const page = await context.newPage();
  page.on("console", (msg) => {
    const t = msg.type();
    const text = msg.text();
    if (t === "error" || t === "warning" || /\[agent\]|\[mint-debug\]|tool/i.test(text)) {
      console.log(`  [browser console.${t}] ${text}`);
    }
  });
  page.on("response", (res) => {
    const url = res.url();
    if (url.includes("/api/agent/") || res.status() >= 400) {
      console.log(`  [net] ${res.status()} ${res.request().method()} ${url}`);
    }
  });

  await page.goto(config.frontendUrl, { waitUntil: "domcontentloaded" });
  await page.bringToFront();

  // Fresh sign-in (a RESTORED session can hang the message pane on stuck history
  // skeletons so the composer never renders — a fresh session renders cleanly).
  // The agent session is already registered server-side, so the probe returns
  // "enabled" → NO Enable mint, just a single sign-in passkey tap.
  await page.evaluate(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      /* ignore */
    }
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  // Landing page may need an "Open app" click.
  await page.getByRole("button", { name: /open app|launch|get started/i }).first()
    .click({ timeout: 4_000 }).catch(() => {});

  const signInBtn = page.getByRole("button", { name: "Sign in" }).first();
  await signInBtn.click({ timeout: 6_000 }).catch(() => {});
  console.log(">>> OPERATOR: tap the passkey / Touch ID to SIGN IN (one tap; no Enable needed).");
  await waitForSignIn(context, config);
  console.log("Signed in.");

  const composer = page.getByPlaceholder(/Message TinyCloud Chat/i);
  await composer.waitFor({ state: "visible", timeout: 30_000 });

  // Give the capability probe a moment to flip the agent path on (enabled).
  await page.waitForTimeout(2_500);

  const prompt = `Use web search to give me one news headline from today, then cite the source. Marker ${marker}`;
  console.log(`Sending web-search prompt (marker ${marker})…`);
  await composer.click();
  await composer.pressSequentially(prompt, { delay: 5 });
  await composer.press("Enter");
  await page.getByRole("button", { name: "Send" }).click({ timeout: 2_000 }).catch(() => {});

  // Observe the tool chip then the streamed answer.
  await page.getByText(/search|tool|running/i).first().waitFor({ timeout: 30_000 })
    .then(() => console.log("  tool-activity chip appeared."), () => {});
  await page.waitForTimeout(8_000);
  await page.screenshot({ path: "/tmp/eliza-e2e-retry-running.png", fullPage: true }).catch(() => {});
  await page.waitForTimeout(25_000);
  await page.screenshot({ path: "/tmp/eliza-e2e-retry-answer.png", fullPage: true }).catch(() => {});

  const text = await page.locator("[data-message-role='assistant'], .aui-assistant-message, body")
    .last().innerText().catch(() => "<no text>");
  console.log("  --- assistant area text (tail) ---");
  console.log(text.split("\n").slice(-40).map((l) => "    " + l).join("\n"));
  console.log("  --- end ---");

  console.log("Holding open 90s for inspection…");
  await page.waitForTimeout(90_000);
} finally {
  await context.close();
}

async function waitForSignIn(ctx: BrowserContext, cfg: RealAuthConfig) {
  const deadline = Date.now() + cfg.timeoutMs;
  while (Date.now() < deadline) {
    const state = (await ctx.storageState()) as PlaywrightStorageState;
    const s = extractStoredSession(state, cfg.sessionStorageKey);
    if (s && s.expiresAt > Date.now() + 30_000) return;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error("sign-in timeout");
}
