import { expect, test } from "bun:test";
import { indexedDB as fakeIndexedDB } from "fake-indexeddb";
import { putPendingSaveState, readPendingSaveStates } from "./pendingSaveState";

test("pending save failure, held reason, and retry time survive an IndexedDB read", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fakeIndexedDB });
  try {
    const state = { id: "recording-a", failed: { kind: "timeout" as const, message: "Trying again" },
      held: "signed-out" as const, retryAt: Date.now() + 5_000 };
    await putPendingSaveState("did:one", state);
    expect((await readPendingSaveStates("did:one", [state.id])).get(state.id)).toEqual(state);
    expect((await readPendingSaveStates("did:two", [state.id])).size).toBe(0);
    await putPendingSaveState("did:one", { id: state.id });
    expect((await readPendingSaveStates("did:one", [state.id])).size).toBe(0);
  } finally {
    if (previous) Object.defineProperty(globalThis, "indexedDB", previous);
    else Reflect.deleteProperty(globalThis, "indexedDB");
  }
});
