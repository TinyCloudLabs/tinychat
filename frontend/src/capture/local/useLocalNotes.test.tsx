import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installDom } from "@/test/dom";
import { VoiceNotes, __setVoiceNotesForTests, type VoiceNotesPlugin, type VoiceNoteRecording } from "@/lib/voiceNotes/nativeVoiceNotes";
import { useLocalNotes } from "./useLocalNotes";

const original = VoiceNotes;
let root: Root | null = null;
let restore: (() => void) | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  __setVoiceNotesForTests(original, { available: null });
  restore?.(); restore = null;
});

test("TC-2785 an old account read cannot publish into the next account or signed-out view", async () => {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const notes = [{ id: "a", owner: "did:A", startedAt: 1 }, { id: "b", owner: "did:B", startedAt: 2 }] as VoiceNoteRecording[];
  const oldRead = Promise.withResolvers<{ recordings: VoiceNoteRecording[] }>();
  let first = true;
  __setVoiceNotesForTests({
    listPending: () => { if (first) { first = false; return oldRead.promise; } return Promise.resolve({ recordings: notes }); },
    getCaptureDefaults: async () => ({ accountDid: "did:A", status: "signed_in" }),
    addListener: async () => ({ remove: async () => {} }),
  } as unknown as VoiceNotesPlugin, { available: true });
  let snapshot: ReturnType<typeof useLocalNotes> | null = null;
  function Probe({ did, offline = false }: { did: string | null; offline?: boolean }) {
    snapshot = useLocalNotes(did, offline);
    return <div>{snapshot.notes.map((note) => note.id).join(",")}</div>;
  }
  await act(async () => root!.render(<Probe did="did:A" />));
  await act(async () => root!.render(<Probe did="did:B" />));
  expect(host.textContent).toBe("b");
  await act(async () => { oldRead.resolve({ recordings: notes }); await oldRead.promise; });
  expect(host.textContent).toBe("b");
  await act(async () => root!.render(<Probe did={null} />));
  expect(host.textContent).toBe("");
  // An offline session still has the account proven by capture defaults.
  await act(async () => root!.render(<Probe did={null} offline />));
  expect(host.textContent).toBe("a");
  expect(snapshot!.accountDid).toBe("did:A");
});
