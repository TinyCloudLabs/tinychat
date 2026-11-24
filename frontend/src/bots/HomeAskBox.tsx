// The ask box on Home, for accounts the backend has turned tiny bots on for, and only once Main's chat works: the
// status says the account has bots, and a read of Main's messages comes back (Sam, 11-13: "hide this bar until chat
// is working"). Until then, and for everyone else, Home shows no box at all. A failed read is tried again each minute.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { ensureBotHistoryGrant, botHistoryEnabled } from "./historyGrant";
import { authorizeBotHistory } from "./historyAuthorization";
import { readBotHistory } from "./historyRead";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { openKeyFailureOf } from "../lib/authErrors";
import { listThreads } from "../lib/threadStore";
import { readHistoryNotice, type HistoryNotice } from "./historyNotice";
import { AskBox } from "./AskBox";
import { BotsError, botsApi, type BotsApi } from "./botsApi";
import { MainChat } from "./MainChat";
import { isWorking, useMainChat } from "./useMainChat";
import { AskCards } from "./AskCards";
import { ensureTrustBotReadGrant, readSettings, revokeReadGrant, setReadArea, signReadGrant } from "./trustbotReadGrant";
import { readDeniedChatIds, setChatDenied } from "./chatReadAccessApi";
import { listTelegramChats } from "./telegramChatReadAccess";
import { newMainChat } from "./mainNewChat";
import { SecretCards } from "./SecretCard";
import { useAsks } from "./useAsks";

const RETRY_MS = 60_000;

/** History steps that fail because the session is gone. */
const SESSION_GONE: Record<string, true> = { history_session_missing: true, history_session_expired: true, history_signed_out: true };

/** Authorizes Main's history before a send. A session that is gone reads as signed out, not as a reply that didn't come. */
async function prepareHistory(tcw: TinyCloudWeb): Promise<void> {
  if (!(await botHistoryEnabled())) return;
  try {
    await authorizeBotHistory(tcw);
    await ensureBotHistoryGrant(tcw);
  } catch (cause) {
    const gone = (cause instanceof Error && Object.hasOwn(SESSION_GONE, cause.message)) || openKeyFailureOf(cause).kind === "session-ended";
    throw gone ? new BotsError("signed_out") : cause;
  }
}

export function HomeAskBox({ api = botsApi, tcw, onReconnect }: { api?: BotsApi; tcw?: TinyCloudWeb; onReconnect?: () => void }) {
  const [working, setWorking] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        if (!(await api.getBotsStatus(controller.signal)).enabled) return;
        await api.listMainMessages(controller.signal);
        if (!controller.signal.aborted) setWorking(true);
      } catch {
        if (!controller.signal.aborted) timer = setTimeout(() => void check(), RETRY_MS);
      }
    };
    void check();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api]);
  return working ? <MainAsk api={api} tcw={tcw} onReconnect={onReconnect} /> : null;
}

