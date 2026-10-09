import { describe, expect, mock, test } from "bun:test";
import { selectRenderSurface } from "./renderer";

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
});
