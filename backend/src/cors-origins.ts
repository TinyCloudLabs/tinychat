/** The fixed origin Tauri assigns to Exo's bundled frontend on macOS. */
export const EXO_DESKTOP_ORIGIN = "tauri://localhost";

/** The fixed origin Tauri assigns to Exo's bundled frontend on Windows. */
export const EXO_DESKTOP_WINDOWS_ORIGIN = "http://tauri.localhost";

/** Browser origins allowed to call the TinyChat backend. */
export function appCorsOrigins(frontendOrigin: string): string[] {
  return [frontendOrigin, EXO_DESKTOP_ORIGIN, EXO_DESKTOP_WINDOWS_ORIGIN];
}
