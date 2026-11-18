// The ask box on Home, for accounts the backend has turned tiny bots on for, and only once Main's chat works: the
// status says the account has bots, and a read of Main's messages comes back (Sam, 11-13: "hide this bar until chat
// is working"). Until then, and for everyone else, Home shows no box at all. A failed read is tried again each minute.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { ensureBotHistoryGrant, botHistoryEnabled } from "./historyGrant";
import { authorizeBotHistory } from "./historyAuthorization";
import { readBotHistory } from "./historyRead";
import { useEffect, useMemo, useState } from "react";

import { readHistoryNotice, type HistoryNotice } from "./historyNotice";
import { AskBox } from "./AskBox";
import { botsApi, type BotsApi } from "./botsApi";
import { MainChat } from "./MainChat";
import { isWorking, useMainChat } from "./useMainChat";

const RETRY_MS = 60_000;

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
    const archived = await readBotHistory(tcw, signal);
    return [...new Map([...archived, ...local].map(message => [message.id, message])).values()];
  } }, [api, tcw]);
  const chat = useMainChat(client, tcw ? async () => { if (await botHistoryEnabled()) { await authorizeBotHistory(tcw); await ensureBotHistoryGrant(tcw); } } : undefined);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<HistoryNotice | null>(null);
  useEffect(() => {
    if (!tcw) return;
    const renew = () => { void ensureBotHistoryGrant(tcw).then(() => readHistoryNotice()).then(setNotice, () => {}); };
    renew();
    const refresh = setInterval(renew, 30_000);
    return () => clearInterval(refresh);
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
      <MainChat
        open={open}
        onOpenChange={setOpen}
        state={chat.state}
        onSend={send}
        onRetry={chat.retry}
        onRetryHistory={() => void chat.loadHistory()}
        notice={notice}
        onReconnect={onReconnect}
      />
    </>
  );
}
