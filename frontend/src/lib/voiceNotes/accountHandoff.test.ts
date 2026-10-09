import { expect, test } from "bun:test";
import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import { __setVoiceNotesForTests } from "./nativeVoiceNotes";
import { handoffBeforeCredentialClear } from "./accountHandoff";
import type { VoiceNotePipeline } from "./voiceNotePipeline";

const did = "did:example:A";
async function setup() {
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  await fake.plugin.setCaptureDefaults({ accountDid: did, transitionGen: 1, transcriber: "private-cloud", identifySpeakers: false });
  const order: string[] = [];
  const pipeline: VoiceNotePipeline = {
    process: async () => {}, reconcileAll: async () => {},
    cancelAll: () => { order.push("cancel"); },
    quiescent: async () => { order.push("quiescent"); return true; },
  };
  return { fake, order, pipeline };
}

test("successful handoff is durable before credentials may clear; next recording is unowned", async () => {
  const { fake, order, pipeline } = await setup();
  const original = fake.plugin.setAccountState;
  fake.plugin.setAccountState = async (next) => { order.push(next.status); await original(next); };
  const result = await handoffBeforeCredentialClear(did, pipeline);
  expect(result.ok).toBe(true);
  expect(order).toEqual(["transitioning", "cancel", "quiescent", "signed_out"]);
  expect((await fake.plugin.getCaptureDefaults()).status).toBe("signed_out");
  await fake.plugin.start();
  expect(await fake.plugin.status()).toMatchObject({ owner: null, options: { transcriber: "on-device" } });
  const note = await fake.plugin.stop();
  expect(note.owner).toBeNull();
  expect((await fake.plugin.listPending()).recordings.map((entry) => entry.id)).toContain(note.id);
  expect((await fake.plugin.localAudioUrl({ id: note.id })).url).toContain(note.id);
  const claimed = await fake.plugin.setCaptureDefaults({ accountDid: "did:example:B", transitionGen: 4,
    transcriber: "on-device", identifySpeakers: false });
  expect(claimed.claimed).toEqual([note.id]);
  expect((await fake.plugin.listPending()).recordings[0]?.owner).toBe("did:example:B");
});

test("step 1 failure leaves credentials authorized and never cancels a save", async () => {
  const { fake, order, pipeline } = await setup();
  fake.controls.failNextAccountState();
  expect((await handoffBeforeCredentialClear(did, pipeline)).ok).toBe(false);
  expect(order).toEqual([]);
  expect((await fake.plugin.getCaptureDefaults()).status).toBe("signed_in");
});

test("step 3 failure compensates; compensation failure stays transitioning", async () => {
  for (const failCompensation of [false, true]) {
    const { fake, pipeline } = await setup();
    const original = fake.plugin.setAccountState;
    fake.plugin.setAccountState = async (next) => {
      if (next.status === "signed_out" || (failCompensation && next.status === "signed_in")) throw new Error("disk failed");
      await original(next);
    };
    const result = await handoffBeforeCredentialClear(did, pipeline);
    expect(result).toMatchObject({ ok: false, failClosed: failCompensation });
    expect((await fake.plugin.getCaptureDefaults()).status).toBe(failCompensation ? "transitioning" : "signed_in");
    if (failCompensation) {
      await fake.plugin.start();
      expect((await fake.plugin.status()).owner).toBeNull();
      await fake.plugin.discard();
    }
  }
});

test("late step 1 acknowledgement cannot overwrite compensation", async () => {
  const { fake, pipeline } = await setup();
  const original = fake.plugin.setAccountState;
  let release!: () => void;
  const late = new Promise<void>((resolve) => { release = resolve; });
  fake.plugin.setAccountState = async (next) => {
    if (next.status === "transitioning") await late;
    await original(next);
  };
  const result = await handoffBeforeCredentialClear(did, pipeline, 5);
  expect(result.ok).toBe(false);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect((await fake.plugin.getCaptureDefaults()).status).toBe("signed_in");
});

