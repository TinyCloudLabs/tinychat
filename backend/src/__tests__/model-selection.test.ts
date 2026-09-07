import { describe, expect, test } from "bun:test";
import { OFFERED_CHAT_MODELS, type OfferedModelId } from "@tinyboilerplate/core";
import { classifyModelHealth, selectChatModel } from "../modelSelection";

const NOW = Date.parse("2026-09-07T14:15:00Z");
const CURRENT = "2026-09-07T14:00:00Z";
const PREVIOUS = "2026-09-07T13:00:00Z";

function fixture(model: OfferedModelId, providers: unknown = [{
  provider: "tee",
  uptime: 0,
  buckets: [{ hour: CURRENT, uptime: 1 }],
}]): unknown {
  return {
    model,
    period_start: "2026-09-04T14:15:00Z",
    period_end: "2026-09-07T14:14:00Z",
    providers,
  };
}

describe("bounded model health classification", () => {
  test("accepts the exact 0.99 boundary and either current UTC hour", () => {
    const id = OFFERED_CHAT_MODELS[0].id;
    expect(classifyModelHealth(id, fixture(id, [{ buckets: [{ hour: PREVIOUS, uptime: 0.99 }] }]), NOW)).toBe("healthy");
  });

  test("uses newest buckets rather than array order or aggregate uptime", () => {
    const id = OFFERED_CHAT_MODELS[0].id;
    expect(classifyModelHealth(id, fixture(id, [{
      uptime: 0,
      buckets: [
        { hour: CURRENT, uptime: 1 },
        { hour: PREVIOUS, uptime: 0 },
      ],
    }]), NOW)).toBe("healthy");
    expect(classifyModelHealth(id, fixture(id, [{
      uptime: 1,
      buckets: [{ hour: CURRENT, uptime: 0.989999 }],
    }]), NOW)).toBe("unhealthy");
  });

  test("does not search backward and treats conflicting duplicate newest buckets as unknown", () => {
    const id = OFFERED_CHAT_MODELS[0].id;
    expect(classifyModelHealth(id, fixture(id, [{ buckets: [
      { hour: PREVIOUS, uptime: 1 },
      { hour: CURRENT, uptime: null },
    ] }]), NOW)).toBe("unknown");
    expect(classifyModelHealth(id, fixture(id, [{ buckets: [
      { hour: CURRENT, uptime: 1 },
      { hour: CURRENT, uptime: 0.5 },
    ] }]), NOW)).toBe("unknown");
  });

  test("rejects stale, future, malformed, reversed, and wrong-model periods", () => {
    const id = OFFERED_CHAT_MODELS[0].id;
    for (const patch of [
      { period_end: "2026-09-07T13:54:59Z" },
      { period_end: "2026-09-07T14:16:00Z" },
      { period_end: "not-a-date" },
      { period_start: "2026-09-07T14:15:00Z", period_end: "2026-09-07T14:14:00Z" },
      { model: "wrong/model" },
    ]) {
      expect(classifyModelHealth(id, { ...(fixture(id) as object), ...patch }, NOW)).toBe("unknown");
    }
  });

  test("requires nonempty providers, valid bucket timestamps and finite bounded values", () => {
    const id = OFFERED_CHAT_MODELS[0].id;
    for (const providers of [
      null,
      [],
      [{ buckets: null }],
      [{ buckets: [] }],
      [{ buckets: [{ hour: "bad", uptime: 1 }] }],
      [{ buckets: [{ hour: "2026-09-07T14:00:01Z", uptime: 1 }] }],
      [{ buckets: [{ hour: CURRENT, uptime: null }] }],
      [{ buckets: [{ hour: CURRENT, uptime: Number.NaN }] }],
      [{ buckets: [{ hour: CURRENT, uptime: 1.01 }] }],
    ]) {
      expect(classifyModelHealth(id, fixture(id, providers), NOW)).toBe("unknown");
    }
  });

  test("any healthy provider wins; only an all-valid below-threshold set is unhealthy", () => {
    const id = OFFERED_CHAT_MODELS[0].id;
    expect(classifyModelHealth(id, fixture(id, [
      { buckets: [{ hour: CURRENT, uptime: 0.2 }] },
      { buckets: [{ hour: CURRENT, uptime: 1 }] },
    ]), NOW)).toBe("healthy");
    expect(classifyModelHealth(id, fixture(id, [
      { buckets: [{ hour: CURRENT, uptime: 0.2 }] },
      { buckets: [{ hour: CURRENT, uptime: null }] },
    ]), NOW)).toBe("unknown");
  });
});

