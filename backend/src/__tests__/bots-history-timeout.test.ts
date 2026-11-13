import { afterEach, expect, spyOn, test } from "bun:test";
import express from "express";
import { createBotsRouter } from "../routes/bots.js";

const mocks: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const mock of mocks.splice(0)) mock.mockRestore(); });
async function route(upstream: typeof fetch) {
  const app = express();
  app.use(createBotsRouter({ config: { serviceUrl: "http://supervisor.test", serviceSecret: "test-only", accountAllowed: () => true, postTimeoutMs: 120_000, fetchImpl: upstream },
    authMiddleware: (req, _res, next) => { req.user = { address: "0x1111111111111111111111111111111111111111" } as typeof req.user; next(); } }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/main/messages`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
function clock() {
  const deadlines: Array<{ ms: number; controller: AbortController }> = [];
  mocks.push(spyOn(AbortSignal, "timeout").mockImplementation(ms => { const controller = new AbortController(); deadlines.push({ ms, controller }); return controller.signal; }));
  return { deadlines, advance: (elapsed: number) => { for (const item of deadlines) if (elapsed >= item.ms) item.controller.abort(new DOMException("Timed out", "TimeoutError")); } };
}

test("GET permits a cold history response after 10 seconds and forwards the actual messages", async () => {
  const time = clock();
  const started = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<Response>();
  const run = await route((async (_url, init) => { started.resolve(); return Promise.race([answer.promise, new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)))]); }) as typeof fetch);
  try {
    const request = fetch(run.url);
    await started.promise;
    time.advance(10_001);
    expect(time.deadlines[0]!.controller.signal.aborted).toBe(false);
    time.advance(240_000);
    expect(time.deadlines[0]!.controller.signal.aborted).toBe(false);
    const messages = [{ id: "older", role: "bot", text: "earlier" }];
    answer.resolve(Response.json({ messages }));
    const response = await request;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ messages });
  } finally { await run.close(); }
});

test("GET remains bounded at 300 seconds and returns a truthful retryable failure", async () => {
  const time = clock();
  const started = Promise.withResolvers<void>();
  const run = await route((async (_url, init) => { started.resolve(); return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason))); }) as typeof fetch);
  try {
    const request = fetch(run.url);
    await started.promise;
    time.advance(300_000);
    expect(time.deadlines[0]!.controller.signal.aborted).toBe(true);
    const response = await request;
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "bot_unavailable", message: "Main isn't available. Try again later." });
  } finally { await run.close(); }
});

test("an upstream error is not converted into an empty successful history", async () => {
  const run = await route((async () => new Response(null, { status: 503 })) as typeof fetch);
  try { expect((await fetch(run.url)).status).toBe(502); } finally { await run.close(); }
});
