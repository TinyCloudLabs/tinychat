import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
  __setVoiceNotesForTests,
  type VoiceNotesPlugin,
} from "@/lib/voiceNotes/nativeVoiceNotes";
import { createFakeVoiceNotes } from "@/lib/voiceNotes/fakeVoiceNotes";
import {
  __resetFailedActionsForTests,
  performFailedAction,
  runFailedAction,
  type ActionEffects,
  type FailedActionsState,
} from "./failedActions";
import { HOME_COPY } from "./homeCopy";

const calls: string[] = [];
let plugin: Partial<VoiceNotesPlugin>;

const reject = (code: string) =>
  Promise.reject(Object.assign(new Error(`native says ${code}`), { code }));

function use(patch: Partial<VoiceNotesPlugin>) {
  plugin = {
    retryRecovery: async ({ id }) => void calls.push(`retry:${id}`),
    discardFailedRecording: async ({ id }) => void calls.push(`discard:${id}`),
    deleteQuarantined: async ({ id }) => void calls.push(`deleteQuarantined:${id}`),
    ...patch,
  };
  __setVoiceNotesForTests(
    { ...createFakeVoiceNotes().plugin, ...plugin } as VoiceNotesPlugin,
    { available: true },
  );
}

function effects() {
  const log: string[] = [];
  const states: Partial<FailedActionsState>[] = [];
  const e: ActionEffects = {
    update: (patch) => {
      states.push(patch);
      log.push(`update:${JSON.stringify(patch)}`);
    },
    refresh: () => void log.push("refresh"),
    onGone: (id) => void log.push(`gone:${id}`),
    onUnavailable: () => void log.push("unavailable"),
  };
  return { e, log, states };
}

let error: ReturnType<typeof spyOn>;
beforeEach(() => {
  calls.length = 0;
  error = spyOn(console, "error").mockImplementation(() => {});
  use({});
});
afterEach(() => {
  error.mockRestore();
  __resetFailedActionsForTests();
  __setVoiceNotesForTests(createFakeVoiceNotes().plugin, { available: null });
});

describe("runFailedAction", () => {
  test("sorts what came back", async () => {
    expect(await runFailedAction(async () => {})).toEqual({ status: "ok" });
    expect(await runFailedAction(() => reject("not_failed_recording"))).toEqual({ status: "gone" });
    expect(await runFailedAction(() => reject("unimplemented"))).toEqual({ status: "unimplemented" });
    expect(await runFailedAction(() => reject("UNIMPLEMENTED"))).toEqual({ status: "unimplemented" });
    expect((await runFailedAction(() => reject("io_error"))).status).toBe("error");
    expect((await runFailedAction(() => Promise.reject(new Error("no code")))).status).toBe("error");
  });
});

describe("Try again", () => {
  test("busy while the call runs, then idle, and the quarantine is read again", async () => {
    const { e, log } = effects();
    await performFailedAction("retry", "recoveryFailed", "a", e);
    expect(calls).toEqual(["retry:a"]);
    expect(log).toEqual([
      'update:{"busy":"retry","error":null,"confirming":false}',
      "refresh",
      'update:{"busy":null}',
    ]);
  });

  test("the same call for a quarantined session", async () => {
    await performFailedAction("retry", "quarantined", "q", effects().e);
    expect(calls).toEqual(["retry:q"]);
  });

  test("a failure shows the inline error, logs, and refreshes (it may stay quarantined)", async () => {
    use({ retryRecovery: () => reject("recovery_failed") });
    const { e, log } = effects();
    await performFailedAction("retry", "quarantined", "q", e);
    expect(log).toEqual([
      'update:{"busy":"retry","error":null,"confirming":false}',
      "refresh",
      `update:{"busy":null,"error":${JSON.stringify(HOME_COPY.tryAgainFailed)}}`,
    ]);
    expect(error).toHaveBeenCalledTimes(1);
  });

  test("not_failed_recording: no error; the rows drop it and the state is read again", async () => {
    use({ retryRecovery: () => reject("not_failed_recording") });
    const { e, log } = effects();
    await performFailedAction("retry", "recoveryFailed", "a", e);
    expect(log).toEqual([
      'update:{"busy":"retry","error":null,"confirming":false}',
      "gone:a",
      "refresh",
      'update:{"busy":null}',
    ]);
    expect(error).not.toHaveBeenCalled();
  });

  test("unimplemented hides the actions: no error, no log", async () => {
    use({ retryRecovery: () => reject("unimplemented") });
    const { e, log } = effects();
    await performFailedAction("retry", "recoveryFailed", "a", e);
    expect(log).toContain("unavailable");
    expect(log.some((line) => line.includes('"error":"'))).toBe(false);
    expect(error).not.toHaveBeenCalled();
  });
});

describe("Delete", () => {
  test("a recoveryFailed session is discarded", async () => {
    const { e, log } = effects();
    await performFailedAction("delete", "recoveryFailed", "a", e);
    expect(calls).toEqual(["discard:a"]);
    expect(log).toEqual([
      'update:{"busy":"delete","error":null,"confirming":false}',
      "gone:a",
      "refresh",
      'update:{"busy":null}',
    ]);
  });

  test("a quarantined session is deleted from the quarantine", async () => {
    await performFailedAction("delete", "quarantined", "q", effects().e);
    expect(calls).toEqual(["deleteQuarantined:q"]);
  });

  test("not_failed_recording refreshes and shows no error", async () => {
    use({ discardFailedRecording: () => reject("not_failed_recording") });
    const { e, log } = effects();
    await performFailedAction("delete", "recoveryFailed", "a", e);
    expect(log).toContain("gone:a");
    expect(log).toContain("refresh");
    expect(log.some((line) => line.includes('"error":"'))).toBe(false);
    expect(error).not.toHaveBeenCalled();
  });

  test("unimplemented hides the actions", async () => {
    use({ discardFailedRecording: () => reject("unimplemented") });
    const { e, log } = effects();
    await performFailedAction("delete", "recoveryFailed", "a", e);
    expect(log).toContain("unavailable");
    expect(log).not.toContain("gone:a");
  });

  test("any other rejection shows the inline error, logs, and keeps the recording", async () => {
    use({ deleteQuarantined: () => reject("io_error") });
    const { e, log } = effects();
    await performFailedAction("delete", "quarantined", "q", e);
    expect(log).not.toContain("gone:q");
    expect(log.at(-1)).toBe(
      `update:{"busy":null,"error":${JSON.stringify(HOME_COPY.deleteFailed)}}`,
    );
    expect(error).toHaveBeenCalledTimes(1);
  });
});
