import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { haloLabel, haloTicks, PipelineHalo, HALO_TICKS, tickAngle } from "./PipelineHalo";
import { allDone, pipelineOf, privateRunning, signedOut, uploading } from "./pipelineFixtures";

const html = (pipeline: Parameters<typeof PipelineHalo>[0]["pipeline"]) => renderToStaticMarkup(<PipelineHalo pipeline={pipeline} />);
const count = (markup: string, kind: string) => [...markup.matchAll(new RegExp(`data-tick="${kind}"`, "g"))].length;

describe("PipelineHalo", () => {
  test("a 14px svg with nine rim ticks and a faint centre disc", () => {
    const markup = html(uploading(0));
    expect(markup).toContain('width="14" height="14"');
    expect([...markup.matchAll(/<line /g)]).toHaveLength(HALO_TICKS);
    expect(HALO_TICKS).toBe(9);
    expect(markup).toMatch(/data-halo-disc=""[^>]*r="2"[^>]*fill="var\(--dim\)"[^>]*fill-opacity="0.25"/);
  });

  test("renders nothing when done", () => {
    expect(html(allDone())).toBe("");
  });

  test("three clusters of three: 24 degrees inside a cluster, 72 degree gaps, one gap centred at 12 o'clock", () => {
    const angles = Array.from({ length: HALO_TICKS }, (_, i) => tickAngle(i));
    expect(angles).toEqual([36, 60, 84, 156, 180, 204, 276, 300, 324]);
    const gaps = angles.map((angle, i) => ((angles[(i + 1) % HALO_TICKS]! - angle + 360) % 360));
    expect(gaps).toEqual([24, 24, 72, 24, 24, 72, 24, 24, 72]);
    expect(((angles[0]! + (360 - angles[8]!)) / 2)).toBe(36);
  });

  test("ticks run from r 4.6 to r 6.4 with a 1.4 stroke and round caps", () => {
    const markup = html(uploading(0));
    const lines = [...markup.matchAll(/<line [^>]*>/g)].map((m) => m[0]);
    for (const [i, line] of lines.entries()) {
      const num = (name: string) => Number(new RegExp(`${name}="([-0-9.]+)"`).exec(line)![1]);
      expect(Math.hypot(num("x1") - 7, num("y1") - 7)).toBeCloseTo(4.6, 2);
      expect(Math.hypot(num("x2") - 7, num("y2") - 7)).toBeCloseTo(6.4, 2);
      const bearing = ((Math.atan2(num("x2") - 7, -(num("y2") - 7)) * 180) / Math.PI + 360) % 360;
      expect(bearing).toBeCloseTo(tickAngle(i), 1);
      expect(line).toContain('stroke-width="1.4"');
      expect(line).toContain('stroke-linecap="round"');
    }
  });

  test("two tones only: ink for done, --dim at 30% for to do, never an in-between", () => {
    const markup = html(uploading(50));
    expect([...markup.matchAll(/data-tick="([a-z]+)"/g)].every((m) => m[1] === "filled" || m[1] === "empty")).toBe(true);
    const opacities = new Set([...markup.matchAll(/<line [^>]*stroke-opacity="([0-9.]+)"/g)].map((m) => m[1]));
    expect([...opacities].sort()).toEqual(["0.3", "1"]);
    expect(markup).not.toContain("partial");
    expect(markup).not.toMatch(/stroke="var\(--line\)"/);
  });

  test("three steps own three ticks each; nothing is filled before the upload starts", () => {
    expect(haloTicks(pipelineOf())).toEqual(Array(9).fill("empty"));
  });

  test("an active step fills 1 or 2 of its 3 whole ticks, never all, clockwise from the top", () => {
    expect(haloTicks(uploading(0))).toEqual(["filled", "empty", "empty", ...Array(6).fill("empty")]);
    expect(haloTicks(uploading(50))).toEqual(["filled", "empty", "empty", ...Array(6).fill("empty")]);
    expect(haloTicks(uploading(70))).toEqual(["filled", "filled", "empty", ...Array(6).fill("empty")]);
    expect(haloTicks(uploading(99))).toEqual(["filled", "filled", "empty", ...Array(6).fill("empty")]);
    expect(count(html(uploading(70)), "filled")).toBe(2);
  });

  test("an active step with no progress fills one tick", () => {
    const ticks = haloTicks(pipelineOf({ space: { saved: false, pending: { upload: { state: "retrying", bytes: 0, total: 0 } }, lane: { busy: false, depth: 0 } } }));
    expect(ticks.slice(0, 3)).toEqual(["filled", "empty", "empty"]);
  });

  test("finished steps are full, and the next step fills 1 or 2 whole ticks", () => {
    expect(haloTicks(privateRunning(1, 2))).toEqual(["filled", "filled", "filled", "filled", "empty", "empty", "empty", "empty", "empty"]);
    expect(haloTicks(privateRunning(3, 4))).toEqual(["filled", "filled", "filled", "filled", "filled", "empty", "empty", "empty", "empty"]);
  });

  test("with two visible steps the nine ticks split five and four", () => {
    const ticks = haloTicks(pipelineOf({ hasNotesOrMoments: false, space: { saved: true, pending: null, lane: { busy: false, depth: 0 } }, transcript: { inSpace: "transcribed", onDevice: null, cloud: null } }));
    expect(ticks).toEqual(Array(9).fill("filled"));
    const partial = haloTicks(pipelineOf({ hasNotesOrMoments: false, space: { saved: true, pending: null, lane: { busy: false, depth: 0 } }, transcript: { inSpace: null, onDevice: null, cloud: { kind: "active", status: { kind: "processing", completed: 1, total: 4 } } } }));
    expect(partial.slice(0, 5)).toEqual(Array(5).fill("filled"));
    expect(partial.slice(5)).toEqual(["filled", "empty", "empty", "empty"]);
  });

  test("it never animates", () => {
    expect(html(uploading(50))).not.toMatch(/animate|transition|class=/);
  });

  test("a blocked or failed note shows a bang, a moving one does not", () => {
    expect(html(signedOut())).toContain("data-halo-bang");
    expect(html(pipelineOf({ space: { saved: false, pending: { failed: { kind: "timeout", message: "x" } }, lane: { busy: false, depth: 0 } } }))).toContain("data-halo-bang");
    expect(html(uploading(10))).not.toContain("data-halo-bang");
  });

  test("the label is the cause, or the current step's caption", () => {
    expect(html(uploading(42))).toContain('aria-label="Uploading · 42%"');
    expect(html(signedOut())).toContain('aria-label="You&#x27;re signed out. This note is safe on this phone."');
    expect(haloLabel(pipelineOf({ space: { saved: false, pending: { held: "other-account" }, lane: { busy: false, depth: 0 } } }))).toBe("Recorded on another account");
  });

  test("ink only, no colour", () => {
    expect(html(signedOut())).not.toMatch(/red|amber|#[0-9a-f]{3,6}/i);
  });

  test("the centre disc gives way to the bang", () => {
    expect(html(signedOut())).not.toContain("data-halo-disc");
    expect(html(uploading(10))).toContain("data-halo-disc");
  });
});
