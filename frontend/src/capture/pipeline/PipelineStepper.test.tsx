import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { notePipeline, type NotePipeline, type PipelineActionKind } from "@/lib/voiceNotes/notePipeline";
import { installDom } from "@/test/dom";
import { PipelineStepper } from "./PipelineStepper";
import { allDone, pipelineOf, privateRunning, signedOut, uploading } from "./pipelineFixtures";

const noop = () => {};
const render = (pipeline: NotePipeline) => renderToStaticMarkup(<PipelineStepper pipeline={pipeline} onAction={noop} />);
const nodeStates = (html: string) => [...html.matchAll(/<li data-step="(\w+)" data-state="(\w+)"/g)].map((m) => [m[1], m[2]]);

let cleanupDom: (() => void) | undefined;
afterEach(() => { cleanupDom?.(); cleanupDom = undefined; });

describe("PipelineStepper", () => {
  test("parallel status rows show each track's state to screen readers", () => {
    const html = render(uploading(42));
    expect(html).toContain('<ul aria-label="Where this note is" class="pipeline-stepper-list"');
    expect(nodeStates(html)).toEqual([["phone", "done"], ["space", "active"], ["transcript", "waiting"]]);
    expect(html).toContain('class="pipeline-stepper-label">Audio on this phone</span>');
    expect(html).toContain('class="pipeline-stepper-label">Audio in your space</span>');
    expect(html).toContain('class="pipeline-stepper-label">Transcript</span>');
    expect(html).toContain("Uploading · 42%");
  });

  test("skipped steps are not drawn", () => {
    const html = render(pipelineOf({ route: "off", hasNotesOrMoments: false }));
    expect(nodeStates(html)).toEqual([["phone", "done"], ["space", "waiting"]]);
    expect(html).not.toContain('data-step="transcript"');
  });

  test("statuses use calm text without sequencing connectors", () => {
    const html = render(uploading(50));
    expect(html).toContain('<span class="pipeline-stepper-status">Uploading · 50%</span>');
    expect(html).not.toContain("pipeline-stepper-connector");
    expect(html).not.toContain("pipeline-stepper-node");
  });

  test("no red, amber or check marks anywhere", () => {
    for (const pipeline of [uploading(10), signedOut(), privateRunning(1, 2)]) {
      const html = render(pipeline);
      expect(html).not.toMatch(/red|amber|warning|destructive|primary|lucide/i);
    }
  });

  test("each track carries its own caption", () => {
    const html = render(uploading(42));
    expect(html).toContain("Uploading · 42%");
    expect(html).not.toContain("data-pipeline-blocker");
    expect(render(privateRunning(4, 9))).toContain("Transcribing · 4 of 9");
  });

  test("a blocker is the cause and one button, and a blocker has no caption", () => {
    const html = render(signedOut());
    expect(html).toContain("You&#x27;re signed out. This note is safe on this phone.");
    expect(html).toMatch(/<button type="button" class="soft-pill" aria-describedby="[^"]+">Sign in<\/button>/);
    expect([...html.matchAll(/<button/g)]).toHaveLength(1);
    expect(html).not.toContain("data-pipeline-caption");
  });

  test("a polite status region carries the blocker's cause, and is empty without one", () => {
    expect(render(signedOut())).toContain(
      'role="status" aria-live="polite" aria-atomic="true" data-pipeline-announce="">You&#x27;re signed out. This note is safe on this phone.</p>',
    );
    expect(render(uploading(40))).toContain('data-pipeline-announce=""></p>');
  });

  test("the status region updates in place when the blocker changes", async () => {
    cleanupDom = installDom();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const announce = () => host.querySelector("[data-pipeline-announce]");
    await act(async () => { root.render(createElement(PipelineStepper, { pipeline: uploading(40), onAction: noop })); });
    const region = announce();
    expect(region?.textContent).toBe("");
    await act(async () => { root.render(createElement(PipelineStepper, { pipeline: signedOut(), onAction: noop })); });
    expect(announce()).toBe(region);
    expect(region?.textContent).toBe("You're signed out. This note is safe on this phone.");
    await act(async () => { root.unmount(); });
  });

  test("a blocker without an action has no button", () => {
    const html = render(pipelineOf({ space: { saved: false, pending: { held: "other-account" }, lane: { busy: false, depth: 0 } } }));
    expect(html).toContain("Recorded on another account");
    expect(html).not.toContain("<button");
  });

  test("a saved transcript stays visible while audio is uploading", () => {
    const html = render(pipelineOf({
      route: "on-device",
      transcript: { inSpace: null, cloud: null, onDevice: { stt: { state: "done", error: null }, queue: null, model: { state: "ready", bytes: 640, totalBytes: 640, error: null }, download: "idle", sync: null } },
      space: { saved: false, pending: { upload: { state: "uploading", bytes: 20, total: 100 } } },
    }));
    expect(html).toContain('data-step="transcript" data-state="done"');
    expect(html).toContain('<span class="pipeline-stepper-status">Ready on this phone</span>');
    expect(html).toContain('<span class="pipeline-stepper-status">Uploading · 20%</span>');
  });

  test("keeps notes progress and read failures visible before upload", () => {
    const syncing = render(pipelineOf({ route: "off", hasNotesOrMoments: true, notes: { state: "syncing" } }));
    expect(syncing).toContain("Syncing notes…");
    const unreadable = render(pipelineOf({ route: "off", hasNotesOrMoments: true, notes: { state: "unreadable", cause: "disk unavailable" } }));
    expect(unreadable).toContain("Couldn&#x27;t read this note&#x27;s text on this phone");
    expect(unreadable).toContain("Try again");
  });

  test("a notice about a saved note's partial audio shows as information", () => {
    const html = render(pipelineOf({ capture: { finalizing: false, issue: "partial_audio" } }));
    expect(html).toContain("data-pipeline-notice");
    expect(html).toContain("part of this recording couldn&#x27;t be written");
  });

  test("renders nothing when done", () => {
    expect(allDone().done).toBe(true);
    expect(render(allDone())).toBe("");
  });

  test("a done pipeline renders nothing even with a stale blocker attached", () => {
    expect(render({ ...notePipeline(allDoneInput()), blocker: { cause: "x" } })).toBe("");
  });

  test("track rows adapt to large text and 320px widths", async () => {
    const css = await Bun.file(new URL("./PipelineStepper.css", import.meta.url)).text();
    expect(css).toContain("container-type: inline-size");
    expect(css).toContain("grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr)");
    expect(css).not.toMatch(/font-size:\s*[\d.]+px/);
    expect(css.match(/font-size:\s*0\.78125rem/g)?.length).toBeGreaterThanOrEqual(3);
    expect(css).toMatch(/\.pipeline-stepper \.soft-pill \{[^}]*font-size: 0\.78125rem/);
    expect(css).not.toMatch(/(?:#[0-9a-f]{3,6}\b|rgb|hsl\(var\(--(?:warning|destructive)\))/i);
  });

  test("the button calls onAction with the action's kind", async () => {
    cleanupDom = installDom();
    const host = document.createElement("div");
    document.body.append(host);
    const calls: PipelineActionKind[] = [];
    const root = createRoot(host);
    await act(async () => root.render(createElement(PipelineStepper, { pipeline: signedOut(), onAction: (kind: PipelineActionKind) => calls.push(kind) })));
    const button = host.querySelector("button")!;
    expect(button.textContent).toBe("Sign in");
    expect(button.getAttribute("aria-describedby")).toBe(host.querySelector(".pipeline-stepper-cause")!.id);
    await act(async () => { button.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
    expect(calls).toEqual(["sign-in"]);
    await act(async () => root.unmount());
  });

  test("each action kind reaches onAction", async () => {
    cleanupDom = installDom();
    const cases: [NotePipeline, PipelineActionKind, string][] = [
      [pipelineOf({ space: { saved: false, pending: { failed: { kind: "timeout", message: "x" } } } }), "retry", "Try again"],
      [pipelineOf({ space: { saved: true, pending: null }, transcript: { inSpace: null, onDevice: null, cloud: { kind: "blocked", reason: "unavailable" } } }), "check-again", "Check again"],
      [pipelineOf({ route: "on-device", space: { saved: true, pending: null }, transcript: { inSpace: null, cloud: null, onDevice: { stt: { state: "waiting_for_model", error: null }, queue: null, model: { state: "absent", bytes: 0, totalBytes: 640, error: null }, download: "idle", sync: null } } }), "get-model", "Get the model"],
    ];
    for (const [pipeline, kind, label] of cases) {
      const host = document.createElement("div");
      document.body.append(host);
      const calls: PipelineActionKind[] = [];
      const root = createRoot(host);
      await act(async () => root.render(createElement(PipelineStepper, { pipeline, onAction: (k: PipelineActionKind) => calls.push(k) })));
      const button = host.querySelector("button")!;
      expect(button.textContent).toBe(label);
      await act(async () => { button.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
      expect(calls).toEqual([kind]);
      await act(async () => root.unmount());
    }
  });
});

function allDoneInput() {
  return {
    device: "phone" as const, route: "off" as const, hasNotesOrMoments: false, online: true,
    capture: { finalizing: false, issue: null }, space: { saved: true, pending: null },
    transcript: { inSpace: null, onDevice: null, cloud: null }, notes: { state: "idle" as const },
  };
}
