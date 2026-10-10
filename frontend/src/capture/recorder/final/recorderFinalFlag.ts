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

// vite.config.ts validates the value with resolveRecorderFinal and defines it as "true" or "false", so Rollup folds this
// comparison and drops the final-only branches from a flag-off build. A bare `resolveRecorderFinal(import.meta.env)` can't
// be folded: it throws. Tests still toggle the flag at run time through the environment.
export function recorderFinalEnabled(): boolean {
  return import.meta.env.VITE_EXO_RECORDER_FINAL === "true";
}
