import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot, RunningLimit, type Sandbox, type SandboxLauncher } from "../bot";
import { botLayout } from "../layout";
import { type BotApi, createApp } from "../server";
import { signedCallHeader } from "../signed-call";
import { INVALID_HOSTS, readWebPolicy } from "../web-policy";

const OPTIONS = { idleMs: 60_000, turnTimeoutMs: 300_000, maxTurnBytes: 1024 };

function setup(launcher: Partial<SandboxLauncher> = {}) {
  const root = mkdtempSync(join(tmpdir(), "bot-web-"));
  const layout = botLayout("c".repeat(64), { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") });
  const base: SandboxLauncher = { hasState: () => false, leftover: () => false, launch: async () => ({}) as Sandbox };
  return { bot: new Bot(layout, { ...base, ...launcher }, OPTIONS, new RunningLimit(1)), layout };
}

describe("the owner's web setting", () => {
  test("is off until set, is saved where the sandbox cannot reach it, and is given to the gateway", async () => {
    const pushed: unknown[] = [];
    const { bot, layout } = setup({ pushWeb: async l => void pushed.push(readWebPolicy(l)) });
    expect((await bot.webSettings()).mode).toBe("off");
    await bot.setWebPolicy({ mode: "listed", hosts: ["docs.rs"] });
    expect(pushed).toEqual([{ mode: "listed", hosts: ["docs.rs"] }]);
    expect(readWebPolicy(layout)).toEqual({ mode: "listed", hosts: ["docs.rs"] });
    expect(layout.dataDir.startsWith(layout.stateMount)).toBe(false);
  });

  test("when the gateway cannot take a new setting the old one stays, and the save fails", async () => {
    const { bot, layout } = setup({
      pushWeb: async l => {
        if (readWebPolicy(l).mode === "any") throw new Error("gateway down");
      },
    });
    await bot.setWebPolicy({ mode: "listed", hosts: ["docs.rs"] });
    await expect(bot.setWebPolicy({ mode: "any", hosts: [] })).rejects.toThrow("gateway down");
    expect(readWebPolicy(layout)).toEqual({ mode: "listed", hosts: ["docs.rs"] });
  });

  test("saves are one at a time, and a failed push says the old setting to the gateway again", async () => {
    const order: string[] = [];
    const release = Promise.withResolvers<void>();
    let pushes = 0;
    const { bot } = setup({
      pushWeb: async l => {
        order.push(`push:${readWebPolicy(l).mode}`);
        if (++pushes === 1) await release.promise;
      },
    });
    const first = bot.setWebPolicy({ mode: "listed", hosts: ["docs.rs"] });
    const second = bot.setWebPolicy({ mode: "any", hosts: [] });
    await Bun.sleep(20);
    expect(order).toEqual(["push:listed"]);
    release.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["push:listed", "push:any"]);

    const attempts: string[] = [];
    const failing = setup({
      pushWeb: async l => {
        attempts.push(readWebPolicy(l).mode);
        if (attempts.length === 2) throw new Error("timed out");
      },
    });
    await failing.bot.setWebPolicy({ mode: "listed", hosts: ["docs.rs"] });
    await expect(failing.bot.setWebPolicy({ mode: "any", hosts: [] })).rejects.toThrow("timed out");
    expect(attempts).toEqual(["listed", "any", "listed"]);
  });

  test("shows counts only; a gateway that cannot answer, or answers with junk, reads as unavailable with zero counts", async () => {
    const answers: unknown[] = [{ available: true, today: { searches: 4, pages: 9, blocked: 1, query: "secret" } }, new Error("down"), { available: true, today: { searches: -1, pages: "x" } }, "junk"];
    const { bot } = setup({
      webStatus: async () => {
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    });
    expect(await bot.webSettings()).toEqual({ mode: "off", hosts: [], available: true, today: { searches: 4, pages: 9, blocked: 1 } });
    expect(await bot.webSettings()).toEqual({ mode: "off", hosts: [], available: false, today: { searches: 0, pages: 0, blocked: 0 } });
    expect((await bot.webSettings()).today).toEqual({ searches: 0, pages: 0, blocked: 0 });
    expect((await bot.webSettings()).available).toBe(false);
  });
});

describe("the web service routes", () => {
  const SECRET = "s".repeat(64);
  const OWNER = "did:pkh:eip155:1:0x00000000000000000000000000000000000000aa";
  const put = (app: ReturnType<typeof createApp>, input: unknown, secret = SECRET) => {
    const body = typeof input === "string" ? input : JSON.stringify(input);
    const path = "/v1/bots/main/web";
    return app(new Request(`http://bots.internal${path}`, {
      method: "PUT", headers: { authorization: signedCallHeader(secret, { direction: "to-service", environment: "private", owner: OWNER, bot: "main", method: "PUT", path, body }) }, body,
    }));
  };

  function app(overrides: Partial<BotApi> = {}) {
    const saved: unknown[] = [];
    const bot: BotApi = {
      send: async () => {}, list: async () => [],
      webSettings: async () => ({ mode: "off", hosts: [], available: true, today: { searches: 0, pages: 0, blocked: 0 } }),
      setWebPolicy: async policy => (saved.push(policy), { ...policy, available: true, today: { searches: 0, pages: 0, blocked: 0 } }),
      ...overrides,
    };
    return { saved, app: createApp({ secret: SECRET, accounts: "*", bots: { forOwner: () => bot } }) };
  }

  test("a bad setting is a 400 with an owner-safe sentence and never reaches the bot", async () => {
    const { app: handler, saved } = app();
    for (const body of [{ mode: "everything", hosts: [] }, { mode: "listed", hosts: ["127.0.0.1"] }, { mode: "listed" }, "{"]) {
      const response = await put(handler, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid", message: INVALID_HOSTS });
    }
    expect(saved).toEqual([]);
  });

  test("a good setting is saved as the service normalised it, and the answer carries the contract fields", async () => {
    const { app: handler, saved } = app();
    const response = await put(handler, { mode: "listed", hosts: ["Docs.RS", "docs.rs"] });
    expect(response.status).toBe(200);
    expect(saved).toEqual([{ mode: "listed", hosts: ["docs.rs"] }]);
    expect(await response.json()).toMatchObject({ mode: "listed", hosts: ["docs.rs"], available: true });
  });

  test("needs the service secret, and a failing bot is a 503 without detail", async () => {
    expect((await put(app().app, { mode: "off", hosts: [] }, "t".repeat(64))).status).toBe(401);
    const failing = app({ setWebPolicy: async () => { throw new Error("secret detail"); } });
    const response = await put(failing.app, { mode: "off", hosts: [] });
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("secret detail");
  });
});
