import { expect, mock, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { botChatApi, botRosterApi } from "./botChatApi";
import * as botHistoryAccess from "./botHistoryAccess";
import { saveChatView } from "./chatViewSetting";
import { ChatSlot } from "./ChatSlot";

test("the Bots view opens the session's archive when no history override is supplied", async () => {
  const restore = installDom();
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const account = "did:pkh:eip155:1:0x00000000000000000000000000000000000000a1";
  const tcw = {} as TinyCloudWeb;
  const enabled = mock(async () => true);
  const build = spyOn(botHistoryAccess, "historyAccessFor").mockReturnValue({
    enabled, authorize: async () => {}, grant: async () => {},
    read: async () => [{ id: "archive-1", role: "bot", text: "An archived message", at: "" }],
  });
  try {
    saveChatView(account, "classic");
    await act(async () => root.render(
      <MemoryRouter initialEntries={["/chat"]}>
        <ChatSlot account={account} tcw={tcw} active classic={<p>Classic chat</p>}
          api={{ getBotsStatus: async () => ({ enabled: true }), listMainMessages: async () => [], sendToMain: async () => {} }}
          chatApi={{ ...botChatApi, listConversation: async () => ({ messages: [], activity: [] }), readNotice: async () => null }}
          rosterApi={{ ...botRosterApi, list: async () => ({
            bots: [], deleted: [], capMode: "flat3", limits: null, canCreate: { private: false, regular: false },
          }) }} />
      </MemoryRouter>,
    ));
    expect(host.querySelector('[data-chat-view="bots"]')).toBeNull();
    expect(build).not.toHaveBeenCalled();

    await act(async () => { saveChatView(account, "bots"); await import("./BotsSurface"); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith(tcw);
    expect(enabled).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("An archived message");
  } finally {
    await act(async () => root.unmount());
    build.mockRestore();
    restore();
  }
});
