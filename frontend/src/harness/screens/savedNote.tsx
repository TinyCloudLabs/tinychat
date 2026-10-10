// The saved voice note (D3): the desktop page and the phone sheet in the real shell over the Library fixture,
// reading, editing, with a discard confirmation and after a failed save. The note lives in an in-memory store
// the screen installs, so nothing depends on a device store or a space.
import { useContext, useEffect, useMemo } from "react";

import {
  clearSavedNoteDrafts,
  setSavedNoteDraft,
} from "@/capture/library/savedNote/savedNoteDraft";
import {
  __setSavedNoteStoreForTests,
  type SavedNoteStore,
} from "@/capture/library/savedNote/savedNoteStore";
import type { RecorderValue } from "@/capture/recorder/RecorderProvider";
import { PlatformContext } from "@/lib/platform";
import { audioBaseKey, audioManifestKey, audioPartKey } from "@/lib/audio/audioStore";
import { libraryTcw } from "../fixtures/library";
import { createRuntimeShim } from "../runtimeShim";
import type { HarnessScreen } from "../screen";
import { ShellApp } from "../ShellApp";
import { FROZEN_NOW } from "../stubs";

const IDLE: Partial<RecorderValue> = { available: true, ready: true, phase: "idle" };
const NOTE_ID = "rec-0928";
const NOTE_PATH = "/chat/capture/library/note-transcribed";
const NOTE_MD = [
  "# Offsite",
  "",
  "- **0:08** Book the venue before Friday",
  "- **0:20** Ask Ana about the second room",
  "",
  "Follow-ups:",
  "",
  "- [ ] Send the agenda to the planning thread",
  "- [ ] Confirm the _catering_ numbers",
].join("\n");
const EDITED_MD = `${NOTE_MD}\n\nAlso: park the offsite budget until Monday.`;

const record = (md: string, laterMs?: number) => ({
  md,
  savedEditAt: laterMs === undefined ? null : new Date(FROZEN_NOW + laterMs).toISOString(),
});

declare global {
  interface Window {
    /** The interactive saved-note screens: every text the store was asked to save, in order. */
    exoSavedNote?: { saves: string[] };
  }
}

// Twenty seconds of silence the browser can play and seek in, served as the recording's stored audio.
const AUDIO_SECONDS = 20;
const AUDIO_RATE = 8000;
function silentWav(): Uint8Array {
  const data = AUDIO_SECONDS * AUDIO_RATE;
  const bytes = new Uint8Array(44 + data).fill(0x80);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) =>
    [...value].forEach((char, index) => view.setUint8(at + index, char.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + data, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, AUDIO_RATE, true);
  view.setUint32(28, AUDIO_RATE, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, "data");
  view.setUint32(40, data, true);
  return bytes;
}

/** The library space, with the first voice note's audio stored (one part of silence) so its player has something to seek in. */
function tcwWithAudio(): ReturnType<typeof libraryTcw> {
  const tcw = libraryTcw();
  const base = audioBaseKey("exo-voice-note", NOTE_ID);
  const wav = silentWav();
  const manifest = {
    v: 1,
    mimeType: "audio/wav",
    fileName: "voice-note.wav",
    size: wav.byteLength,
    partSize: wav.byteLength,
    parts: [{ size: wav.byteLength, etag: null }],
    sha256: null,
    createdAt: new Date(FROZEN_NOW).toISOString(),
  };
  const kv = new Proxy(tcw.kv as unknown as Record<string, unknown>, {
    get: (target, key) => {
      if (key !== "get") return Reflect.get(target, key);
      const get = target.get as (key: string, options?: unknown) => Promise<unknown>;
      return async (name: string, options?: unknown) => {
        if (name === audioManifestKey(base)) return { ok: true, data: { data: manifest, headers: {} } };
        if (name === audioPartKey(base, 0)) return { ok: true, data: { data: wav, headers: {} } };
        return get.call(target, name, options);
      };
    },
  });
  return new Proxy(tcw, {
    get: (target, key) => (key === "kv" ? kv : Reflect.get(target, key)),
  }) as typeof tcw;
}

function memoryStore(options: { failSave?: boolean; empty?: boolean } = {}): SavedNoteStore {
  let saves = 0;
  let current = record(options.empty ? "" : NOTE_MD);
  return {
    load: async () => (options.empty ? null : current),
    save: async (_id, md) => {
      (window.exoSavedNote ??= { saves: [] }).saves.push(md);
      if (options.failSave) throw new Error("The device storage is full.");
      // The note starts with no Edited line; each save is an hour and a half later than the last, so the line appears, then changes.
      current = record(md, ++saves * 90 * 60_000);
      options = { ...options, empty: false };
      return { record: current, synced: Promise.resolve() };
    },
  };
}

