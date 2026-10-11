import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { haloLabel, haloTicks, PipelineHalo, HALO_TICKS } from "./PipelineHalo";
import { allDone, pipelineOf, privateRunning, signedOut, uploading } from "./pipelineFixtures";

const html = (pipeline: Parameters<typeof PipelineHalo>[0]["pipeline"]) => renderToStaticMarkup(<PipelineHalo pipeline={pipeline} />);
const count = (markup: string, kind: string) => [...markup.matchAll(new RegExp(`data-tick="${kind}"`, "g"))].length;

describe("PipelineHalo", () => {
  test("a 14px svg with nine ticks", () => {
    const markup = html(uploading(0));
    expect(markup).toContain('width="14" height="14"');
    expect([...markup.matchAll(/<line /g)]).toHaveLength(HALO_TICKS);
    expect(HALO_TICKS).toBe(9);
  });

  test("renders nothing when done", () => {
    expect(html(allDone())).toBe("");
  });

  test("three steps own three ticks each; nothing is filled before the upload starts", () => {
    const markup = html(pipelineOf());
    expect(count(markup, "empty")).toBe(9);
  });

  test("the active step's ticks are partly filled, clockwise from the top", () => {
    // space is 3 ticks: 50% of 3 = 1 full tick + the second tick half-lit
    expect(haloTicks(uploading(50))).toEqual(["filled", "partial", "empty", "empty", "empty", "empty", "empty", "empty", "empty"]);
    expect(haloTicks(uploading(100))).toEqual(["filled", "filled", "filled", "empty", "empty", "empty", "empty", "empty", "empty"]);
    expect(count(html(uploading(50)), "partial")).toBe(1);
  });

  test("an active step with no progress lights its first tick halfway", () => {
    const ticks = haloTicks(pipelineOf({ space: { saved: false, pending: { upload: { state: "retrying", bytes: 0, total: 0 } } } }));
    expect(ticks.slice(0, 3)).toEqual(["partial", "empty", "empty"]);
  });

  test("finished steps are full, and the step after them carries the partial fill", () => {
    const ticks = haloTicks(privateRunning(1, 2));
    expect(ticks).toEqual(["filled", "filled", "filled", "filled", "partial", "empty", "empty", "empty", "empty"]);
  });

  test("with two visible steps the nine ticks split five and four", () => {
    const ticks = haloTicks(pipelineOf({ hasNotesOrMoments: false, space: { saved: true, pending: null }, transcript: { inSpace: "transcribed", onDevice: null, cloud: null } }));
    expect(ticks).toEqual(Array(9).fill("filled"));
    const partial = haloTicks(pipelineOf({ hasNotesOrMoments: false, space: { saved: true, pending: null }, transcript: { inSpace: null, onDevice: null, cloud: { kind: "active", status: { kind: "processing", completed: 1, total: 4 } } } }));
    expect(partial.slice(0, 6)).toEqual(Array(6).fill("filled"));
    expect(partial[6]).toBe("partial");
    expect(partial).toHaveLength(9);
  });

  test("a blocked or failed note shows a bang, a moving one does not", () => {
    expect(html(signedOut())).toContain("data-halo-bang");
    expect(html(pipelineOf({ space: { saved: false, pending: { failed: { kind: "timeout", message: "x" } } } }))).toContain("data-halo-bang");
    expect(html(uploading(10))).not.toContain("data-halo-bang");
  });

  test("the label is the cause, or the current step's caption", () => {
    expect(html(uploading(42))).toContain('aria-label="Uploading · 42%"');
    expect(html(signedOut())).toContain('aria-label="You&#x27;re signed out. This note is safe on this phone."');
    expect(haloLabel(pipelineOf({ space: { saved: false, pending: { held: "other-account" } } }))).toBe("Recorded on another account");
  });

  test("ink only, no colour", () => {
    expect(html(signedOut())).not.toMatch(/red|amber|#[0-9a-f]{3,6}/i);
  });
});
