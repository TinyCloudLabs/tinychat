import { chromium, type BrowserContext, type Page } from "playwright";

import {
  extractStoredSession,
  fetchBackendIdentity,
  resolveRealAuthCommandEnv,
  resolveRealAuthConfig,
  type PlaywrightStorageState,
  type RealAuthConfig,
  type StoredSession,
} from "./real-auth-support.ts";

const repoRoot = new URL("..", import.meta.url).pathname;
const env = resolveRealAuthCommandEnv({ cwd: repoRoot, env: process.env });
const config = resolveRealAuthConfig({ cwd: repoRoot, env });

// A unique marker we send in the prompt so we can prove, after reload, that the
// conversation was persisted to (and restored from) the user's TinyCloud space.
const marker = `e2e-${Date.now().toString(36)}`;
const replyToken = "TINYCHAT_E2E_OK";

console.log("Starting headed Playwright for TinyChat real auth + chat round-trip.");
console.log(`Frontend: ${config.frontendUrl}`);
console.log(`Backend:  ${config.backendUrl}`);
console.log(
  `Browser: ${config.browserChannel ?? "installed Chrome if available, otherwise bundled Chromium"}`,
);
if (config.userDataDir) console.log(`Browser profile: ${config.userDataDir}`);
console.log("");
console.log("In the browser window:");
console.log("  1. Click \"Sign in\" (it may be clicked for you) and complete the OpenKey passkey.");
console.log("  2. Approve TinyCloud space creation if prompted.");
console.log("Playwright resumes automatically once your backend session token appears.");
console.log(
  "Use HTTP localhost or trusted HTTPS. WebAuthn is not supported on sites with TLS certificate errors.",
);

const launched = await launchManualContext(config);

try {
  const { context } = launched;
  const page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log(`  [browser console.error] ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    console.log(`  [pageerror] ${err.message}`);
    if (err.stack) console.log(err.stack.split("\n").slice(0, 6).map((l) => "      " + l).join("\n"));
  });
  page.on("response", (res) => {
    const url = res.url();
    if (url.includes("/api/") || res.status() >= 400) {
      console.log(`  [net] ${res.status()} ${res.request().method()} ${url}`);
    }
  });
  await openFrontendPage(page, config.frontendUrl);
  await page.bringToFront();

  // Nudge the flow along: click "Sign in" if it is present. The human still
  // completes the passkey + space-creation prompts.
  await page
    .getByRole("button", { name: "Sign in" })
    .click({ timeout: 5_000 })
    .catch(() => {});

  const session = await waitForSignIn(context, config);
  console.log("");
  console.log(`Signed in. Address: ${session.address ?? "<unknown>"}`);
  // Identity is informational only; a Bun-side TLS hiccup must not abort the test.
  try {
    const identity = await fetchBackendIdentity(config.backendUrl);
    console.log(`App id: ${identity.appId}`);
    console.log(`Backend DID: ${identity.backendDid}`);
  } catch (error) {
    console.log(`(skipped backend identity fetch: ${errorMessage(error)})`);
  }

  await runChatExchange(page);
  await verifyPersistence(page, config);

  console.log("");
  console.log("✅ Verified: real sign-in, streamed RedPill reply, and TinyCloud-persisted history.");
} finally {
  await launched.close();
}

async function launchManualContext(config: RealAuthConfig): Promise<{
  close: () => Promise<void>;
  context: BrowserContext;
}> {
  const preferredChannel = config.browserChannel ?? "chrome";

  const launchWithChannel = async (channel: string | undefined) => {
    if (config.userDataDir) {
      const context = await chromium.launchPersistentContext(config.userDataDir, {
        channel,
        headless: false,
      });
      return { context, close: () => context.close() };
    }

    const browser = await chromium.launch({ channel, headless: false });
    const context = await browser.newContext();
    return { context, close: () => browser.close() };
  };

  try {
    return await launchWithChannel(preferredChannel);
  } catch (error) {
    if (config.browserChannel) throw error;
    console.warn(
      `Could not launch installed Chrome (${errorMessage(error)}). Falling back to bundled Chromium.`,
    );
    console.warn(
      "If the passkey prompt asks for a security key, install Chrome and rerun with REAL_AUTH_BROWSER=chrome REAL_AUTH_USER_DATA_DIR=.auth/chrome-profile.",
    );
    return launchWithChannel(undefined);
  }
}

async function openFrontendPage(page: Page, frontendUrl: string): Promise<void> {
  try {
    await page.goto(frontendUrl, { waitUntil: "domcontentloaded" });
  } catch (error) {
    const message = errorMessage(error);
    if (
      message.includes("ERR_CERT") ||
      message.includes("SSL") ||
      message.includes("certificate")
    ) {
      throw new Error(
        `Could not open ${frontendUrl} because the browser rejected its TLS certificate. Use HTTP localhost or trusted HTTPS. WebAuthn is not supported on sites with TLS certificate errors.`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function waitForSignIn(
  context: BrowserContext,
  config: RealAuthConfig,
): Promise<StoredSession> {
  const deadline = Date.now() + config.timeoutMs;
  let lastStatus = "waiting for browser session";
  let lastLogged = "";

  while (Date.now() < deadline) {
    const browserState = (await context.storageState()) as PlaywrightStorageState;
    const session = extractStoredSession(browserState, config.sessionStorageKey);
    if (!session) {
      lastStatus = "waiting for backend session token in browser storage (complete sign-in)";
    } else if (session.expiresAt <= Date.now() + 30_000) {
      lastStatus = "backend session token is expired or about to expire";
    } else {
      return session;
    }

    if (lastStatus !== lastLogged) {
      console.log(lastStatus);
      lastLogged = lastStatus;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Timed out waiting for sign-in: ${lastStatus}`);
}

