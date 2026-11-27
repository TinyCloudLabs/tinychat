// Account erase (TC-4416), the gateway's half: POST /owners/<did>/erase on the control socket removes one owner's
// bots from every file on the gateway volume and from its memory, and nobody else's.
import { afterAll, describe, expect, test } from "bun:test";
import * as realLinks from "@tinycloud/share-envelope/links";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileActionLedgerStore } from "../actions-desk";
import { type GatewayConfig, PINNED_UPSTREAM } from "../config";
import { courierBotId } from "../courier/bot-id";
import { fileBudgetStore, fileOwnerStore, Gateway, type UpstreamFetch } from "../gateway";
import { fileHeldStore, MeetingDesk } from "../meeting-reads";
import { botIdFor } from "../owner";
import { ownerErase, OWNER_ERASE_ROUTE, type OwnerEraseDeps } from "../owner-erase";
import { type ApprovalLinks, SecretGrants } from "../secret-grants";
import { removeSealedFor, sealedGrantStore } from "../secret-store";

const tmp = mkdtempSync(join(tmpdir(), "erase-gateway-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const OWNER = `did:pkh:eip155:1:0x${"22".repeat(20)}`;
const OTHER = `did:pkh:eip155:1:0x${"33".repeat(20)}`;
const KEY_A = "ab".repeat(16);
const MODEL = "z-ai/glm-5.2";
const NOON = Date.parse("2026-11-11T12:00:00Z");
const MAIN = botIdFor(OWNER);
const SIBLING = botIdFor(OWNER, KEY_A);
const COURIER = courierBotId(OWNER);
const THEIRS = botIdFor(OTHER);
const THEIRS_SIBLING = botIdFor(OTHER, KEY_A);
const tokenOf = (botId: string) => botId.slice(0, 32).repeat(2);
const SEAL = new Uint8Array(32).fill(5);

const upstream: UpstreamFetch = async () => {
  const events = [{ choices: [{ index: 0, delta: { content: "pong" } }] }, { choices: [], usage: { total_tokens: 50 } }];
  return new Response(`${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
};

const links = {
  generateRelayKey: realLinks.generateRelayKey,
  signerFromJwk: realLinks.signerFromJwk,
  isApprovalClientError: realLinks.isApprovalClientError,
  createApprovalRequest: async (input: { expiresAt: Date }) => ({ link: "https://openkey.so/a/r#k", id: crypto.randomUUID(), bodyCid: "bafy-body", expiresAt: input.expiresAt.toISOString(), record: { header: "h", signature: "s" } }),
};
const ORIGINS = { node: "https://node.example", linksApi: "https://links.example", openkey: "https://openkey.so", openkeyApi: "https://api.openkey.example" };
const ask = (ownerDid: string) => ({ name: "OPENAI_API_KEY", sites: ["api.openai.com"], header: "authorization", why: "To transcribe a call.", ownerDid });

const ids = (record: Record<string, unknown>) => Object.keys(record).sort();

interface Failing { budget: boolean; courier: boolean }

/** A gateway over real files, with two owners' bots registered, charged, holding marks, approvals and sealed requests. */
async function setup() {
  const failing: Failing = { budget: false, courier: false };
  const root = mkdtempSync(join(tmp, "case-"));
  const path = (name: string) => join(root, name);
  const cfg: GatewayConfig = {
    egressRoot: "/egress", modelKey: "model-key", upstream: PINNED_UPSTREAM, models: [MODEL], maxTokens: 100, botDailyTokens: 1000,
    ownerDailyTokens: 5000, globalDailyTokens: 100_000, maxBodyBytes: 4096, maxResponseBytes: 1024 * 1024, connectTimeoutMs: 1000,
    totalTimeoutMs: 5000, bodyTimeoutMs: 30_000, budgetFile: path("budget.json"),
  };
  const conversation = "c".repeat(32);
  writeFileSync(path("held.json"), JSON.stringify({ [MAIN]: conversation, [THEIRS]: conversation }));
  const spendable = (bot: string) => ({ bot, binding: "binding", expiresAt: NOON + 3_600_000 });
  writeFileSync(path("actions.json"), JSON.stringify({ ["a".repeat(24)]: spendable(MAIN), ["b".repeat(24)]: spendable(SIBLING), ["c".repeat(24)]: spendable(THEIRS) }));
  const secretsDir = path("secret-grants");
  mkdirSync(secretsDir);
  const secrets = new SecretGrants({
    store: sealedGrantStore(secretsDir, SEAL), reader: { read: async () => ({ value: "fake" }), forget: () => {} }, links: links as unknown as ApprovalLinks, now: () => NOON, origins: ORIGINS,
  });
  const budget = fileBudgetStore(cfg.budgetFile);
  const gateway = new Gateway(cfg, {
    fetch: upstream, now: () => NOON,
    store: { load: () => budget.load(), save: state => { if (failing.budget) throw new Error("disk full"); budget.save(state); } },
    ownerStore: fileOwnerStore(path("owners.json")),
    meetings: new MeetingDesk({ backendOrigin: "https://backend.test", backendCallSecret: undefined, store: fileHeldStore(path("held.json")), now: () => NOON }),
    actionStore: fileActionLedgerStore(path("actions.json")),
    secrets,
  });
  gateway.setToken(MAIN, tokenOf(MAIN));
  gateway.setToken(SIBLING, tokenOf(SIBLING), MAIN);
  gateway.setToken(COURIER, tokenOf(COURIER), MAIN);
  gateway.setToken(THEIRS, tokenOf(THEIRS));
  gateway.setToken(THEIRS_SIBLING, tokenOf(THEIRS_SIBLING), THEIRS);
  const chat = async (botId: string) => {
    const response = await gateway.handle(botId, new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { authorization: `Bearer ${tokenOf(botId)}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "ping" }], stream: true }),
    }));
    await response.text();
    return response.status;
  };
  for (const botId of [MAIN, SIBLING, COURIER, THEIRS, THEIRS_SIBLING]) expect(await chat(botId)).toBe(200);
  await secrets.ask(MAIN, "1".repeat(24), ask(OWNER));
  await secrets.ask(SIBLING, "2".repeat(24), ask(OWNER));
  await secrets.ask(THEIRS, "3".repeat(24), ask(OTHER));

  const unlistened: string[] = [];
  const courierErased: string[] = [];
  const deps: OwnerEraseDeps = {
    gateway,
    unlisten: botId => void unlistened.push(botId),
    eraseCourier: async owner => { if (failing.courier) throw new Error(`Courier down for ${owner}`); courierErased.push(owner); },
  };
  const post = (owner: string, body: unknown, method = "POST") => {
    const pathname = `/owners/${encodeURIComponent(owner)}/erase`;
    return ownerErase(new Request(`http://control${pathname}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }), OWNER_ERASE_ROUTE.exec(pathname)!, deps);
  };
  // The test's own files, written by the code under test; the type is the caller's statement of their shape.
  const json = <T = Record<string, unknown>>(name: string): T => JSON.parse(readFileSync(path(name), "utf8"));
  const perBot = () => ids(json<{ perBot: Record<string, number> }>("budget.json").perBot);
  const sealed = () => readdirSync(secretsDir).filter(name => name.endsWith(".json"));
  return { gateway, chat, post, json, perBot, sealed, unlistened, courierErased, failing, cfg, path };
}


describe("the control route", () => {
  test("removes the owner's bots from budget, owners, held, actions and sealed requests, and nobody else's", async () => {
    const s = await setup();
    expect(s.perBot()).toEqual([MAIN, SIBLING, COURIER, THEIRS, THEIRS_SIBLING].sort());
    expect(s.sealed()).toHaveLength(3);
    const response = await s.post(OWNER, { keys: [KEY_A] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "gone" });

    expect(s.perBot()).toEqual([THEIRS, THEIRS_SIBLING].sort());
    expect(s.json("owners.json")).toEqual({ [THEIRS_SIBLING]: THEIRS });
    expect(s.json("held.json")).toEqual({ [THEIRS]: "c".repeat(32) });
    expect(Object.values(s.json<Record<string, { bot: string }>>("actions.json")).map(entry => entry.bot)).toEqual([THEIRS]);
    expect(s.sealed()).toHaveLength(1);
    expect(s.courierErased).toEqual([OWNER]);
    expect([...s.unlistened].sort()).toEqual([MAIN, SIBLING, COURIER].sort());
  });

  test("a bot the supervisor did not list is still removed, because the owner map names its owner", async () => {
    const s = await setup();
    const unlisted = botIdFor(OWNER, "cd".repeat(16));
    s.gateway.setToken(unlisted, tokenOf(unlisted), MAIN);
    expect(await s.chat(unlisted)).toBe(200);
    expect(await (await s.post(OWNER, { keys: [KEY_A] })).json()).toEqual({ outcome: "gone" });
    expect(s.perBot()).not.toContain(unlisted);
    expect(s.json("owners.json")).not.toHaveProperty(unlisted);
  });

  test("an erased bot's token no longer works, and a call in flight cannot put its count back", async () => {
    const s = await setup();
    await s.post(OWNER, { keys: [KEY_A] });
    expect(await s.chat(MAIN)).not.toBe(200);
    expect(s.perBot()).not.toContain(MAIN);
    expect(s.gateway.readsHeld(MAIN)).toBe(false);
    // The other owner is as they were.
    expect(await s.chat(THEIRS)).toBe(200);
  });

  test("repeating it answers gone, also for an owner with nothing", async () => {
    const s = await setup();
    for (const owner of [OWNER, OWNER, `did:pkh:eip155:1:0x${"44".repeat(20)}`]) {
      expect(await (await s.post(owner, { keys: [] })).json()).toEqual({ outcome: "gone" });
    }
    expect(s.perBot()).toEqual([THEIRS, THEIRS_SIBLING].sort());
  });

  test("a file that cannot be saved is failed, the Courier half still runs, and the retry finishes", async () => {
    const s = await setup();
    s.failing.budget = true;
    const first = await s.post(OWNER, { keys: [KEY_A] });
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ outcome: "failed" });
    expect(s.courierErased).toEqual([OWNER]);
    s.failing.budget = false;
    expect(await (await s.post(OWNER, { keys: [KEY_A] })).json()).toEqual({ outcome: "gone" });
    expect(s.perBot()).not.toContain(MAIN);
  });

  test("a Courier store that cannot be erased is failed, and the answer names nothing", async () => {
    const s = await setup();
    s.failing.courier = true;
    const response = await s.post(OWNER, { keys: [KEY_A] });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe(JSON.stringify({ outcome: "failed" }));
  });

  test("a malformed request changes nothing: not a POST, another owner spelling, bad or too many keys, no body", async () => {
    const s = await setup();
    const many = Array.from({ length: 65 }, (_, i) => i.toString(16).padStart(32, "0"));
    const refused = [
      await s.post(OWNER, { keys: [] }, "DELETE"),
      await s.post("not-a-did", { keys: [] }),
      await s.post(OWNER.toUpperCase(), { keys: [] }),
      await s.post(OWNER, { keys: ["../x"] }),
      await s.post(OWNER, { keys: ["AB".repeat(16)] }),
      await s.post(OWNER, { keys: many }),
      await s.post(OWNER, { keys: "ab" }),
      await s.post(OWNER, {}),
      await s.post(OWNER, undefined),
    ];
    expect(refused.map(response => response.status)).toEqual([405, 400, 400, 400, 400, 400, 400, 400, 400]);
    expect(s.courierErased).toEqual([]);
    expect(s.unlistened).toEqual([]);
    expect(s.perBot()).toHaveLength(5);
  });

  test("sealed requests are removed by bot id when the key service was down and no grants are open", async () => {
    const s = await setup();
    const sealedDir = s.path("secret-grants");
    writeFileSync(join(sealedDir, `${"9".repeat(24)}.json.new`), JSON.stringify({ v: 1, botId: MAIN, nonce: "", data: "" }));
    writeFileSync(join(sealedDir, "garbage.json"), "not json");
    removeSealedFor(sealedDir, [MAIN, SIBLING, COURIER]);
    expect(s.sealed().sort()).toEqual([`${"3".repeat(24)}.json`, "garbage.json"].sort());
    expect(readdirSync(sealedDir).filter(name => name.endsWith(".new"))).toEqual([]);
    removeSealedFor(join(sealedDir, "missing"), [MAIN]);
  });

  test("the route hands every bot id of the owner to the sealed-request cleanup when it is given", async () => {
    const s = await setup();
    const seen: string[][] = [];
    const pathname = `/owners/${encodeURIComponent(OWNER)}/erase`;
    const response = await ownerErase(new Request(`http://control${pathname}`, { method: "POST", body: JSON.stringify({ keys: [KEY_A] }) }), OWNER_ERASE_ROUTE.exec(pathname)!, {
      gateway: s.gateway, unlisten: () => {}, eraseCourier: async () => {}, eraseSealed: ids => void seen.push([...ids]),
    });
    expect(await response.json()).toEqual({ outcome: "gone" });
    expect(seen).toEqual([[MAIN, SIBLING, COURIER]]);
  });

  test("the route matches only /owners/<one segment>/erase", () => {
    expect(OWNER_ERASE_ROUTE.test(`/owners/${encodeURIComponent(OWNER)}/erase`)).toBe(true);
    for (const path of ["/owners//erase", "/owners/a/b/erase", `/owners/${OWNER}/erase/x`, "/owners/x", "/bots/x/erase"]) {
      expect(OWNER_ERASE_ROUTE.test(path)).toBe(false);
    }
  });

  test("nothing is left in the owner's sealed secret directory but other owners' files", async () => {
    const s = await setup();
    await s.post(OWNER, { keys: [KEY_A] });
    expect(existsSync(s.path("secret-grants"))).toBe(true);
    expect(s.sealed()).toHaveLength(1);
    expect(readdirSync(s.path("secret-grants")).filter(name => name.endsWith(".new"))).toEqual([]);
  });
});
