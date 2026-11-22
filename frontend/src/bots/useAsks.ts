// Main's questions, secret requests and proposals to the owner, as one page-wide state: the setting, the pending
// requests, and what became of the ones the owner watched (said not now, expired, sent). Main's chat and Home both draw
// from this one state, so a request is one card in one place and deciding it anywhere resolves it everywhere.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ACTION_STRINGS } from "./actionStrings";
import {
  BotsHeld, BotsRouteMissing, type ActionRequest, type AskDecision, type AskRequest, type BotsApi, type MainRequest, type SecretDecision, type SecretLine, type SecretRequest,
} from "./botsApi";
import type { AppReply } from "./useMainChat";

export type AsksApi = Pick<BotsApi, "getAsks" | "setAsks" | "listRequests" | "answerRequest" | "getMainWeb">;

/** Secret cards the owner closed, by request id: an approved, ended or failed card stays until closed, across reloads. */
export const CLOSED_SECRETS_KEY = "tinychat:bots:secret-cards-closed";
const CLOSED_SECRETS_KEEP = 50;

function readClosed(): ReadonlySet<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(CLOSED_SECRETS_KEY) ?? "[]");
    return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

const lineOf = ({ name, sites, service, until }: SecretRequest): SecretLine => ({ name, sites, ...(service ? { service } : {}), ...(until ? { until } : {}) });

/** Poll while Main's chat is open; Home checks less often. */
export const OPEN_POLL_MS = 5_000;
export const CLOSED_POLL_MS = 30_000;

/** What the owner sees where a card was. A proposal's line follows its request: sending, then what was sent. */
export type AskOutcome = { id: string; kind: "declined" | "expired" } | { id: string; kind: "action"; request: ActionRequest };

/** The recipients' names as the card shows them. */
export const actionNames = (request: ActionRequest): string[] => request.targets.map((target) => target.name ?? ACTION_STRINGS.missing);

/** `held`: a Send for a chat that holds the owner's meeting data; the proposal stays as it is. */
export type AskResult = "ok" | "failed" | "held";

export interface Asks {
  /** `unknown` until the service answers; `no` when it has no such route (nothing about asks is shown). */
  support: "unknown" | "yes" | "no";
  enabled: boolean;
  /** True once the owner pressed "Stop Main from asking" and not since turned it back on. */
  stopped: boolean;
  pending: (AskRequest | ActionRequest)[];
  outcomes: AskOutcome[];
  /**
   * The secret cards: pending ones while asks are on; approved, ended and failed ones until the owner closes them;
   * declined, expired and stopped ones the owner watched in this page, until closed.
   */
  secrets: SecretRequest[];
  /** Secret requests whose secret the owner saved in TinyCloud Secrets in this page (the card's first step is done). */
  saved: ReadonlySet<string>;
  markSaved(id: string): void;
  /** Closes a secret card for good. */
  dismiss(id: string): void;
  /** The owner's DID, which TinyCloud Secrets is opened for. */
  owner?: string;
  /** Web access is on, so the card says what a page could try. Always the current setting. */
  webOn: boolean;
  /** Tells the cards the owner just saved this Web access setting. */
  noteWeb(on: boolean): void;
  setEnabled(enabled: boolean): Promise<AskResult>;
  stop(): Promise<AskResult>;
  decide(request: MainRequest, decision: AskDecision | SecretDecision): Promise<AskResult>;
  refresh(): void;
}

/** A call on an api that may not have the route (an older client object): any throw is a failure, never a crash. */
const attempt = <T>(call: () => Promise<T>): Promise<T> => Promise.resolve().then(call);