/** Presses the first button matching `selector` once it is there. */
function Press({ selector, text }: { selector: string; text?: string }) {
  useEffect(() => {
    let timer = 0;
    const attempt = (left: number) => {
      const button = [...document.querySelectorAll<HTMLButtonElement>(selector)].find(
        (candidate) => text === undefined || candidate.textContent?.trim() === text,
      );
      if (button) {
        button.click();
        return;
      }
      if (left > 0) timer = window.setTimeout(() => attempt(left - 1), 100);
    };
    attempt(40);
    return () => window.clearTimeout(timer);
  }, [selector, text]);
  return null;
}

function Note(props: {
  draft?: { draft: string; confirming: "cancel" | "close" | null };
  failSave?: boolean;
  empty?: boolean;
  audio?: boolean;
  press?: { selector: string; text?: string };
}) {
  const platform = useContext(PlatformContext);
  const shim = useMemo(() => createRuntimeShim(), []);
  const tcw = useMemo(() => (props.audio ? tcwWithAudio() : libraryTcw()), [props.audio]);
  useMemo(() => {
    __setSavedNoteStoreForTests(memoryStore({ failSave: props.failSave, empty: props.empty }));
    clearSavedNoteDrafts();
    if (props.draft) setSavedNoteDraft(NOTE_ID, props.draft);
  }, [props.draft, props.failSave, props.empty]);
  return (
    <>
      <ShellApp
        platform={platform}
        shim={shim}
        state="ready"
        captureTcw={tcw}
        recorder={IDLE}
      />
      {props.press && <Press {...props.press} />}
    </>
  );
}

const DESKTOP_VIEWPORTS = ["tablet-land", "desktop-min", "desktop"];
const PHONE_VIEWPORTS = ["phone"];
const RENDERED = '[data-testid="saved-note-rendered"]';
const EDITOR = '[data-testid="saved-note-notes"][data-editing="true"] textarea';

const screen = (
  id: string,
  platform: HarnessScreen["platform"],
  viewports: string[],
  readyWhen: string,
  render: () => React.ReactNode,
): HarnessScreen => ({
  id: `saved-note-${id}`,
  group: "savedNote",
  layout: "pane",
  displayTitle: true,
  path: NOTE_PATH,
  platform,
  viewports,
  readyWhen,
  render,
});

const EDIT = { selector: '[data-testid="saved-note-notes"] .sn-pill', text: "Edit" };
const SAVE = { selector: '[data-testid="saved-note-notes"] .sn-pill', text: "Save" };

export const savedNoteScreens: HarnessScreen[] = [
  screen("page", "tauri", DESKTOP_VIEWPORTS, RENDERED, () => <Note />),
  screen("page-editing", "tauri", DESKTOP_VIEWPORTS, EDITOR, () => (
    <Note press={EDIT} />
  )),
  screen("page-confirm", "tauri", DESKTOP_VIEWPORTS, '[role="alertdialog"]', () => (
    <Note draft={{ draft: EDITED_MD, confirming: "cancel" }} />
  )),
  screen("page-save-failed", "tauri", DESKTOP_VIEWPORTS, '[data-testid="saved-note-save-error"]', () => (
    <Note draft={{ draft: EDITED_MD, confirming: null }} failSave press={SAVE} />
  )),
  // Driven by test/recorder-final-saved-note.e2e.test.ts: the note with its audio, and an empty one.
  { ...screen("interactive-page", "tauri", DESKTOP_VIEWPORTS, RENDERED, () => <Note audio />), interactive: true },
  { ...screen("interactive-sheet", "ios", PHONE_VIEWPORTS, RENDERED, () => <Note audio />), interactive: true },
  {
    ...screen("interactive-page-empty", "tauri", DESKTOP_VIEWPORTS, '[data-testid="saved-note-add"]', () => <Note empty />),
    interactive: true,
  },
  {
    ...screen("interactive-sheet-empty", "ios", PHONE_VIEWPORTS, '[data-testid="saved-note-add"]', () => <Note empty />),
    interactive: true,
  },
  screen("sheet", "ios", PHONE_VIEWPORTS, RENDERED, () => <Note />),
  screen("sheet-editing", "ios", PHONE_VIEWPORTS, EDITOR, () => <Note press={EDIT} />),
  screen("sheet-confirm", "ios", PHONE_VIEWPORTS, '[role="alertdialog"]', () => (
    <Note draft={{ draft: EDITED_MD, confirming: "close" }} />
  )),
];
