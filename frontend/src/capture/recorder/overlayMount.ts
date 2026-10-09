import type { RecorderLayout, RecorderShell } from "./final/shellCapabilities";

/** Which view fills the recorder overlay: the classic full-viewport dialog, the phone's Soft recorder, or the desktop ring view in the main region. */
export type OverlayMount = "legacy" | "phone" | "desktop";

export interface OverlayMountInput {
  flag: boolean;
  shell: RecorderShell;
  layout: RecorderLayout;
  /** The recorder can record on this shell (web and Tauri until their native recorders land). */
  available: boolean;
  /** There is a main region to draw the ring view in (the shell's recorder host); the signed-out overlay, above the gate, has none. */
  hosted: boolean;
  /** A saved or failed recording's receipt, which keeps today's view until the Soft skin reaches it. */
  receipt: boolean;
}

export function overlayMount({
  flag,
  shell,
  layout,
  available,
  hosted,
  receipt,
}: OverlayMountInput): OverlayMount {
  if (!flag || receipt) return "legacy";
  if (layout === "phone") return shell === "phone" || available ? "phone" : "legacy";
  return available && hosted ? "desktop" : "legacy";
}
