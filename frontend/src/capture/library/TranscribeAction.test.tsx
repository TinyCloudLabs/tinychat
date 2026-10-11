// "Transcribe" for a note with no transcript: the providers on offer, Local by default, what pressing it starts,
// and the failure's "Try again" choosing a provider the same way.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

import type { VoiceNoteTranscriptionProps } from "@/capture/recorder/transcriptionProps";
import { createFakeOnDeviceStt } from "@/lib/voiceNotes/fakeOnDeviceStt";
import { __setVoiceNotesForTests, VoiceNotes, type VoiceNotesPlugin } from "@/lib/voiceNotes/nativeVoiceNotes";
import { __resetOnDeviceSttStoreForTests, onDeviceSttStore } from "@/lib/voiceNotes/onDeviceSttStore";
import { __setOnDeviceSttForTests, OnDeviceStt } from "@/lib/voiceNotes/onDeviceStt";
import { installDom } from "@/test/dom";
import { TranscribeActionFor, type PhoneRead } from "./TranscribeAction";
import { LOCAL_START_FAILED, needsConsent, transcribeProviders, transcribeWith, type PhoneRecording } from "./transcribeProviders";

const NOTE = "rec-1";
const noop = () => {};
const phone = (patch: Partial<PhoneRecording> = {}): PhoneRecording => ({ committed: "on-device", hasLocalState: false, ...patch });
const onPhone = (patch: Partial<PhoneRecording> = {}): PhoneRead => ({ state: "read", phone: phone(patch) });
const nowhere: PhoneRead = { state: "read", phone: null };

function transcription(patch: Partial<VoiceNoteTranscriptionProps> = {}): VoiceNoteTranscriptionProps {
  return { availability: "available", consented: true, maxSeconds: 600, jobs: new Map(), onTranscribe: noop, onTranscribePrivately: noop, onConsent: noop, onTurnOff: noop, onRecheck: noop, ...patch };
}

const originals = { voiceNotes: VoiceNotes, onDeviceStt: OnDeviceStt };
let enqueued: string[];
let cleanupDom: (() => void) | undefined;
let root: Root | null = null;

beforeEach(() => {
  enqueued = [];
  __resetOnDeviceSttStoreForTests();
  __setVoiceNotesForTests({ listPending: async () => ({ recordings: [] }) } as unknown as VoiceNotesPlugin, { available: true });
  const fake = createFakeOnDeviceStt();
  const enqueue = fake.plugin.enqueue.bind(fake.plugin);
  fake.plugin.enqueue = async (input) => { enqueued.push(input.id); await enqueue(input); };
  __setOnDeviceSttForTests(fake.plugin);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  cleanupDom?.();
  cleanupDom = undefined;
  __resetOnDeviceSttStoreForTests();
  __setVoiceNotesForTests(originals.voiceNotes, { available: null });
  __setOnDeviceSttForTests(originals.onDeviceStt);
});

