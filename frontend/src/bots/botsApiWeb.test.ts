import { describe, expect, test } from "bun:test";

import { BotsError, createBotsApi } from "./botsApi";

const SETTINGS = { mode: "listed", hosts: ["docs.example.com"], available: true, today: { searches: 4, pages: 9, blocked: 1 } };

function apiReturning(response: Response | (() => Response), seen: { url: string; init: RequestInit }[] = [], token: string | null = "session-token") {
  return createBotsApi({
    baseUrl: "https://backend.test/",
    getToken: () => token,
    fetch: async (input, init) => {
      seen.push({ url: String(input), init: init ?? {} });
      return typeof response === "function" ? response() : response;
    },
  });
}

describe("main web access", () => {
  test("getMainWeb reads GET /api/bots/main/web with the session bearer and returns only the contract fields", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const settings = await apiReturning(Response.json({ ...SETTINGS, extra: "x" }), seen).getMainWeb();
    expect(settings).toEqual(SETTINGS);
    expect(seen[0]!.url).toBe("https://backend.test/api/bots/main/web");
    expect(seen[0]!.init.method).toBe("GET");
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer session-token");
  });

  test("setMainWeb sends PUT with only mode and hosts as JSON", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const settings = await apiReturning(Response.json({ ...SETTINGS, mode: "any" }), seen)
      .setMainWeb({ mode: "any", hosts: ["a.example.com"], available: false, today: SETTINGS.today } as never);
    expect(settings.mode).toBe("any");
    expect(seen[0]!.url).toBe("https://backend.test/api/bots/main/web");
    expect(seen[0]!.init.method).toBe("PUT");
    expect((seen[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ mode: "any", hosts: ["a.example.com"] });
  });

  test("an unknown response shape is a failed request", async () => {
    const shapes: unknown[] = [
      null, [], {}, { ...SETTINGS, mode: "sometimes" }, { ...SETTINGS, hosts: "docs.example.com" }, { ...SETTINGS, hosts: [1] },
      { ...SETTINGS, available: "yes" }, { ...SETTINGS, today: undefined }, { ...SETTINGS, today: { searches: "4", pages: 0, blocked: 0 } },
      { ...SETTINGS, today: { searches: -1, pages: 0, blocked: 0 } },
    ];
    for (const shape of shapes) {
      for (const call of [(api: ReturnType<typeof apiReturning>) => api.getMainWeb(), (api: ReturnType<typeof apiReturning>) => api.setMainWeb({ mode: "off", hosts: [] })]) {
        await expect(call(apiReturning(Response.json(shape)))).rejects.toMatchObject({ name: "BotsError", code: "failed" });
      }
    }
    await expect(apiReturning(new Response("not json")).getMainWeb()).rejects.toMatchObject({ code: "failed" });
  });

  test("maps 401, 400 and other failures to BotsError codes", async () => {
    await expect(apiReturning(new Response("", { status: 401 })).getMainWeb()).rejects.toMatchObject({ code: "signed_out" });
    await expect(apiReturning(new Response("", { status: 400 })).setMainWeb({ mode: "off", hosts: [] })).rejects.toMatchObject({ code: "invalid" });
    await expect(apiReturning(new Response("", { status: 502 })).getMainWeb()).rejects.toMatchObject({ code: "failed" });
    await expect(apiReturning(() => { throw new Error("offline"); }).getMainWeb()).rejects.toBeInstanceOf(BotsError);
  });

  test("without a session token nothing is sent", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    await expect(apiReturning(Response.json(SETTINGS), seen, null).getMainWeb()).rejects.toMatchObject({ code: "signed_out" });
    expect(seen).toHaveLength(0);
  });
});
