// The Done receipt for a Local note: the truthful source, the static "needs the model" block with
// its two ways forward, and when the receipt counts as offering something to press.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { honestSourceRoute, NeedsOnDeviceModel, onDeviceOffer, SavedReceipt } from "./SavedReceipt";
import { voiceNoteRoute } from "./RouteLine";
import type { NotePipeline } from "@/lib/voiceNotes/notePipeline";
import { allDone, pipelineOf, signedOut, uploading, waitingForModel } from "@/capture/pipeline/pipelineFixtures";
import { RECEIPT_ACTION_MS, RECEIPT_MS, receiptWindowMs } from "./RecorderProvider";

const noop = () => {};
const guideWithAction = { reason: "The on-device model isn't downloaded (602 MB)", action: { label: "Get the on-device model", run: noop } };
const waiting = { kind: "pending", state: "waiting_for_model", retry: noop } as const;
const offer = (patch: Partial<Parameters<typeof onDeviceOffer>[0]> = {}) =>
  onDeviceOffer({ onDevice: waiting, guide: guideWithAction, modelReady: false, saved: true, hasNote: true, movedToPrivate: false, canUsePrivate: true, canOpen: false, ...patch });

describe("the needs-the-model block", () => {
  test("is static copy and two buttons, with no spinner", () => {
    const html = renderToStaticMarkup(<NeedsOnDeviceModel guide={guideWithAction} error={null} onUsePrivate={noop} />);
    expect(html).toContain("Needs the on-device model");
    expect(html).toContain("Get model");
    expect(html).toContain("Use Private instead");
    expect(html).not.toContain("animate-spin");
    expect(html).not.toContain("Waiting for the on-device model");
  });

  test("Use Private instead is absent when private cloud is not on offer", () => {
    const html = renderToStaticMarkup(<NeedsOnDeviceModel guide={guideWithAction} error={null} />);
    expect(html).toContain("Get model");
    expect(html).not.toContain("Use Private instead");
  });

  test("while the model downloads it says so rather than offering to get it again", () => {
    const html = renderToStaticMarkup(<NeedsOnDeviceModel guide={{ reason: "Downloading the model: 50% of 602 MB" }} error={null} onUsePrivate={noop} />);
    expect(html).toContain("Downloading the model: 50% of 602 MB");
    expect(html).not.toContain("Get model");
    expect(html).toContain("Use Private instead");
  });

  test("a failed attempt to switch or download shows safe copy", () => {
    expect(renderToStaticMarkup(<NeedsOnDeviceModel guide={guideWithAction} error="Could not stop it" />)).toContain("Couldn&#x27;t switch to Private. Try again.");
  });
});

describe("what the receipt is offering", () => {
  test("waiting for the model with something to press is actionable and shows the block", () => {
    expect(offer()).toEqual({ needsModel: true, usePrivate: true, actionable: true });
    expect(offer({ canUsePrivate: false })).toMatchObject({ needsModel: true, usePrivate: false, actionable: true });
    expect(offer({ guide: { reason: "Downloading…" }, canUsePrivate: false })).toMatchObject({ needsModel: true, actionable: false });
  });

  test("with the model on the phone the note's seeded waiting_for_model is not 'Needs the on-device model'", () => {
    expect(offer({ modelReady: true })).toEqual({ needsModel: false, usePrivate: false, actionable: false });
  });

  test("Use Private instead needs a note that is saved", () => {
    expect(offer({ saved: false })).toMatchObject({ needsModel: true, usePrivate: false });
  });

  test("a note moved to private cloud offers nothing from the phone", () => {
    expect(offer({ movedToPrivate: true })).toEqual({ needsModel: false, usePrivate: false, actionable: false });
    expect(offer({ onDevice: { kind: "failed", retry: noop }, movedToPrivate: true }).actionable).toBe(false);
  });

  test("a failed on-device note with a saved note is actionable (Retry); queued and running are not", () => {
    expect(offer({ onDevice: { kind: "failed", retry: noop } })).toMatchObject({ needsModel: false, actionable: true });
    expect(offer({ onDevice: { kind: "failed", retry: noop }, hasNote: false }).actionable).toBe(false);
    expect(offer({ onDevice: { kind: "pending", state: "running", retry: noop } })).toMatchObject({ needsModel: false, actionable: false });
    expect(offer({ onDevice: { kind: "none", retry: noop } }).actionable).toBe(false);
  });
});

