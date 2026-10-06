// TC-515 — record voice notes offline from a cold start.
//
//   1. The offline screen's recorder (`OfflineVoiceNotesView`, pure, via react-dom/server) offers
//      Record, shows the live state with the card's OS mic-state copy and Stop, and says how many
//      notes on the phone will be saved when the user is back online.
//   2. It renders nothing outside the native app, and the app offers it only while a session is
//      HELD (`offline`, and `booting` after "Try again"); never signed out.
//   3. Once the session is back, what is on the phone is saved without opening Connectors, through
//      the card's single-flight retry (`savePendingVoiceNotes`, plain logic with fakes), and a
//      recording still running is shown in the chat screen's bar, never restarted.
// App's wiring is pinned against the source (App pulls in @tinycloud/web-sdk, which a bun test
// process cannot evaluate), as in connectorsNav.test.tsx.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import type { VoiceNoteRecording } from "@/lib/voiceNotes/nativeVoiceNotes";
import {
  OfflineVoiceNotes,
  OfflineVoiceNotesView,
  offlinePendingText,
  type OfflineVoiceNotesViewProps,
} from "./OfflineVoiceNotes";
import { savePendingVoiceNotes } from "./PendingVoiceNotesSaver";
import type { PendingRun } from "@/lib/voiceNotes/recorderSaves";

const noop = () => {};
const read = (name: string) => readFileSync(join(import.meta.dir, name), "utf8");

function render(patch: Partial<OfflineVoiceNotesViewProps> = {}): string {
  return renderToStaticMarkup(
    <OfflineVoiceNotesView
      phase="idle"
      mic={{ state: "idle", reason: null }}
      elapsedMs={0}
      subscribeLevel={() => noop}
      error={null}
      pendingCount={0}
      onRecord={noop}
      onStop={noop}
      {...patch}
    />,
  );
}

function recording(id: string): VoiceNoteRecording {
  return { id, startedAt: 1, durationMs: 4000, mimeType: "audio/mp4", sizeBytes: 4, silencedMs: 0, silencedEvents: 0, noSignalMs: 0 };
}

describe("OfflineVoiceNotesView", () => {
  test("idle: offers Record and says the note stays on the phone until the user is back online", () => {
    const html = render();
    expect(html).toContain("Record a voice note");
    expect(html).toContain("It stays on this phone and is saved to your TinyCloud space when you&#x27;re back online.");
    expect(html).toContain('data-testid="offline-voice-note-record"');
    expect(html).toContain("Not recording. The microphone is off.");
    expect(html).not.toContain('data-testid="offline-voice-note-pending"');
  });

  test("recording: elapsed time, level and Stop; what the OS reports reads as a warning", () => {
    const html = render({ phase: "recording", mic: { state: "recording", reason: null }, elapsedMs: 65_000 });
    expect(html).toContain(">Recording<");
    expect(html).toContain(">1:05</p>");
    expect(html).toContain('data-testid="offline-voice-note-stop"');
    expect(html).toContain("data-level-trace");
    expect(html).not.toContain('data-testid="offline-voice-note-record"');
    const silenced = render({ phase: "recording", mic: { state: "silenced", reason: "os_silenced" }, elapsedMs: 5_000 });
    expect(silenced).toContain("The system is blocking the microphone");
    expect(silenced).toContain("text-warning");
  });

  test("stopping never claims a save: the note is kept on the phone", () => {
    const html = render({ phase: "stopping" });
    expect(html).toContain("Keeping it on this phone…");
    expect(html).not.toContain("Saving to your TinyCloud space");
    expect(html).toMatch(/disabled=""[^>]*data-testid="offline-voice-note-record"/);
  });

  test("notes on the phone are counted with what happens to them", () => {
    expect(offlinePendingText(1)).toBe("1 note will be saved when you're back online.");
    expect(offlinePendingText(3)).toBe("3 notes will be saved when you're back online.");
    expect(render({ pendingCount: 2 })).toContain("2 notes will be saved when you&#x27;re back online.");
  });

  test("a start the OS refused is told", () => {
    const html = render({ error: "Microphone permission is required to record." });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Microphone permission is required to record.");
  });
});