function MainAsk({ api, tcw, onReconnect }: { api: BotsApi; tcw?: TinyCloudWeb; onReconnect?: () => void }) {
  const client = useMemo(() => !tcw ? api : { ...api, listMainMessages: async (signal?: AbortSignal) => {
    const local = await api.listMainMessages(signal);
    if (!(await botHistoryEnabled())) return local;
    await authorizeBotHistory(tcw);
    await ensureBotHistoryGrant(tcw);
    const archived = await readBotHistory(tcw, signal, { reseal: true });
    return [...new Map([...archived, ...local].map(message => [message.id, message])).values()];
  } }, [api, tcw]);
  const refreshRequests = useRef<() => void>(() => {});
  const chat = useMainChat(client, tcw ? () => prepareHistory(tcw) : undefined, () => refreshRequests.current());
  const [open, setOpen] = useState(false);
  const asks = useAsks(client, { open, onDecided: chat.sendAppReply, owner: tcw?.did });
  const refreshAsks = asks.refresh;
  refreshRequests.current = refreshAsks;
  // Saving a Web access change tells the cards at once, so their note is never stale.
  const noteWeb = asks.noteWeb;
  const webAccess = useMemo(() => ({
    getMainWeb: client.getMainWeb,
    setMainWeb: async (...args: Parameters<BotsApi["setMainWeb"]>) => {
      const stored = await client.setMainWeb(...args);
      noteWeb(stored.mode !== "off");
      return stored;
    },
  }), [client, noteWeb]);
  const [readRevision, setReadRevision] = useState(0);
  const meetings = useMemo(() => tcw ? {
    readSettings,
    setReadArea,
    signReadGrant: (serviceDid: string, areas: Parameters<typeof signReadGrant>[2]) => signReadGrant(tcw, serviceDid, areas),
    revokeReadGrant: (cid: string) => revokeReadGrant(tcw, cid),
    chatReadAccess: {
      listChats: async () => (await Promise.all([listThreads(tcw), listTelegramChats(tcw)])).flat(),
      readDeniedChatIds,
      setChatDenied,
    },
  } : undefined, [tcw, readRevision]);
  const clearChat = chat.clear;
  const newChat = useMemo(() => ({ start: () => newMainChat(), onStarted: () => { clearChat(); refreshAsks(); } }), [clearChat, refreshAsks]);
  // A turn is when Main asks: read the requests as it ends.
  const working = isWorking(chat.state.turn);
  const wasWorking = useRef(false);
  useEffect(() => {
    if (wasWorking.current && !working) refreshAsks();
    wasWorking.current = working;
  }, [working, refreshAsks]);
  const loadChatHistory = chat.loadHistory;
  const requestEarlier = useCallback(async () => (await import("./earlierHistoryRequest")).requestEarlierHistoryAccess(tcw!), [tcw]);
  const earlierHistory = useMemo(() => tcw ? { bot: "main", request: requestEarlier, reload: loadChatHistory } : undefined, [tcw, requestEarlier, loadChatHistory]);
  const [notice, setNotice] = useState<HistoryNotice | null>(null);
  useEffect(() => {
    if (!tcw) return;
    let current = true;
    const renew = () => {
      void ensureBotHistoryGrant(tcw).then(() => readHistoryNotice()).then(setNotice, () => {});
      void ensureTrustBotReadGrant(tcw).then(renewed => {
        if (current && renewed) setReadRevision(revision => revision + 1);
      });
    };
    renew();
    const refresh = setInterval(renew, 30_000);
    return () => { current = false; clearInterval(refresh); };
  }, [tcw]);
  useEffect(() => {
    if (!open || !tcw) return;
    let current = true;
    const load = () => { void readHistoryNotice().then(value => { if (current) setNotice(value); }, () => {}); };
    load();
    const retry = setInterval(load, 30_000);
    return () => { current = false; clearInterval(retry); };
  }, [open, tcw]);
  const openChat = () => {
    setOpen(true);
    void chat.ensureHistory();
  };
  const send = (text: string) => {
    setOpen(true);
    void chat.send(text);
  };
  return (
    <>
      <AskBox working={isWorking(chat.state.turn)} onSend={send} onOpenMain={openChat} />
      {/* The same requests as in Main's chat: they are shown here only while the chat is closed. */}
      {!open && asks.support === "yes" && (asks.pending.length > 0 || asks.stopped || asks.secrets.length > 0) ? (
        <div className="mb-6 flex flex-col gap-3" data-home-asks="">
          <AskCards asks={asks} />
          <SecretCards asks={asks} onMessage={openChat} />
        </div>
      ) : null}
      <MainChat
        open={open}
        onOpenChange={setOpen}
        state={chat.state}
        onSend={send}
        onRetry={chat.retry}
        onRetryHistory={() => void chat.loadHistory()}
        notice={notice}
        onReconnect={onReconnect}
        webAccess={webAccess}
        meetings={meetings}
        courier={Boolean(tcw)}
        asks={asks}
        newChat={newChat}
        earlierHistory={earlierHistory}
      />
    </>
  );
}
