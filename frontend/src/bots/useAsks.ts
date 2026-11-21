// Main's questions to the owner, as one page-wide state: the setting, the pending requests, and what became of the
// ones the owner watched (said not now, expired). Main's chat and Home both draw from this one state, so a question
// is one card in one place and answering it anywhere resolves it everywhere.
import { useCallback, useEffect, useRef, useState } from "react";

import { BotsRouteMissing, type AskDecision, type AskRequest, type BotsApi } from "./botsApi";
import type { AppReply } from "./useMainChat";

export type AsksApi = Pick<BotsApi, "getAsks" | "setAsks" | "listRequests" | "answerRequest" | "getMainWeb">;

/** Poll while Main's chat is open; Home checks less often. */
export const OPEN_POLL_MS = 5_000;
export const CLOSED_POLL_MS = 30_000;

/** What the owner sees where a card was. */
export interface AskOutcome {
  id: string;
  kind: "declined" | "expired";
}

export type AskResult = "ok" | "failed";

export interface Asks {
  /** `unknown` until the service answers; `no` when it has no such route (nothing about asks is shown). */
  support: "unknown" | "yes" | "no";
  enabled: boolean;
  /** True once the owner pressed "Stop Main from asking" and not since turned it back on. */
  stopped: boolean;
  pending: AskRequest[];
  outcomes: AskOutcome[];
  /** Web access is on, so the card says what a page could try. */
  webOn: boolean;
  setEnabled(enabled: boolean): Promise<AskResult>;
  stop(): Promise<AskResult>;
  decide(request: AskRequest, decision: AskDecision): Promise<AskResult>;
  refresh(): void;
}

/** A call on an api that may not have the route (an older client object): any throw is a failure, never a crash. */
const attempt = <T>(call: () => Promise<T>): Promise<T> => Promise.resolve().then(call);

export function useAsks(api: AsksApi, { open, onDecided }: { open: boolean; onDecided: (reply: AppReply) => void }): Asks {
  const [support, setSupport] = useState<Asks["support"]>("unknown");
  const [enabled, setEnabledState] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [requests, setRequests] = useState<AskRequest[]>([]);
  const [outcomes, setOutcomes] = useState<AskOutcome[]>([]);
  const [webOn, setWebOn] = useState(false);
  const alive = useRef(true);
  const watched = useRef(new Set<string>());
  /** Requests decided in this page: a poll that started before the decision must not bring the card back. */
  const decided = useRef(new Set<string>());
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

  const apply = useCallback((list: AskRequest[]) => {
    const now = Date.now();
    const live = list.filter((request) => request.state === "pending" && Date.parse(request.expiresAt) > now && !decided.current.has(request.id));
    const liveIds = new Set(live.map((request) => request.id));
    const gone: AskOutcome[] = [];
    for (const id of watched.current) {
      if (liveIds.has(id)) continue;
      watched.current.delete(id);
      const request = list.find((candidate) => candidate.id === id);
      if (decided.current.has(id)) continue;
      if (request?.state === "declined") gone.push({ id, kind: "declined" });
      else if (request?.state === "expired" || (request?.state === "pending" && Date.parse(request.expiresAt) <= now)) gone.push({ id, kind: "expired" });
    }
    for (const id of liveIds) watched.current.add(id);
    setRequests(live);
    if (gone.length > 0) setOutcomes((current) => [...current, ...gone.filter((outcome) => !current.some((known) => known.id === outcome.id))]);
    // A decision that was recorded but never reached Main (the page closed first) goes out now.
    for (const request of list) {
      if ((request.state === "answered" || request.state === "declined") && request.undelivered && !decided.current.has(request.id)) {
        decided.current.add(request.id);
        onDecidedRef.current({ requestId: request.id, decision: request.state });
      }
    }
  }, []);

  const hasPending = requests.length > 0;
  useEffect(() => {
    if (support !== "yes" || !enabled || !hasPending) return;
    const controller = new AbortController();
    attempt(() => api.getMainWeb(controller.signal)).then(
      (settings) => { if (!controller.signal.aborted) setWebOn(settings.mode !== "off"); },
      () => {},
    );
    return () => controller.abort();
  }, [api, support, enabled, hasPending]);

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
      setStopped(false);
      if (!stored.enabled) { setRequests([]); watched.current.clear(); }
      return "ok";
    } catch {
      return "failed";
    }
  }, [api]);

  const stop = useCallback(async (): Promise<AskResult> => {
    const result = await setEnabled(false);
    if (result === "ok" && alive.current) setStopped(true);
    return result;
  }, [setEnabled]);

  const decide = useCallback(async (request: AskRequest, decision: AskDecision): Promise<AskResult> => {
    let stored: AskRequest;
    // Marked first, so a read that lands while the decision is in flight neither brings the card back nor sends the answer twice.
    decided.current.add(request.id);
    try {
      stored = await attempt(() => api.answerRequest(request.id, decision));
    } catch {
      // Most likely the request is no longer pending (answered elsewhere, expired): the next read says which.
      decided.current.delete(request.id);
      poll.current();
      return "failed";
    }
    watched.current.delete(request.id);
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
  }, [api]);

  return { support, enabled, stopped, pending: requests, outcomes, webOn, setEnabled, stop, decide, refresh };
}
