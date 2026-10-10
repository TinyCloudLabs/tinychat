export interface HaloCanvasState {
  width: number;
  height: number;
  has2dContext: boolean;
  centerVisible: boolean;
  cornerAlpha: number | null;
}

export interface HaloCenterPixel {
  size: number;
  color: number[];
}

export function inspectHaloPixels(options: {
  checkCorners?: boolean;
  diagnostics?: boolean;
}): boolean | { ready: boolean; canvases: HaloCanvasState[] } {
  const canvases = [
    ...document.querySelectorAll<HTMLCanvasElement>(".halo-ring__canvas"),
  ];
  const states = canvases.map((canvas) => {
    const context = canvas.getContext("2d");
    let centerVisible = false;
    let cornerAlpha: number | null = null;
    if (context && canvas.width > 1 && canvas.height > 1) {
      const pixels = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      ).data;
      for (
        let y = Math.floor(canvas.height * 0.3);
        y < canvas.height * 0.7 && !centerVisible;
        y += 4
      ) {
        for (
          let x = Math.floor(canvas.width * 0.3);
          x < canvas.width * 0.7;
          x += 4
        ) {
          if (pixels[(y * canvas.width + x) * 4 + 3] > 0) {
            centerVisible = true;
            break;
          }
        }
      }
      cornerAlpha =
        pixels[3] +
        pixels[(canvas.width - 1) * 4 + 3] +
        pixels[(canvas.height - 1) * canvas.width * 4 + 3] +
        pixels[(canvas.height * canvas.width - 1) * 4 + 3];
    }
    return {
      width: canvas.width,
      height: canvas.height,
      has2dContext: context !== null,
      centerVisible,
      cornerAlpha,
    };
  });
  const ready =
    canvases.length === 8 &&
    states.every(
      (state) =>
        state.has2dContext &&
        state.width > 1 &&
        state.height > 1 &&
        state.centerVisible &&
        (!options.checkCorners || state.cornerAlpha === 0),
    );
  if (options.diagnostics) return { ready, canvases: states };
  return ready;
}

export function readHaloCenterPixel(
  canvas: HTMLCanvasElement,
): HaloCenterPixel {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Halo output canvas has no 2D context");
  return {
    size: canvas.width,
    color: [
      ...context
        .getImageData(
          Math.floor(canvas.width / 2),
          Math.floor(canvas.height / 2),
          1,
          1,
        )
        .data.slice(0, 3),
    ],
  };
}

export function readHaloThemeColor(
  canvas: HTMLCanvasElement,
  theme: "light" | "dark",
): number[] {
  const token = getComputedStyle(canvas)
    .getPropertyValue(theme === "dark" ? "--secondary" : "--card")
    .trim();
  if (!token) throw new Error(`Halo ${theme} fill token is missing`);
  const sample = canvas.ownerDocument.createElement("canvas");
  sample.width = sample.height = 1;
  const context = sample.getContext("2d");
  if (!context) throw new Error("Unable to sample the halo theme token");
  context.fillStyle = `hsl(${token})`;
  context.fillRect(0, 0, 1, 1);
  return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
}
