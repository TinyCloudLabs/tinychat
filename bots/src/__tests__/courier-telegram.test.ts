import { expect, test } from "bun:test";
import { replyText } from "../courier/guard";
import { courierTurn, COURIER_READ_OFF } from "../courier/turn";
import { MeetingDesk } from "../meeting-reads";

const owner = `did:pkh:eip155:1:0x${"ab".repeat(20)}`;
const call = (name: string, args = {}) => ({ id: name, type: "function", function: { name, arguments: JSON.stringify(args) } });

function setup(areas: Array<"telegram" | "feed_chats">, steps: Array<Record<string, unknown>>) {
  const inputs: Array<Record<string, unknown>> = [];
  const reads: string[] = [];
  const desk = new MeetingDesk({ backendOrigin: "https://backend.test", backendCallSecret: "s".repeat(48), fetch: async url => {
    reads.push(url);
    return Response.json({ ok: true, text: JSON.stringify({ chat: "a:1", title: "Project", messages: [{ id: "1", sender: "Ada", time: 1, text: "Release moved to Friday.", truncated: false }], before: null }) });
  } });
  const run = () => courierTurn({ owner, handle: "cli", peerDid: "did:key:cli", threadId: "thread", text: "What's new?", reads: desk, deniedChatIds: async () => new Set(["a:private"]), enabledReadAreas: async () => areas,
    model: async input => { inputs.push(structuredClone(input)); return steps.shift()!; } });
  return { run, inputs, reads };
}

test("Telegram tools reach a Courier turn only when the owner has Telegram on", async () => {
  const on = setup(["telegram"], [{ content: null, tool_calls: [call("read_telegram_chat", { chat: "a:1" })] }, { content: "The release moved." }]);
  expect(replyText(await on.run())).toBe("The release moved.");
  expect((on.inputs[0]!.tools as Array<{ function: { name: string } }>).map(t => t.function.name)).toEqual(["list_telegram_chats", "read_telegram_chat"]);
  expect(on.reads).toEqual(["https://backend.test/api/internal/bots/main/reads/read_telegram_chat"]);
  expect(JSON.stringify(on.inputs[1]!.messages)).toContain("Release moved to Friday.");

  const off = setup(["feed_chats"], [{ content: null, tool_calls: [call("read_telegram_chat", { chat: "a:1" })] }, { content: "No access." }]);
  await off.run();
  expect((off.inputs[0]!.tools as Array<{ function: { name: string } }>).map(t => t.function.name)).not.toContain("read_telegram_chat");
  expect(off.reads).toEqual([]);
  expect(JSON.stringify(off.inputs[1]!.messages)).toContain(COURIER_READ_OFF);
});

test("a denied Telegram chat is refused before any backend read", async () => {
  const s = setup(["telegram"], [{ content: null, tool_calls: [call("read_telegram_chat", { chat: "a:private" })] }, { content: "No access." }]);
  await s.run();
  expect(s.reads).toEqual([]);
  expect(JSON.stringify(s.inputs[1]!.messages)).toContain(COURIER_READ_OFF);
});
