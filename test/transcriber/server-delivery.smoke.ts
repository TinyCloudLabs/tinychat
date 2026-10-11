// S1 live smoke: real browser sign-in and real dev node, mock PTX only.
// Launch backend with stdout redirected to transcriber/.backend.log before this driver.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Frame, type Page } from "playwright";
import { DEFAULT_SESSION_STORAGE_KEY, extractStoredSession } from "../real-auth-support.ts";

const appUrl = process.env.APP_URL ?? "https://localhost:5186";
const backendUrl = process.env.BACKEND_URL ?? "http://127.0.0.1:3014";
const mockUrl = process.env.MOCK_PTX_URL ?? "http://127.0.0.1:4555";
const passkeyPath = resolve(process.env.PASSKEY_PATH ?? "/tmp/e2e/.passkey.json");
const logPath = resolve(process.env.BACKEND_LOG_PATH ?? new URL("./.backend.log", import.meta.url).pathname);
const timeoutMs = Number(process.env.SMOKE_AUTH_TIMEOUT_MS ?? "120000");
const here = new URL(".", import.meta.url);
// A per-run room, so a re-run on the same throwaway account finds exactly this run's Library row.
const room = `tc641-smoke-${Date.now().toString(36)}`;
const meetingUrl = `https://meet.ffmuc.net/${room}`;
const meetingTitle = `${room} (meet.ffmuc.net)`;
const expectedText = "Hello from Alice.";

function requireFile(path: string, description: string): void {
  if (!existsSync(path)) throw new Error(`${description} not found at ${path}`);
}

// Persist ONLY the shape. Never persist the SIWE, signature, Bearer token or JWT.
function captureRequest(raw: string): Record<string, unknown> {
  const body = JSON.parse(raw) as { serialized?: string; siwe?: string; signature?: string };
  if (!body.serialized || !body.siwe || !body.signature) throw new Error("Delegation POST lacks serialized/siwe/signature");
  const bundle = JSON.parse(body.serialized) as Record<string, unknown>;
  const authorization = (bundle.delegationHeader as { Authorization?: string } | undefined)?.Authorization;
  if (!authorization) throw new Error("Delegation POST lacks UCAN Authorization");
  const parts = authorization.replace(/^Bearer\s+/i, "").split(".");
  if (parts.length !== 3) throw new Error("Delegation Authorization is not a compact UCAN");
  const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as Record<string, unknown>;
  const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  const att = payload.att && typeof payload.att === "object" ? payload.att as Record<string, unknown> : {};
  const uri = body.siwe.match(/^URI:\s*(\S+)\s*$/im)?.[1];
  if (!uri) throw new Error("Delegation SIWE URI not found");
  return {
    bodyKeys: Object.keys(body).sort(), bundleKeys: Object.keys(bundle).sort(),
    host: typeof bundle.host === "string" ? bundle.host : null, siweUri: uri,
    ucan: {
      headerKeys: Object.keys(header).sort(), alg: typeof header.alg === "string" ? header.alg : null,
      payloadKeys: Object.keys(payload).sort(), aud: typeof payload.aud === "string" ? payload.aud : null,
      att: Object.fromEntries(Object.entries(att).map(([resource, abilities]) => [
        resource, abilities && typeof abilities === "object"
          ? Object.fromEntries(Object.entries(abilities).map(([action, conditions]) => [action, Array.isArray(conditions) ? conditions.map((condition) => condition && typeof condition === "object" ? Object.keys(condition) : typeof condition) : "non-array"]))
          : {},
      ])),
    },
  };
}

let nextSignCount = Math.floor(Date.now() / 1000);
function logOffset(): number { return existsSync(logPath) ? readFileSync(logPath).length : 0; }
async function awaitDelivery(id: string, offset: number): Promise<string> {
  const deadline = Date.now() + 60_000;
  let lastLog = "no transcript-delivery lines after completing meeting";
  while (Date.now() < deadline) {
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    const recent = Buffer.from(log).subarray(offset).toString("utf8");
    const lines = recent.split(/\r?\n/).filter((line) => line.includes("[transcript-delivery]"));
    const matching = lines.filter((line) => line.includes(`id=${id}`));
    const written = matching.find((line) => /op=deliver\s+result=written\b/.test(line));
    if (written) return `[transcript-delivery] op=deliver result=written id=${id}`;
    const last = matching.at(-1) ?? lines.at(-1);
    if (last) {
      const result = last.match(/\bresult=([a-z_]+)\b/)?.[1] ?? "absent";
      const operation = last.match(/\bop=([a-z_]+)\b/)?.[1] ?? "absent";
      lastLog = `op=${operation} result=${result}`;
    }
    await Bun.sleep(500);
  }
  // Backend logs may contain sensitive request data from unrelated work: report
  // only delivery lines, never dump the full log file.
  throw new Error(`No result=written id=${id} within 60s; last delivery line: ${lastLog}`);
}

