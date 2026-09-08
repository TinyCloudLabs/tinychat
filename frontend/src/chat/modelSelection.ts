import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { SessionStore } from "@tinyboilerplate/client";
import {
  DEFAULT_CHAT_MODEL,
  isOfferedChatModel,
  type OfferedModelId,
} from "@tinyboilerplate/core";
import { getThreadModel, setThreadModel } from "../lib/threadStore";

export type SelectionReason = "healthy" | "health-unverified" | "restored" | "manual";
export type SelectionPhase = "choosing" | "ready" | "needs-manual-choice";

export interface SelectionView {
  threadId: string | null;
  phase: SelectionPhase;
  model: OfferedModelId | null;
  reason?: SelectionReason;
  message?: string;
  revision: number;
  saving: boolean;
  saveFailed: boolean;
  canSend: boolean;
  canPick: boolean;
}

export interface TurnOrigin {
  readonly tcw: TinyCloudWeb;
  readonly space: string;
  readonly threadId: string;
  readonly activation: number;
  readonly model: OfferedModelId;
  readonly turnId: string;
  readonly signal: AbortSignal;
}

type ChoiceResult =
  | { status: "ready"; model: OfferedModelId }
  | { status: "cancelled" };

interface Deferred {
  promise: Promise<ChoiceResult>;
  settled: boolean;
  resolve: (result: ChoiceResult) => void;
}

function deferred(): Deferred {
  let resolvePromise!: (result: ChoiceResult) => void;
  const value: Deferred = {
    promise: new Promise((resolve) => {
      resolvePromise = resolve;
    }),
    settled: false,
    resolve: (result) => {
      if (value.settled) return;
      value.settled = true;
      resolvePromise(result);
    },
  };
  return value;
}

interface RecordState {
  threadId: string;
  kind: "new" | "existing";
  phase: SelectionPhase;
  revision: number;
  desired: OfferedModelId | null;
  confirmed: OfferedModelId | null;
  reason?: SelectionReason;
  message?: string;
  correctionNotice?: string;
  saving: boolean;
  saveFailed: boolean;
  running: boolean;
  authBlocked: boolean;
  rowExists: boolean | null;
  choice: Deferred;
  abort?: AbortController;
  lookupStarted: boolean;
  restoreStarted: boolean;
  retryFirstAppend?: () => Promise<void>;
  firstAppendOrigin?: TurnOrigin;
}

export class TurnCancelledError extends Error {
  constructor() {
    super("This send was cancelled because the active chat changed.");
    this.name = "TurnCancelledError";
  }
}

export class SelectionBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectionBlockedError";
  }
}

class SelectionAuthError extends Error {}

export interface SelectionCoordinatorOptions {
  tcw: TinyCloudWeb;
  backendUrl: string;
  sessionStore: SessionStore;
  onView: (view: SelectionView) => void;
  onAuthFailure?: () => void;
}

function spaceOf(tcw: TinyCloudWeb): string {
  return (
    (typeof tcw.spaceId === "string" && tcw.spaceId) ||
    (typeof tcw.did === "string" && tcw.did) ||
    "unknown-space"
  );
}