export function useAsks(api: AsksApi, { open, onDecided, owner }: { open: boolean; onDecided: (reply: AppReply) => void; owner?: string }): Asks {
  const enabledRef = useRef(false);
  const [support, setSupport] = useState<Asks["support"]>("unknown");
  const [enabled, setEnabledState] = useState(false);
  enabledRef.current = enabled;
  const [stopped, setStopped] = useState(false);
  const [requests, setRequests] = useState<(AskRequest | ActionRequest)[]>([]);
  const [outcomes, setOutcomes] = useState<AskOutcome[]>([]);
  const [secretList, setSecretList] = useState<SecretRequest[]>([]);
  const [saved, setSaved] = useState<ReadonlySet<string>>(() => new Set());
  const [closed, setClosed] = useState<ReadonlySet<string>>(readClosed);
  const [webOn, setWebOn] = useState(false);
  const alive = useRef(true);
  const watched = useRef(new Set<string>());
  /** Secret requests the owner saw pending in this page: what becomes of them is shown until closed. */
  const watchedSecrets = useRef(new Set<string>());
  /** Requests decided in this page: a poll that started before the decision must not bring the card back. */
  const decided = useRef(new Set<string>());
  /** Proposals whose outcome has gone to Main from this page. */
  const told = useRef(new Set<string>());
  /** Secret decisions already sent to Main from this page, as `id:state` (one request can be approved, then stopped). */
  const sentSecrets = useRef(new Set<string>());
  const onDecidedRef = useRef(onDecided);
  onDecidedRef.current = onDecided;
  const poll = useRef<() => void>(() => {});

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (support !== "unknown") return;
    const controller = new AbortController();
    attempt(() => api.getAsks(controller.signal)).then(
      (asks) => { if (!controller.signal.aborted) { setEnabledState(asks.enabled); setSupport("yes"); } },
      (error: unknown) => { if (!controller.signal.aborted && error instanceof BotsRouteMissing) setSupport("no"); },
    );
    return () => controller.abort();
    // A failed read is tried again each time Main's chat opens.
  }, [api, support, open]);

  /** A secret decision in flight or just made, with the state it was made on: a read that still says that state is older. */
  const localSecrets = useRef(new Map<string, { from: SecretRequest["state"]; stored: SecretRequest }>());

  const applySecrets = useCallback((list: SecretRequest[], now: number) => {
    const read = list.map((request) => request.state === "pending" && Date.parse(request.expiresAt) <= now ? { ...request, state: "expired" as const } : request);
    const next = read.map((request) => {
      const local = localSecrets.current.get(request.id);
      if (!local) return request;
      if (request.state === local.from) return local.stored;
      localSecrets.current.delete(request.id);
      return request;
    });
    if (enabledRef.current) for (const request of next) if (request.state === "pending") watchedSecrets.current.add(request.id);
    setSecretList(next);
    // Approved (in OpenKey), declined or stopped, and not yet told to Main (the page closed first): it goes out now.
    for (const request of read) {
      if ((request.state !== "approved" && request.state !== "declined" && request.state !== "revoked") || !request.undelivered) continue;
      const key = `${request.id}:${request.state}`;
      if (sentSecrets.current.has(key)) continue;
      sentSecrets.current.add(key);
      onDecidedRef.current({ requestId: request.id, decision: request.state, secret: lineOf(request) });
    }
  }, []);

  const apply = useCallback((list: MainRequest[]) => {
    const now = Date.now();
    const cards = list.filter((request): request is AskRequest | ActionRequest => request.kind !== "secret");
    applySecrets(list.filter((request): request is SecretRequest => request.kind === "secret"), now);
    // While asks are off no card is shown, whatever an older read says is pending.
    const live = enabledRef.current
      ? cards.filter((request) => request.state === "pending" && Date.parse(request.expiresAt) > now && !decided.current.has(request.id))
      : [];
    const liveIds = new Set(live.map((request) => request.id));
    const gone: AskOutcome[] = [];
    for (const id of watched.current) {
      if (liveIds.has(id)) continue;
      watched.current.delete(id);
      const request = cards.find((candidate) => candidate.id === id);
      if (decided.current.has(id)) continue;
      const lapsed = request?.state === "expired" || (request?.state === "pending" && Date.parse(request.expiresAt) <= now);
      if (request?.kind === "action") gone.push({ id, kind: "action", request: lapsed ? { ...request, state: "expired" } : request });
      else if (request?.state === "declined") gone.push({ id, kind: "declined" });
      else if (lapsed) gone.push({ id, kind: "expired" });
    }
    for (const id of liveIds) watched.current.add(id);
    setRequests(live);
    setOutcomes((current) => {
      // A proposal's line follows the latest read of its request (sending, then sent).
      const updated = current.map((outcome) => {
        if (outcome.kind !== "action") return outcome;
        const latest = list.find((candidate): candidate is ActionRequest => candidate.id === outcome.id && candidate.kind === "action");
        return latest && latest.state !== "pending" ? { ...outcome, request: latest } : outcome;
      });
      return gone.length > 0 ? [...updated, ...gone.filter((outcome) => !updated.some((known) => known.id === outcome.id))] : updated;
    });
    // A decision that was recorded but never reached Main (the page closed first) goes out now.
    for (const request of cards) {
      if (request.kind === "action") {
        if ((request.state === "done" || request.state === "declined") && request.undelivered && !told.current.has(request.id)) {
          told.current.add(request.id);
          onDecidedRef.current({ requestId: request.id, decision: request.state === "done" ? "action_approved" : "action_declined", names: actionNames(request) });
        }
        continue;
      }
      if ((request.state === "answered" || request.state === "declined") && request.undelivered && !decided.current.has(request.id)) {
        decided.current.add(request.id);
        onDecidedRef.current({ requestId: request.id, decision: request.state });
      }
    }
    // One switch-off is one message to Main, however many questions and secret requests it closed: the service marks
    // the whole batch delivered together, so the first id stands for all, and a batch is not sent again while the page is open.
    const stopped = list.filter((request) => request.kind !== "action" && request.state === "stopped" && request.undelivered);
    const first = stopped.find((request) => !decided.current.has(request.id));
    for (const request of stopped) decided.current.add(request.id);
    if (first) onDecidedRef.current({ requestId: first.id, decision: "stopped" });
  }, [applySecrets]);

  // Web access is read again whenever the list of cards changes or the chat opens or closes, and `noteWeb` sets it
  // the moment the owner saves a change; a read that began before such a change is dropped.
  const pendingKey = requests.map((request) => request.id).join(",");
  const webVersion = useRef(0);
  const noteWeb = useCallback((on: boolean) => { webVersion.current++; setWebOn(on); }, []);
  useEffect(() => {
    if (support !== "yes" || !enabled || pendingKey === "") return;
    const controller = new AbortController();
    const version = webVersion.current;
    attempt(() => api.getMainWeb(controller.signal)).then(
      (settings) => { if (!controller.signal.aborted && version === webVersion.current) setWebOn(settings.mode !== "off"); },
      () => {},
    );
    return () => controller.abort();
  }, [api, support, enabled, pendingKey, open]);

  useEffect(() => {
    if (support !== "yes" || !enabled) return;
    const controller = new AbortController();
    const refresh = () => {
      attempt(() => api.listRequests(controller.signal)).then(
        (list) => { if (!controller.signal.aborted) apply(list); },
        () => {},
      );
    };
    poll.current = refresh;
    refresh();
    const timer = setInterval(refresh, open ? OPEN_POLL_MS : CLOSED_POLL_MS);
    return () => { controller.abort(); clearInterval(timer); };
  }, [api, support, enabled, open, apply]);

  const refresh = useCallback(() => poll.current(), []);

  const setEnabled = useCallback(async (next: boolean): Promise<AskResult> => {
    try {
      const stored = await attempt(() => api.setAsks({ enabled: next }));
      if (!alive.current) return "ok";
      setEnabledState(stored.enabled);
      enabledRef.current = stored.enabled;
      setStopped(false);
      if (!stored.enabled) {
        setRequests([]);
        watched.current.clear();
        // Turning asks off closes what is pending: the service records each as stopped and undelivered. One read
        // now sends Main its word for each, without waiting for a reload; no card comes back from this read.
        attempt(() => api.listRequests()).then((list) => { if (alive.current) apply(list); }, () => {});
      }
      return "ok";
    } catch {
      return "failed";
    }
  }, [api, apply]);

  const stop = useCallback(async (): Promise<AskResult> => {
    const result = await setEnabled(false);
    if (result === "ok" && alive.current) setStopped(true);
    return result;
  }, [setEnabled]);

  const decideSecret = useCallback(async (request: SecretRequest, decision: SecretDecision): Promise<AskResult> => {
    let stored: MainRequest;
    try {
      stored = await attempt(() => api.answerRequest(request.id, decision));
    } catch {
      // Most likely the request has moved on (approved, expired, decided elsewhere): the next read says which.
      poll.current();
      return "failed";
    }
    if (stored.kind !== "secret") return "failed";
    const result = stored;
    watchedSecrets.current.add(request.id);
    localSecrets.current.set(request.id, { from: request.state, stored: result });
    if (alive.current) setSecretList((current) => current.map((candidate) => candidate.id === request.id ? result : candidate));
    if (result.state === "declined" || result.state === "revoked") {
      sentSecrets.current.add(`${request.id}:${result.state}`);
      onDecidedRef.current({ requestId: request.id, decision: result.state, secret: lineOf(result) });
    }
    return "ok";
  }, [api]);

  const decide = useCallback(async (request: MainRequest, decision: AskDecision | SecretDecision): Promise<AskResult> => {
    if (request.kind === "secret") {
      return decision.decision === "decline" || decision.decision === "stop" || decision.decision === "retry"
        ? decideSecret(request, { decision: decision.decision })
        : "failed";
    }
    if (decision.decision === "stop" || decision.decision === "retry") return "failed";
    let stored: MainRequest;
    // Marked first, so a read that lands while the decision is in flight neither brings the card back nor sends the answer twice.
    decided.current.add(request.id);
    if (request.kind === "action") told.current.add(request.id);
    try {
      stored = await attempt(() => api.answerRequest(request.id, decision));
    } catch (cause) {
      // Most likely the request is no longer pending (answered elsewhere, expired): the next read says which.
      decided.current.delete(request.id);
      told.current.delete(request.id);
      if (cause instanceof BotsHeld) return "held";
      poll.current();
      return "failed";
    }
    watched.current.delete(request.id);
    if (stored.kind === "action") {
      const action = stored;
      // A Send is told to Main once the service has sent it, from a later read; a Don't send is told now.
      if (action.state === "sending") told.current.delete(request.id);
      if (alive.current) {
        setRequests((current) => current.filter((candidate) => candidate.id !== request.id));
        setOutcomes((current) => [...current.filter((outcome) => outcome.id !== request.id), { id: request.id, kind: "action", request: action }]);
      }
      if (action.state === "declined") onDecidedRef.current({ requestId: request.id, decision: "action_declined", names: actionNames(action) });
      return "ok";
    }
    if (alive.current) {
      setRequests((current) => current.filter((candidate) => candidate.id !== request.id));
      if (stored.state === "declined" || stored.state === "expired") {
        const kind = stored.state;
        setOutcomes((current) => [...current.filter((outcome) => outcome.id !== request.id), { id: request.id, kind }]);
      }
    }
    // Expired sends nothing: Main is never nagged.
    if (stored.state === "answered") onDecidedRef.current({ requestId: request.id, decision: "answered" });
    else if (stored.state === "declined") onDecidedRef.current({ requestId: request.id, decision: "declined" });
    return "ok";
  }, [api, decideSecret]);

  const markSaved = useCallback((id: string) => setSaved((current) => new Set([...current, id])), []);
  const dismiss = useCallback((id: string) => {
    setClosed((current) => {
      const next = [...current].filter((known) => known !== id).concat(id).slice(-CLOSED_SECRETS_KEEP);
      try { localStorage.setItem(CLOSED_SECRETS_KEY, JSON.stringify(next)); } catch { /* Kept for this page only. */ }
      return new Set(next);
    });
  }, []);

  const secrets = useMemo(() => secretList.filter((request) => {
    if (closed.has(request.id)) return false;
    if (request.state === "pending") return enabled;
    if (request.state === "approved" || request.state === "ended" || request.state === "failed") return true;
    // A switch-off has its own line; a decline, expiry or stop shows only where the owner watched the request.
    return request.state !== "stopped" && watchedSecrets.current.has(request.id);
  }), [secretList, closed, enabled]);

  return {
    support, enabled, stopped, pending: requests, outcomes, secrets, saved, markSaved, dismiss, ...(owner ? { owner } : {}),
    webOn, noteWeb, setEnabled, stop, decide, refresh,
  };
}