async function mount(props: { read: PhoneRead; transcription?: VoiceNoteTranscriptionProps; label?: string }) {
  cleanupDom = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(MemoryRouter, null, createElement(TranscribeActionFor, { noteId: NOTE, transcription: props.transcription, read: props.read, label: props.label }))));
  return host;
}
const click = (element: Element) => act(async () => { element.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
const choose = (host: HTMLElement, value: string) =>
  act(async () => {
    const select = host.querySelector<HTMLSelectElement>('[data-testid="transcribe-provider"]')!;
    select.value = value;
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
const button = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('[data-testid="transcribe-button"]')!;

describe("the providers on offer", () => {
  test("Local when the recording is on this phone, Private when private cloud is available; Local first", () => {
    expect(transcribeProviders(NOTE, transcription(), phone())).toEqual(["on-device", "private-cloud"]);
  });

  test("Local needs the recording on this phone", () => {
    expect(transcribeProviders(NOTE, transcription(), null)).toEqual(["private-cloud"]);
  });

  test("Private only while private cloud is available, and not while its job runs or has finished", () => {
    for (const availability of ["hidden", "checking", "failed"] as const) {
      expect(transcribeProviders(NOTE, transcription({ availability }), phone())).toEqual(["on-device"]);
    }
    expect(transcribeProviders(NOTE, undefined, phone())).toEqual(["on-device"]);
    for (const job of [{ kind: "active", status: { kind: "processing", completed: 1, total: 3 } }, { kind: "done", outcome: "transcribed" }] as const) {
      expect(transcribeProviders(NOTE, transcription({ jobs: new Map([[NOTE, job]]) }), phone())).toEqual(["on-device"]);
    }
  });

  test("Private asks for consent once", () => {
    expect(needsConsent("private-cloud", transcription({ consented: false }))).toBe(true);
    expect(needsConsent("private-cloud", transcription())).toBe(false);
    expect(needsConsent("on-device", transcription({ consented: false }))).toBe(false);
  });
});

describe("the Transcribe action", () => {
  test("Local is the default, with Private beside it in the provider chip", async () => {
    const host = await mount({ read: onPhone(), transcription: transcription() });
    expect(button(host).textContent).toBe("Transcribe");
    const select = host.querySelector<HTMLSelectElement>('[data-testid="transcribe-provider"]')!;
    expect(select.value).toBe("on-device");
    expect([...select.options].map((option) => option.textContent)).toEqual(["Local", "Private"]);
  });

  test("one provider is a plain chip, not a dropdown", async () => {
    const host = await mount({ read: nowhere, transcription: transcription() });
    expect(host.querySelector('[data-testid="transcribe-provider"]')).toBeNull();
    expect(host.querySelector('[data-testid="transcribe-provider-static"]')?.textContent).toContain("Private");
  });

  test("nothing to transcribe with shows nothing", async () => {
    const host = await mount({ read: nowhere, transcription: transcription({ availability: "hidden" }) });
    expect(host.innerHTML).toBe("");
  });

  test("while the phone is still asked about the note, nothing shows", async () => {
    const host = await mount({ read: { state: "reading" }, transcription: transcription() });
    expect(host.innerHTML).toBe("");
  });

  test("a failed read of the phone is told, and Private stays on offer", async () => {
    const host = await mount({ read: { state: "failed" }, transcription: transcription() });
    expect(host.querySelector('[data-testid="transcribe-phone-read-failed"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="transcribe-provider-static"]')?.textContent).toContain("Private");
  });

  test("pressing Transcribe with the default starts Local on the phone and nothing in the cloud", async () => {
    const sent: string[] = [];
    const host = await mount({ read: onPhone(), transcription: transcription({ onTranscribe: (id) => sent.push(id), onTranscribePrivately: (id) => sent.push(id) }) });
    await click(button(host));
    expect(enqueued).toEqual([NOTE]);
    expect(sent).toEqual([]);
  });

  test("a second press while the start is on its way starts nothing more, and the provider cannot change", async () => {
    const sent: string[] = [];
    const host = await mount({ read: onPhone(), transcription: transcription({ onTranscribePrivately: (id) => sent.push(id) }) });
    await act(async () => {
      button(host).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      button(host).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    await click(button(host));
    expect(enqueued).toEqual([NOTE]);
    // The queue has not answered yet: the action stays locked, so Private cannot start beside Local.
    expect(button(host).disabled).toBe(true);
    expect(host.querySelector<HTMLSelectElement>('[data-testid="transcribe-provider"]')!.disabled).toBe(true);
    expect(sent).toEqual([]);
  });

  test("a start that fails unlocks the action for another try", async () => {
    OnDeviceStt.enqueue = async () => { throw new Error("busy"); };
    const originalError = console.error;
    console.error = noop;
    try {
      const host = await mount({ read: onPhone(), transcription: transcription() });
      await click(button(host));
      expect(host.querySelector('[data-testid="transcribe-problem"]')).not.toBeNull();
      expect(button(host).disabled).toBe(false);
    } finally {
      console.error = originalError;
    }
  });

  test("choosing Private sends the note to private cloud and leaves the phone alone", async () => {
    const sent: string[] = [];
    const host = await mount({ read: onPhone({ committed: "private-cloud" }), transcription: transcription({ onTranscribe: (id) => sent.push(id) }) });
    await choose(host, "private-cloud");
    await click(button(host));
    expect(sent).toEqual([NOTE]);
    expect(enqueued).toEqual([]);
  });

  test("a note committed to another mode is moved to private cloud explicitly", async () => {
    const calls: string[] = [];
    const host = await mount({
      read: onPhone({ committed: "off" }),
      transcription: transcription({ onTranscribe: () => calls.push("transcribe"), onTranscribePrivately: () => calls.push("privately") }),
    });
    await choose(host, "private-cloud");
    await click(button(host));
    expect(calls).toEqual(["privately"]);
  });

  test("Private without consent asks first; agreeing records it and starts the transcription", async () => {
    const calls: string[] = [];
    const host = await mount({
      read: nowhere,
      transcription: transcription({ consented: false, onConsent: () => calls.push("consent"), onTranscribe: () => calls.push("transcribe") }),
    });
    await click(button(host));
    expect(calls).toEqual([]);
    expect(host.querySelector('[data-testid="transcribe-consent"]')).not.toBeNull();
    await click(host.querySelector('[data-testid="transcribe-consent-enable"]')!);
    expect(calls).toEqual(["consent", "transcribe"]);
  });

  test("not now leaves the consent question without starting anything", async () => {
    const calls: string[] = [];
    const host = await mount({ read: nowhere, transcription: transcription({ consented: false, onConsent: () => calls.push("consent"), onTranscribe: () => calls.push("transcribe") }) });
    await click(button(host));
    await click(host.querySelector('[data-testid="transcribe-consent-dismiss"]')!);
    expect(calls).toEqual([]);
    expect(host.querySelector('[data-testid="transcribe-consent"]')).toBeNull();
    expect(button(host)).not.toBeNull();
  });

  test("after a failure the same action reads Try again and still lets the provider be chosen", async () => {
    const sent: string[] = [];
    const host = await mount({ read: onPhone(), label: "Try again", transcription: transcription({ onTranscribePrivately: (id) => sent.push(id) }) });
    expect(button(host).textContent).toBe("Try again");
    expect(host.querySelector<HTMLSelectElement>('[data-testid="transcribe-provider"]')!.value).toBe("on-device");
    await choose(host, "private-cloud");
    await click(button(host));
    expect(sent).toEqual([NOTE]);
    expect(enqueued).toEqual([]);
  });

  test("private cloud unreachable after consent offers Check again, not a dead Transcribe", async () => {
    let rechecked = 0;
    const host = await mount({ read: nowhere, transcription: transcription({ availability: "failed", onRecheck: async () => { rechecked += 1; } }) });
    expect(host.querySelector('[data-testid="transcribe-button"]')).toBeNull();
    const recheck = host.querySelector('[data-testid="transcribe-private-recheck"]')!;
    await click(recheck.querySelector("button")!);
    expect(rechecked).toBe(1);
  });
});

describe("starting a transcription", () => {
  test("Local on the phone queues the note", async () => {
    expect(await transcribeWith("on-device", NOTE, transcription(), phone())).toBeNull();
    expect(enqueued).toEqual([NOTE]);
  });

  test("Local that cannot start says so in calm words, not the plugin's error", async () => {
    OnDeviceStt.enqueue = async () => { throw new Error("tombstoned: ECODE_77"); };
    const originalError = console.error;
    console.error = noop;
    try {
      const failure = await transcribeWith("on-device", NOTE, transcription(), phone());
      expect(failure).toBe(LOCAL_START_FAILED);
      expect(failure).not.toContain("tombstoned");
    } finally {
      console.error = originalError;
    }
  });

  test("a Local note with a job on the phone has it stopped before Private starts", async () => {
    const sent: string[] = [];
    const cancelled: string[] = [];
    const states = [{ id: NOTE, stt: { state: "running" } }, { id: NOTE, stt: { state: "cancelled" } }];
    __setVoiceNotesForTests(
      { listPending: async () => ({ recordings: [states.shift() ?? { id: NOTE, stt: { state: "cancelled" } }] }), getTranscript: async () => ({ transcript: null }) } as unknown as VoiceNotesPlugin,
      { available: true },
    );
    OnDeviceStt.cancel = async ({ id }) => { cancelled.push(id); };
    const props = transcription({ onTranscribePrivately: (id) => sent.push(id) });
    expect(await transcribeWith("private-cloud", NOTE, props, phone({ hasLocalState: true }))).toBeNull();
    expect(cancelled).toEqual([NOTE]);
    expect(sent).toEqual([NOTE]);
  });

  test("a Private note's retry keeps the plain route", async () => {
    const sent: string[] = [];
    expect(await transcribeWith("private-cloud", NOTE, transcription({ onTranscribe: (id) => sent.push(id) }), phone({ committed: "private-cloud" }))).toBeNull();
    expect(sent).toEqual([NOTE]);
  });

  test("a Local choice leaves the on-device queue in the store's snapshot", async () => {
    await transcribeWith("on-device", NOTE, transcription(), phone());
    await onDeviceSttStore.refresh();
    expect(onDeviceSttStore.snapshot().queue.some((entry) => entry.id === NOTE)).toBe(true);
  });
});
