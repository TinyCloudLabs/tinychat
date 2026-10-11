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
  test("an ordered list of the visible steps, with a per-step state for screen readers", () => {
    const html = render(uploading(42));
    expect(html).toContain('<ol aria-label="Where this note is" class="pipeline-stepper-list"');
    expect(html).toContain("--pipeline-step-count:4");
    expect(nodeStates(html)).toEqual([["phone", "done"], ["space", "active"], ["transcript", "upcoming"], ["notes", "upcoming"]]);
    expect(html).toContain('On this phone<span class="sr-only">, done</span>');
    expect(html).toContain('In your space<span class="sr-only">, in progress</span>');
    expect(html).toContain('Transcript<span class="sr-only">, not started</span>');
  });

  test("skipped steps are not drawn", () => {
    const html = render(pipelineOf({ route: "off", hasNotesOrMoments: false }));
    expect(nodeStates(html)).toEqual([["phone", "done"], ["space", "waiting"]]);
    expect(html).toContain("--pipeline-step-count:2");
  });

  test("done: a filled ink dot; upcoming and waiting: a hollow --line ring", () => {
    const html = render(pipelineOf());
    const nodes = html.match(/<svg class="pipeline-stepper-node"[^>]*>.*?<\/svg>/g)!;
    expect(nodes[0]).toContain('data-node-state="done"');
    expect(nodes[0]).toContain('fill="var(--ink)"');
    expect(nodes[1]).toContain('data-node-state="waiting"');
    expect(nodes[1]).toContain('fill="none" stroke="var(--line)"');
    expect(nodes[3]).toContain('data-node-state="upcoming"');
    expect(nodes[3]).toContain('stroke="var(--line)"');
    expect(nodes[3]).not.toContain("var(--ink)");
  });

  test("active: a ring with a thin arc that is exactly as long as the progress, and still", () => {
    const html = render(uploading(50));
    const node = html.match(/<svg class="pipeline-stepper-node"[^>]*data-node-state="active"[^>]*>.*?<\/svg>/)![0];
    expect(node).toContain('data-arc="progress"');
    expect(node).not.toContain("pipeline-stepper-spin");
    const circumference = 2 * Math.PI * 6;
    expect(node).toContain(`stroke-dasharray="${circumference * 0.5} ${circumference}"`);
    expect(node).toContain('stroke-width="1.5"');
  });

  test("active with no known progress: a short arc that is the only thing that spins", () => {
    const html = render(pipelineOf({ space: { saved: false, pending: { upload: { state: "retrying", bytes: 0, total: 0 } } } }));
    expect(html).toContain('data-arc="unknown"');
    expect(html).toContain("pipeline-stepper-spin");
  });

  test("blocked: a hollow ring with a bang; failed: a filled ink dot with a bang", () => {
    const blocked = render(signedOut()).match(/<svg class="pipeline-stepper-node"[^>]*data-node-state="blocked"[^>]*>.*?<\/svg>/)![0];
    expect(blocked).toContain('fill="none" stroke="var(--ink)"');
    expect(blocked).toContain('<path d="M8 4.6 V8.4"');
    const failed = render(pipelineOf({ space: { saved: false, pending: { failed: { kind: "timeout", message: "x" } } } }))
      .match(/<svg class="pipeline-stepper-node"[^>]*data-node-state="failed"[^>]*>.*?<\/svg>/)![0];
    expect(failed).toContain('<circle cx="8" cy="8" r="7" fill="var(--ink)"></circle>');
    expect(failed).toContain('stroke="var(--bgc)"');
  });

  test("no red, amber or check marks anywhere", () => {
    for (const pipeline of [uploading(10), signedOut(), privateRunning(1, 2)]) {
      const html = render(pipeline);
      expect(html).not.toMatch(/red|amber|warning|destructive|primary|lucide/i);
    }
  });

  test("the connector is ink up to the current step", () => {
    const html = render(uploading(10));
    const connectors = [...html.matchAll(/<span class="pipeline-stepper-connector"( data-ink="")?><\/span>/g)].map((m) => m[1] !== undefined);
    expect(connectors).toEqual([true, false, false]);
    expect([...render(privateRunning(1, 3)).matchAll(/pipeline-stepper-connector"( data-ink="")?/g)].map((m) => m[1] !== undefined)).toEqual([true, true, false]);
  });

  test("one caption, for the current step only", () => {
    const html = render(uploading(42));
    expect([...html.matchAll(/data-pipeline-caption=""/g)]).toHaveLength(1);
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
    const dom = installDom();
    cleanupDom = dom.cleanup;
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

  test("Ready on this phone shows under the transcript label while the upload is the current step", () => {
    const html = render(pipelineOf({
      route: "on-device",
      transcript: { inSpace: null, cloud: null, onDevice: { stt: { state: "done", error: null }, queue: null, model: null, download: "idle", sync: null } },
      space: { saved: false, pending: { upload: { state: "uploading", bytes: 20, total: 100 } } },
    }));
    expect(html).toContain('<span class="pipeline-stepper-sublabel">Ready on this phone</span>');
    expect(html).toContain("Uploading · 20%");
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

  test("the large-text stacking container query is declared", async () => {
    const css = await Bun.file(new URL("./PipelineStepper.css", import.meta.url)).text();
    expect(css).toContain("container-type: inline-size");
    expect(css).toMatch(/@container pipeline-stepper \(max-width: 14rem\)/);
    expect(css).toContain("prefers-reduced-motion: no-preference");
    expect(css).not.toMatch(/font-size:\s*[\d.]+px/);
    expect(css.match(/font-size:\s*0\.78125rem/g)?.length).toBeGreaterThanOrEqual(4);
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