async function runChatExchange(page: Page): Promise<void> {
  const prompt = `Reply with exactly: ${replyToken} and nothing else. Marker ${marker}`;
  const composer = page.getByPlaceholder(/Message TinyChat/);
  await composer.waitFor({ state: "visible", timeout: 30_000 });
  console.log("");
  console.log(`Sending test message (marker ${marker})...`);
  await composer.click();
  // Real keystrokes so assistant-ui's controlled composer updates its send state.
  await composer.pressSequentially(prompt, { delay: 5 });
  console.log(`  composer value after type: ${JSON.stringify(await composer.inputValue())}`);
  const sendBtn = page.getByRole("button", { name: "Send" });
  console.log(`  Send button enabled: ${await sendBtn.isEnabled().catch(() => "n/a")}`);
  await composer.press("Enter");
  await sendBtn.click({ timeout: 2_000 }).catch(() => {});
  console.log("  submitted; waiting 4s then capturing state...");
  await page.waitForTimeout(4_000);
  await page.screenshot({ path: "/tmp/tinychat-after-send.png", fullPage: true }).catch(() => {});
  const viewportText = await page
    .locator("body")
    .innerText()
    .catch(() => "<no text>");
  console.log("  --- visible page text after send ---");
  console.log(viewportText.split("\n").map((l) => "    " + l).join("\n"));
  console.log("  --- end page text ---");

  // The user bubble should render with our marker.
  await page.getByText(marker, { exact: false }).first().waitFor({ timeout: 15_000 });
  // The assistant reply streams in from the RedPill proxy.
  await page.getByText(replyToken, { exact: false }).first().waitFor({ timeout: 90_000 });
  console.log(`Received streamed assistant reply containing "${replyToken}".`);
}

async function verifyPersistence(page: Page, config: RealAuthConfig): Promise<void> {
  console.log("");
  console.log("Reloading to verify the conversation was persisted to TinyCloud...");
  await page.reload({ waitUntil: "domcontentloaded" });

  // Our run is the newest thread, so its sidebar item (a button — distinct from
  // message text) is the first one whose title starts with the prompt. Open it.
  const sidebarItem = page.getByRole("button", { name: /Reply with exactly/ }).first();
  await sidebarItem.waitFor({ state: "visible", timeout: 45_000 });
  await sidebarItem.click();

  // The restored message body carries the full marker, and the assistant reply
  // is restored from KV (not just the truncated title).
  await page.getByText(marker, { exact: false }).first().waitFor({ timeout: 30_000 });
  await page.getByText(replyToken, { exact: false }).first().waitFor({ timeout: 30_000 });
  console.log(`Conversation restored from TinyCloud space at ${config.frontendUrl}.`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