describe("how long the receipt stays: an Open button counts as something to press", () => {
  const transcript = { version: 1, noteId: "rec-1", transcriber: "on-device", rev: 1, outcome: "transcribed", segments: [] } as never;
  const windowFor = (patch: Parameters<typeof offer>[0] = {}) => receiptWindowMs(offer({ canOpen: true, ...patch }).actionable);

  test("every receipt that offers Open gets the longer window, whatever the note is doing", () => {
    const noMore = { canUsePrivate: false } as const;
    const states = [
      { onDevice: { kind: "pending", state: "running", retry: noop }, ...noMore },
      { onDevice: { kind: "pending", state: "queued", retry: noop }, ...noMore },
      { onDevice: { kind: "transcribed", transcript, retry: noop }, ...noMore },
      { onDevice: { kind: "transcribed", transcript: { ...transcript, outcome: "no_speech" }, retry: noop }, ...noMore },
      { onDevice: { kind: "none", retry: noop }, movedToPrivate: true, ...noMore },
      { onDevice: { kind: "none", retry: noop }, ...noMore },
    ] as const;
    for (const state of states) expect(windowFor(state)).toBe(RECEIPT_ACTION_MS);
  });

  test("starting the model download does not shorten the window while Open is there", () => {
    expect(windowFor()).toBe(RECEIPT_ACTION_MS);
    expect(windowFor({ guide: { reason: "Downloading the model: 5% of 602 MB" }, canUsePrivate: false })).toBe(RECEIPT_ACTION_MS);
  });

  test("a receipt with nothing to press still closes quickly", () => {
    expect(receiptWindowMs(offer({ onDevice: { kind: "pending", state: "running", retry: noop }, canUsePrivate: false }).actionable)).toBe(RECEIPT_MS);
  });
});

describe("the source on the route", () => {
  test("reads This iPhone until a transcript made there exists", () => {
    const route = voiceNoteRoute("on-device");
    expect(honestSourceRoute(route, false).map((node) => node.label)).toEqual(["This iPhone", "Your space"]);
    expect(honestSourceRoute(route, true).map((node) => node.label)).toEqual(["This iPhone (transcribed here)", "Your space"]);
  });

  test("other routes are untouched", () => {
    expect(honestSourceRoute(voiceNoteRoute("private-cloud"), false)).toEqual(voiceNoteRoute("private-cloud"));
  });
});

describe("the receipt's wording", () => {
  const render = (patch: Partial<Parameters<typeof SavedReceipt>[0]> = {}) => renderToStaticMarkup(
    <SavedReceipt outcome="saved" saved={{ id: "rec-1", durationMs: 65_000, at: Date.UTC(2026, 9, 9, 9, 41) }}
      route={voiceNoteRoute("on-device")} transcriber="on-device" onDone={noop} onSaveNow={noop} {...patch} />,
  );

  test("the saved location is said once, not as a heading and a label", () => {
    const html = render();
    expect(html).not.toContain("<h3");
    expect(html.match(/Saved on this browser/g) ?? []).toHaveLength(1);
    expect(html).toContain('aria-label="Saved on this browser"');
  });

  test("a Local note with no transcript yet names its source This iPhone", () => {
    const html = render();
    expect(html).not.toContain("transcribed here");
  });

  test("a held local receipt names only its actual account cause", () => {
    const held = (holdReason?: "signed-out" | "other-account" | "legacy" | "unowned") => render({ outcome: "local", localUpload: "held", holdReason });
    expect(held("other-account")).toContain("Recorded on another account");
    expect(held("signed-out")).toContain("Sign in to sync to your TinyCloud space");
    expect(held("legacy")).toContain("Exo can&#x27;t tell which account this note belongs to");
    expect(held("unowned")).toContain("Exo can&#x27;t tell which account this note belongs to");
    expect(held()).not.toContain("Recorded on another account");
  });

  test("a note private cloud has taken shows no on-device line", () => {
    const html = render({ movedToPrivate: true, transcribing: true });
    expect(html).toContain("Transcribing in private cloud…");
    expect(html).not.toContain("Transcribing on this phone");
  });

  test("a note Private finished says so, with no transcribing line left behind", () => {
    const html = render({ transcriber: "private-cloud", route: voiceNoteRoute("private-cloud"), privateOutcome: "transcribed" });
    expect(html).toContain("Transcribed in private cloud");
    expect(html).not.toContain("Transcribing in private cloud");
    expect(render({ transcriber: "private-cloud", privateOutcome: "no_speech" })).toContain("No speech found");
  });

  test("a Powerful note names Powerful while running and when it finishes or fails", () => {
    const powerful = { transcriber: "assemblyai" as const, route: voiceNoteRoute("assemblyai") };
    expect(render({ ...powerful, transcribing: true })).toContain("Transcribing with Powerful…");
    expect(render({ ...powerful, privateOutcome: "transcribed" })).toContain("Transcribed with Powerful");
    expect(render({ ...powerful, privateOutcome: "no_speech" })).toContain("No speech found");
    expect(render({ ...powerful, privateFailure: "Today's Powerful allowance is used." })).toContain("Powerful transcription didn&#x27;t finish.");
  });

  test("a failure of a note committed to Private is shown too, not only after a switch", () => {
    expect(render({ transcriber: "private-cloud", privateFailure: "service busy" })).toContain("Private transcription didn&#x27;t finish.");
  });

  test("an Audio only note says nothing about transcribing", () => {
    const html = render({ transcriber: "off", route: voiceNoteRoute("off") });
    expect(html).not.toContain("ranscrib");
  });

  test("a private-cloud failure after the switch is shown, not silent", () => {
    expect(render({ movedToPrivate: true, privateFailure: "service busy" })).toContain("Private transcription didn&#x27;t finish.");
  });
});


