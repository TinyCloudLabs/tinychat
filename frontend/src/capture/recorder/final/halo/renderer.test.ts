import { describe, expect, mock, test } from "bun:test";
import {
  easePause,
  haloFrameInterval,
  HaloRafLoop,
  pauseBreathOpacity,
  selectRenderSurface,
  TICKS_SHADER,
} from "./renderer";

describe("halo renderer selection", () => {
  test("selects and logs Canvas 2D when WebGL getContext returns null", () => {
    const getContext = mock(() => null);
    const canvas = { getContext } as unknown as HTMLCanvasElement;
    const logPath = mock((_path: string) => {});

    const selected = selectRenderSurface(
      () => null,
      () => canvas,
      logPath,
    );

    expect(selected.path).toBe("canvas-2d");
    expect(selected.gl).toBeNull();
    expect(selected.canvas).toBe(canvas);
    expect(getContext).toHaveBeenCalledWith("webgl", expect.any(Object));
    expect(logPath).toHaveBeenCalledWith("canvas-2d");
  });

  test("stops with no visible work and restarts when a ring becomes visible", () => {
    let pending: FrameRequestCallback | null = null;
    let requests = 0;
    let visible = false;
    const loop = new HaloRafLoop(
      () => visible,
      (callback) => {
        pending = callback;
        return ++requests;
      },
      () => {
        pending = null;
      },
    );
    const frame = (time: number) => {
      const callback = pending;
      pending = null;
      callback?.(time);
    };

    loop.start();
    frame(0);
    expect(requests).toBe(1);
    expect(pending).toBeNull();

    visible = true;
    loop.start();
    frame(16);
    expect(requests).toBe(3);
    expect(pending).not.toBeNull();

    loop.stop();
    expect(pending).toBeNull();
  });

  test("uses 15 fps for quiet, paused and still rings while level activity stays live", () => {
    expect(
      haloFrameInterval("webgl-atlas", 0, 0, false, false, false),
    ).toBeCloseTo(1000 / 15);
    expect(haloFrameInterval("webgl-atlas", 0.2, 0, false, false, false)).toBe(
      0,
    );
    expect(
      haloFrameInterval("webgl-atlas", 0.3, 0.2, true, false, false),
    ).toBeCloseTo(1000 / 15);
    expect(
      haloFrameInterval("canvas-2d", 0.3, 0.8, false, false, false),
    ).toBeCloseTo(1000 / 15);
    expect(haloFrameInterval("webgl-atlas", 0.3, 0.8, true, false, true)).toBe(
      0,
    );
  });

  test("eases the pause drain over the prototype's 150 ms time constant", () => {
    let pause = 0;
    for (let frame = 0; frame < 9; frame++) pause = easePause(pause, 1, 1 / 60);
    expect(pause).toBeGreaterThan(0.6);
    expect(pause).toBeLessThan(0.7);
  });

  test("gates paused breathing for reduced motion in WebGL and Canvas 2D", () => {
    expect(pauseBreathOpacity(0, 1, true)).toBe(1);
    expect(pauseBreathOpacity(1, 1, true)).toBe(1);
    expect(pauseBreathOpacity(0, 1, false)).not.toBe(
      pauseBreathOpacity(1, 1, false),
    );
    expect(TICKS_SHADER).toContain("uPause * (1.0 - uReduce)");
  });
});