describe("ladder selection", () => {
  test("each exact candidate can win at its ladder position", async () => {
    const ids = OFFERED_CHAT_MODELS.map(({ id }) => id);
    for (let winner = 0; winner < ids.length; winner++) {
      const fetchImpl = (async (input: string | URL | Request) => {
        const id = ids.find((candidate) => String(input).includes(candidate))!;
        const index = ids.indexOf(id);
        return Response.json(fixture(id, [{ buckets: [{ hour: CURRENT, uptime: index === winner ? 1 : 0.5 }] }]));
      }) as typeof fetch;
      await expect(selectChatModel({ fetchImpl, now: () => NOW })).resolves.toEqual({
        model: ids[winner],
        reason: "healthy",
      });
    }
  });

  test("selects the first unknown when no model is healthy", async () => {
    const ids = OFFERED_CHAT_MODELS.map(({ id }) => id);
    const fetchImpl = (async (input: string | URL | Request) => {
      const id = ids.find((candidate) => String(input).includes(candidate))!;
      return Response.json(fixture(id, [{ buckets: [{ hour: CURRENT, uptime: id === ids[2] ? null : 0.1 }] }]));
    }) as typeof fetch;
    await expect(selectChatModel({ fetchImpl, now: () => NOW })).resolves.toEqual({
      model: ids[2],
      reason: "health-unverified",
    });
  });

  test("returns all-unhealthy only when every candidate is conclusively unhealthy", async () => {
    const ids = OFFERED_CHAT_MODELS.map(({ id }) => id);
    const fetchImpl = (async (input: string | URL | Request) => {
      const id = ids.find((candidate) => String(input).includes(candidate))!;
      return Response.json(fixture(id, [{ buckets: [{ hour: CURRENT, uptime: 0.1 }] }]));
    }) as typeof fetch;
    await expect(selectChatModel({ fetchImpl, now: () => NOW })).resolves.toEqual({
      model: null,
      reason: "all-unhealthy",
    });
  });

  test("fetches every candidate once in parallel and degrades failures to unknown", async () => {
    let calls = 0;
    let concurrent = 0;
    let peak = 0;
    const fetchImpl = (async () => {
      calls++;
      concurrent++;
      peak = Math.max(peak, concurrent);
      await Promise.resolve();
      concurrent--;
      throw new Error("network down");
    }) as typeof fetch;
    await expect(selectChatModel({ fetchImpl, now: () => NOW })).resolves.toEqual({
      model: OFFERED_CHAT_MODELS[0].id,
      reason: "health-unverified",
    });
    expect(calls).toBe(6);
    expect(peak).toBe(6);
  });
});

test("two-second deadline bounds both fetch and a body parser that ignores abort", async () => {
  const signals: AbortSignal[] = [];
  const started = performance.now();
  let calls = 0;
  const fetchImpl = (async (_input, init) => {
    signals.push(init!.signal!);
    calls++;
    if (calls % 2 === 0) return new Promise(() => {});
    return { ok: true, json: () => new Promise(() => {}) };
  }) as typeof fetch;
  expect(await selectChatModel({ fetchImpl })).toEqual({ model: OFFERED_CHAT_MODELS[0].id, reason: "health-unverified" });
  expect(calls).toBe(6);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(performance.now() - started).toBeLessThan(2600);
});
