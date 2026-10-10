import { describe, expect, mock, test } from "bun:test";
import {
  easePause,
  haloDrawCount,
  haloFrameInterval,
  HaloRafLoop,
  haloRenderPath,
  pauseBreathOpacity,
  registerHalo,
  selectRenderSurface,
  TICKS_SHADER,
  type HaloConfig,
} from "./renderer";
import { sourceFromLevel } from "./source";

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

// A permissive stand-in for a WebGL or 2D context: every member is a no-op
// that returns another stand-in, except the few the renderer branches on.
function permissive(overrides: Record<string, unknown> = {}): any {
  const target = function () {};
  return new Proxy(target, {
    get: (_target, key) => {
      if (key in overrides) return overrides[key];
      if (key === Symbol.toPrimitive) return () => 0;
      return permissive();
    },
    set: () => true,
    apply: () => permissive(),
  });
}

describe("halo renderer bitmap hold", () => {
  test("holds a bitmap for one frame and closes it when the last ring unmounts", () => {
    const g = globalThis as any;
    const saved = {
      OffscreenCanvas: g.OffscreenCanvas,
      document: g.document,
      window: g.window,
      matchMedia: g.matchMedia,
      IntersectionObserver: g.IntersectionObserver,
      ResizeObserver: g.ResizeObserver,
      requestAnimationFrame: g.requestAnimationFrame,
      cancelAnimationFrame: g.cancelAnimationFrame,
    };
    const bitmaps: { closed: boolean; close(): void }[] = [];
    const discCanvases: object[] = [];
    const uploadedDiscs: unknown[] = [];
    const discFills: string[] = [];
    const gl = permissive({
      isContextLost: () => false,
      texImage2D: (...args: unknown[]) => {
        const source = args.at(-1);
        if (source && discCanvases.includes(source as object)) {
          uploadedDiscs.push(source);
        }
      },
    });
    let theme: "night" | "day" = "night";
    const document = {
      documentElement: {},
      defaultView: {
        getComputedStyle: () => ({
          getPropertyValue: (name: string) => {
            if (name === "--solid") {
              return theme === "day"
                ? "hsl(0 0% 100%)"
                : "hsl(240 3.7% 15.9%)";
            }
            if (name === "--foreground") return "0 0% 98%";
            return "";
          },
        }),
      },
      createElement: () => {
        const gradient = { addColorStop() {} };
        const context = {
          set fillStyle(value: string | object) {
            if (typeof value === "string") discFills.push(value);
          },
          fillRect() {},
          createRadialGradient: () => gradient,
        };
        const disc = { width: 0, height: 0, getContext: () => context };
        discCanvases.push(disc);
        return disc;
      },
    } as unknown as Document;
    let intersect: (items: { isIntersecting: boolean }[]) => void = () => {};
    let frame: FrameRequestCallback | null = null;
    g.OffscreenCanvas = class {
      getContext() {
        return gl;
      }
      addEventListener() {}
      transferToImageBitmap() {
        const bitmap = {
          closed: false,
          close() {
            bitmap.closed = true;
          },
        };
        bitmaps.push(bitmap);
        return bitmap;
      }
    };
    g.document = document;
    g.window = { devicePixelRatio: 1 };
    g.matchMedia = () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    });
    g.IntersectionObserver = class {
      constructor(callback: typeof intersect) {
        intersect = callback;
      }
      observe() {}
      disconnect() {}
    };
    g.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
    g.requestAnimationFrame = (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    };
    g.cancelAnimationFrame = () => {
      frame = null;
    };
    const run = (now: number) => {
      const callback = frame;
      frame = null;
      callback?.(now);
    };

    try {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => permissive(),
        ownerDocument: document,
      } as unknown as HTMLCanvasElement;
      const config: HaloConfig = {
        size: 100,
        ticks: 40,
        paused: false,
        still: false,
        theme: "night",
        sourceRef: { current: sourceFromLevel(0.3) },
        weight: 1,
        spread: 1,
      };
      const unmount = registerHalo(canvas, config);
      expect(haloRenderPath()).toBe("webgl-atlas");
      expect(uploadedDiscs.length).toBeGreaterThan(0);
      expect(discFills).toContain("hsl(240 3.7% 15.9%)");
      const nightDisc = uploadedDiscs.at(-1);
      intersect([{ isIntersecting: true }]);

      run(1000);
      expect(bitmaps).toHaveLength(1);
      expect(bitmaps[0].closed).toBe(false);
      expect(haloDrawCount(canvas)).toBe(1);

      run(2000);
      expect(bitmaps).toHaveLength(2);
      expect(bitmaps[0].closed).toBe(true);
      expect(bitmaps[1].closed).toBe(false);

      theme = "day";
      config.theme = theme;
      run(3000);
      expect(uploadedDiscs.length).toBeGreaterThan(1);
      expect(uploadedDiscs.at(-1)).not.toBe(nightDisc);
      expect(discFills).toContain("hsl(0 0% 100%)");

      theme = "night";
      config.theme = theme;
      run(4000);
      expect(uploadedDiscs.at(-1)).toBe(nightDisc);

      unmount();
      expect(bitmaps.at(-1)?.closed).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete g[key];
        else g[key] = value;
      }
    }
  });
});
