// Main's secret requests as cards: the question card's frame with two steps (save the secret in TinyCloud Secrets,
// approve it in OpenKey), then what became of the request. The value never passes through this page: the owner types
// it in TinyCloud Secrets, and OpenKey grants Main use of it. Main's sentence on what it is for is shown as plain text.
import { CheckIcon } from "lucide-react";
import { Fragment, useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { StatusMark } from "@/feed/CompactCard";
import { secretsAvailable } from "@/lib/openkeyNative";
import { AppLine } from "./AskCards";
import { ASK_STRINGS, SECRET_STRINGS as S, askedAgo, secretDate, secretWith } from "./askStrings";
import { plainText } from "./askText";
import type { SecretRequest } from "./botsApi";
import type { Asks } from "./useAsks";

/** TinyCloud Secrets: the page the owner saves the secret in, and the only origin its saved signal is taken from. */
export const SECRETS_ORIGIN = "https://secrets.tinycloud.xyz";
/** The only origin an approval page is opened on. */
const OPENKEY_ORIGIN = new URL(import.meta.env.VITE_OPENKEY_HOST || "https://openkey.so").origin;
export const SAVED_SIGNAL = "tinycloud:secret-saved";
const REQUESTER = "TinyCloud One";
const WINDOW_FEATURES = "popup,width=480,height=720";
const WINDOW_POLL_MS = 500;
const MINUTE_MS = 60_000;
const MAX_WHY = 200;

const randomState = (): string => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** TinyCloud Secrets' request page for this secret; it signals back to this page's origin with `state`. */
export function secretsRequestUrl(name: string, state: string, owner: string | undefined, returnTo: string): string {
  const url = new URL("/request", SECRETS_ORIGIN);
  if (owner) url.searchParams.set("owner", owner);
  url.searchParams.set("name", name);
  url.searchParams.set("requester", REQUESTER);
  url.searchParams.set("return_to", returnTo);
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * True only for TinyCloud Secrets' saved signal for exactly this secret and this window's single-use state: a plain
 * object with exactly `type`, `v`, `names` and `state`. The caller checks the origin and the window it came from.
 */
export function isSavedSignal(data: unknown, name: string, state: string): boolean {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
  const prototype: unknown = Object.getPrototypeOf(data);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.keys(data).sort().join(",") !== "names,state,type,v") return false;
  const signal = data as Record<string, unknown>;
  return signal.type === SAVED_SIGNAL && signal.v === 1 && Array.isArray(signal.names) && signal.names.length === 1
    && signal.names[0] === name && typeof signal.state === "string" && state.length > 0 && signal.state === state;
}

const isApprovalUrl = (url: string | undefined): url is string => {
  if (!url) return false;
  try {
    return new URL(url).origin === OPENKEY_ORIGIN;
  } catch {
    return false;
  }
};

const words = (parts: ReactNode[]) => parts.map((part, index) => <Fragment key={index}>{part}</Fragment>);
const code = (name: string) => <code className="rounded bg-muted px-1 font-mono text-[0.95em]" data-secret-name="">{name}</code>;

type WindowNote = "open" | "blocked" | null;

/** One pop-up at a time for a step: says it is open or was blocked, and calls `onClosed` once the owner closes it. */
function usePopup(onClosed: () => void) {
  const [note, setNote] = useState<WindowNote>(null);
  const current = useRef<Window | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  useEffect(() => () => clearInterval(timer.current), []);
  const open = useCallback((url: string, name: string) => {
    // Never noopener: TinyCloud Secrets signals back through window.opener.
    const opened = window.open(url, name, WINDOW_FEATURES);
    clearInterval(timer.current);
    if (!opened) {
      current.current = null;
      setNote("blocked");
      return;
    }
    current.current = opened;
    setNote("open");
    timer.current = setInterval(() => {
      if (!opened.closed) return;
      clearInterval(timer.current);
      if (current.current !== opened) return;
      current.current = null;
      setNote(null);
      onClosedRef.current();
    }, WINDOW_POLL_MS);
  }, []);
  const settle = useCallback(() => setNote(null), []);
  return { note, open, settle, current };
}

interface CardProps {
  request: SecretRequest;
  asks: Asks;
  chat: boolean;
  onMessage?: () => void;
}

function useDecision(request: SecretRequest, asks: Asks) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const decide = async (decision: "decline" | "stop" | "retry") => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const result = await asks.decide(request, { decision });
    setBusy(false);
    if (result === "failed") setFailed(true);
  };
  return { busy, failed, setFailed, setBusy, decide };
}

function Frame({ request, state, children, labelledBy }: { request: SecretRequest; state: string; children: ReactNode; labelledBy: string }) {
  return (
    <section
      aria-labelledby={labelledBy}
      data-secret-card=""
      data-secret-id={request.id}
      data-secret-state={state}
      className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4"
    >
      {children}
    </section>
  );
}

const SendFailed = ({ failed }: { failed: boolean }) =>
  failed ? <p role="alert" className="text-callout text-muted-foreground">{ASK_STRINGS.sendFailed}</p> : null;

