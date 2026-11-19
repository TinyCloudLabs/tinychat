// A Sync now / Full rescan that another Google Meet sync refuses waits for it and then runs, with that
// sync's progress on the row. It never ends as a bare "already running" message.
import { afterEach, describe, expect, test } from "bun:test";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { runGmeetSyncNow } from "@/chat/ConnectorsCard";
import { _resetGmeetSyncSingleFlightForTests, syncGoogleMeet, type GmeetSyncClient, type GmeetSyncStore } from "@/lib/connectors/gmeetSync";
import { CONNECTORS } from "@/lib/connectors/registry";
import type { ConnectorDescriptor } from "@/lib/connectors/types";
import { installDom } from "@/test/dom";
import { runSourceSync, useSourceSync, type SourceSyncController, type SourceSyncDeps } from "./useSourceSync";

const gmeet = CONNECTORS.find((d) => d.id === "google-meet") as ConnectorDescriptor;
const ALICE = { did: "did:pkh:eip155:1:0xalice" } as unknown as TinyCloudWeb;
const BOB = { did: "did:pkh:eip155:1:0xbob" } as unknown as TinyCloudWeb;
const session = { getToken: () => "bearer", isExpired: () => false } as unknown as SessionStore;
const ok = <T,>(data: T) => ({ ok: true as const, data });

interface HeldRun { run: Promise<unknown>; release: () => void }

/** A real engine run that stays in flight until released: the run another lane owns. */
function heldRun(tcw: TinyCloudWeb): HeldRun {
  const gate = Promise.withResolvers<void>();
  const store = {
    async getConnection() { return ok(null); },
    async putTranscriptBody() { return ok(undefined); },
    async upsertMeeting() { return ok({ id: "x", inserted: true, createdAt: "" }); },
    async updateSyncState() { return ok(undefined); },
    async countMeetings() { return ok(0); },
  } as unknown as GmeetSyncStore;
  const client = {
    delayMs: 0,
    async pace() {},
    async listConferenceRecords() { await gate.promise; return ok([]); },
    async listParticipants() { return ok([]); },
    async listTranscripts() { return ok([]); },
    async listTranscriptEntries() { return ok([]); },
  } as unknown as GmeetSyncClient;
  const run = syncGoogleMeet({ client, store, tcw });
  return { run, release: () => gate.resolve() };
}

function deps(patch: Partial<SourceSyncDeps> = {}): SourceSyncDeps {
  return {
    secretsAvailable: () => true,
    isSecretsUnlocked: () => true,
    unlockSecrets: (async () => ({ ok: true, data: undefined })) as SourceSyncDeps["unlockSecrets"],
    getConnectorKey: (async () => ({ ok: true, data: "key" })) as SourceSyncDeps["getConnectorKey"],
    isGmeetSyncInFlight: () => false,
    isGmeetNotesSyncInFlight: () => false,
    awaitSessionSync: async () => {},
    runGmeetSyncNow: async () => ({ ok: true }),
    runFirefliesSyncNow: async () => ({ ok: true }),
    ...patch,
  };
}
const input = { tcw: ALICE, backendUrl: "https://x.test", sessionStore: session };

afterEach(() => { _resetGmeetSyncSingleFlightForTests(); });