describe("OfflineVoiceNotes", () => {
  test("renders nothing outside the Exo mobile app", () => {
    expect(renderToStaticMarkup(<OfflineVoiceNotes />)).toBe("");
  });

  test("Stop keeps the recording on the phone and recounts; a stop by the recorder itself counts too", () => {
    const source = read("OfflineVoiceNotes.tsx");
    const stop = source.slice(source.indexOf("const onStop = useCallback"), source.indexOf("return (\n    <OfflineVoiceNotesView"));
    expect(stop).toContain("await VoiceNotes.stop();");
    expect(stop).toContain("await refreshPending();");
    // Nothing here writes to a space or deletes the device copy.
    expect(source).not.toContain("readAudio");
    expect(source).not.toContain("deleteAudio");
    expect(source).not.toContain("saveVoiceNote");
    expect(source).toContain('if (event.state === "idle" && phaseRef.current === "recording") {');
  });
});

describe("savePendingVoiceNotes", () => {
  test("saves through the given single-flight and hands each saved note to transcription after its check", async () => {
    const order: string[] = [];
    let releaseCheck = () => {};
    const checked = new Promise<void>((resolve) => {
      releaseCheck = resolve;
    });
    const run: PendingRun = { total: 3, saved: [recording("a"), recording("b")], left: [recording("c")], lastError: "Failed to fetch" };
    const pending = savePendingVoiceNotes({
      save: async () => {
        order.push("save");
        return run;
      },
      transcriber: {
        check: async () => {
          order.push("check");
          await checked;
        },
        noteSaved: (r) => order.push(`noteSaved:${r.id}`),
      },
    });
    await Promise.resolve();
    expect(order).toEqual(["save", "check"]);
    releaseCheck();
    expect(await pending).toBe(run);
    expect(order).toEqual(["save", "check", "noteSaved:a", "noteSaved:b"]);
  });

  test("without transcription for this build or account it only saves", async () => {
    const run: PendingRun = { total: 1, saved: [recording("a")], left: [], lastError: null };
    expect(await savePendingVoiceNotes({ save: async () => run, transcriber: null })).toBe(run);
  });

  test("the saver is the card's own retry: the module-level single-flight, native app only", () => {
    const saver = read("PendingVoiceNotesSaver.tsx");
    expect(saver).toContain("save: () => savePendingRecordings(tcw),");
    expect(saver).toContain("if (!nativeVoiceNotesAvailable()) return;");
    // The single-flight now lives with the other save singletons (TC-761, PR4).
    const saves = read("../lib/voiceNotes/recorderSaves.ts");
    expect(saves).toContain("export function savePendingRecordings(tcw: TinyCloudWeb): Promise<PendingRun> {");
    expect(saves).toContain("if (pendingRunInFlight) return pendingRunInFlight;");
  });
});

describe("App wiring of offline voice notes", () => {
  const app = read("../App.tsx");

  test("offered only in the native app while a session is held: offline, and booting after Try again", () => {
    expect(app).toContain('if (state === "offline") setOfflineCapture(true);');
    expect(app).toContain('else if (state !== "booting") setOfflineCapture(false);');
    expect(app).toContain("const offlineRecorder = voiceNotesInApp && !LOCAL_VALIDATION && offlineCapture;");
    const boot = app.slice(app.indexOf("<BootSurface"), app.indexOf("/>", app.indexOf("<BootSurface")));
    expect(boot).toContain("offlineRecorder ? (");
    expect(boot).toContain("<OfflineVoiceNotes");
    // BootSurface renders the slot; nothing in it depends on the signed-out states.
    const shell = read("../shell/BootSurface.tsx");
    const surface = shell.slice(shell.indexOf("export function BootSurface("));
    expect(surface).toContain("{props.voiceNotes}");
  });

  test("once ready, notes on the phone are saved without opening Connectors", () => {
    expect(app).toContain("{voiceNotesInApp && !LOCAL_VALIDATION && state === \"ready\" && tcw && (");
    expect(app).toContain("<PendingVoiceNotesSaver");
  });

  test("a recording still running when the session returns is picked up by the recorder, never restarted", () => {
    // No handoff state in App any more: the one recorder asks the plugin what is running when it mounts.
    expect(app).not.toContain("voiceNoteOpen");
    expect(app).not.toContain("offlineRecordingRef");
    expect(app).toContain("<OfflineVoiceNotes />");
    const controller = read("../capture/recorder/voiceNoteRecorderController.ts");
    // Once its listeners are in (the retained events heard), it asks status() and picks the recording up.
    expect(controller).toContain(".then(() => VoiceNotes.status())");
    expect(controller).toContain('type: "PICKED_UP",');
  });
});
