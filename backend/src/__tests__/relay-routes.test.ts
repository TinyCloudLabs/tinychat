import { afterEach, describe, expect, it } from "bun:test";
import { relayUpstream } from "../routes/relay.js";

const realFetch = globalThis.fetch;

/** Minimal Express-Response stand-in capturing status/type/body. */
function fakeRes() {
  const state: { statusCode: number; body: unknown; contentType: string | undefined } = {
    statusCode: 200,
    body: undefined,
    contentType: undefined,
  };
  const res = {
    state,
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(obj: unknown) {
      state.body = obj;
      return res;
    },
    type(t: string) {
      state.contentType = t;
      return res;
    },
    send(b: unknown) {
      state.body = b;
      return res;
    },
  };
  return res;
}

describe("relayUpstream (ST12a)", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("relays upstream status + content-type + body verbatim on success", async () => {
    globalThis.fetch = (async () =>
      new Response("upstream-bytes", {
        status: 201,
        headers: { "content-type": "application/jwt" },
      })) as typeof fetch;
    const res = fakeRes();
    await relayUpstream(res as never, "https://example.test", { method: "GET" }, "test");
    expect(res.state.statusCode).toBe(201);
    expect(res.state.body).toBe("upstream-bytes");
    expect(res.state.contentType).toContain("application/jwt");
  });

  it("returns 502 when the upstream never resolves (timeout abort, not a hang)", async () => {
    // Never resolve; only reject when the abort signal fires.
    globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (signal) {
          signal.addEventListener("abort", () =>
            reject(new DOMException("The operation timed out.", "TimeoutError")),
          );
        }
      })) as typeof fetch;
    const res = fakeRes();
    await relayUpstream(res as never, "https://example.test", { method: "GET" }, "test", 50);
    expect(res.state.statusCode).toBe(502);
    expect((res.state.body as { error: string }).error).toBe("upstream_error");
  });

  it("returns 502 when reading the upstream body rejects", async () => {
    globalThis.fetch = (async () =>
      ({
        status: 200,
        headers: new Headers({ "content-type": "text/plain" }),
        text: async () => {
          throw new Error("body stream aborted");
        },
      }) as Response) as typeof fetch;

    const res = fakeRes();
    await relayUpstream(res as never, "https://example.test", { method: "GET" }, "test");

    expect(res.state.statusCode).toBe(502);
    expect((res.state.body as { error: string }).error).toBe("upstream_error");
  });
});
