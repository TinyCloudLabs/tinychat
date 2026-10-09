import { expect, test } from "bun:test";
import { dismissPartialAudioIssue, partialAudioDismissed, partialAudioScope,
  prunePartialAudioIssues, savedPartialAudioIssues, savePartialAudioIssue } from "./partialAudioIssues";

test("partial-audio records are per DID and space, and old unknown dismissals are pruned", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
  } });
  try {
    const alice = partialAudioScope("did:alice", "space-1");
    const otherSpace = partialAudioScope("did:alice", "space-2");
    const bob = partialAudioScope("did:bob", "space-1");
    savePartialAudioIssue(alice, "saved", { kind: "partial_audio" });
    expect(savedPartialAudioIssues(otherSpace)).toEqual({});
    expect(savedPartialAudioIssues(bob)).toEqual({});
    expect(dismissPartialAudioIssue(alice, "old")).toBe(true);
    expect(dismissPartialAudioIssue(alice, "kept")).toBe(true);
    expect(partialAudioDismissed(alice, "old")).toBe(true);
    prunePartialAudioIssues(alice, new Set(["kept"]), Date.now() + 31 * 24 * 60 * 60 * 1000);
    expect(partialAudioDismissed(alice, "old")).toBe(false);
    expect(partialAudioDismissed(alice, "kept")).toBe(true);
    expect(savedPartialAudioIssues(alice).saved).toEqual({ kind: "partial_audio" });
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
