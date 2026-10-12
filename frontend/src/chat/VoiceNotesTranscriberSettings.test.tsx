import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { FINAL_COPY, TRANSCRIBER_NAME } from "@/capture/recorder/final/finalCopy";
import type { VoiceNoteTranscriptionProps } from "@/capture/recorder/transcriptionProps";
import { createFakeVoiceNotes, type FakeVoiceNotes } from "@/harness/fakeVoiceNotes";
import { __setVoiceNotesForTests, type TranscriberId } from "@/lib/voiceNotes/nativeVoiceNotes";
import type { TranscriptionAvailability } from "@/lib/voiceNotes/voiceNoteTranscription";
import { PrivateUnavailable, transcriberOptions, useDefaultTranscriber } from "./VoiceNotesTranscriberSettings";

const noop = () => {};
function transcription(availability: TranscriptionAvailability): VoiceNoteTranscriptionProps {
  return {
    availability,
    consented: false,
    maxSeconds: 3600,
    jobs: new Map(),
    onTranscribe: noop,
    onConsent: noop,
    onTurnOff: noop,
    onRecheck: noop,
  };
}

describe("Settings → Voice notes names and offers", () => {
  test("the options carry the recorder's names", () => {
    const { options } = transcriberOptions(true, transcription("available"));
    expect(options.map((o) => o.label)).toEqual([FINAL_COPY.modes.skipName, FINAL_COPY.modes.localName, FINAL_COPY.modes.privateName]);
    expect(options.map((o) => o.label)).toEqual(["Audio only", "Local", "Private"]);
  });

  test("Private is offered only when signed in and the check says it is available", () => {
    const privateOption = (signedIn: boolean, t: VoiceNoteTranscriptionProps | undefined) =>
      transcriberOptions(signedIn, t).options.find((o) => o.value === "private-cloud");
    expect(privateOption(true, transcription("available"))?.disabled).toBe(false);
    for (const availability of ["checking", "failed"] as const) {
      expect(privateOption(true, transcription(availability))?.disabled).toBe(true);
    }
    expect(privateOption(false, transcription("available"))?.disabled).toBe(true);
    expect(privateOption(true, undefined)?.disabled).toBe(true);
  });

  test("a failed check says so and offers Check again", () => {
    const html = renderToStaticMarkup(<PrivateUnavailable signedIn transcription={transcription("failed")} />);
    expect(html).toContain(`${TRANSCRIBER_NAME["private-cloud"]}: Couldn&#x27;t check right now`);
    expect(html).toContain(">Check again<");
  });

  test("checking gives a reason without a retry", () => {
    const checking = renderToStaticMarkup(<PrivateUnavailable signedIn transcription={transcription("checking")} />);
    expect(checking).toContain("Private: Checking…");
    expect(checking).not.toContain("Check again");
  });

  test("signed out says why, with no retry", () => {
    const html = renderToStaticMarkup(<PrivateUnavailable signedIn={false} transcription={transcription("failed")} />);
    expect(html).toContain("Private: ");
    expect(html).not.toContain("Check again");
  });
});

describe("the default transcriber setting", () => {
  const global = globalThis as Record<string, unknown>;
  const DID = "did:example:alice";
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const saved = { act: global.IS_REACT_ACT_ENVIRONMENT, window: global.window, storage: Object.getOwnPropertyDescriptor(globalThis, "localStorage") };
  let errors: ReturnType<typeof spyOn>;

  beforeAll(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    global.window = { setTimeout, clearTimeout, event: undefined, HTMLIFrameElement: class {} };
  });
  afterAll(() => {
    global.IS_REACT_ACT_ENVIRONMENT = saved.act;
    global.window = saved.window;
  });

  let fake: FakeVoiceNotes;
  let root: Root | null = null;
  let seen: ReturnType<typeof useDefaultTranscriber> | null = null;

  function Probe() {
    seen = useDefaultTranscriber();
    return null;
  }

  async function mount() {
    const container = { nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: null, textContent: "",
      addEventListener() {}, removeEventListener() {} } as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () => { root!.render(<Probe />); await tick(); });
  }

  beforeEach(async () => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } });
    fake = createFakeVoiceNotes();
    await fake.plugin.setCaptureDefaults({ accountDid: DID, transitionGen: 1, transcriber: "private-cloud", identifySpeakers: false });
    __setVoiceNotesForTests(fake.plugin, { available: true });
    errors = spyOn(console, "error").mockImplementation(() => {});
    seen = null;
  });
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    errors.mockRestore();
    __setVoiceNotesForTests(null, { available: null });
    if (saved.storage) Object.defineProperty(globalThis, "localStorage", saved.storage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

    test("shows the engine's default, not a stored preference the engine is not using", async () => {
      await mount();
      expect(seen!.value).toBe("private-cloud");
      expect(seen!.error).toBeNull();
    });

    test("a choice moves the control only once the engine has taken it", async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      __setVoiceNotesForTests({ ...fake.plugin, async setCaptureDefaults(defaults) {
        const result = await fake.plugin.setCaptureDefaults(defaults);
        await held;
        return result;
      } }, { available: true });
      await mount();
      await act(async () => { seen!.choose("on-device"); await tick(); });
      expect(seen!.value).toBe("private-cloud");
      await act(async () => { release(); await tick(); await tick(); });
      expect(seen!.value).toBe("on-device" satisfies TranscriberId);
      expect((await fake.plugin.getCaptureDefaults()).transcriber).toBe("on-device");
    });

    test("a refused choice is shown and logged, and the control stays on what the engine holds", async () => {
      __setVoiceNotesForTests({ ...fake.plugin, async setCaptureDefaults() { throw new Error("engine is busy"); } }, { available: true });
      await mount();
      await act(async () => { seen!.choose("on-device"); await tick(); await tick(); });
      expect(seen!.error).toStartWith("Could not save the default transcriber: engine is busy");
      expect(seen!.error).toContain("recording is held");
      expect(seen!.value).toBe("private-cloud");
      expect(errors).toHaveBeenCalled();
    });
});