test("a late step 3 acknowledgement is rejected after compensation", async () => {
  const { fake, pipeline } = await setup();
  const original = fake.plugin.setAccountState;
  let release!: () => void;
  const late = new Promise<void>((resolve) => { release = resolve; });
  fake.plugin.setAccountState = async (next) => {
    if (next.status === "signed_out") await late;
    await original(next);
  };
  const result = await handoffBeforeCredentialClear(did, pipeline, 5);
  expect(result).toMatchObject({ ok: false, failClosed: false });
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect((await fake.plugin.getCaptureDefaults()).status).toBe("signed_in");
});

test("quiescent may time out but cancellation precedes the durable signed-out record", async () => {
  const { fake, order, pipeline } = await setup();
  pipeline.quiescent = async () => { order.push("quiescent"); return false; };
  const original = fake.plugin.setAccountState;
  fake.plugin.setAccountState = async (next) => { order.push(next.status); await original(next); };
  expect((await handoffBeforeCredentialClear(did, pipeline)).ok).toBe(true);
  expect(order).toEqual(["transitioning", "cancel", "quiescent", "signed_out"]);
});

test("a never-resolving native account update aborts within the deadline and leaves credentials authorized", async () => {
  const { fake, pipeline } = await setup();
  fake.plugin.setAccountState = async (next) => {
    if (next.status === "transitioning") return new Promise(() => {});
  };
  const result = await handoffBeforeCredentialClear(did, pipeline, 5);
  expect(result).toMatchObject({ ok: false, failClosed: false });
  expect((await fake.plugin.getCaptureDefaults()).status).toBe("signed_in");
});

test("a never-resolving pipeline quiescence cannot hold sign-out open", async () => {
  const { fake, pipeline } = await setup();
  pipeline.quiescent = async () => new Promise(() => {});
  const result = await handoffBeforeCredentialClear(did, pipeline, 5);
  expect(result.ok).toBe(true);
  expect((await fake.plugin.getCaptureDefaults()).status).toBe("signed_out");
});

test("a never-resolving native defaults read aborts before any credential clear", async () => {
  const { fake, pipeline } = await setup();
  fake.plugin.getCaptureDefaults = async () => new Promise(() => {});
  expect(await handoffBeforeCredentialClear(did, pipeline, 5)).toMatchObject({ ok: false, failClosed: false });
});

test("process death after each acknowledged step recovers without assigning a new account", async () => {
  for (const status of ["transitioning", "signed_out"] as const) {
    const { fake } = await setup();
    await fake.plugin.setAccountState({ status, accountDid: status === "transitioning" ? did : null, transitionGen: 2 });
    await fake.plugin.start();
    expect((await fake.plugin.status()).owner).toBeNull();
    const note = await fake.plugin.stop();
    await fake.plugin.setCaptureDefaults({ accountDid: did, transitionGen: 3, transcriber: "on-device", identifySpeakers: false });
    expect((await fake.plugin.listPending()).recordings.find((item) => item.id === note.id)?.owner).toBe(did);
  }
});

test("a live recording keeps the first account that signed in during it", async () => {
  const fake = createFakeVoiceNotes();
  const session = await fake.plugin.start();
  await fake.plugin.setCaptureDefaults({ accountDid: did, transitionGen: 1,
    transcriber: "on-device", identifySpeakers: false });
  expect((await fake.plugin.status()).owner).toBe(did);
  await fake.plugin.setAccountState({ status: "transitioning", accountDid: did, transitionGen: 2 });
  await fake.plugin.setAccountState({ status: "signed_out", accountDid: null, transitionGen: 3 });
  await fake.plugin.setCaptureDefaults({ accountDid: "did:example:B", transitionGen: 4,
    transcriber: "on-device", identifySpeakers: false });
  const saved = await fake.plugin.stop();
  expect(saved.id).toBe(session.id);
  expect(saved.owner).toBe(did);
  expect(saved.ownerUnknown).toBe(false);
});
