// Offline history interaction with the chat hook and SDK permission UI.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TinyCloudWeb } from "@tinycloud/web-sdk";
import { MainChat } from "../bots/MainChat";
import { useMainChat } from "../bots/useMainChat";
import { botHistoryOwnerPermissions } from "../bots/historyAuthorization";
import { initSizeClass } from "../lib/sizeClass";
import { botsApi, type BotsApi } from "../bots/botsApi";
const owner = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
// Client initialization is unrelated to this DOM interoperability check; no node, wallet or signing traffic.
const prototype = TinyCloudWeb.prototype as unknown as { _init(): Promise<void> };
const initialize = prototype._init;
prototype._init = async () => {};
const client = new TinyCloudWeb({ ui: { button: false }, persistSession: false,
  manifest: { manifest_version: 1, app_id: "xyz.tinycloud.tinychat", name: "TinyCloud One", defaults: false, permissions: [] } });
prototype._init = initialize;
Object.assign(client, { _node: { did: owner }, _testHooks: { hasRuntimePermissions: () => false, grantPermissions: async () => [] } });


const probe = { asks: 0, sends: 0 };
Object.assign(window, { tc3583: probe });
const api: BotsApi = {
  ...botsApi,
  getBotsStatus: async () => ({ enabled: true }),
  listMainMessages: async () => {
    probe.asks++;
    const result = await client.requestPermissions(botHistoryOwnerPermissions("0x1111111111111111111111111111111111111111"));
    if (!result.approved) throw new Error("history_approval_declined");
    return [];
  },
  sendToMain: async (_text, event) => { probe.sends++; event({ type: "delta", text: "Current answer" }); event({ type: "done", messageId: `reply-${probe.sends}` }); },
};
initSizeClass();
function Fixture() {
  const [open, setOpen] = useState(true);
  const chat = useMainChat(api, undefined, undefined, true);
  return <><button id="outside" onClick={() => { setOpen(true); void chat.ensureHistory(); }}>Open chat</button><MainChat open={open} onOpenChange={setOpen}
    state={chat.state} onSend={text => void chat.send(text)} onRetry={chat.retry} onRetryHistory={() => void chat.loadHistory()} onShowHistory={() => void chat.requestHistory()} /></>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
