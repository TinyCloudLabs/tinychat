import { afterEach, describe, expect, it } from "bun:test";
import {
  clearToolActivity,
  getToolActivity,
  onToolActivityChange,
  setToolActivity,
  type ToolActivity,
} from "./toolActivityStore.js";

// Reset store state between tests by clearing any entries we set.
const idsUsed: string[] = [];
afterEach(() => {
  for (const id of idsUsed) clearToolActivity(id);
  idsUsed.length = 0;
});

function track(id: string): string {
  idsUsed.push(id);
  return id;
}

describe("toolActivityStore", () => {
  it("getToolActivity returns null when no entry exists", () => {
    expect(getToolActivity("msg-unknown")).toBeNull();
  });

  it("setToolActivity persists and getToolActivity retrieves", () => {
    const id = track("msg-1");
    setToolActivity(id, { name: "web_search", status: "running" });
    expect(getToolActivity(id)).toEqual({ name: "web_search", status: "running" });
  });

  it("setToolActivity overwrites the previous entry", () => {
    const id = track("msg-2");
    setToolActivity(id, { name: "web_search", status: "running" });
    setToolActivity(id, { name: "web_search", status: "done" });
    expect(getToolActivity(id)).toEqual({ name: "web_search", status: "done" });
  });

  it("clearToolActivity removes the entry", () => {
    const id = track("msg-3");
    setToolActivity(id, { name: "web_search", status: "done" });
    clearToolActivity(id);
    expect(getToolActivity(id)).toBeNull();
  });

  it("clearToolActivity is a no-op on an unknown id", () => {
    expect(() => clearToolActivity("msg-nonexistent")).not.toThrow();
  });

  it("onToolActivityChange fires on set with the new activity", () => {
    const id = track("msg-4");
    const events: Array<ToolActivity | null> = [];
    const unsub = onToolActivityChange((mid, a) => {
      if (mid === id) events.push(a);
    });
    setToolActivity(id, { name: "web_search", status: "running" });
    setToolActivity(id, { name: "web_search", status: "done" });
    unsub();
    expect(events).toEqual([
      { name: "web_search", status: "running" },
      { name: "web_search", status: "done" },
    ]);
  });

  it("onToolActivityChange fires null on clear", () => {
    const id = track("msg-5");
    setToolActivity(id, { name: "web_search", status: "done" });
    const nullEvents: Array<ToolActivity | null> = [];
    const unsub = onToolActivityChange((mid, a) => {
      if (mid === id) nullEvents.push(a);
    });
    clearToolActivity(id);
    unsub();
    expect(nullEvents).toEqual([null]);
  });

  it("unsub stops listener from receiving further events", () => {
    const id = track("msg-6");
    const events: Array<ToolActivity | null> = [];
    const unsub = onToolActivityChange((mid, a) => {
      if (mid === id) events.push(a);
    });
    setToolActivity(id, { name: "web_search", status: "running" });
    unsub();
    setToolActivity(id, { name: "web_search", status: "done" });
    expect(events).toHaveLength(1);
  });

  it("a throwing listener does not break the store update", () => {
    const id = track("msg-7");
    const goodEvents: Array<ToolActivity | null> = [];
    const badUnsub = onToolActivityChange(() => {
      throw new Error("boom");
    });
    const goodUnsub = onToolActivityChange((mid, a) => {
      if (mid === id) goodEvents.push(a);
    });
    setToolActivity(id, { name: "web_search", status: "done" });
    badUnsub();
    goodUnsub();
    expect(goodEvents).toHaveLength(1);
  });
});
