import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTION_ERRORS, actionBinding, actionHash, type ActionsPush } from "../actions";
import { ActionDesk, fileActionLedgerStore } from "../actions-desk";
import { utcDay } from "../asks";
import { FEEDBACK_ORIGIN, gatewayConfig } from "../config";
import { FEEDBACK_ERRORS, feedbackBody, postFeedback } from "../feedback";

const REPORT_ID = "01HZY3J5Q8V6K9W2X4N7M0P1RS";
const REPORT = {
  type: "friction",
  title: "Settings page is slow",
  tried: "I opened the settings page.",
  happened: "It took a long time to show.",
  expected: "The page to show at once.",
};
const BODY = feedbackBody({ kind: "friction", title: REPORT.title, tried: REPORT.tried, happened: REPORT.happened, expected: REPORT.expected });

/** The feedback service on loopback: records each body and answers with `reply`. */
function feedbackMock() {
  const posted: string[] = [];
  const state = { reply: async (): Promise<Response> => Response.json({ id: REPORT_ID, attach_token: "attach-secret-token" }, { status: 201 }) };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      posted.push(await req.text());
      return state.reply();
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, posted, state, stop: () => server.stop(true) };
}

let mock: ReturnType<typeof feedbackMock>;
let root: string;
let spy: { mockRestore(): void };
beforeEach(() => {
  spy = spyOn(console, "log").mockImplementation(() => {});
  mock = feedbackMock();
  root = mkdtempSync(join(tmpdir(), "feedback-desk-"));
});
afterEach(() => {
  mock.stop();
  rmSync(root, { recursive: true, force: true });
  spy.mockRestore();
});

const bot = (n: number) => n.toString(16).padStart(64, "0");

/** A desk where each bot is its own owner, with a clock the test moves. */
function desk(options: { held?: () => boolean; store?: boolean } = {}) {
  const clock = { now: Date.parse("2026-03-02T09:00:00Z") };
  const store = options.store ? fileActionLedgerStore(join(root, "actions.json")) : undefined;
  const make = () => new ActionDesk(() => clock.now, botId => `owner-${botId}`, () => false, store, options.held ?? (() => false), mock.url);
  const state = { desk: make() };
  /** The supervisor's push at the start of a turn the owner wrote, with no proposal open. */
  const ownerTurn = (botId: string, push: Partial<ActionsPush> = {}) =>
    state.desk.push(botId, { keys: [], ownerTurn: true, pending: 0, feedback: 0, day: utcDay(clock.now), today: 0, final: [], ...push });
  const propose = (botId: string, report: Record<string, unknown> = REPORT) => {
    const result = state.desk.call(botId, { kind: "send_feedback", report });
    return { text: result.content[0]!.text, isError: "isError" in result };
  };
  /** Proposes in an owner turn and collects the proposal as the supervisor would. */
  const proposed = (botId: string) => {
    ownerTurn(botId);
    expect(propose(botId).isError).toBe(false);
    const [action] = state.desk.drain(botId);
    return action!;
  };
  return { clock, state, ownerTurn, propose, proposed, reload: () => { state.desk = make(); } };
}

