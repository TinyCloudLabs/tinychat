/** The Soft-skin recorder is opt-in until the flag flips (TC-862). Anything but true/false/unset is a build mistake. */
export function resolveRecorderFinal(env: {
  VITE_EXO_RECORDER_FINAL?: string;
}): boolean {
  const flag = env.VITE_EXO_RECORDER_FINAL;
  if (flag === undefined || flag === "false") return false;
  if (flag !== "true")
    throw new Error("VITE_EXO_RECORDER_FINAL must be true or false");
  return true;
}

export function recorderFinalEnabled(): boolean {
  return resolveRecorderFinal(import.meta.env);
}