describe("a refused press", () => {
  test("Full rescan whose own unlock started the session-start run queues behind it, without being asked", async () => {
    let unlocked = false;
    let running = false;
    let awaited = 0;
    let ran = 0;
    const result = await runSourceSync(gmeet, { ...input, driveMode: "snapshot" }, deps({
      isSecretsUnlocked: () => unlocked,
      unlockSecrets: (async () => { unlocked = true; running = true; return { ok: true, data: undefined }; }) as SourceSyncDeps["unlockSecrets"],
      isGmeetSyncInFlight: () => running,
      awaitSessionSync: async () => { awaited++; },
      runGmeetSyncNow: async () => (ran++, { ok: true }),
    }));
    expect(result).toEqual({ busy: "queue" });
    expect(awaited).toBe(1); // It waited for the run its unlock started before looking at the slot.
    expect(ran).toBe(0);
  });

  test("a press that did not unlock does not wait for the session-start run", async () => {
    let awaited = 0;
    await runSourceSync(gmeet, input, deps({ awaitSessionSync: async () => { awaited++; } }));
    expect(awaited).toBe(0);
  });

  test("Sync now while the background Notes reconcile runs is offered a wait, not an error", async () => {
    const result = await runSourceSync(gmeet, input, deps({ isGmeetNotesSyncInFlight: () => true }));
    expect(result).toEqual({ busy: "offer" });
  });

  test("a run that claims the engine while the token is minted is a busy outcome, never a message", async () => {
    const original = globalThis.fetch;
    let held: HeldRun | null = null;
    globalThis.fetch = (async () => {
      held = heldRun(ALICE); // The session-start run takes the slot during the token mint.
      return new Response(JSON.stringify({ access_token: "at" }));
    }) as unknown as typeof fetch;
    try {
      const outcome = await runGmeetSyncNow({
        tcw: ALICE,
        backendUrl: "https://x.test",
        sessionStore: session,
        refreshToken: "rt",
        driveMode: "snapshot",
        signal: new AbortController().signal,
        onProgress: () => {},
      });
      expect(outcome).toEqual({ ok: false, busy: true });
      expect(JSON.stringify(outcome)).not.toContain("already running");
    } finally {
      globalThis.fetch = original;
      held?.release();
    }
  });
});

describe("the press waits for the run and then starts by itself", () => {
  function mount() {
    const uninstall = installDom();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    return {
      root,
      async cleanup() {
        await act(async () => { root.unmount(); });
        uninstall();
      },
    };
  }

  test("a queued Full rescan starts when the run it waits for ends, and the offer follows the account", async () => {
    const ui = mount();
    let controller!: SourceSyncController;
    const modes: string[] = [];
    const syncDeps = deps({
      runGmeetSyncNow: async (call) => {
        modes.push(call.driveMode);
        return modes.length === 1 ? { ok: false, busy: true } : { ok: true };
      },
    });
    function Harness({ tcw }: { tcw: TinyCloudWeb }) {
      controller = useSourceSync({ tcw, backendUrl: "https://x.test", sessionStore: session, onSettled: () => {}, deps: syncDeps });
      return null;
    }
    try {
      const held = heldRun(ALICE);
      await act(async () => { ui.root.render(createElement(Harness, { tcw: ALICE })); });
      await act(async () => { await controller.sync(gmeet, "snapshot"); });
      expect(modes).toEqual(["snapshot"]);
      expect(controller.busy).toEqual({ id: "google-meet", mode: "snapshot", queued: true });
      expect(controller.error).toBeNull(); // No bare message.

      // Another account sees none of it.
      await act(async () => { ui.root.render(createElement(Harness, { tcw: BOB })); });
      expect(controller.busy).toBeNull();
      await act(async () => { ui.root.render(createElement(Harness, { tcw: ALICE })); });
      expect(controller.busy).not.toBeNull();
      expect(modes).toEqual(["snapshot"]); // Still waiting: the run is live.

      held.release();
      await act(async () => { await held.run; });
      await act(async () => { await Promise.resolve(); });
      expect(modes).toEqual(["snapshot", "snapshot"]); // Started by itself, same mode.
      expect(controller.busy).toBeNull();
      expect(controller.error).toBeNull();
    } finally {
      await ui.cleanup();
    }
  });

  test("a press that is refused again after waiting is offered once more, not retried in a loop", async () => {
    const ui = mount();
    let controller!: SourceSyncController;
    let calls = 0;
    const syncDeps = deps({ runGmeetSyncNow: async () => (calls++, { ok: false, busy: true }) });
    function Harness() {
      controller = useSourceSync({ tcw: ALICE, backendUrl: "https://x.test", sessionStore: session, onSettled: () => {}, deps: syncDeps });
      return null;
    }
    try {
      await act(async () => { ui.root.render(createElement(Harness)); });
      await act(async () => { await controller.sync(gmeet, "snapshot"); });
      await act(async () => { await Promise.resolve(); });
      expect(calls).toBe(2); // One press, one automatic start.
      expect(controller.busy).toEqual({ id: "google-meet", mode: "snapshot", queued: false });
    } finally {
      await ui.cleanup();
    }
  });
});
