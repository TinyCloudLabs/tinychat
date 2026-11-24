import { expect, spyOn, test } from "bun:test";
import { COURIER_READS_PER_DAY, MeetingDesk, READ_ERRORS } from "../meeting-reads";
import { botIdFor } from "../owner";

const owner = `did:pkh:eip155:1:0x${"ab".repeat(20)}`;
const botId = botIdFor(owner);
const tool = "tinycloud_find_meetings";
const conversation = "0".repeat(32);

test("Courier refusals at their own forwarding cap leave Main's refusal reports forwarded", async () => {
  const bodies: Record<string, unknown>[] = [];
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const desk = new MeetingDesk({
      backendOrigin: "https://backend.invalid", backendCallSecret: "t".repeat(64), forwardRefusals: true,
      async fetch(_url, init) {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 204 });
      },
    });
    const courier = { peer: "peer.example", setting: { owner, conversation, areas: [] } };
    for (let i = 0; i < COURIER_READS_PER_DAY + 3; i++) {
      expect((await desk.call(botId, tool, {}, courier)).content[0]?.text).toBe(READ_ERRORS.off);
    }
    expect(bodies).toHaveLength(COURIER_READS_PER_DAY);
    expect(bodies.every(body => body.source === "courier")).toBe(true);
    expect(log.mock.calls.filter(([entry]) => entry === '{"gateway":"courier","outcome":"audit_forward_capped"}')).toHaveLength(1);

    desk.push(botId, { owner, conversation, areas: [] });
    expect((await desk.call(botId, tool, {})).content[0]?.text).toBe(READ_ERRORS.off);
    expect(bodies).toHaveLength(COURIER_READS_PER_DAY + 1);
    expect(bodies.at(-1)).toEqual({ owner, area: "meetings", tool, outcome: "off" });
  } finally {
    log.mockRestore();
  }
});
