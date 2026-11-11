import { expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { readHomeFeatures, rememberHomeFeature } from "./homeFeatures";
import { rememberExistingWebConnectors } from "./rememberWebConnectors";

const ADDRESS = "0x00000000000000000000000000000000000000a1";

function fixture(covered: boolean, state: "connected" | "disconnected" | "empty" | "error" | "throw") {
  const data = new Map<string, string>();
  const store = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
  const reads: unknown[][] = [];
  const tcw = {
    hasPermissions: () => covered,
    sql: { db: () => ({ query: async (sql: string, params: unknown[]) => {
      reads.push([sql, params]);
      if (state === "throw") throw new Error("unreachable");
      if (state === "error") return { ok: false, error: { code: "NETWORK_ERROR", message: "unreachable" } };
      return { ok: true, data: { rows: state === "empty" ? [] : [[params[0], state, null, null, null, 0]] } };
    } }) },
  } as unknown as TinyCloudWeb;
  return { store, tcw, reads };
}

test("a covering old web session with a connected source remembers Connectors in the shared record", async () => {
  const { store, tcw, reads } = fixture(true, "connected");
  rememberHomeFeature(store, ADDRESS, "recording");
  await rememberExistingWebConnectors(store, tcw, ADDRESS);
  expect(readHomeFeatures(store, ADDRESS)).toEqual(["recording", "connectors"]);
  expect(reads).toHaveLength(1);
  expect(reads[0][0]).toStartWith("SELECT connector_id");
  expect(reads[0][1]).toEqual(["fireflies"]);
  await rememberExistingWebConnectors(store, tcw, ADDRESS);
  expect(reads).toHaveLength(1);
});

for (const state of ["empty", "disconnected", "error", "throw"] as const) {
  test(`a covering web session with ${state} connector state leaves the flag unset`, async () => {
    const { store, tcw, reads } = fixture(true, state);
    await rememberExistingWebConnectors(store, tcw, ADDRESS);
    expect(readHomeFeatures(store, ADDRESS)).toEqual([]);
    expect(reads).toHaveLength(state === "empty" || state === "disconnected" ? 3 : 1);
  });
}

test("a reduced web session reads no connector records and sets no feature flag", async () => {
  const { store, tcw, reads } = fixture(false, "connected");
  await rememberExistingWebConnectors(store, tcw, ADDRESS);
  expect(readHomeFeatures(store, ADDRESS)).toEqual([]);
  expect(reads).toEqual([]);
});
