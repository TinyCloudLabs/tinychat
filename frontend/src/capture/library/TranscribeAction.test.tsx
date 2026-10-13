// "Transcribe" for a note with no transcript: the providers on offer, Local by default, what pressing it starts,
// and the failure's "Try again" choosing a provider the same way.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

import type { VoiceNoteTranscriptionProps } from "@/capture/recorder/transcriptionProps";
import { PlatformContext } from "@/lib/platform";
import { createFakeOnDeviceStt } from "@/lib/voiceNotes/fakeOnDeviceStt";
import { __setVoiceNotesForTests, VoiceNotes, type VoiceNotesPlugin } from "@/lib/voiceNotes/nativeVoiceNotes";
import { __resetOnDeviceSttStoreForTests, onDeviceSttStore } from "@/lib/voiceNotes/onDeviceSttStore";
import { __setOnDeviceSttForTests, OnDeviceStt } from "@/lib/voiceNotes/onDeviceStt";
import { installDom } from "@/test/dom";
import { NoteDetailView } from "./NoteDetailView";
import { TranscribeActionFor } from "./TranscribeAction";
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

async function mount(props: { read: PhoneRead; transcription?: VoiceNoteTranscriptionProps; label?: string; durationSecs?: number | null; platform?: "ios" | "tauri" }) {
  cleanupDom = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(MemoryRouter, null, createElement(PlatformContext.Provider, { value: props.platform ?? "ios" }, createElement(TranscribeActionFor, { noteId: NOTE, transcription: props.transcription, durationSecs: props.durationSecs === undefined ? 60 : props.durationSecs, read: props.read, label: props.label })) )));
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
    expect(transcribeProviders(NOTE, transcription(), phone(), 60)).toEqual(["on-device", "private-cloud"]);
  });

  test("Private only for a note within the length private cloud advertises, on the first try and the retry alike", () => {
    expect(transcribeProviders(NOTE, transcription({ maxSeconds: 7200 }), phone(), 7200)).toEqual(["on-device", "private-cloud"]);
    expect(transcribeProviders(NOTE, transcription({ maxSeconds: 7200 }), phone(), 7201)).toEqual(["on-device"]);
    expect(transcribeProviders(NOTE, transcription({ maxSeconds: 7200 }), null, 7201)).toEqual([]);
    expect(transcribeProviders(NOTE, transcription({ maxSeconds: 7200 }), phone(), null)).toEqual(["on-device", "private-cloud"]);
  });

  test("Local needs the recording on this phone", () => {
    expect(transcribeProviders(NOTE, transcription(), null, 60)).toEqual(["private-cloud"]);
  });

  test("Private only while private cloud is available, and not while its job runs or has finished", () => {
    for (const availability of ["failed", "checking"] as const) {
      expect(transcribeProviders(NOTE, transcription({ availability }), phone(), 60)).toEqual(["on-device"]);
    }
    expect(transcribeProviders(NOTE, undefined, phone(), 60)).toEqual(["on-device"]);
    for (const job of [{ kind: "active", status: { kind: "processing", completed: 1, total: 3 } }, { kind: "done", outcome: "transcribed" }] as const) {
      expect(transcribeProviders(NOTE, transcription({ jobs: new Map([[NOTE, job]]) }), phone(), 60)).toEqual(["on-device"]);
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

  test("a failed Private check offers Check again", async () => {
    const host = await mount({ read: nowhere, transcription: transcription({ availability: "failed" }) });
    expect(host.textContent).toContain("Couldn't check right now");
    expect(host.textContent).toContain("Check again");
  });

  test("a native status failure offers Check again before Private consent", async () => {
    const host = await mount({ read: nowhere, transcription: transcription({ availability: "failed", consented: false,
      checkErrorCode: "native_status_failed" }) });
    expect(host.textContent).toContain("Couldn't check this phone's file upload");
    expect(host.textContent).toContain("Check again");
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

  test("a start the phone accepts without putting the note in line is a failure: calm copy, and the action unlocks", async () => {
    OnDeviceStt.enqueue = async () => { throw Object.assign(new Error("This note already has a transcript"), { code: "already_transcribed" }); };
    const originalError = console.error;
    console.error = noop;
    try {
      const host = await mount({ read: onPhone(), transcription: transcription() });
      await click(button(host));
      expect(host.querySelector('[data-testid="transcribe-problem"]')!.textContent).toBe(LOCAL_START_FAILED);
      expect(button(host).disabled).toBe(false);
    } finally {
      console.error = originalError;
    }
  });

  test("a private job that settles as blocked is the start's answer: the action unlocks", async () => {
    const sent: string[] = [];
    const host = await mount({ read: nowhere, transcription: transcription({ onTranscribePrivately: (id) => sent.push(id) }) });
    await click(button(host));
    expect(sent).toEqual([NOTE]);
    expect(button(host).disabled).toBe(true);
    await act(async () => root!.render(createElement(MemoryRouter, null, createElement(TranscribeActionFor, {
      noteId: NOTE, durationSecs: 60, read: nowhere,
      transcription: transcription({ jobs: new Map([[NOTE, { kind: "blocked", reason: "unavailable" }]]) }),
    }))));
    expect(button(host).disabled).toBe(false);
  });

  test("choosing Private sends the note to private cloud and leaves the phone alone", async () => {
    const sent: string[] = [];
    const host = await mount({ read: onPhone({ committed: "private-cloud" }), transcription: transcription({ onTranscribePrivately: (id) => sent.push(id) }) });
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
  test("an Audio-only web note uses explicit Private and surfaces refusal in NoteDetailView", async () => {
    const calls: string[] = [];
    cleanupDom = installDom();
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(createElement(MemoryRouter, null,
      createElement(PlatformContext.Provider, { value: "web" },
        createElement(NoteDetailView, {
          item: { id: "row-1", source: "exo-voice-note", sourceId: NOTE, title: "Voice note", startedAt: null, durationSecs: 60 },
          listStatus: "ready",
          metadata: { status: "ok", metadata: { transcription_outcome: "skipped", capture: { version: 2, options: { transcriber: "off" } }, audio: { stored: true } } },
          transcript: { status: "absent" },
          audio: { load: async () => null },
          transcription: transcription({ onTranscribe: () => calls.push("ordinary"), onTranscribePrivately: () => { calls.push("private"); throw new Error("private refused"); } }),
          copyState: "idle", onCopy: noop, onRetry: noop, pushed: true, onBack: noop,
        }),
      ),
    )));

    const originalError = console.error;
    console.error = noop;
    try {
      await click(button(host));
      expect(calls).toEqual(["private"]);
      expect(host.querySelector('[data-testid="transcribe-problem"]')?.textContent)
        .toBe("Couldn’t start the transcription. Try again in a moment.");
    } finally {
      console.error = originalError;
    }
  });

  test("Private without consent asks first; agreeing records it and starts the transcription", async () => {
    const calls: string[] = [];
    const host = await mount({
      read: nowhere,
      transcription: transcription({ consented: false, onConsent: () => calls.push("consent"), onTranscribePrivately: () => calls.push("transcribe") }),
    });
    await click(button(host));
    expect(calls).toEqual([]);
    expect(host.querySelector('[data-testid="transcribe-consent"]')).not.toBeNull();
    await click(host.querySelector('[data-testid="transcribe-consent-enable"]')!);
    expect(calls).toEqual(["consent", "transcribe"]);
  });

  test("Mac Library Transcribe shows the Mac disclosure", async () => {
    const host = await mount({ read: nowhere, platform: "tauri", transcription: transcription({ consented: false }) });
    await click(button(host));
    expect(host.querySelector('[data-testid="transcribe-consent"]')?.textContent).toContain("from this Mac to TinyCloud Private Transcription");
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

  test("a Private note's explicit retry uses the override route", async () => {
    const calls: string[] = [];
    expect(await transcribeWith("private-cloud", NOTE,
      transcription({ onTranscribe: () => calls.push("ordinary"), onTranscribePrivately: (id) => calls.push(`private:${id}`) }),
      phone({ committed: "private-cloud" }))).toBeNull();
    expect(calls).toEqual([`private:${NOTE}`]);
  });

  test("a Local choice leaves the on-device queue in the store's snapshot", async () => {
    await transcribeWith("on-device", NOTE, transcription(), phone());
    await onDeviceSttStore.refresh();
    expect(onDeviceSttStore.snapshot().queue.some((entry) => entry.id === NOTE)).toBe(true);
  });
});
