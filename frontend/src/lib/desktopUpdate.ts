/**
 * The desktop app's (Tauri) in-app update offer: "Restart to update".
 *
 * Rust owns the updater (desktop/src-tauri/src/desktop_update.rs): it checks at launch and every 4 hours, downloads in
 * the background, and offers the restart only while no recording is in progress (withdrawing the offer when one
 * starts). This store mirrors that offer for the toast in components/pwa-prompts.tsx. The webview has no updater
 * permission of its own: only the two app commands below.
 */

export interface DesktopUpdateOffer {
  /** The downloaded version, e.g. "0.22.0". */
  version: string;
}

const PROMPT_EVENT = "exo://update-prompt";

let offer: DesktopUpdateOffer | null = null;
const listeners = new Set<() => void>();

function setOffer(next: DesktopUpdateOffer | null) {
  offer = next;
  for (const listener of listeners) listener();
}

export function subscribeDesktopUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDesktopUpdate(): DesktopUpdateOffer | null {
  return offer;
}

/** Desktop shell only: follow the offer. Updater errors stay in the logs; the page only ever sees an offer or none. */
export async function setupDesktopUpdate(): Promise<void> {
  // Lazy: @tauri-apps/api must never enter the web bundle's main chunk.
  const [{ invoke }, { listen }] = await Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")]);
  await listen<DesktopUpdateOffer | null>(PROMPT_EVENT, event => setOffer(event.payload));
  setOffer(await invoke<DesktopUpdateOffer | null>("desktop_update_status"));
}

/** Install the downloaded version and relaunch. Refused while recording (the offer returns once idle). */
export async function restartToUpdate(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  setOffer(null);
  try {
    await invoke("desktop_update_restart");
  } catch (error) {
    console.warn("[desktop-update] restart refused:", error);
  }
}
