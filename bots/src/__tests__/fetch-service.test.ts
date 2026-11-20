import { describe, expect, test } from "bun:test";
import net from "node:net";
import { blockedAddress, type Conn, type GuardDeps, LIMITS } from "../fetch-guard";
import { connectTo, networkDeps } from "../fetch-net";
import { fetchService, MAX_REPLY_CHARS } from "../fetch-service";

const enc = new TextEncoder();
const PUBLIC = "93.184.216.34";

function scripted(responses: Record<string, string[]>, hold?: Promise<void>): GuardDeps & { dialled: string[] } {
  const dialled: string[] = [];
  return {
    dialled,
    lookup: async host => (host.startsWith("inside.") ? ["10.0.0.7"] : [PUBLIC]),
    connect: async (_ip, _port, _secure, servername) => {
      dialled.push(servername);
      const queue = responses[servername];
      if (!queue) throw new Error("refused");
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      const conn: Conn = {
        write: () => {},
        destroy: () => {},
        read: () => ({
          async *[Symbol.asyncIterator]() {
            await hold;
            yield enc.encode(next);
          },
        }),
      };
      return conn;
    },
  };
}

const html = (body: string, type = "text/html") => `HTTP/1.1 200 OK\r\ncontent-type: ${type}\r\ncontent-length: ${enc.encode(body).length}\r\n\r\n${body}`;
const moved = (to: string) => `HTTP/1.1 302 Found\r\nlocation: ${to}\r\ncontent-length: 0\r\n\r\n`;
const ask = (service: (req: Request) => Promise<Response>, body: unknown, init: RequestInit = {}) =>
  service(new Request("http://bots-fetch:8080/fetch", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), ...init }));