/** A numbered step; once done, its number turns into a tick and `done` says what happened. */
function Step({ n, step, title, done, children }: { n: number; step: string; title: string; done?: ReactNode; children?: ReactNode }) {
  return (
    <li className="grid grid-cols-[1.5rem_1fr] gap-2 rounded-xl border border-border bg-muted/40 p-2.5" data-secret-step={step}>
      <span aria-hidden className={`mt-0.5 grid size-[22px] place-items-center rounded-full text-[12px] font-semibold ${done ? "bg-emerald-700 text-white" : "bg-foreground text-background"}`}>
        {done ? <CheckIcon className="size-3.5" /> : n}
      </span>
      <div className="flex flex-col gap-1.5">
        <p className="text-body font-medium">{title}</p>
        {done ? <p className="text-callout" data-secret-step-done={step}>{done}</p> : children}
      </div>
    </li>
  );
}

function PendingCard({ request, asks, onMessage, labelledBy }: Omit<CardProps, "chat"> & { labelledBy: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);
  const { busy, failed, setFailed, setBusy, decide } = useDecision(request, asks);
  const saved = asks.saved.has(request.id);
  const native = !secretsAvailable();
  const why = plainText(request.why ?? "", MAX_WHY);
  const approveUrl = isApprovalUrl(request.approveUrl) ? request.approveUrl : undefined;

  const add = usePopup(() => {});
  const approve = usePopup(asks.refresh);
  const expected = useRef<string | null>(null);
  const markSaved = asks.markSaved;
  const settleAdd = add.settle;
  const addWindow = add.current;
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const state = expected.current;
      if (!state || event.origin !== SECRETS_ORIGIN || !addWindow.current || event.source !== addWindow.current) return;
      if (!isSavedSignal(event.data, request.name, state)) return;
      // Single use: a second signal with the same state is not taken.
      expected.current = null;
      markSaved(request.id);
      settleAdd();
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [request.id, request.name, markSaved, settleAdd, addWindow]);

  const openAdd = () => {
    const state = randomState();
    expected.current = state;
    approve.settle();
    add.open(secretsRequestUrl(request.name, state, asks.owner, window.location.origin), `tinycloud-secrets-${request.id}`);
  };
  const openApprove = () => {
    if (!approveUrl) return;
    add.settle();
    approve.open(approveUrl, `openkey-approve-${request.id}`);
  };
  const note = add.note ?? approve.note;

  return (
    <>
      <p id={labelledBy} className="text-headline">{S.title}</p>
      {why ? <p className="whitespace-pre-wrap break-words text-body" data-secret-why="">{ASK_STRINGS.quote(why)}</p> : null}
      <p className="text-callout" data-secret-sites="">{S.onlyWith(request)}</p>
      {request.writes?.length ? <p className="text-callout" data-secret-writes="">{S.writes(secretWith(request))}</p> : null}
      <p className="text-callout text-muted-foreground">{askedAgo(now - Date.parse(request.askedAt))}</p>
      {request.outside ? <p className="text-callout" data-secret-outside="">{S.outside}</p> : null}
      {native ? <p className="text-callout" data-secret-iphone="">{S.iphone}</p> : (
        <ol className="flex flex-col gap-2">
          <Step n={1} step="add" title={S.addTitle} done={saved ? S.addDone : undefined}>
            <p className="text-callout text-muted-foreground">{S.addHelp}</p>
            <Button type="button" className="self-start" disabled={busy} onClick={openAdd}>{S.addButton}</Button>
          </Step>
          <Step n={2} step="approve" title={S.approveTitle}>
            <p className="text-callout text-muted-foreground">{S.approveHelp}</p>
            <Button type="button" className="self-start" variant={saved ? "default" : "outline"} disabled={busy || !saved || !approveUrl} onClick={openApprove}>
              {S.approveButton}
            </Button>
          </Step>
        </ol>
      )}
      {note === "open" ? <p role="status" className="text-callout text-muted-foreground" data-secret-window="open">{S.windowOpen}</p> : null}
      {note === "blocked" ? <p role="alert" className="text-callout" data-secret-window="blocked">{S.windowBlocked}</p> : null}
      {native ? null : <p className="text-callout text-muted-foreground">{S.footer(secretWith(request))}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={() => void decide("decline")}>{S.decline}</Button>
        {onMessage && !native ? <Button type="button" variant="ghost" onClick={onMessage}>{S.message}</Button> : null}
      </div>
      <SendFailed failed={failed} />
      {native ? null : (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setFailed(false);
            void asks.stop().then((result) => { setBusy(false); if (result === "failed") setFailed(true); });
          }}
          className="inline-flex min-h-11 items-center self-start text-callout text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {ASK_STRINGS.stop}
        </button>
      )}
    </>
  );
}

