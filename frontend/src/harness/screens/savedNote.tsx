// The saved voice note (D3): the desktop page and the phone sheet in the real shell over the Library fixture,
// reading, editing, with a discard confirmation and after a failed save. The note lives in an in-memory store
// the screen installs, so nothing depends on a device store or a space.
import { useContext, useEffect, useMemo } from "react";

import { forceSoftHome } from "@/capture/home/softHome";
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

const record = (md: string) => ({ md, editedAt: new Date(FROZEN_NOW).toISOString() });

function memoryStore(options: { failSave?: boolean } = {}): SavedNoteStore {
  let current = record(NOTE_MD);
  return {
    load: async () => current,
    save: async (_id, md) => {
      if (options.failSave) throw new Error("The device storage is full.");
      current = record(md);
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
  press?: { selector: string; text?: string };
}) {
  forceSoftHome(true);
  const platform = useContext(PlatformContext);
  const shim = useMemo(() => createRuntimeShim(), []);
  const tcw = useMemo(() => libraryTcw(), []);
  useMemo(() => {
    __setSavedNoteStoreForTests(memoryStore({ failSave: props.failSave }));
    clearSavedNoteDrafts();
    if (props.draft) setSavedNoteDraft(NOTE_ID, props.draft);
  }, [props.draft, props.failSave]);
  return (
    <>
      <ShellApp
        platform={platform}
        shim={shim}
        state="ready"
        captureTcw={tcw}
        recorder={IDLE}
        finalRecorder
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
  screen("sheet", "ios", PHONE_VIEWPORTS, RENDERED, () => <Note />),
  screen("sheet-editing", "ios", PHONE_VIEWPORTS, EDITOR, () => <Note press={EDIT} />),
  screen("sheet-confirm", "ios", PHONE_VIEWPORTS, '[role="alertdialog"]', () => (
    <Note draft={{ draft: EDITED_MD, confirming: "close" }} />
  )),
];
