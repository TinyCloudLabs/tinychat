// An owner-only view: no composer, model tools or cross-thread reply controls.
// Details: TC-4058
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { courierThreadsApi, type CourierThreadsApi, type CourierThreadSummary, type CourierThreadView } from "./courierThreadsApi";

export function CourierThreads({ api = courierThreadsApi }: { api?: CourierThreadsApi }) {
  const [threads, setThreads] = useState<CourierThreadSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [thread, setThread] = useState<CourierThreadView | null>(null);
  const [error, setError] = useState(false);
  const [confirm, setConfirm] = useState<"delete" | "unpair" | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleted, setDeleted] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let missing = false;
    const load = async () => {
      if (missing) return;
      try {
        const value = await api.list(controller.signal);
        if (controller.signal.aborted) return;
        missing = value === null;
        setThreads(value);
      } catch { if (!controller.signal.aborted) { setThreads(old => old ?? []); setError(true); } }
    };
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [api]);
  useEffect(() => {
    if (!selected) { setThread(null); return; }
    const controller = new AbortController();
    setThread(null); setError(false); setConfirm(null);
    const load = async () => {
      try { const value = await api.read(selected, controller.signal); if (!controller.signal.aborted) { setThread(value); setError(false); } }
      catch { if (!controller.signal.aborted) setError(true); }
    };
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [api, selected]);
  const execute = async () => {
    if (!thread || !confirm || busy) return;
    setBusy(true); setError(false);
    try {
      if (confirm === "delete") { await api.remove(thread.id); setThreads(old => old?.filter(item => item.id !== thread.id) ?? []); setSelected(null); setDeleted(true); }
      else { await api.unpair(thread.peer); }
      setConfirm(null);
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  // A dark backend is a 404, not a disabled control or an invitation to connect.
  if (threads === null) return null;
  return (
    <section className="flex min-w-0 flex-col gap-3" data-courier-conversations="">
      {selected ? (
        <>
          <Button type="button" variant="ghost" className="self-start" onClick={() => { setSelected(null); setConfirm(null); setError(false); }}>Back</Button>
          <h3 className="break-words font-display text-title-3">{thread?.title ?? threads.find(item => item.id === selected)?.title}</h3>
          <p className="text-callout text-muted-foreground">Messages from this paired agent and TrustBot's answers. You can read them here; replies go only to this agent.</p>
          {!thread && !error ? <p role="status" className="text-callout">Loading messages…</p> : null}
          {thread?.messages.length === 0 ? <p className="text-callout text-muted-foreground">No messages from this agent.</p> : null}
          <ol className="flex flex-col gap-4">
            {thread?.messages.map((message, index) => (
              <li key={`${message.at}:${index}`} className="min-w-0 border-l-2 border-border pl-3">
                <div className="mb-1 flex flex-wrap items-baseline gap-x-2 text-meta text-muted-foreground"><span>{message.role === "peer" ? thread.peer : "TrustBot"}</span><time dateTime={new Date(message.at).toISOString()}>{new Date(message.at).toLocaleString()}</time></div>
                <p className="whitespace-pre-wrap break-words text-callout">{message.text}</p>
              </li>
            ))}
          </ol>
          {thread ? <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" onClick={() => setConfirm("unpair")}>Unpair</Button><Button type="button" variant="outline" onClick={() => setConfirm("delete")}>Delete conversation</Button></div> : null}
          {confirm && thread ? (
            <div role="alertdialog" aria-modal="true" aria-label={confirm === "delete" ? "Delete conversation" : "Unpair"} className="rounded-xl border border-border bg-card p-4">
              <p className="mb-3 text-callout">{confirm === "delete" ? `Delete this conversation with ${thread.peer}? The messages are removed. The agent stays paired.` : `Unpair ${thread.peer}? TrustBot stops answering it.`}</p>
              <div className="flex gap-2"><Button type="button" disabled={busy} onClick={() => void execute()}>{confirm === "delete" ? "Delete" : "Unpair"}</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>Cancel</Button></div>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <h3 className="text-meta font-medium text-muted-foreground">Courier conversations</h3>
          <p className="text-callout text-muted-foreground">TrustBot keeps the latest 200 messages in each conversation, and up to 50 conversations, for 30 days. Older ones are deleted.</p>
          {deleted ? <p role="status" className="text-callout">Conversation deleted.</p> : null}
          <ul className="divide-y divide-border">{[...threads].sort((a, b) => b.updatedAt - a.updatedAt).map(item => <li key={item.id}><button type="button" className="min-h-11 w-full break-words py-2 text-left text-callout hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { setSelected(item.id); setDeleted(false); }}>{item.title}</button></li>)}</ul>
        </>
      )}
      {error ? <p role="alert" className="text-callout text-destructive">These messages couldn't be loaded. Try again.</p> : null}
    </section>
  );
}
