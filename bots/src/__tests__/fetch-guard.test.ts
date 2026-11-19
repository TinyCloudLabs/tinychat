import { describe, expect, test } from "bun:test";
import { blockedAddress, type Conn, fetchGuarded, type GuardDeps, type GuardLimits, LIMITS } from "../fetch-guard";

const enc = new TextEncoder();
const dec = new TextDecoder();

interface Served {
  /** The bytes the server sends, in order; a function is awaited between them (a pause, or never). */
  parts: Array<string | Uint8Array | (() => Promise<void>)>;
}

/** A connection whose far end is a script. It records what was written to it. */
function conn(served: Served, written: string[]): Conn {
  let destroyed = false;
  return {
    write: data => void written.push(data),
    destroy: () => void (destroyed = true),
    read: () => ({
      async *[Symbol.asyncIterator]() {
        for (const part of served.parts) {
          if (destroyed) return;
          if (typeof part === "function") await part();
          else yield typeof part === "string" ? enc.encode(part) : part;
        }
      },
    }),
  };
}

const response = (status: string, headers: Record<string, string>, body = "") =>
  `HTTP/1.1 ${status}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n${body}`;
const page = (body: string, type = "text/html; charset=utf-8") => response("200 OK", { "content-type": type, "content-length": String(enc.encode(body).length) }, body);
const redirect = (location: string, status = "302 Found") => response(status, { location, "content-length": "0" });

const PUBLIC = "93.184.216.34";

/** Deps over a table of name -> answers and url -> response; records every lookup and connect. */
function world(hosts: Record<string, string[]>, servers: Record<string, Served | Served[]>) {
  const lookups: string[] = [];
  const connects: Array<{ ip: string; port: number; secure: boolean; servername: string }> = [];
  const written: string[] = [];
  const seen = new Map<string, number>();
  const deps: GuardDeps = {
    lookup: async host => {
      lookups.push(host);
      const answers = hosts[host];
      if (!answers) throw new Error("NXDOMAIN");
      return answers;
    },
    connect: async (ip, port, secure, servername) => {
      connects.push({ ip, port, secure, servername });
      const entry = servers[servername];
      if (!entry) throw new Error("refused");
      const n = seen.get(servername) ?? 0;
      seen.set(servername, n + 1);
      const served = Array.isArray(entry) ? entry[Math.min(n, entry.length - 1)]! : entry;
      return conn(served, written);
    },
  };
  return { deps, lookups, connects, written };
}

const ok = (name: string, body = "<p>hello</p>"): Record<string, Served> => ({ [name]: { parts: [page(body)] } });
const limits = (over: Partial<GuardLimits> = {}): GuardLimits => ({ ...LIMITS, ...over });

describe("addresses that are never dialled", () => {
  const blocked = [
    "0.0.0.0", "0.255.255.255", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.255.254", "169.254.169.254",
    "169.254.0.1", "172.16.0.1", "172.31.255.255", "192.0.0.8", "192.0.2.1", "192.88.99.1", "192.168.0.1", "192.168.255.255", "198.18.0.1", "198.19.255.255",
    "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
    "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "fec0::1", "ff02::1", "::10.0.0.1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a00:1",
    "::ffff:169.254.169.254", "64:ff9b::7f00:1", "64:ff9b:1::1", "2002:7f00:1::", "2002:a00:1::1", "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:db8::1",
    "100::1", "fe80::1%eth0",
    "", "abc", "1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4x", "1::2::3", "[::1]", "999.0.0.1", "not an ip",
  ];
  test.each(blocked)("%p is refused", ip => {
    expect(blockedAddress(ip)).toBe(true);
  });

  const open = ["8.8.8.8", "93.184.216.34", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "198.17.255.255", "198.20.0.1", "223.255.255.254", "1.1.1.1",
    "2606:4700:10::6814:179a", "2a00:1450:4001:81b::200e", "::ffff:8.8.8.8", "::ffff:808:808", "2620:fe::fe"];
  test.each(open)("%p is a public address", ip => {
    expect(blockedAddress(ip)).toBe(false);
  });
});

