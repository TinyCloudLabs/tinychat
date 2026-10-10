import type { RecorderLayout } from "./final/shellCapabilities";

/** Which view fills the recorder overlay: the saved or failed recording's receipt, the phone's Soft recorder, or the desktop ring view in the main region. */
export type OverlayMount = "receipt" | "phone" | "desktop";

export interface OverlayMountInput {
  layout: RecorderLayout;
  /** The recorder can record on this shell. */
  available: boolean;
  /** There is a main region to draw the ring view in (the shell's recorder host); the signed-out overlay, above the gate, has none. */
  hosted: boolean;
  /** A saved or failed recording's receipt, which has its own full-page view. */
  receipt: boolean;
}

export function overlayMount({
  layout,
  available,
  hosted,
  receipt,
}: OverlayMountInput): OverlayMount {
  if (receipt) return "receipt";
  return layout !== "phone" && available && hosted ? "desktop" : "phone";
}
