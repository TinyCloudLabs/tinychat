import { validateRecord, type Answer, type Approval, type Progress } from "./schema";
import type { ProgressTransitionActor } from "./model-types";
import { findSecrets } from "./guard";

/** One rule for every answer kind: it belongs to an earlier issuance of the card. */
export function answerReissued(answer: Answer, approval: Approval): boolean {
  return answer.issuedAt ? answer.issuedAt !== approval.issuedAt : Date.parse(answer.at) < Date.parse(approval.issuedAt);
}

export function goStale(answer: Answer, approval: Approval, now: string): string | null {
  // Times compare as instants: stored times may carry an offset, and strings would order them wrongly.
  const at = Date.parse(answer.at);
  // A card Sam's go reached while open, and that the owner later marked done, still carries a valid go.
  // A cancel or an expiry after the go wins, and so does a card whose go was already relayed ("answered").
  // A closed card with no closedAt cannot be shown to have been open at the answer's time.
  const doneAfterGo = approval.status === "done" && approval.closedAt !== undefined && Date.parse(approval.closedAt) > at;
  if (approval.status !== "open" && !doneAfterGo) return `the card is ${approval.status}${approval.status === "answered" ? " (an earlier go was already relayed)" : ""}`;
  if (answer.issuedAt && answer.issuedAt !== approval.issuedAt) return `the card was re-issued at ${approval.issuedAt}, after he saw it`;
  if (at < Date.parse(approval.issuedAt)) return `the card was re-issued at ${approval.issuedAt}, after it`;
  if (approval.expiresAt && at >= Date.parse(approval.expiresAt)) return `the window closed at ${approval.expiresAt}`;
  if (approval.expiresAt && Date.parse(now) >= Date.parse(approval.expiresAt)) return `the window closed at ${approval.expiresAt}, before it reached you`;
  return null;
}

export type ProgressTransitionResult = { ok: true; value: Progress } | { ok: false; errors: string[] };

/** Authenticated runtime verifies the actor; this pure rule never discovers or grants authority. */
export function validateProgressTransition(prior: Progress, patch: Record<string, unknown>, actor: ProgressTransitionActor): ProgressTransitionResult {
  if (actor.actorName !== prior.owner) return { ok: false, errors: ["Only the stored progress owner can edit this progress"] };
  if (prior.status === "closed" && actor.operation !== "close") return { ok: false, errors: ["Closed progress cannot be edited"] };
  if (patch.owner !== undefined && patch.owner !== prior.owner) return { ok: false, errors: ["Progress owner cannot be changed"] };
  if (!actor.verifiedLive) return { ok: false, errors: ["Cannot verify updater against the live runtime"] };
  if (actor.agentId && prior.updaters?.includes(actor.agentId) && actor.operation !== "step" && actor.operation !== "note") return { ok: false, errors: ["Appointed updaters may only update a step or note"] };
  const allowed = actor.operation === "set" ? ["title", "ticket", "owner", "steps", "currentStep", "eta", "important", "updaters", "updatedAt", "updatedBy"]
    : actor.operation === "step" ? ["steps", "currentStep", "note", "eta", "updatedAt", "updatedBy"]
    : actor.operation === "note" ? ["note", "updatedAt", "updatedBy"] : ["status", "closedAt", "updatedAt", "updatedBy"];
  if (Object.keys(patch).some((key) => !allowed.includes(key))) return { ok: false, errors: ["Field is not editable through this progress operation"] };
  if (actor.operation === "note" && patch.note === undefined) return { ok: false, errors: ["A note update requires its note"] };
  if (actor.operation === "step") {
    if (!Array.isArray(patch.steps) || patch.steps.length !== prior.steps.length || !Number.isSafeInteger(patch.currentStep)) return { ok: false, errors: ["A step update requires an existing step"] };
    const changed: number[] = [];
    for (let index = 0; index < prior.steps.length; index++) {
      const step = patch.steps[index];
      if (!step || typeof step !== "object" || step.name !== prior.steps[index]!.name) return { ok: false, errors: ["A step update cannot rename or replace steps"] };
      if (step.state !== prior.steps[index]!.state) changed.push(index);
    }
    if (changed.length > 1 || (changed.length === 1 && changed[0] !== patch.currentStep)) return { ok: false, errors: ["A step update changes only its selected step"] };
  }
  if (actor.operation === "set" && Array.isArray(patch.steps) && patch.steps.some((step) => !step || typeof step !== "object" || step.state !== "todo")) return { ok: false, errors: ["New step definitions start todo"] };
  if (actor.operation === "close") {
    if (patch.status !== "closed" || typeof patch.closedAt !== "string") return { ok: false, errors: ["Closing progress requires its close time"] };
    if (prior.status === "closed") return { ok: true, value: prior };
  }
  const next = { ...prior, ...patch, ...(actor.operation === "set" && patch.steps !== undefined && patch.currentStep === undefined ? { currentStep: 0 } : {}), owner: prior.owner, kind: "progress", id: prior.id };
  if (findSecrets(next).length) return { ok: false, errors: ["Progress contains disallowed credential material"] };
  const checked = validateRecord("progress", next);
  return checked.ok && checked.value.kind === "progress" ? { ok: true, value: checked.value } : { ok: false, errors: ["Invalid progress record"] };
}