describe("one fetch", () => {
  test("goes to the checked address with the original name for TLS, and sends nothing that identifies the reader", async () => {
    const { deps, connects, written, lookups } = world({ "docs.example.com": [PUBLIC] }, ok("docs.example.com"));
    const result = await fetchGuarded("https://docs.example.com/a?b=c#frag", null, deps);
    expect(result.ok && dec.decode(result.body)).toBe("<p>hello</p>");
    expect(result.ok && result.url.href).toBe("https://docs.example.com/a?b=c");
    expect(connects).toEqual([{ ip: PUBLIC, port: 443, secure: true, servername: "docs.example.com" }]);
    expect(lookups).toEqual(["docs.example.com"]);
    const request = written.join("");
    expect(request.startsWith("GET /a?b=c HTTP/1.1\r\nHost: docs.example.com\r\n")).toBe(true);
    expect(request.toLowerCase()).not.toMatch(/cookie|authorization|referer|x-forwarded|origin:/);
    expect(request).toContain("Accept-Encoding: identity");
    expect(request).toContain("User-Agent: TinyChatBot/");
    expect(request).not.toContain("#");
  });

  test("http uses port 80 and no TLS", async () => {
    const { deps, connects } = world({ "docs.example.com": [PUBLIC] }, ok("docs.example.com"));
    await fetchGuarded("http://docs.example.com/", null, deps);
    expect(connects[0]).toMatchObject({ port: 80, secure: false });
  });

  test("text/plain is read, with or without a charset; other types, encodings and statuses are not", async () => {
    const plain = world({ "a.example.com": [PUBLIC] }, { "a.example.com": { parts: [page("just text", "text/plain; charset=iso-8859-1")] } });
    expect((await fetchGuarded("https://a.example.com/", null, plain.deps)).ok).toBe(true);
    for (const [served, reason] of [
      [response("200 OK", { "content-type": "image/png", "content-length": "1" }, "x"), "type"],
      [response("200 OK", { "content-type": "application/pdf", "content-length": "1" }, "x"), "type"],
      [response("200 OK", { "content-length": "1" }, "x"), "type"],
      [response("200 OK", { "content-type": "text/html", "content-encoding": "gzip", "content-length": "1" }, "x"), "type"],
      [response("404 Not Found", { "content-type": "text/html", "content-length": "1" }, "x"), "status"],
      [response("500 Oops", {}, ""), "status"],
      ["garbage\r\n\r\n", "protocol"],
      ["HTTP/1.1 200 OK\r\nno colon here\r\n\r\n", "protocol"],
      [response("200 OK", { "content-type": "text/html", "transfer-encoding": "gzip" }), "protocol"],
      [response("200 OK", { "content-type": "text/html", "content-length": "12abc" }), "protocol"],
    ] as const) {
      const w = world({ "a.example.com": [PUBLIC] }, { "a.example.com": { parts: [served] } });
      expect(await fetchGuarded("https://a.example.com/", null, w.deps)).toEqual({ ok: false, reason });
    }
  });

  test("refuses an address that is not readable, before any lookup", async () => {
    const { deps, lookups } = world({}, {});
    for (const raw of ["http://127.0.0.1/", "https://[::1]/", "http://2130706433/", "https://localhost/", "https://a.example.com:8443/", "ftp://a.example.com/", "https://u:p@a.example.com/", "nope", ""]) {
      expect(await fetchGuarded(raw, null, deps)).toEqual({ ok: false, reason: "address" });
    }
    expect(lookups).toEqual([]);
  });

  test("a site outside the owner's list is refused before any lookup", async () => {
    const { deps, lookups } = world({ "evil.example.net": [PUBLIC] }, ok("evil.example.net"));
    expect(await fetchGuarded("https://evil.example.net/", host => host.endsWith("example.com"), deps)).toEqual({ ok: false, reason: "site" });
    expect(lookups).toEqual([]);
  });
});

