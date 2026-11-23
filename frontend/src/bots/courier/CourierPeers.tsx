import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { AlertDialog, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { BotsRouteMissing } from "../botsApi";
import { courierPeersApi, type CourierPairPending, type CourierPeer, type CourierPeersApi } from "./courierPeersApi";

const COPY = {
  title: "Paired agents",
  pairLabel: "Pair code from your agent",
  pair: "Pair agent",
  acceptLabel: "Give this code to your agent. It sends back a final code.",
  copy: "Copy",
  copied: "Copied",
  unpair: "Unpair",
  cancel: "Cancel",
  empty: "No paired agents.",
  loading: "Loading paired agents…",
  loadFailed: "Paired agents couldn't be loaded. Try again.",
  pairFailed: "This agent couldn't be paired. Check the code and try again.",
  unpairFailed: "This agent couldn't be unpaired. Try again.",
  copyFailed: "The code couldn't be copied. Select it and copy it yourself.",
  waiting: "Waiting for your agent's final code.",
  finalLabel: "Final code from your agent",
  finish: "Finish pairing",
  expired: "This pairing request expired. Start with a new pair code from your agent.",
  restart: "Start over",
};
const fieldClass = "w-full min-w-0 resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/** The owner exchanges pair-start, accept and final codes; only verified peers appear in the list. */
export function CourierPeers({ api = courierPeersApi }: { api?: CourierPeersApi }) {
  const id = useId();
  const artifact = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true);
  const [peers, setPeers] = useState<CourierPeer[] | null>(null);
  const [pending, setPending] = useState<CourierPairPending | null>(null);
  const [now, setNow] = useState(Date.now);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<CourierPeer | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    let current = true;
    setPeers(null);
    setMissing(false);
    setError(null);
    setPending(null);
    api.listPeers().then(
      (result) => { if (current) setPeers(result.peers); },
      (cause: unknown) => {
        if (!current) return;
        if (cause instanceof BotsRouteMissing) setMissing(true);
        else setError(COPY.loadFailed);
      },
    );
    return () => { current = false; };
  }, [api]);

  useEffect(() => {
    if (!pending) return;
    setNow(Date.now());
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, pending.pendingExpiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [pending]);

  const expired = pending !== null && now >= pending.pendingExpiresAt;

  async function pair(event: FormEvent) {
    event.preventDefault();
    const code = artifact.current?.value.trim();
    if (!code || busy) return;
    if (pending && Date.now() >= pending.pendingExpiresAt) { setNow(Date.now()); return; }
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const result = await api.pairPeer({ artifact: code });
      if (!alive.current) return;
      if ("pending" in result) {
        setPending(result);
        setNow(Date.now());
      } else {
        setPeers((saved) => [...(saved ?? []).filter((peer) => peer.handle !== result.peer.handle), result.peer]);
        setPending(null);
      }
      if (artifact.current) artifact.current.value = "";
    } catch (cause) {
      if (!alive.current) return;
      if (cause instanceof BotsRouteMissing) setMissing(true);
      else setError(COPY.pairFailed);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function copy() {
    if (!pending) return;
    setError(null);
    try {
      await navigator.clipboard.writeText(pending.acceptArtifact);
      if (alive.current) setCopied(true);
    } catch {
      if (alive.current) setError(COPY.copyFailed);
    }
  }

  async function unpair() {
    if (!confirming || busy) return;
    const handle = confirming.handle;
    setBusy(true);
    setError(null);
    try {
      await api.unpairPeer(handle);
      if (!alive.current) return;
      setPeers((saved) => (saved ?? []).filter((peer) => peer.handle !== handle));
      setConfirming(null);
    } catch (cause) {
      if (!alive.current) return;
      if (cause instanceof BotsRouteMissing) setMissing(true);
      else setError(COPY.unpairFailed);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  if (missing) return null;
  return (
    <section aria-labelledby={`${id}-title`} className="flex min-w-0 flex-col gap-3" data-courier-peers="">
      <h2 id={`${id}-title`} className="text-headline">{COPY.title}</h2>
      {peers === null ? (
        error ? null : <p role="status" className="text-callout text-muted-foreground">{COPY.loading}</p>
      ) : (
        <>
          {pending && !expired ? (
            <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-muted p-3">
              <label htmlFor={`${id}-accept`} className="text-callout">{COPY.acceptLabel}</label>
              <textarea id={`${id}-accept`} readOnly value={pending.acceptArtifact} rows={3} className={fieldClass} />
              <div><Button type="button" variant="outline" size="sm" onClick={() => void copy()}>{copied ? COPY.copied : COPY.copy}</Button></div>
              <p role="status" className="text-callout text-muted-foreground">{COPY.waiting}</p>
              <p className="text-caption text-muted-foreground">{`This step expires at ${new Date(pending.pendingExpiresAt).toLocaleTimeString(undefined, { timeStyle: "short" })}.`}</p>
            </div>
          ) : null}
          {expired ? (
            <div className="flex flex-col gap-2">
              <p role="status" className="text-callout text-muted-foreground">{COPY.expired}</p>
              <div><Button type="button" variant="outline" size="sm" onClick={() => { setPending(null); setError(null); setCopied(false); }}>{COPY.restart}</Button></div>
            </div>
          ) : (
            <form onSubmit={(event) => void pair(event)} className="flex min-w-0 flex-col gap-2">
              <label htmlFor={`${id}-artifact`} className="text-callout">{pending ? COPY.finalLabel : COPY.pairLabel}</label>
              <textarea key={pending ? "final" : "start"} ref={artifact} id={`${id}-artifact`} required rows={3} disabled={busy} className={fieldClass} />
              <div><Button type="submit" variant="outline" size="sm" disabled={busy}>{pending ? COPY.finish : COPY.pair}</Button></div>
            </form>
          )}
          {peers.length === 0 ? <p className="text-callout text-muted-foreground">{COPY.empty}</p> : (
            <ul className="flex min-w-0 flex-col divide-y divide-border">
              {peers.map((peer) => (
                <li key={peer.handle} className="flex min-w-0 items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="break-words text-callout">{peer.handle}</p>
                    <p className="text-caption text-muted-foreground">{`Paired until ${new Date(peer.delegationExpiresAt).toLocaleDateString(undefined, { dateStyle: "medium" })}`}</p>
                  </div>
                  <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { setError(null); setConfirming(peer); }}>{COPY.unpair}</Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {error && !confirming ? <p role="alert" className="text-callout text-destructive">{error}</p> : null}
      {confirming ? (
        <AlertDialog open onOpenChange={(open) => { if (!open && !busy) setConfirming(null); }}>
          <AlertDialogContent aria-describedby={undefined}>
            <AlertDialogHeader>
              <AlertDialogTitle>{`Unpair ${confirming.handle}? TrustBot stops answering it.`}</AlertDialogTitle>
            </AlertDialogHeader>
            {error ? <p role="alert" className="text-callout text-destructive">{error}</p> : null}
            <AlertDialogFooter>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => { setConfirming(null); setError(null); }}>{COPY.cancel}</Button>
              <Button type="button" variant="destructive" disabled={busy} onClick={() => void unpair()}>{COPY.unpair}</Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </section>
  );
}
