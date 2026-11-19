import { describe, expect, test } from "bun:test";
import { BOT_LIMITS_BY_PLAN, botCaps, CAP_MODE, capModeFromEnv, planFor } from "../bot-caps.js";
import { parseOwnerBots, type OwnerBots } from "../bots-registry.js";

const T0 = "2026-11-19T00:00:00.000Z";
const key = (n: number) => n.toString(16).repeat(32);

/** A record with Main and `privateBots - 1` more private bots, plus extras given in full. */
function record(privateBots: number, extras: Array<{ state?: string; environment?: string }> = []): OwnerBots {
  // A bot that is being deleted always carries the time its deletion began; the record is refused without it.
  const bot = (index: number, state = "active", environment = "private") =>
    ({ key: index === 0 ? "main" : key(index), name: index === 0 ? "Main" : `Bot ${index}`, shape: "pebble", colour: "blue", environment, state, createdAt: T0, ...(state === "deleting" ? { deletingSince: T0 } : {}) });
  const bots = Array.from({ length: privateBots }, (_unused, index) => bot(index));
  extras.forEach((extra, offset) => bots.push(bot(privateBots + offset, extra.state, extra.environment)));
  return parseOwnerBots({ v: 1, seq: 1, bots, deleted: [] });
}

describe("how many bots an account may have", () => {
  test("the default is the flat limit, and only BOTS_CAP_MODE set to table or flat3 changes it", () => {
    expect(CAP_MODE).toBe("flat3");
    expect(capModeFromEnv({})).toBe("flat3");
    expect(capModeFromEnv({ BOTS_CAP_MODE: "table" })).toBe("table");
    expect(capModeFromEnv({ BOTS_CAP_MODE: "flat3" })).toBe("flat3");
    for (const other of ["", "TABLE", "off", "flat", " table "]) expect(capModeFromEnv({ BOTS_CAP_MODE: other })).toBe("flat3");
  });

  test("under the flat limit every account may have 3 bots, Main included, whatever its plan", () => {
    for (const plan of ["tier1", "tier2", "tier3", "tier4", undefined] as const) {
      expect(botCaps("flat3", plan, record(1))).toEqual({
        capMode: "flat3",
        limits: { private: { max: 3, used: 1 }, regular: { max: 0, used: 0 } },
        canCreate: { private: true, regular: false },
      });
      expect(botCaps("flat3", plan, record(2)).canCreate).toEqual({ private: true, regular: false });
      expect(botCaps("flat3", plan, record(3)).canCreate).toEqual({ private: false, regular: false });
    }
  });

  test("the per-plan table holds exactly these numbers", () => {
    expect(BOT_LIMITS_BY_PLAN).toEqual({
      tier1: { private: 0, regular: 1 },
      tier2: { private: 1, regular: 3 },
      tier3: { private: 3, regular: 5 },
      tier4: { private: 10, regular: 10 },
    });
  });

  test("the backend's tiers map to the table's rows: free to tier1, plus to tier2, pro to tier3", () => {
    expect(planFor("free")).toBe("tier1");
    expect(planFor("plus")).toBe("tier2");
    expect(planFor("pro")).toBe("tier3");
  });

  test("under the table a plan's private limit counts Main", () => {
    expect(botCaps("table", "tier2", record(1))).toEqual({
      capMode: "table",
      limits: { private: { max: 1, used: 1 }, regular: { max: 3, used: 0 } },
      canCreate: { private: false, regular: false },
    });
    expect(botCaps("table", "tier3", record(1)).canCreate.private).toBe(true);
    expect(botCaps("table", "tier3", record(2)).canCreate.private).toBe(true);
    expect(botCaps("table", "tier3", record(3)).canCreate.private).toBe(false);
    expect(botCaps("table", "tier1", record(1)).limits).toEqual({ private: { max: 0, used: 1 }, regular: { max: 1, used: 0 } });
  });

  test("a bot that is being deleted is not counted", () => {
    const caps = botCaps("flat3", undefined, record(2, [{ state: "deleting" }, { state: "suspended" }]));
    expect(caps.limits?.private.used).toBe(3);
    expect(botCaps("flat3", undefined, record(2, [{ state: "deleting" }])).canCreate.private).toBe(true);
  });

  test("an account that already has more than its limit keeps its count and cannot create", () => {
    const caps = botCaps("flat3", undefined, record(5));
    expect(caps.limits?.private).toEqual({ max: 3, used: 5 });
    expect(caps.canCreate.private).toBe(false);
  });

  test("under the table, when the plan cannot be read there are no numbers and nothing can be created", () => {
    expect(botCaps("table", undefined, record(1))).toEqual({ capMode: "table", limits: null, canCreate: { private: false, regular: false } });
  });

  test("a regular bot cannot be created, whatever the limit says", () => {
    const caps = botCaps("table", "tier4", record(1));
    expect(caps.limits?.regular).toEqual({ max: 10, used: 0 });
    expect(caps.canCreate.regular).toBe(false);
    expect(botCaps("table", "tier1", record(1, [{ environment: "regular" }])).limits?.regular).toEqual({ max: 1, used: 1 });
  });
});