describe("names that resolve to somewhere internal", () => {
  const internal = ["127.0.0.1", "10.1.2.3", "100.100.100.100", "169.254.169.254", "172.17.0.2", "192.168.1.1", "0.0.0.0", "224.0.0.1", "::1", "fd00::2", "fe80::1", "::ffff:10.0.0.1", "64:ff9b::a00:1"];
  test.each(internal)("a name that resolves to %p is never connected to", async ip => {
    const { deps, connects } = world({ "a.example.com": [ip] }, ok("a.example.com"));
    expect(await fetchGuarded("https://a.example.com/", null, deps)).toEqual({ ok: false, reason: "blocked" });
    expect(connects).toEqual([]);
  });

  test("one internal answer among public ones refuses the name, whatever the order", async () => {
    for (const answers of [[PUBLIC, "10.0.0.5"], ["10.0.0.5", PUBLIC], [PUBLIC, "fd00::1"]]) {
      const { deps, connects } = world({ "a.example.com": answers }, ok("a.example.com"));
      expect(await fetchGuarded("https://a.example.com/", null, deps)).toEqual({ ok: false, reason: "blocked" });
      expect(connects).toEqual([]);
    }
  });

  test("a name that does not resolve is a network failure, not a crash", async () => {
    const { deps } = world({}, {});
    expect(await fetchGuarded("https://nowhere.example.com/", null, deps)).toEqual({ ok: false, reason: "network" });
    const empty = world({ "a.example.com": [] }, {});
    expect(await fetchGuarded("https://a.example.com/", null, empty.deps)).toEqual({ ok: false, reason: "network" });
  });

  test("a resolver that changes its answer after the check cannot redirect the connection: one lookup, one connect, to the checked address", async () => {
    let answers = [PUBLIC];
    const connects: string[] = [];
    let lookups = 0;
    const deps: GuardDeps = {
      lookup: async () => {
        lookups++;
        const now = answers;
        answers = ["169.254.169.254"]; // what the resolver answers the next time it is asked
        return now;
      },
      connect: async ip => {
        connects.push(ip);
        return conn({ parts: [page("ok")] }, []);
      },
    };
    expect((await fetchGuarded("https://rebind.example.com/", null, deps)).ok).toBe(true);
    expect(lookups).toBe(1);
    expect(connects).toEqual([PUBLIC]);
  });
});

describe("redirects", () => {
  test("a redirect is followed, with the name looked up and checked again", async () => {
    const w = world({ "a.example.com": [PUBLIC], "b.example.com": ["93.184.216.35"] }, { "a.example.com": { parts: [redirect("https://b.example.com/next#x")] }, ...ok("b.example.com", "there") });
    const result = await fetchGuarded("https://a.example.com/", null, w.deps);
    expect(result.ok && dec.decode(result.body)).toBe("there");
    expect(result.ok && result.url.href).toBe("https://b.example.com/next");
    expect(w.lookups).toEqual(["a.example.com", "b.example.com"]);
    expect(w.connects.map(c => c.ip)).toEqual([PUBLIC, "93.184.216.35"]);
  });

  test("a relative Location resolves against the current address", async () => {
    const w = world({ "a.example.com": [PUBLIC] }, { "a.example.com": [{ parts: [redirect("/moved?x=1", "301 Moved Permanently")] }, { parts: [page("moved")] }] });
    const result = await fetchGuarded("https://a.example.com/old", null, w.deps);
    expect(result.ok && result.url.href).toBe("https://a.example.com/moved?x=1");
  });

  test("a redirect to a name that resolves to an internal address is refused, and never connected to", async () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.0.10", "100.64.1.1", "::1", "fd00::1"]) {
      const w = world({ "a.example.com": [PUBLIC], "inside.example.com": [ip] }, { "a.example.com": { parts: [redirect("https://inside.example.com/")] }, ...ok("inside.example.com") });
      expect(await fetchGuarded("https://a.example.com/", null, w.deps)).toEqual({ ok: false, reason: "blocked" });
      expect(w.connects.map(c => c.servername)).toEqual(["a.example.com"]);
    }
  });

  test("a redirect to an address that is not readable is refused: IPs, other schemes, other ports, user info", async () => {
    for (const location of ["http://169.254.169.254/latest/meta-data", "http://127.0.0.1:80/", "http://[::1]/", "http://2130706433/", "file:///etc/passwd", "ftp://a.example.com/",
      "javascript:alert(1)", "https://a.example.com:8443/", "https://u:p@a.example.com/", "https://localhost/", "https://intranet/"]) {
      const w = world({ "a.example.com": [PUBLIC] }, { "a.example.com": { parts: [redirect(location)] } });
      expect(await fetchGuarded("https://a.example.com/", null, w.deps)).toEqual({ ok: false, reason: "address" });
      expect(w.connects).toHaveLength(1);
    }
  });

  test("in the owner's list mode a redirect to another site is refused before it is looked up", async () => {
    const w = world({ "docs.example.com": [PUBLIC], "other.example.net": [PUBLIC] }, { "docs.example.com": { parts: [redirect("https://other.example.net/")] }, ...ok("other.example.net") });
    const result = await fetchGuarded("https://docs.example.com/", host => host === "docs.example.com", w.deps);
    expect(result).toEqual({ ok: false, reason: "site" });
    expect(w.lookups).toEqual(["docs.example.com"]);
  });

  test("three redirects are followed and a fourth is refused; a loop ends the same way", async () => {
    const chain = (n: number): Record<string, Served | Served[]> => ({ "a.example.com": Array.from({ length: n }, (_, i) => ({ parts: [redirect(`/hop${i + 1}`)] })).concat([{ parts: [page("end")] }]) });
    const three = world({ "a.example.com": [PUBLIC] }, chain(3));
    expect((await fetchGuarded("https://a.example.com/", null, three.deps)).ok).toBe(true);
    const four = world({ "a.example.com": [PUBLIC] }, chain(4));
    expect(await fetchGuarded("https://a.example.com/", null, four.deps)).toEqual({ ok: false, reason: "redirect" });
    expect(four.connects).toHaveLength(4);
    const loop = world({ "a.example.com": [PUBLIC] }, { "a.example.com": { parts: [redirect("/")] } });
    expect(await fetchGuarded("https://a.example.com/", null, loop.deps)).toEqual({ ok: false, reason: "redirect" });
  });

  test("a redirect with no usable Location is refused", async () => {
    for (const served of [response("302 Found", {}), response("302 Found", { location: "http://" }), response("302 Found", { location: "x".repeat(3000) })]) {
      const w = world({ "a.example.com": [PUBLIC] }, { "a.example.com": { parts: [served] } });
      expect((await fetchGuarded("https://a.example.com/", null, w.deps)).ok).toBe(false);
    }
  });
});

