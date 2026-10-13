import { describe, expect, test } from "bun:test";

import { onDeviceQueuePlace } from "./onDeviceQueue";

const entry = (id: string, state: "waiting_for_model" | "queued" | "running" | "done" | "failed" | "cancelled", percent: number | null = null) =>
  ({ id, state, percent, error: null });

describe("onDeviceQueuePlace", () => {
  test("positions count only the notes still in line, in queue order, from 1", () => {
    const queue = [entry("old", "done"), entry("run", "running", 63.4), entry("next", "queued"), entry("bad", "failed"), entry("last", "queued")];
    expect(onDeviceQueuePlace({ queue }, "run")).toMatchObject({ position: 1, inLine: 3, percent: 63.4 });
    expect(onDeviceQueuePlace({ queue }, "next")).toMatchObject({ position: 2, inLine: 3, percent: null });
    expect(onDeviceQueuePlace({ queue }, "last")).toMatchObject({ position: 3, inLine: 3, percent: null });
  });

  test("notes waiting for the model are in line; finished ones have no position", () => {
    const queue = [entry("a", "waiting_for_model"), entry("b", "waiting_for_model"), entry("c", "done"), entry("d", "cancelled")];
    expect(onDeviceQueuePlace({ queue }, "b")?.position).toBe(2);
    expect(onDeviceQueuePlace({ queue }, "c")).toMatchObject({ position: null, inLine: 2 });
    expect(onDeviceQueuePlace({ queue }, "d")?.position).toBeNull();
  });

  test("returns the queue's own entry, and null for a note that is not in it", () => {
    const queue = [entry("a", "queued")];
    expect(onDeviceQueuePlace({ queue }, "a")?.entry).toBe(queue[0]!);
    expect(onDeviceQueuePlace({ queue }, "zzz")).toBeNull();
    expect(onDeviceQueuePlace({ queue: [] }, "a")).toBeNull();
  });

  test("percent is only reported while running", () => {
    expect(onDeviceQueuePlace({ queue: [entry("a", "queued", 40)] }, "a")?.percent).toBeNull();
    expect(onDeviceQueuePlace({ queue: [entry("a", "running")] }, "a")?.percent).toBeNull();
  });
});