function ApprovedCard({ request, asks, labelledBy }: Omit<CardProps, "chat" | "onMessage"> & { labelledBy: string }) {
  const [confirming, setConfirming] = useState(false);
  const { busy, failed, decide } = useDecision(request, asks);
  const until = secretDate(request.until ?? request.resolvedAt ?? request.askedAt);
  if (confirming) {
    return (
      <>
        <p id={labelledBy} className="text-headline">{words(S.stopConfirm(code(request.name)))}</p>
        <p className="text-callout text-muted-foreground">{S.stopConfirmHelp}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void decide("stop")}>{S.stopNow}</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirming(false)}>{S.cancel}</Button>
        </div>
        <SendFailed failed={failed} />
      </>
    );
  }
  return (
    <>
      <p id={labelledBy} className="text-headline" data-secret-approved="">{words(S.approved(code(request.name), secretWith(request), until))}</p>
      <p className="text-callout text-muted-foreground">{S.approvedHelp}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => setConfirming(true)}>{S.stopNow}</Button>
        <Button type="button" onClick={() => asks.dismiss(request.id)}>{S.close}</Button>
      </div>
    </>
  );
}

function ResolvedCard({ request, asks, chat, labelledBy }: Omit<CardProps, "onMessage"> & { labelledBy: string }) {
  const { busy, failed, decide } = useDecision(request, asks);
  const close = <Button type="button" variant="outline" disabled={busy} onClick={() => asks.dismiss(request.id)}>{S.close}</Button>;
  const sites = secretWith(request);
  switch (request.state) {
    case "revoked":
      return <><p id={labelledBy} className="text-headline">{S.stopped(request.name)}</p><div>{close}</div></>;
    case "declined":
    case "expired":
      return (
        <>
          <p id={labelledBy} className="text-headline">{request.state === "declined" ? S.declined : S.expired}</p>
          <p className="text-callout text-muted-foreground">{words(S.nameOnlyWith(code(request.name), sites))}</p>
          <div>{close}</div>
          {chat && request.state === "expired" ? <AppLine decision="expired" live secret={request} /> : null}
        </>
      );
    case "ended":
      return (
        <>
          <p id={labelledBy} className="text-headline">{words(S.ended(code(request.name), secretDate(request.until ?? request.resolvedAt ?? request.askedAt)))}</p>
          <p className="text-callout text-muted-foreground">{S.endedHelp}</p>
          <div>{close}</div>
          {chat ? <AppLine decision="ended" live secret={request} /> : null}
        </>
      );
    case "failed":
      return (
        <>
          <p id={labelledBy} className="text-headline">{words(S.failed(code(request.name)))}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={busy} onClick={() => void decide("retry")}>{S.tryAgain}</Button>
            {close}
          </div>
          <SendFailed failed={failed} />
        </>
      );
    default:
      return null;
  }
}

/** Feed: a pending request is one "Needs you" row; it opens in place into the full card. */
function SecretRow({ request, onOpen, onMessage }: { request: SecretRequest; onOpen: () => void; onMessage?: () => void }) {
  const [now] = useState(Date.now);
  return (
    <section data-secret-row="" data-secret-id={request.id} className="flex flex-col gap-1 rounded-2xl border border-border bg-card px-4 py-3">
      <button type="button" aria-expanded={false} onClick={onOpen} className="flex items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <StatusMark status={S.needsYou} />
        <span className="text-headline">{words(S.rowTitle(code(request.name)))}</span>
      </button>
      <p className="text-callout text-muted-foreground">
        {S.rowLine(secretWith(request), askedAgo(now - Date.parse(request.askedAt)))}
        {onMessage ? (
          <button type="button" onClick={onMessage} data-inline-link="" className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {S.openChat}
          </button>
        ) : S.openChat}
      </p>
    </section>
  );
}

function SecretCard({ request, asks, chat, onMessage }: CardProps) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  if (!chat && request.state === "pending" && !expanded) return <SecretRow request={request} onOpen={() => setExpanded(true)} onMessage={onMessage} />;
  const labelledBy = `${id}-title`;
  return (
    <Frame request={request} state={request.state} labelledBy={labelledBy}>
      {request.state === "pending" ? <PendingCard request={request} asks={asks} onMessage={onMessage} labelledBy={labelledBy} />
        : request.state === "approved" ? <ApprovedCard key="approved" request={request} asks={asks} labelledBy={labelledBy} />
        : <ResolvedCard request={request} asks={asks} chat={chat} labelledBy={labelledBy} />}
    </Frame>
  );
}

/**
 * Main's secret requests: in Main's chat (`chat`) as full cards; on Home a pending one is a Feed row that opens in place.
 * `onMessage` is "Message Main" on the card and "Open chat" on the row.
 */
export function SecretCards({ asks, chat = false, onMessage }: { asks: Asks; chat?: boolean; onMessage?: () => void }) {
  if (asks.support !== "yes" || asks.secrets.length === 0) return null;
  return <>{asks.secrets.map((request) => <SecretCard key={request.id} request={request} asks={asks} chat={chat} onMessage={onMessage} />)}</>;
}