describe("the receipt's pipeline stepper", () => {
  const view = (pipeline: NotePipeline, actionError: string | null = null) => ({ pipeline, onAction: noop, actionError });
  const render = (pipeline: NotePipeline, patch: Partial<Parameters<typeof SavedReceipt>[0]> = {}, actionError: string | null = null) => renderToStaticMarkup(
    <SavedReceipt outcome="local" saved={{ id: "rec-1", durationMs: 65_000, at: Date.UTC(2026, 9, 9, 9, 41) }}
      route={voiceNoteRoute("private-cloud")} transcriber="private-cloud" onDone={noop} onSaveNow={noop} pipeline={view(pipeline, actionError)} {...patch} />,
  );

  test("an uploading note shows the stepper in place of the route line and the saving line", () => {
    const html = render(uploading(40), { localUpload: "in-flight" });
    expect(html).toContain('data-testid="voice-note-receipt-pipeline"');
    expect(html).toContain("Uploading audio to your TinyCloud space");
    expect(html).not.toContain("Saving to your TinyCloud space…");
    expect(html).not.toContain("Another save is finishing");
  });

  test("a signed-out note says so from the selector, not 'needs an ownership check'", () => {
    const pipeline = signedOut();
    const html = render(pipeline, { localUpload: "held" });
    expect(html).toContain(pipeline.blocker!.cause.replace("'", "&#x27;"));
    expect(html).toContain(pipeline.blocker!.action!.label);
    expect(html).not.toContain("ownership check");
  });

  test("a note waiting for the model offers the download from the stepper, once", () => {
    const html = render(waitingForModel(), { outcome: "saved", transcriber: "on-device", route: voiceNoteRoute("on-device") });
    expect(html.match(/Get model/g) ?? []).toHaveLength(1);
    expect(html).not.toContain("Needs the on-device model");
  });

  test("a rejected action's message shows in the blocker line", () => {
    expect(render(signedOut(), {}, "Sign-in failed: offline")).toContain("Sign-in failed: offline");
  });

  test("a receipt with ongoing notes sync keeps the durable coverage reason in its only status line", () => {
    const pipeline = pipelineOf({ route: "off", hasNotesOrMoments: true,
      space: { saved: true, pending: null, lane: { busy: false, depth: 0 } },
      transcript: { inSpace: null, persistedState: "failed", errorCode: "transcript_incomplete", cloud: null, onDevice: null },
      notes: { state: "syncing" } });
    const html = render(pipeline, { outcome: "saved", transcriber: "off", route: voiceNoteRoute("off") });
    expect(html).toContain('data-testid="voice-note-receipt-pipeline"');
    expect(html.match(/Private Transcription returned a transcript that may be incomplete/g)).toHaveLength(1);
  });

  test("done shows no stepper and the landed state", () => {
    const html = render(allDone(), { outcome: "saved" });
    expect(html).not.toContain("voice-note-receipt-pipeline");
    expect(html).toContain("In your TinyCloud space");
  });

  test("while the pipeline is still being read, neither the stepper nor the old saving line flashes", () => {
    const html = renderToStaticMarkup(
      <SavedReceipt outcome="local" saved={{ id: "rec-1", durationMs: 65_000, at: 0 }} route={voiceNoteRoute("private-cloud")} transcriber="private-cloud" onDone={noop} onSaveNow={noop} pipeline={null} pipelineReading />,
    );
    expect(html).not.toContain("voice-note-receipt-pipeline");
    expect(html).not.toContain("Saving to your TinyCloud space…");
  });
});