describe("feedback proposals at the gateway", () => {
  test("only a push for a turn the owner wrote allows a report", () => {
    const { state, ownerTurn, propose } = desk();
    expect(propose(bot(1))).toEqual({ text: FEEDBACK_ERRORS.ownerTurn, isError: true });
    ownerTurn(bot(1), { ownerTurn: false });
    expect(propose(bot(1))).toEqual({ text: FEEDBACK_ERRORS.ownerTurn, isError: true });
    // A push without keys (a collection mid-turn) leaves the turn as it was; the push at the turn's end clears it.
    ownerTurn(bot(1));
    state.desk.push(bot(1), { pending: 0, day: "2026-03-02", today: 0, final: [] });
    expect(propose(bot(1)).isError).toBe(false);
    state.desk.push(bot(1), { keys: [], pending: 1, feedback: 1, day: "2026-03-02", today: 1, final: [] });
    expect(propose(bot(1))).toEqual({ text: FEEDBACK_ERRORS.ownerTurn, isError: true });
  });

  test("a held chat cannot propose a report or send one", async () => {
    const held = { on: false };
    const { state, proposed, ownerTurn, propose } = desk({ held: () => held.on });
    const action = proposed(bot(1));
    held.on = true;
    ownerTurn(bot(2));
    expect(propose(bot(2))).toEqual({ text: FEEDBACK_ERRORS.held, isError: true });
    expect(await state.desk.send(bot(1), action.id, action.binding, action.text)).toEqual({ outcome: "refused" });
    expect(mock.posted).toEqual([]);
  });

  test("a security report is refused", () => {
    const { ownerTurn, propose } = desk();
    ownerTurn(bot(1));
    expect(propose(bot(1), { ...REPORT, type: "security" })).toEqual({ text: FEEDBACK_ERRORS.security, isError: true });
  });

  test("a report the owner has decided on cannot be proposed a second time", () => {
    const { ownerTurn, propose } = desk();
    ownerTurn(bot(1), { final: [actionHash({ kind: "send_feedback", targets: [], text: BODY })] });
    expect(propose(bot(1))).toEqual({ text: FEEDBACK_ERRORS.final, isError: true });
  });

  test("an edited ledger or body is refused at send and nothing is posted", async () => {
    const { state, proposed, reload } = desk({ store: true });
    const action = proposed(bot(1));
    expect(action.text).toBe(BODY);
    const leaked = feedbackBody({ kind: "friction", title: REPORT.title, tried: REPORT.tried, happened: "Mail owner@example.com", expected: REPORT.expected });
    const leakedBinding = actionBinding(`owner-${bot(1)}`, bot(1), { kind: "send_feedback", targets: [], text: leaked });
    // The ledger on the gateway's volume is edited to issue the leaked body's binding.
    const file = join(root, "actions.json");
    const ledger = JSON.parse(readFileSync(file, "utf8")) as Record<string, { binding: string }>;
    ledger[action.id]!.binding = leakedBinding;
    writeFileSync(file, JSON.stringify(ledger));
    reload();
    expect(await state.desk.send(bot(1), action.id, leakedBinding, leaked)).toEqual({ outcome: "refused" });
    // A body over 8 KB under its own binding is refused the same way.
    const big = BODY.replace(REPORT.title, "x".repeat(9000));
    expect(await state.desk.send(bot(1), action.id, actionBinding(`owner-${bot(1)}`, bot(1), { kind: "send_feedback", targets: [], text: big }), big)).toEqual({ outcome: "refused" });
    // The body the owner saw differs from what the edited ledger issued, so it is not spent either.
    expect(await state.desk.send(bot(1), action.id, action.binding, action.text)).toEqual({ outcome: "refused" });
    expect(mock.posted).toEqual([]);
  });

  test("a message to bots approval cannot be sent as a report", async () => {
    const { state, ownerTurn } = desk();
    ownerTurn(bot(1), { keys: ["c".repeat(32), "d".repeat(32)] });
    expect(state.desk.call(bot(1), { kind: "message_bots", targets: ["c".repeat(32), "d".repeat(32)], text: REPORT.title })).not.toHaveProperty("isError");
    const [action] = state.desk.drain(bot(1));
    expect(await state.desk.send(bot(1), action!.id, action!.binding, action!.text)).toEqual({ outcome: "refused" });
    expect(mock.posted).toEqual([]);
  });

  test("per owner: one report per 10 minutes and three per UTC day", () => {
    const { clock, state, ownerTurn, propose } = desk();
    for (let n = 0; n < 3; n++) {
      ownerTurn(bot(1));
      expect(propose(bot(1), { ...REPORT, title: `Report ${n}` }).isError).toBe(false);
      // Before collection and after it, while the owner has not decided, a second report is refused as one more open proposal.
      expect(propose(bot(1), { ...REPORT, title: `Early ${n}` })).toEqual({ text: ACTION_ERRORS.pending, isError: true });
      state.desk.drain(bot(1));
      ownerTurn(bot(1), { pending: 1, feedback: 1 });
      expect(propose(bot(1), { ...REPORT, title: `Open ${n}` })).toEqual({ text: ACTION_ERRORS.pending, isError: true });
      // The owner declines it: the supervisor's next push counts no open report.
      ownerTurn(bot(1));
      expect(propose(bot(1), { ...REPORT, title: `Gap ${n}` })).toEqual({ text: FEEDBACK_ERRORS.gap, isError: true });
      clock.now += 11 * 60_000;
    }
    ownerTurn(bot(1));
    expect(propose(bot(1), { ...REPORT, title: "Fourth" })).toEqual({ text: FEEDBACK_ERRORS.daily, isError: true });
    // Another owner is not held back.
    ownerTurn(bot(2));
    expect(propose(bot(2)).isError).toBe(false);
    // The next UTC day allows a report.
    clock.now = Date.parse("2026-03-03T00:30:00Z");
    ownerTurn(bot(1));
    expect(propose(bot(1), { ...REPORT, title: "Next day" }).isError).toBe(false);
  });

  test("across all bots at most five reports are posted a minute", async () => {
    const { state, proposed } = desk();
    const outcomes = [];
    for (let n = 1; n <= 6; n++) {
      const action = proposed(bot(n));
      outcomes.push((await state.desk.send(bot(n), action.id, action.binding, action.text)).outcome);
    }
    expect(outcomes).toEqual(["filed", "filed", "filed", "filed", "filed", "busy"]);
    expect(mock.posted).toHaveLength(5);
  });
});