describe("the fetch process's route", () => {
  test("reads a page and returns only plain text and the address it ended on", async () => {
    const deps = scripted({ "docs.example.com": [html('<h1>Guide</h1><p>Hello <img src="https://evil.test/?q=1" alt="chart"> <a href="/next">next</a></p><script>x()</script>')] });
    const response = await ask(fetchService({ guard: deps }), { url: "https://docs.example.com/guide", hosts: null });
    expect(await response.json()).toEqual({ ok: true, url: "https://docs.example.com/guide", text: "Guide\n\nHello chart next (https://docs.example.com/next)" });
  });

  test("text/plain pages and charsets are read; a PDF is not", async () => {
    const plain = await ask(fetchService({ guard: scripted({ "a.example.com": [html("plain & <simple>", "text/plain")] }) }), { url: "https://a.example.com/", hosts: null });
    expect(await plain.json()).toMatchObject({ ok: true, text: "plain & <simple>" });
    const pdf = await ask(fetchService({ guard: scripted({ "a.example.com": [html("%PDF-1.7", "application/pdf")] }) }), { url: "https://a.example.com/", hosts: null });
    expect(await pdf.json()).toEqual({ ok: false, reason: "type" });
  });

  test("the owner's list is applied to a redirect, and an internal address behind a name is refused", async () => {
    const off = scripted({ "docs.example.com": [moved("https://other.example.net/")], "other.example.net": [html("hi")] });
    expect(await (await ask(fetchService({ guard: off }), { url: "https://docs.example.com/", hosts: ["docs.example.com"] })).json()).toEqual({ ok: false, reason: "site" });
    expect(off.dialled).toEqual(["docs.example.com"]);
    const inside = scripted({ "docs.example.com": [moved("https://inside.example.com/")], "inside.example.com": [html("secret")] });
    expect(await (await ask(fetchService({ guard: inside }), { url: "https://docs.example.com/", hosts: null })).json()).toEqual({ ok: false, reason: "blocked" });
    expect(inside.dialled).toEqual(["docs.example.com"]);
  });

  test("a list covers subdomains as the owner's rule does, and nothing that only ends with the same letters", async () => {
    const deps = scripted({ "docs.example.com": [html("ok")], "badexample.com": [html("no")] });
    const service = fetchService({ guard: deps });
    expect((await (await ask(service, { url: "https://docs.example.com/", hosts: ["example.com"] })).json() as { ok: boolean }).ok).toBe(true);
    expect(await (await ask(service, { url: "https://badexample.com/", hosts: ["example.com"] })).json()).toEqual({ ok: false, reason: "site" });
  });

  test("text handed back is cut", async () => {
    const response = await ask(fetchService({ guard: scripted({ "a.example.com": [html(`<p>${"word ".repeat(60_000)}</p>`)] }), limits: { ...LIMITS, maxBodyBytes: 2 * 1024 * 1024 } }), { url: "https://a.example.com/", hosts: null });
    const reply = (await response.json()) as { text: string };
    expect(reply.text.length).toBe(MAX_REPLY_CHARS);
  });

  test("a malformed request is refused before any lookup", async () => {
    const deps = scripted({ "a.example.com": [html("ok")] });
    const service = fetchService({ guard: deps });
    const tooMany = Array.from({ length: 51 }, (_, i) => `site${i}.example.com`);
    for (const body of ["not json", "[]", "null", { hosts: null }, { url: 5, hosts: null }, { url: "https://a.example.com/" }, { url: "https://a.example.com/", hosts: "example.com" },
      { url: "https://a.example.com/", hosts: [5] }, { url: "https://a.example.com/", hosts: ["github.io"] }, { url: "https://a.example.com/", hosts: ["not a host"] }, { url: "https://a.example.com/", hosts: tooMany }]) {
      expect((await ask(service, body)).status).toBe(400);
    }
    expect((await ask(service, "x".repeat(20_000))).status).toBe(400);
    expect(deps.dialled).toEqual([]);
  });

  test("only POST /fetch exists", async () => {
    const service = fetchService({ guard: scripted({}) });
    expect((await service(new Request("http://bots-fetch:8080/fetch"))).status).toBe(405);
    expect((await service(new Request("http://bots-fetch:8080/other", { method: "POST", body: "{}" }))).status).toBe(404);
  });

  test("a request over the in-flight limit is refused, not queued", async () => {
    const release = Promise.withResolvers<void>();
    const service = fetchService({ guard: scripted({ "a.example.com": [html("ok")] }, release.promise), maxInFlight: 1 });
    const first = ask(service, { url: "https://a.example.com/", hosts: null });
    const second = await ask(service, { url: "https://a.example.com/", hosts: null });
    expect(second.status).toBe(503);
    release.resolve();
    expect(((await (await first).json()) as { ok: boolean }).ok).toBe(true);
    expect((await ask(service, { url: "https://a.example.com/", hosts: null })).status).toBe(200);
  });
});

describe("the real network pieces", () => {
  test("a socket carries a request out and the response back, and can be dropped", async () => {
    const seen: string[] = [];
    const server = net.createServer(socket => {
      socket.on("data", chunk => {
        seen.push(chunk.toString());
        socket.write("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nhi");
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as net.AddressInfo).port;
      const conn = await connectTo("127.0.0.1", port, false, "example.com");
      conn.write("GET / HTTP/1.1\r\n\r\n");
      let got = "";
      for await (const chunk of conn.read()) {
        got += new TextDecoder().decode(chunk);
        if (got.endsWith("hi")) break;
      }
      conn.destroy();
      expect(got).toBe("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nhi");
      expect(seen).toEqual(["GET / HTTP/1.1\r\n\r\n"]);
    } finally {
      server.close();
    }
  });

  test("a refused connection rejects instead of hanging", async () => {
    const probe = net.createServer();
    await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    await expect(connectTo("127.0.0.1", port, false, "example.com")).rejects.toBeDefined();
  });

  test("the real resolver's answers for localhost are all refused by the guard", async () => {
    const answers = await networkDeps.lookup("localhost");
    expect(answers.length).toBeGreaterThan(0);
    expect(answers.every(blockedAddress)).toBe(true);
  });
});
