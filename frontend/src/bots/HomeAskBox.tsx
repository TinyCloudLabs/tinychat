// The ask box on Home, for accounts the backend has turned tiny bots on for. Everyone else, and anyone
// whose status call fails, gets nothing: Home looks as it does today.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { ensureBotHistoryGrant, botHistoryEnabled } from "./historyGrant";
import { readBotHistory } from "./historyRead";
import { useEffect, useMemo, useState } from "react";

import { readHistoryNotice, type HistoryNotice } from "./historyNotice";
import { AskBox } from "./AskBox";
import { botsApi, type BotsApi } from "./botsApi";
import { MainChat } from "./MainChat";
import { isWorking, useMainChat } from "./useMainChat";

export function HomeAskBox({ api = botsApi, tcw, onReconnect }: { api?: BotsApi; tcw?: TinyCloudWeb; onReconnect?: () => void }) {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api.getBotsStatus(controller.signal).then(
      ({ enabled: on }) => { if (!controller.signal.aborted) setEnabled(on); },
      () => {},
    );
    return () => controller.abort();
  }, [api]);
  return enabled ? <MainAsk api={api} tcw={tcw} onReconnect={onReconnect} /> : null;
}

function MainAsk({ api, tcw, onReconnect }: { api: BotsApi; tcw?: TinyCloudWeb; onReconnect?: () => void }) {
  const client = useMemo(() => !tcw ? api : { ...api, listMainMessages: async (signal?: AbortSignal) => {
    const local = await api.listMainMessages(signal);
    if (!(await botHistoryEnabled())) return local;
    const archived = await readBotHistory(tcw, signal);
    return [...new Map([...archived, ...local].map(message => [message.id, message])).values()];
  } }, [api, tcw]);
  const chat = useMainChat(client, tcw ? () => ensureBotHistoryGrant(tcw) : undefined);
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