describe("the feedback POST", () => {
  test("keeps only a report id of the ULID form and drops the attach token", async () => {
    expect(await postFeedback(mock.url, BODY)).toEqual({ outcome: "filed", status: 201, reportId: REPORT_ID });
    mock.state.reply = async () => Response.json({ id: "not-a-ulid", attach_token: "attach-secret-token" }, { status: 201 });
    expect(await postFeedback(mock.url, BODY)).toEqual({ outcome: "filed", status: 201 });
    // A reply over 4 KB is read only in part: the report counts as filed without an id.
    mock.state.reply = async () => Response.json({ pad: "x".repeat(8000), id: REPORT_ID }, { status: 201 });
    expect(await postFeedback(mock.url, BODY)).toEqual({ outcome: "filed", status: 201 });
  });

  test("maps the service's answers to outcomes", async () => {
    const cases: Array<[Response, unknown]> = [
      [new Response("slow down", { status: 429 }), { outcome: "rate_limited", status: 429 }],
      [new Response("busy", { status: 503 }), { outcome: "busy", status: 503 }],
      [Response.json({ error: { code: "title_too_long" } }, { status: 400 }), { outcome: "rejected", status: 400, code: "title_too_long" }],
      [Response.json({ error: { code: "Bad Code!" } }, { status: 422 }), { outcome: "rejected", status: 422 }],
      [new Response("oops", { status: 500 }), { outcome: "unknown", status: 500 }],
    ];
    for (const [reply, outcome] of cases) {
      mock.state.reply = async () => reply;
      expect(await postFeedback(mock.url, BODY)).toEqual(outcome as never);
    }
  });

  test("never follows a redirect", async () => {
    const target = feedbackMock();
    try {
      mock.state.reply = async () => new Response(null, { status: 307, headers: { location: `${target.url}/reports` } });
      expect(await postFeedback(mock.url, BODY)).toEqual({ outcome: "unknown" });
      expect(target.posted).toEqual([]);
    } finally {
      target.stop();
    }
  });

  test("a closed port or a reply past the deadline is unknown", async () => {
    const closed = feedbackMock();
    closed.stop();
    expect(await postFeedback(closed.url, BODY)).toEqual({ outcome: "unknown" });
    // The service answers only after the client's 50 ms deadline has passed.
    const hold = Promise.withResolvers<void>();
    mock.state.reply = async () => {
      await hold.promise;
      return Response.json({ id: REPORT_ID }, { status: 201 });
    };
    expect(await postFeedback(mock.url, BODY, 50)).toEqual({ outcome: "unknown" });
    hold.resolve();
  });
});

describe("where reports go", () => {
  test("the pinned origin unless a loopback mock is named", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(gatewayConfig({ REDPILL_API_KEY: "test-only" }).feedbackUrl).toBe(FEEDBACK_ORIGIN);
      expect(FEEDBACK_ORIGIN).toBe("https://feedback.tinycloud.xyz");
      expect(gatewayConfig({ REDPILL_API_KEY: "test-only", BOTS_TEST_FEEDBACK_URL: "http://127.0.0.1:4555/reports" }).feedbackUrl).toBe("http://127.0.0.1:4555");
      expect(() => gatewayConfig({ REDPILL_API_KEY: "test-only", BOTS_TEST_FEEDBACK_URL: "https://feedback.example.com" })).toThrow("loopback");
      expect(() => gatewayConfig({ REDPILL_API_KEY: "test-only", BOTS_TEST_FEEDBACK_URL: "http://10.1.2.3:8080" })).toThrow("loopback");
    } finally {
      warn.mockRestore();
    }
  });
});
