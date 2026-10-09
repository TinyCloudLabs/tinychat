/**
 * Today's Mac recorder card shows in the desktop app, unless the shared recorder (flag on, engine installed)
 * is the one Record entry; then both would be on screen.
 */
export function localRecorderCardShown(input: {
  tauri: boolean;
  flag: boolean;
  recorderAvailable: boolean;
}): boolean {
  return input.tauri && !(input.flag && input.recorderAvailable);
}
