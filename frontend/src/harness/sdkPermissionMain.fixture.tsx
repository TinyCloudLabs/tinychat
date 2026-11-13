// Offline TC-2835 fixture: real MainChat and SDK permission UI, synthetic owner/grant transport only.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TinyCloudWeb } from "@tinycloud/web-sdk";
import { MainChat } from "../bots/MainChat";
import { initSizeClass } from "../lib/sizeClass";

const owner = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
// Client initialization is unrelated to this DOM interoperability check; no node, wallet or signing traffic.
const prototype = TinyCloudWeb.prototype as unknown as { _init(): Promise<void> };
const initialize = prototype._init;
prototype._init = async () => {};
const client = new TinyCloudWeb({ ui: { button: false }, persistSession: false,
  manifest: { manifest_version: 1, app_id: "xyz.tinycloud.tinychat", name: "TinyCloud Home", defaults: false, permissions: [] } });
prototype._init = initialize;
Object.assign(client, { _node: { did: owner }, _testHooks: { hasRuntimePermissions: () => false, grantPermissions: async () => [] } });

Object.assign(window, { tc2835: { result: null as boolean | null, request: async () => {
  const result = await client.requestPermissions([{ service: "tinycloud.encryption", path: `urn:tinycloud:encryption:${owner}:default`, actions: ["network.create", "decrypt"], skipPrefix: true }]);
  (window as unknown as { tc2835: { result: boolean | null } }).tc2835.result = result.approved;
} } });
initSizeClass();
function Fixture() {
  const [open, setOpen] = useState(true);
  return <><button id="outside" onClick={() => setOpen(true)}>Outside</button><MainChat open={open} onOpenChange={setOpen}
    state={{ lines: [], history: "loaded", turn: null }} onSend={() => {}} onRetry={() => {}} onRetryHistory={() => {}} /></>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
