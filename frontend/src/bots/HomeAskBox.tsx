// The ask box on Home, for accounts the backend has turned tiny bots on for. Everyone else, and anyone
// whose status call fails, gets nothing: Home looks as it does today.
import { useEffect, useState } from "react";

import { AskBox } from "./AskBox";
import { botsApi, type BotsApi } from "./botsApi";
import { MainChat } from "./MainChat";
import { isWorking, useMainChat } from "./useMainChat";

export function HomeAskBox({ api = botsApi }: { api?: BotsApi }) {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api.getBotsStatus(controller.signal).then(
      ({ enabled: on }) => { if (!controller.signal.aborted) setEnabled(on); },
      () => {},
    );
    return () => controller.abort();
  }, [api]);
  return enabled ? <MainAsk api={api} /> : null;
}

function MainAsk({ api }: { api: BotsApi }) {
  const chat = useMainChat(api);
  const [open, setOpen] = useState(false);
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
      />
    </>
  );
}