function loadCredentials(): Record<string, unknown>[] {
  requireFile(passkeyPath, "Virtual passkey credential fixture");
  const contents = JSON.parse(readFileSync(passkeyPath, "utf8")) as unknown;
  if (!Array.isArray(contents) || contents.length === 0) throw new Error("Passkey fixture contains no credentials");
  return contents as Record<string, unknown>[];
}

async function signIn(context: BrowserContext, page: Page, credentials: Record<string, unknown>[]): Promise<void> {
  const attached = new WeakSet<Frame>();
  const sessions: CDPSession[] = [];
  const failures: string[] = [];
  const responses: string[] = [];
  const pendingRequests = new Set<string>();
  const requestKey = (url: string) => {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  };
  page.on("request", (request) => { pendingRequests.add(requestKey(request.url())); });
  page.on("requestfinished", (request) => { pendingRequests.delete(requestKey(request.url())); });
  page.on("requestfailed", (request) => { pendingRequests.delete(requestKey(request.url())); });
  page.on("response", (response) => {
    responses.push(`${response.status()} ${requestKey(response.url())}`);
    if (response.status() < 400) return;
    const url = new URL(response.url());
    failures.push(`${response.status()} ${url.hostname}${url.pathname}`);
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    failures.push(`failed ${url.hostname}${url.pathname}`);
  });
  const attach = async (frame: Frame) => {
    if (!/openkey\.so\/widget\/embed\/(connect|sign)/.test(frame.url()) || attached.has(frame)) return;
    attached.add(frame);
    const cdp = await context.newCDPSession(frame).catch(() => context.newCDPSession(page));
    sessions.push(cdp);
    await cdp.send("WebAuthn.enable", { enableUI: false });
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true,
        hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
    for (const credential of credentials) {
      await cdp.send("WebAuthn.addCredential", {
        authenticatorId, credential: { ...credential, signCount: ++nextSignCount },
      });
    }
  };
  const attaching = new Set<Promise<void>>();
  const attachErrors: unknown[] = [];
  const onFrame = (frame: Frame) => {
    const pending = attach(frame).catch((error: unknown) => { attachErrors.push(error); });
    attaching.add(pending);
    void pending.finally(() => { attaching.delete(pending); });
  };
  page.on("framenavigated", onFrame);
  try {
    await page.goto(new URL("/chat", appUrl).toString(), { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Sign in", exact: true }).click({ timeout: 30_000 });
    const frameDeadline = Date.now() + 30_000;
    while (!page.frame({ url: /openkey\.so\/widget\/embed\/(connect|sign)/ }) && Date.now() < frameDeadline) {
      await page.waitForTimeout(250);
    }
    for (const frame of page.frames()) onFrame(frame);
    await Promise.all(attaching);
    if (attachErrors.length > 0) throw new Error("Could not attach OpenKey virtual authenticator", { cause: attachErrors[0] });
    const widget = page.frame({ url: /openkey\.so\/widget\/embed\/(connect|sign)/ });
    if (!widget) {
      const frames = page.frames().map((frame) => requestKey(frame.url()));
      const appState = (await page.locator("body").innerText()).slice(0, 160);
      throw new Error(`OpenKey embedded frame did not load; frames=${JSON.stringify(frames)}, app=${JSON.stringify(appState)}, failures=${JSON.stringify(failures.slice(-6))}`);
    }
    // OpenKey can first show a remembered account or the method chooser.
    const passkey = widget.getByRole("button", { name: /passkey/i });
    if (await passkey.waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false)) await passkey.click();
    const deadline = Date.now() + timeoutMs;
    const passkeyFrames = new WeakSet<Frame>();
    passkeyFrames.add(widget);
    const approvedFrames = new WeakSet<Frame>();
    while (Date.now() < deadline) {
      const session = extractStoredSession(await context.storageState(), DEFAULT_SESSION_STORAGE_KEY);
      if (session && session.expiresAt > Date.now() + 30_000) return;
      const current = page.frames().find((frame) => /openkey\.so\/widget\/embed\/(connect|sign)/.test(frame.url()));
      if (current) {
        await Promise.all([...attaching]);
        if (attachErrors.length) throw new Error("Could not attach OpenKey signing authenticator", { cause: attachErrors[0] });
        const choice = current.getByRole("button", { name: /passkey/i });
        if (!passkeyFrames.has(current) && await choice.isVisible({ timeout: 500 }).catch(() => false) &&
            await choice.isEnabled({ timeout: 500 }).catch(() => false)) {
          passkeyFrames.add(current);
          await choice.click().catch((error: unknown) => { if (!current.isDetached()) throw error; });
        }
        const approve = current.getByRole("button", { name: /^approve$/i });
        if (!approvedFrames.has(current) && await approve.isVisible({ timeout: 500 }).catch(() => false) &&
            await approve.isEnabled({ timeout: 500 }).catch(() => false)) {
          approvedFrames.add(current);
          await approve.click().catch((error: unknown) => { if (!current.isDetached()) throw error; });
        }
      }
      await Bun.sleep(500);
    }
    const controls = widget.isDetached() ? ["frame_detached"] :
      (await widget.locator("button").allTextContents().catch(() => ["frame_unavailable"])).map((label) =>
        label.trim().replace(/[^\s@]+@[^\s@]+/g, "[email]").slice(0, 80),
      );
    const appState = page.isClosed() ? "page_closed" :
      (await page.locator("body").innerText().catch(() => "page_unavailable")).replace(/[^\s@]+@[^\s@]+/g, "[email]").slice(0, 160);
    const frames = page.frames().map((frame) => requestKey(frame.url()));
    const active = page.frames().find((frame) => /openkey\.so\/widget\/embed\/sign/.test(frame.url()));
    const signControls = active ? await active.locator("button").allTextContents().catch(() => ["unavailable"]) : [];
    throw new Error(`Sign-in timed out; OpenKey controls=${JSON.stringify(controls)}, signControls=${JSON.stringify(signControls.map((label) => label.trim().slice(0, 80)))}, app=${JSON.stringify(appState)}, failures=${JSON.stringify(failures.slice(-6))}, pending=${JSON.stringify([...pendingRequests].slice(-6))}, frames=${JSON.stringify(frames)}, apiResponses=${JSON.stringify(responses.filter((line) => /api|invoke|auth|info/.test(line)).slice(-12))}`);
  } finally {
    page.off("framenavigated", onFrame);
    for (const cdp of sessions) await cdp.detach().catch(() => {});
  }
}

async function run(): Promise<void> {
  requireFile(logPath, "Backend stdout capture (set BACKEND_LOG_PATH)");
  const credentials = loadCredentials();
  const browser: Browser = await chromium.launch({ headless: true, args: ["--site-per-process"] });
  let first: BrowserContext | undefined;
  let second: BrowserContext | undefined;
  try {
    first = await browser.newContext();
    const page = await first.newPage();
    const posts: { status: number; verified: boolean; active: boolean; error?: string }[] = [];
    let shape: Record<string, unknown> | undefined;
    let requestCount = 0;
    let captureError: unknown;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname !== "/api/delegations" || request.method() !== "POST") return;
      requestCount++;
      try { shape = captureRequest(request.postData() ?? ""); } catch (error) { captureError = error; }
    });
    page.on("response", (response) => {
      if (new URL(response.url()).pathname !== "/api/delegations" || response.request().method() !== "POST") return;
      void response.json().then((body: { status?: string; verified?: boolean; error?: string }) => {
        posts.push({ status: response.status(), verified: body.verified === true, active: body.status === "active", error: body.error });
      }).catch(() => posts.push({ status: response.status(), verified: false, active: false }));
    });
    await signIn(first, page, credentials);
    const deadline = Date.now() + 60_000;
    while (posts.length === 0 && Date.now() < deadline) await page.waitForTimeout(250);
    if (captureError) throw new Error("V1 shape capture failed", { cause: captureError });
    if (requestCount !== 1 || posts.length !== 1 || posts[0]?.status !== 200 || !posts[0].active || !posts[0].verified || !shape) {
      throw new Error(`Expected one active verified delegation POST 200; sent ${requestCount}, responses ${JSON.stringify(posts)}, grantShape=${JSON.stringify(shape)}`);
    }
    // Write safe structural V1 capture, never bearer/session material.
    writeFileSync(new URL("./.v1-capture.json", here), JSON.stringify(shape, null, 2) + "\n", { mode: 0o600 });
    for (let i = 0; i < 3; i++) {
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
      if (requestCount !== 1) throw new Error(`Reload ${i + 1} minted an extra delegation (${requestCount} POSTs)`);
    }
    const session = extractStoredSession(await first.storageState(), DEFAULT_SESSION_STORAGE_KEY);
    if (!session) throw new Error("Signed-in browser has no backend token");
    const meeting = await page.evaluate(async ({ backendUrl, token, meetingUrl }) => {
      const response = await fetch(`${backendUrl}/api/transcriber/meetings`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/json" },
        body: JSON.stringify({ meeting_url: meetingUrl }),
      });
      if (response.status !== 201) throw new Error(`Create meeting returned HTTP ${response.status}`);
      return response.json() as Promise<{ id: string }>;
    }, { backendUrl, token: session.token, meetingUrl });
    if (!/^mtg_[A-Za-z0-9_-]+$/.test(meeting.id)) throw new Error("Backend returned an unusable meeting id");
    await first.close();
    first = undefined;
    if (browser.contexts().length !== 0) throw new Error("Browser contexts still open during webhook delivery");
    const offset = logOffset();
    const complete = await fetch(`${mockUrl}/__complete/${encodeURIComponent(meeting.id)}`, { method: "POST" });
    const webhook = await complete.json() as { webhook_status?: number; error?: { code?: string } };
    if (complete.status !== 200 || webhook.webhook_status !== 202) {
      throw new Error(`Mock completion failed: admin HTTP ${complete.status}, webhook HTTP ${webhook.webhook_status ?? "absent"}, code ${webhook.error?.code ?? "none"}`);
    }
    const deliveryLine = await awaitDelivery(meeting.id, offset);
    second = await browser.newContext();
    const restored = await second.newPage();
    const transcriptGets: string[] = [];
    second.on("request", (request) => {
      if (request.method() === "GET" && new URL(request.url()).pathname === `/api/transcriber/meetings/${meeting.id}/transcript`) {
        transcriptGets.push(request.url());
      }
    });
    await signIn(second, restored, credentials);
    // Navigate the real Capture → Library UI; do not seed browser state or a mocked SQL response.
    await restored.getByRole("link", { name: "Capture", exact: true }).click({ timeout: 30_000 });
    await restored.getByRole("link", { name: "Library", exact: true }).click({ timeout: 30_000 });
    const row = restored.getByTestId("library-item").filter({ hasText: meetingTitle });
    await row.waitFor({ state: "visible", timeout: 60_000 });
    await row.click();
    await restored.getByTestId("note-transcript").getByText(expectedText).waitFor({ state: "visible", timeout: 30_000 });
    if (transcriptGets.length !== 0) throw new Error(`Browser fetched the PTX transcript ${transcriptGets.length} time(s)`);
    const evidence = {
      meetingId: meeting.id, delegationPost: posts[0], reloadsWithoutMint: 3,
      noTabsDuringCompletion: true, webhookStatus: webhook.webhook_status,
      delivery: deliveryLine, libraryTitle: meetingTitle, transcriptText: expectedText,
      browserTranscriptGetCount: transcriptGets.length, completedAt: new Date().toISOString(),
    };
    writeFileSync(new URL("./.last-smoke.json", here), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
    console.log(`TC-641 S1 smoke passed: meeting=${meeting.id}, webhook=202, result=written, Library transcript visible, browser transcript GETs=0`);
  } finally {
    await first?.close();
    await second?.close();
    await browser.close();
  }
}

await run();