// The deadline is a real timer in the code under test, so these tests wait on the real clock with tiny budgets (tens of
// milliseconds); fake timers would not drive the socket-side pauses the scripted servers make.
describe("size and time", () => {
  const big = (n: number) => "a".repeat(n);

  test("a body over the cap is cut at the cap, not held whole, whatever it declares", async () => {
    const small = limits({ maxBodyBytes: 1000 });
    for (const served of [
      page(big(50_000)),
      response("200 OK", { "content-type": "text/html" }, big(50_000)), // no length: until close
      response("200 OK", { "content-type": "text/html", "content-length": "5" }, big(50_000)), // lies short
    ]) {
      const w = world({ "a.example.com": [PUBLIC] }, { "a.example.com": { parts: [served] } });
      const result = await fetchGuarded("https://a.example.com/", null, w.deps, small);
      expect(result.ok && result.body.length).toBeLessThanOrEqual(1000);
    }
    const w = world({ "a.example.com": [PUBLIC] }, { "a.example.com": { parts: [page(big(50_000))] } });
    const cut = await fetchGuarded("https://a.example.com/", null, w.deps, small);
    expect(cut.ok && cut.body.length).toBe(1000);
    expect(cut.ok && cut.truncated).toBe(true);
  });

  test("a chunked body is decoded, across read boundaries, and cut at the cap", async () => {
    const body = response("200 OK", { "content-type": "text/html", "transfer-encoding": "chunked" }, "5\r\nhello\r\n6;ext=1\r\n world\r\n0\r\nx-trailer: 1\r\n\r\n");
    for (const cut of [1, 3, 7, 1000]) {
      const bytes = enc.encode(body);
      const parts = Array.from({ length: Math.ceil(bytes.length / cut) }, (_, i) => bytes.slice(i * cut, (i + 1) * cut));
      const w = world({ "a.example.com": [PUBLIC] }, { "a.example.com": { parts } });
      const result = await fetchGuarded("https://a.example.com/", null, w.deps);
      expect(result.ok && dec.decode(result.body)).toBe("hello world");
      expect(result.ok && result.truncated).toBe(false);
    }
    const endless = response("200 OK", { "content-type": "text/html", "transfer-encoding": "chunked" }, `${"400"}\r\n${big(1024)}\r\n`.repeat(100));
    const w = world({ "a.example.com": [PUBLIC] }, { "a.example.com": { parts: [endless] } });
    const result = await fetchGuarded("https://a.example.com/", null, w.deps, limits({ maxBodyBytes: 2000 }));
    expect(result.ok && result.body.length).toBe(2000);
    expect(result.ok && result.truncated).toBe(true);
  });

  test("a malformed chunk is a protocol failure", async () => {
    for (const body of ["zz\r\nhello\r\n0\r\n\r\n", "5\r\nhelloXX0\r\n\r\n"]) {
      const w = world({ "a.example.com": [PUBLIC] }, { "a.example.com": { parts: [response("200 OK", { "content-type": "text/html", "transfer-encoding": "chunked" }, body)] } });
      expect(await fetchGuarded("https://a.example.com/", null, w.deps)).toEqual({ ok: false, reason: "protocol" });
    }
  });

  test("response headers over the cap are refused", async () => {
    const w = world({ "a.example.com": [PUBLIC] }, { "a.example.com": { parts: [response("200 OK", { "content-type": "text/html", "x-pad": big(40_000) }, "x")] } });
    expect(await fetchGuarded("https://a.example.com/", null, w.deps)).toEqual({ ok: false, reason: "protocol" });
    const endless = world({ "a.example.com": [PUBLIC] }, { "a.example.com": { parts: [`HTTP/1.1 200 OK\r\nx-pad: ${big(40_000)}`] } });
    expect(await fetchGuarded("https://a.example.com/", null, endless.deps)).toEqual({ ok: false, reason: "protocol" });
  });

  test("a server that sends nothing, or one byte at a time, ends at the deadline", async () => {
    const never = () => Promise.withResolvers<void>().promise; // a server that never answers
    const quick = limits({ totalMs: 60 });
    const silent = world({ "a.example.com": [PUBLIC] }, { "a.example.com": { parts: [never] } });
    const started = Date.now();
    expect(await fetchGuarded("https://a.example.com/", null, silent.deps, quick)).toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(1000);
    const header = response("200 OK", { "content-type": "text/html" }, "");
    const trickle: Served = { parts: [header, ...Array.from({ length: 200 }, () => async () => Bun.sleep(10)).flatMap(pause => ["x", pause])] };
    const slow = world({ "a.example.com": [PUBLIC] }, { "a.example.com": trickle });
    expect(await fetchGuarded("https://a.example.com/", null, slow.deps, quick)).toEqual({ ok: false, reason: "timeout" });
  });

  test("one deadline covers every hop: a slow chain of redirects ends it", async () => {
    const hops = Array.from({ length: 3 }, (_, i): Served => ({ parts: [async () => Bun.sleep(30), redirect(`/hop${i + 1}`)] }));
    const w = world({ "a.example.com": [PUBLIC] }, { "a.example.com": [...hops, { parts: [page("end")] }] });
    expect(await fetchGuarded("https://a.example.com/", null, w.deps, limits({ totalMs: 70 }))).toEqual({ ok: false, reason: "timeout" });
  });

  test("a connection that opens after the deadline is closed, not left open", async () => {
    const release = Promise.withResolvers<void>();
    let destroyed = false;
    const late: Conn = { write: () => {}, read: () => ({ async *[Symbol.asyncIterator]() {} }), destroy: () => void (destroyed = true) };
    const deps: GuardDeps = { lookup: async () => [PUBLIC], connect: async () => (await release.promise, late) };
    expect(await fetchGuarded("https://a.example.com/", null, deps, limits({ totalMs: 30 }))).toEqual({ ok: false, reason: "timeout" });
    expect(destroyed).toBe(false);
    release.resolve();
    for (let turn = 0; turn < 5; turn++) await Promise.resolve(); // lets the late connection's promise settle
    expect(destroyed).toBe(true);
  });

  test("a lookup or a connection that never answers ends at the deadline", async () => {
    const stuckLookup: GuardDeps = { lookup: () => Promise.withResolvers<string[]>().promise, connect: async () => conn({ parts: [] }, []) };
    expect(await fetchGuarded("https://a.example.com/", null, stuckLookup, limits({ totalMs: 40 }))).toEqual({ ok: false, reason: "timeout" });
    const stuckConnect: GuardDeps = { lookup: async () => [PUBLIC], connect: () => Promise.withResolvers<Conn>().promise };
    expect(await fetchGuarded("https://a.example.com/", null, stuckConnect, limits({ totalMs: 40 }))).toEqual({ ok: false, reason: "timeout" });
  });

  test("a connection that fails or drops is a network failure", async () => {
    const dropped = world({ "a.example.com": [PUBLIC] }, { "a.example.com": { parts: ["HTTP/1.1 200 OK\r\ncontent-type: text/html\r\n"] } });
    expect(await fetchGuarded("https://a.example.com/", null, dropped.deps)).toEqual({ ok: false, reason: "protocol" });
    const refused = world({ "a.example.com": [PUBLIC] }, {});
    expect(await fetchGuarded("https://a.example.com/", null, refused.deps)).toEqual({ ok: false, reason: "network" });
  });
});