async function fetchAutomaticChoice(
  backendUrl: string,
  sessionStore: SessionStore,
  signal: AbortSignal,
): Promise<{ model: OfferedModelId; reason: "healthy" | "health-unverified" } | null> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const token = sessionStore.getToken();
    const body = await Promise.race([
      (async () => {
        const response = await fetch(`${backendUrl}/api/chat/model-selection`, {
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            "X-Requested-With": "XMLHttpRequest",
          },
          signal: controller.signal,
          cache: "no-store",
        });
        if (response.status === 401 || response.status === 403) throw new SelectionAuthError();
        if (!response.ok) throw new Error("Health unavailable");
        return response.json();
      })(),
      new Promise<never>((_, reject) => {
        const fail = () => reject(new Error("Health lookup aborted"));
        if (controller.signal.aborted) fail();
        else controller.signal.addEventListener("abort", fail, { once: true });
      }),
    ]);
    if (
      body?.model === null &&
      body?.reason === "all-unhealthy"
    ) {
      return null;
    }
    if (
      isOfferedChatModel(body?.model) &&
      (body?.reason === "healthy" || body?.reason === "health-unverified")
    ) {
      return { model: body.model, reason: body.reason };
    }
    return { model: DEFAULT_CHAT_MODEL, reason: "health-unverified" };
  } catch (error) {
    if (error instanceof SelectionAuthError) throw error;
    if (signal.aborted) throw new TurnCancelledError();
    return { model: DEFAULT_CHAT_MODEL, reason: "health-unverified" };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export interface ModelSelectionController {
  pick: (model: string) => void;
  retry: () => void;
  reload: () => void;
  getView: () => SelectionView;
}

/** Workspace-scoped selection state shared by activation, initialize and send. */
export class ModelSelectionCoordinator implements ModelSelectionController {
  private readonly records = new Map<string, RecordState>();
  private readonly turns = new Map<string, TurnOrigin>();
  private readonly pendingTurns = new Map<string, Promise<TurnOrigin>>();
  private knownThreadIds = new Set<string>();
  private activeThreadId: string | null = null;
  private activation = 0;
  private disposed = false;
  private activationAbort = new AbortController();
  private readonly appends = new Map<string, Deferred>();
  private readonly savedTurns = new Set<string>();

  isAppendSaved(origin: TurnOrigin): boolean { return this.savedTurns.has(origin.turnId); }

  resume(): void { this.disposed = false; }

  captureCancel(): () => void {
    const activation = this.activation;
    return () => { if (this.activation === activation) this.cancel(); };
  }

  cancel(): void {
    this.cancelActive();
    this.activationAbort = new AbortController();
    this.activation++;
    if (this.activeThreadId) this.publish(this.records.get(this.activeThreadId)!);
  }

  confirmAppend(origin: TurnOrigin, saved: boolean): void {
    if (saved) this.savedTurns.add(origin.turnId);
    this.appends.get(origin.turnId)?.resolve(saved
      ? { status: "ready", model: origin.model } : { status: "cancelled" });
  }

  async waitForAppend(origin: TurnOrigin): Promise<void> {
    const result = await this.appends.get(origin.turnId)!.promise;
    this.assertActive(origin);
    if (result.status !== "ready") throw new SelectionBlockedError("Message not saved.");
  }

  constructor(private readonly options: SelectionCoordinatorOptions) {}

  setKnownThreadIds(ids: readonly string[]): void {
    this.knownThreadIds = new Set(ids);
  }

  private createRecord(threadId: string, kind: "new" | "existing"): RecordState {
    const record: RecordState = {
      threadId,
      kind,
      phase: "choosing",
      revision: 0,
      desired: null,
      confirmed: null,
      saving: false,
      saveFailed: false,
      running: false,
      authBlocked: false,
      rowExists: kind === "new" ? false : null,
      choice: deferred(),
      lookupStarted: false,
      restoreStarted: false,
    };
    this.records.set(threadId, record);
    return record;
  }

  activate(threadId: string, kindHint?: "new" | "existing"): number {
    if (this.disposed) return this.activation;
    if (this.activeThreadId !== threadId) {
      this.cancelActive();
      this.activeThreadId = threadId;
      this.activationAbort = new AbortController();
      this.activation++;
    }
    const kind = kindHint ?? (this.knownThreadIds.has(threadId) ? "existing" : "new");
    const record = this.records.get(threadId) ?? this.createRecord(threadId, kind);
    if (record.kind === "new") this.startLookup(record);
    else this.startRestore(record);
    this.publish(record);
    return this.activation;
  }

  async initialize(threadId: string): Promise<void> {
    // Begin selection here, but do not hold assistant-ui's thread-list
    // lifecycle open. A pending initialize prevents switchToThread/newThread
    // from committing, which in turn makes navigation unable to cancel the
    // lookup. The actual side-effect barriers live in beginTurn(), called by
    // both history append and inference before either can do work.
    if (this.activeThreadId === threadId) this.activate(threadId, "new");
  }

  async beginTurn(threadId: string, turnId: string): Promise<TurnOrigin> {
    const existing = this.turns.get(turnId);
    if (existing) {
      this.assertActive(existing);
      return existing;
    }
    const pending = this.pendingTurns.get(turnId);
    if (pending) return pending;
    const capture = this.captureTurn(threadId, turnId);
    this.pendingTurns.set(turnId, capture);
    try {
      return await capture;
    } finally {
      if (this.pendingTurns.get(turnId) === capture) this.pendingTurns.delete(turnId);
    }
  }

  private async captureTurn(threadId: string, turnId: string): Promise<TurnOrigin> {
    if (this.activeThreadId !== threadId || this.disposed) throw new TurnCancelledError();
    const activation = this.activation;
    const record = this.records.get(threadId)!;
    let result: ChoiceResult;
    for (;;) {
      const choice = record.choice;
      result = await choice.promise;
      if (result.status === "cancelled" || !this.isActive(threadId, activation)) {
        throw new TurnCancelledError();
      }
      // A pick can replace an already-resolved choice before this await's
      // continuation runs. Wait for the latest revision's persistence too.
      if (choice === record.choice) break;
    }
    if (record.saving || record.saveFailed || record.phase !== "ready") {
      throw new SelectionBlockedError(record.message ?? "Choose and save a model before sending.");
    }
    const origin = Object.freeze({
      tcw: this.options.tcw,
      space: spaceOf(this.options.tcw),
      threadId,
      activation,
      model: result.model,
      turnId,
      signal: this.activationAbort.signal,
    });
    this.turns.set(turnId, origin);
    this.appends.set(turnId, deferred());
    return origin;
  }

  async beginActiveTurn(turnId: string): Promise<TurnOrigin> {
    const existing = this.turns.get(turnId);
    if (existing) {
      this.assertActive(existing);
      return existing;
    }
    const pending = this.pendingTurns.get(turnId);
    if (pending) return pending;
    if (!this.activeThreadId) throw new TurnCancelledError();
    return this.beginTurn(this.activeThreadId, turnId);
  }

  needsFirstInsert(origin: TurnOrigin): boolean {
    return this.records.get(origin.threadId)?.rowExists === false;
  }

  assertActive(origin: TurnOrigin): void {
    if (!this.isActive(origin.threadId, origin.activation)) throw new TurnCancelledError();
  }

  setRunning(origin: TurnOrigin, running: boolean): void {
    const record = this.records.get(origin.threadId);
    if (!record || (running && !this.isActive(origin.threadId, origin.activation))) return;
    record.running = running;
    this.publish(record);
  }

  markFirstAppend(
    origin: TurnOrigin,
    pending: boolean,
    failed = false,
    retry?: () => Promise<void>,
  ): void {
    const record = this.records.get(origin.threadId);
    if (!record) return;
    record.saving = pending;
    record.saveFailed = failed;
    if (retry) {
      record.retryFirstAppend = retry;
      record.firstAppendOrigin = origin;
    }
    if (failed) record.message = "Model not saved. Retry this message or choose a model again.";
    if (!pending && !failed) {
      record.rowExists = true;
      record.confirmed = origin.model;
      record.retryFirstAppend = undefined;
      record.firstAppendOrigin = undefined;
      if (record.desired === origin.model) {
        record.message = undefined;
        record.saving = false;
      } else {
        // A newer manual pick is already queued behind the first INSERT. Keep
        // send disabled until that exact revision is confirmed by readback.
        record.saving = true;
      }
    }
    this.publish(record);
  }

  pick(model: string): void {
    if (!isOfferedChatModel(model) || !this.activeThreadId) return;
    const record = this.records.get(this.activeThreadId);
    if (!record || record.running || record.authBlocked || record.message === "Chat unavailable.") return;
    record.abort?.abort();
    record.abort = undefined;
    record.revision++;
    record.desired = model;
    record.reason = "manual";
    record.correctionNotice = undefined;
    record.phase = "ready";
    record.message = undefined;
    record.saveFailed = false;
    if (record.choice.settled) record.choice = deferred();

    if (record.retryFirstAppend) {
      void this.retryFirstAppend(record);
      return;
    }
    if (record.rowExists === false && !record.saving) {
      record.confirmed = model;
      record.choice.resolve({ status: "ready", model });
      this.publish(record);
      return;
    }
    void this.persist(record, model, record.revision);
  }

  retry(): void {
    if (!this.activeThreadId) return;
    const record = this.records.get(this.activeThreadId);
    if (!record || record.running) return;
    if (record.retryFirstAppend && record.firstAppendOrigin) {
      void this.retryFirstAppend(record);
      return;
    }
    if (record.kind === "existing" &&
        (record.restoreStarted === false ||
          (record.rowExists === null && record.phase === "needs-manual-choice"))) {
      record.restoreStarted = false;
      if (record.choice.settled) record.choice = deferred();
      record.phase = "choosing";
      record.message = undefined;
      this.startRestore(record);
      this.publish(record);
      return;
    }
    if (record.desired && record.rowExists !== false) {
      record.revision++;
      void this.persist(record, record.desired, record.revision);
    }
  }

  reload(): void {
    if (typeof window !== "undefined") window.location.reload();
  }

  getView(): SelectionView {
    if (!this.activeThreadId) return this.emptyView();
    return this.viewOf(this.records.get(this.activeThreadId));
  }

  dispose(): void {
    this.disposed = true;
    this.cancelActive();
    this.activeThreadId = null;
  }

  private isActive(threadId: string, activation: number): boolean {
    return !this.disposed && this.activeThreadId === threadId && this.activation === activation;
  }

  private cancelActive(): void {
    this.activationAbort.abort();
    if (!this.activeThreadId) return;
    const record = this.records.get(this.activeThreadId);
    if (!record) return;
    record.abort?.abort();
    record.abort = undefined;
    for (const [id, origin] of this.turns) {
      if (origin.threadId === record.threadId) this.appends.get(id)?.resolve({ status: "cancelled" });
    }
    record.running = false;
    if (!record.choice.settled) {
      record.choice.resolve({ status: "cancelled" });
      record.choice = deferred();
      if (record.confirmed && !record.saving && !record.saveFailed) {
        record.choice.resolve({ status: "ready", model: record.confirmed });
      }
    }
    if (record.kind === "new" && record.lookupStarted && !record.desired) {
      record.phase = "needs-manual-choice";
      record.message = "Automatic selection was cancelled. Choose a model to continue.";
      record.lookupStarted = true;
      record.choice = deferred();
    } else if (record.kind === "existing" && record.rowExists === null) {
      record.restoreStarted = false;
      record.choice = deferred();
      record.phase = "choosing";
    }
  }

  private startLookup(record: RecordState): void {
    if (record.lookupStarted) return;
    record.lookupStarted = true;
    const revision = ++record.revision;
    const controller = new AbortController();
    record.abort = controller;
    void fetchAutomaticChoice(
      this.options.backendUrl,
      this.options.sessionStore,
      controller.signal,
    ).then((result) => {
      if (controller.signal.aborted || record.revision !== revision) return;
      record.abort = undefined;
      if (!result) {
        record.phase = "needs-manual-choice";
        record.message = "All automatic choices look unhealthy. Choose a model to continue.";
        this.publish(record);
        return;
      }
      record.phase = "ready";
      record.desired = result.model;
      record.confirmed = result.model;
      record.reason = result.reason;
      record.message = result.reason === "health-unverified" ? "Health unverified" : undefined;
      record.choice.resolve({ status: "ready", model: result.model });
      this.publish(record);
    }).catch((error) => {
      if (controller.signal.aborted || error instanceof TurnCancelledError) return;
      if (error instanceof SelectionAuthError) {
        record.authBlocked = true;
        record.phase = "needs-manual-choice";
        record.message = "Sign in again before sending.";
        this.options.onAuthFailure?.();
        this.publish(record);
      }
    });
  }

  private startRestore(record: RecordState): void {
    if (record.restoreStarted || record.rowExists !== null) return;
    record.restoreStarted = true;
    const revision = ++record.revision;
    const controller = new AbortController();
    record.abort = controller;
    void getThreadModel(this.options.tcw, record.threadId).then((read) => {
      if (controller.signal.aborted || record.revision !== revision) return;
      record.abort = undefined;
      if (read.status === "missing") {
        record.rowExists = false;
        record.phase = "needs-manual-choice";
        record.authBlocked = true;
        record.message = "Chat unavailable.";
        this.publish(record);
        return;
      }
      record.rowExists = true;
      const saved = read.model;
      const model = isOfferedChatModel(saved ?? "") ? saved as OfferedModelId : DEFAULT_CHAT_MODEL;
      record.desired = model;
      record.reason = "restored";
      record.phase = "ready";
      if (saved !== model) {
        record.correctionNotice = "Saved model was unavailable; switched to " + model + ".";
        void this.persist(record, model, revision);
      } else {
        record.confirmed = model;
        record.choice.resolve({ status: "ready", model });
        this.publish(record);
      }
    }).catch(() => {
      if (controller.signal.aborted || record.revision !== revision) return;
      record.abort = undefined;
      record.phase = "needs-manual-choice";
      record.message = "Retry loading model, or choose one to override it.";
      this.publish(record);
    });
  }

  private async persist(record: RecordState, model: OfferedModelId, revision: number): Promise<void> {
    record.saving = true;
    record.saveFailed = false;
    record.message = record.correctionNotice ? "Saving… " + record.correctionNotice : "Saving…";
    this.publish(record);
    try {
      await setThreadModel(this.options.tcw, record.threadId, model);
      if (record.revision !== revision) return;
      record.rowExists = true;
      record.confirmed = model;
      record.saving = false;
      record.message = record.correctionNotice;
      record.choice.resolve({ status: "ready", model });
    } catch {
      if (record.revision !== revision) return;
      record.saving = false;
      record.saveFailed = true;
      record.message = "Model not saved. Retry or choose another model.";
    }
    this.publish(record);
  }

  private async retryFirstAppend(record: RecordState): Promise<void> {
    const retry = record.retryFirstAppend;
    const origin = record.firstAppendOrigin;
    if (!retry || !origin) return;
    record.saving = true;
    record.saveFailed = false;
    record.message = "Retrying save…";
    this.publish(record);
    try {
      await retry();
      record.rowExists = true;
      record.confirmed = origin.model;
      record.retryFirstAppend = undefined;
      record.firstAppendOrigin = undefined;
      if (record.desired && record.desired !== origin.model) {
        const revision = ++record.revision;
        await this.persist(record, record.desired, revision);
        return;
      }
      record.saving = false;
      record.message = undefined;
      record.choice.resolve({ status: "ready", model: origin.model });
    } catch {
      record.saving = false;
      record.saveFailed = true;
      record.message = "Model not saved. Retry this message or choose a model again.";
    }
    this.publish(record);
  }

  private publish(record: RecordState): void {
    const activation = this.activation;
    queueMicrotask(() => {
      if (this.isActive(record.threadId, activation)) this.options.onView(this.viewOf(record));
    });
  }

  private emptyView(): SelectionView {
    return {
      threadId: null,
      phase: "choosing",
      model: null,
      revision: 0,
      saving: false,
      saveFailed: false,
      canSend: false,
      canPick: false,
    };
  }

  private viewOf(record?: RecordState): SelectionView {
    if (!record) return this.emptyView();
    return {
      threadId: record.threadId,
      phase: record.phase,
      model: record.desired,
      reason: record.reason,
      message: record.message,
      revision: record.revision,
      saving: record.saving,
      saveFailed: record.saveFailed,
      canSend:
        record.phase === "ready" &&
        !record.saving &&
        !record.saveFailed &&
        !record.authBlocked &&
        record.desired !== null,
      canPick: !record.running && !record.authBlocked,
    };
  }
}
