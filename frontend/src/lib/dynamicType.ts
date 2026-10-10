/** iOS AX5 is roughly 3.3× body; cap rem-based layout at 2× so the
 * recorder, ribbon and navigation retain room on a phone. */
export const IOS_DYNAMIC_TYPE_MAX_SCALE = 2;
const IOS_DYNAMIC_TYPE_MIN_SCALE = 1;
const IOS_DEFAULT_BODY_SIZE_PX = 17;

export function iosDynamicTypeScale(bodySizePx: number): number {
  if (!Number.isFinite(bodySizePx) || bodySizePx <= 0) return 1;
  return Math.min(
    IOS_DYNAMIC_TYPE_MAX_SCALE,
    Math.max(IOS_DYNAMIC_TYPE_MIN_SCALE, bodySizePx / IOS_DEFAULT_BODY_SIZE_PX),
  );
}

export function setIOSDynamicTypeScale(root: HTMLElement, bodySizePx: number): number {
  const scale = iosDynamicTypeScale(bodySizePx);
  root.style.setProperty("--ios-body-scale", String(scale));
  return scale;
}
