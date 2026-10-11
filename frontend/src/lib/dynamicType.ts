/** iOS AX5 is roughly 3.3× body; cap rem-based layout at 2× so the
 * recorder, ribbon and navigation retain room on a phone. */
export const IOS_DYNAMIC_TYPE_MAX_SCALE = 2;
export const ANDROID_DYNAMIC_TYPE_MAX_SCALE = IOS_DYNAMIC_TYPE_MAX_SCALE;
const IOS_DYNAMIC_TYPE_MIN_SCALE = 1;
const IOS_DEFAULT_BODY_SIZE_PX = 17;

/** Android exposes the user's font scale directly, rather than a preferred body point size. */
export function androidDynamicTypeScale(fontScale: number): number {
  if (!Number.isFinite(fontScale) || fontScale <= 0) return 1;
  return Math.min(
    ANDROID_DYNAMIC_TYPE_MAX_SCALE,
    Math.max(IOS_DYNAMIC_TYPE_MIN_SCALE, fontScale),
  );
}

export function setAndroidDynamicTypeScale(root: HTMLElement, fontScale: number): number {
  const scale = androidDynamicTypeScale(fontScale);
  root.style.setProperty("--android-body-scale", String(scale));
  return scale;
}

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
