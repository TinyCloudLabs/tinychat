// The step line of the working indicator (TC-4382): what the owner reads while a bot works, from the signals the
// app has. The service names a step from a fixed set (botsApi.ts BOT_STEPS) and reply text arriving is `writing`.
// A card waiting on the owner comes ahead of both.
import type { BotStep } from "./botsApi";
import { WORKING_STRINGS } from "./workingStrings";

/** The step a turn is at: the service's latest or, once reply text arrives, `writing`. */
export interface WorkingStep {
  step: BotStep | "writing";
  /** With `read_page`: the host of the page. */
  host?: string;
}

/** The line for a working turn. With no step known it is the generic line. */
export function workingStepText(step: WorkingStep | undefined, awaitingOwner = false): string {
  if (awaitingOwner) return WORKING_STRINGS.approval;
  if (!step) return WORKING_STRINGS.generic;
  if (step.step === "read_page") return step.host ? WORKING_STRINGS.readingSite(step.host.replace(/^www\./, "")) : WORKING_STRINGS.readingPage;
  return WORKING_STRINGS.steps[step.step];
}
