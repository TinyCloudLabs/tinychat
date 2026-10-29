export const SITREP_NOW = "2026-10-29T12:00:00.000Z";
export const SITREP_CREATED = "2026-10-28T12:00:00.000Z";
export const SITREP_REASKED = "2026-10-29T10:00:00.000Z";
export const SITREP_CONTEXT = Object.freeze({
  background: "A synthetic rehearsal checks the existing card semantics without reading or changing any live records.",
  whyNow: "The isolated owner needs to choose the next reversible step.",
  ifNoAnswer: "Nothing is approved or executed until a valid owner response arrives.",
  known: [], related: [],
});
const common = {
  from: "SyntheticOfficer", owner: "SyntheticOwner", body: "Synthetic card body.",
  createdAt: SITREP_CREATED, updatedAt: SITREP_CREATED, urgency: 2, importance: 2,
  links: [{ label: "Private report", url: "https://reports.synthetic-example.ts.net/rehearsal.md" }],
};

export const FROZEN_SITREP_RECORDS = Object.freeze([
  { ...common, kind: "ask", id: "ask-synthetic", title: "Choose the synthetic approach", askedAt: SITREP_CREATED, status: "open", context: SITREP_CONTEXT,
    options: [{ id: "quick", label: "Quick option", detail: "Fast but limited." }, { id: "careful", label: "Careful option", detail: "Slower and reversible." }], recommend: "careful" },
  { ...common, kind: "task", id: "task-synthetic", title: "Complete the synthetic checks", status: "todo", context: SITREP_CONTEXT,
    steps: [{ id: "verify", text: "Verify the isolated result" }, { id: "undo", text: "Confirm the action is reversible" }] },
  { ...common, kind: "approval", id: "approval-synthetic", title: "Approve the synthetic deploy window", approvalType: "go", approvalKind: "deploy", codeExpected: false,
    issuedAt: SITREP_REASKED, expiresAt: "2099-01-01T00:00:00.000Z", status: "open", context: SITREP_CONTEXT },
  { ...common, kind: "incident", id: "incident-synthetic", title: "Synthetic incident", status: "degraded", severity: "sev2", impact: "Only the disposable rehearsal is affected.", startedAt: SITREP_CREATED },
  { ...common, kind: "work", id: "work-synthetic", title: "Synthetic work", status: "waiting-sam", waitsOn: "The isolated owner decision", next: "Resume only after a valid decision", askIds: ["ask-synthetic"], standing: false },
  { ...common, kind: "ship", id: "ship-synthetic", title: "Synthetic release", component: "Rehearsal component", version: "0.0.2-test", prevVersion: "0.0.1-test", at: SITREP_CREATED, status: "live" },
  { ...common, kind: "order", id: "order-synthetic", title: "Synthetic standing order", at: SITREP_CREATED, source: "chat", verbatim: "Keep every rehearsal action inside its disposable directory.", appliesTo: "Synthetic rehearsal only", status: "active" },
  { ...common, kind: "claim", id: "T-001", title: "Synthetic claim", status: "open", site: "Synthetic site", url: "https://example.test/claim", quote: "Every rehearsal is reversible.", location: "Synthetic page, first paragraph",
    trueToday: "Only the isolated marker action has been demonstrated.", evidence: [{ label: "Synthetic evidence", ref: "https://example.test/evidence" }], makeTrue: { tc: ["TC-1"], effort: "Verify all synthetic operations" }, severity: "med" },
  { ...common, kind: "hold", id: "hold-synthetic", title: "Hold the synthetic release", status: "active", what: "Hold the synthetic release", cause: "A reversible check is incomplete.", exit: "Both synthetic task checks are complete.", releasedBy: "sam", unblockedBy: ["task:task-synthetic"] },
  { ...common, kind: "progress", id: "progress-synthetic", title: "Synthetic owner progress", owner: "SyntheticOwner", ticket: "TC-1", steps: [{ name: "Build", state: "live" }, { name: "Review", state: "in-progress" }], currentStep: 1, important: true, status: "open", note: "Review belongs to the assigned owner.", updaters: ["00000000-0000-4000-8000-000000000001"] },
].map((record) => Object.freeze(record)));

export function syntheticRecord(kind: string): Record<string, unknown> {
  const record = FROZEN_SITREP_RECORDS.find((candidate) => candidate.kind === kind);
  if (!record) throw new Error(`Missing synthetic kind ${kind}`);
  return structuredClone(record);
}

export const FROZEN_SITREP_RECEIPTS = Object.freeze([
  { eventSourceKey: "xyz.tinycloud.rocinante/sam/answers/ask-synthetic/20261029T110000000Z.json", recipientKey: "synthetic-owner", state: "delivered", routedTo: "owner", at: "2026-10-29T11:00:01.000Z" },
  { eventSourceKey: "xyz.tinycloud.rocinante/sam/thread/ask/ask-synthetic/20261029T110100000Z-00000000000000000000000000000001.json", recipientKey: "synthetic-owner", state: "unconfirmed", routedTo: "owner", at: "2026-10-29T11:01:01.000Z" },
  { eventSourceKey: "xyz.tinycloud.rocinante/sam/answers/approval-synthetic/20261029T110200000Z.json", recipientKey: "unmapped-synthetic-officer", state: "held", routedTo: "owner", at: "2026-10-29T11:02:01.000Z" },
  { eventSourceKey: "xyz.tinycloud.rocinante/sam/answers/ask-synthetic/20261029T110300000Z.json", recipientKey: "synthetic-owner", state: "pending", routedTo: "owner", at: "2026-10-29T11:03:01.000Z" },
]);

export const FROZEN_SITREP_WATCH_CHECKPOINT = Object.freeze({
  version: 2, cursor: "2026-10-29T10:59:59.999Z", claimsSince: "2026-10-28T00:00:00.000Z", prunedThrough: "2026-09-29T00:00:00.000Z",
  delivered: { "xyz.tinycloud.rocinante/sam/answers/ask-synthetic/20261029T110000000Z.json": { done: ["SyntheticOwner"], complete: false } },
  claimDelivered: {}, tasks: { "task-synthetic": { verify: "2026-10-29T10:00:00.000Z", undo: null } }, taskClosed: {},
});
