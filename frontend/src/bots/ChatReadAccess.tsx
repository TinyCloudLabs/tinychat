import { useEffect, useId, useRef, useState } from "react";

import type { ChatReadAccessApi, ChatReadChat } from "./chatReadAccessApi";
import { CHAT_READ_ACCESS_STRINGS as COPY } from "./chatReadAccessStrings";

/** Chat exclusions can be changed even while the enclosing read area is off. */
export function ChatReadAccess({ api }: { api: ChatReadAccessApi }) {
  const id = useId();
  const [loaded, setLoaded] = useState<{ api: ChatReadAccessApi; chats: ChatReadChat[]; denied: Set<string> } | null>(null);
  const [loadFailed, setLoadFailed] = useState<ChatReadAccessApi | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const lifecycle = useRef<{ api: ChatReadAccessApi; active: boolean; saving: boolean } | null>(null);

  useEffect(() => {
    const scope = { api, active: true, saving: false };
    lifecycle.current = scope;
    setLoaded(null);
    setLoadFailed(null);
    setSaveFailed(false);
    setPending(false);
    Promise.all([api.listChats(), api.readDeniedChatIds()]).then(
      ([chats, denied]) => { if (scope.active) setLoaded({ api, chats, denied }); },
      () => { if (scope.active) setLoadFailed(api); },
    );
    return () => { scope.active = false; };
  }, [api]);

  const change = async (chat: string) => {
    const scope = lifecycle.current;
    if (!scope?.active || scope.api !== api || scope.saving || loaded?.api !== api) return;
    scope.saving = true;
    setPending(true);
    setSaveFailed(false);
    try {
      const denied = await api.setChatDenied(chat, !loaded.denied.has(chat));
      if (scope.active) setLoaded({ ...loaded, denied });
    } catch {
      if (scope.active) setSaveFailed(true);
    } finally {
      scope.saving = false;
      if (scope.active) setPending(false);
    }
  };

  const ready = loaded?.api === api ? loaded : null;
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3 border-l border-border pl-4">
      <div className="flex flex-col gap-1">
        <h3 id={`${id}-title`} className="text-headline">{COPY.heading}</h3>
        <p className="text-callout text-muted-foreground">{COPY.description}</p>
      </div>
      {loadFailed === api ? (
        <p role="alert" className="text-callout text-muted-foreground">{COPY.loadError}</p>
      ) : !ready ? (
        <p role="status" className="text-callout text-muted-foreground">{COPY.loading}</p>
      ) : ready.chats.length === 0 ? (
        <p className="text-callout text-muted-foreground">{COPY.empty}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {ready.chats.map((chat, index) => {
            const allowed = !ready.denied.has(chat.id);
            return (
              <li key={chat.id} className="flex items-center gap-3">
                <span id={`${id}-chat-${index}`} className="min-w-0 flex-1 break-words text-callout">{chat.title?.trim() || COPY.unnamed}</span>
                <button
                  type="button"
                  role="switch"
                  aria-label={COPY.switchLabel}
                  aria-describedby={`${id}-chat-${index} ${id}-scope`}
                  aria-checked={allowed}
                  disabled={pending}
                  onClick={() => void change(chat.id)}
                  className="flex h-11 w-12 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span aria-hidden="true" className={`relative h-6 w-11 rounded-full transition-colors ${allowed ? "bg-primary" : "bg-muted"}`}>
                    <span className={`absolute top-1 size-4 rounded-full bg-background transition-transform ${allowed ? "left-6" : "left-1"}`} />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {ready && ready.chats.length > 0 ? <p id={`${id}-scope`} className="text-callout text-muted-foreground">{COPY.scopeHint}</p> : null}
      {saveFailed ? <p role="alert" className="text-callout text-muted-foreground">{COPY.saveError}</p> : null}
    </section>
  );
}
