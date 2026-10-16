import { describe, expect, test } from "bun:test";
import {
  TINYCLOUD_CONNECTION_MESSAGE,
  createTinyCloudFetch,
  selectNewSessionHosts,
} from "./tinycloudHosts";

const node = "https://node.tinycloud.xyz";
const tee = "https://tee.node.tinycloud.xyz";
const fetchOf = (implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => implementation as typeof fetch;

describe("new-session TinyCloud host selection", () => {
  test("uses node when its public info is reachable", async () => {
    const requests: Request[] = [];
    const transport = fetchOf(async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ protocol: 1 });
    });
    expect(await selectNewSessionHosts(undefined, transport)).toEqual([node]);
    expect(requests.map((request) => [request.url, request.method, request.body])).toEqual([[`${node}/info`, "GET", null]]);
  });

  test("tries tee once after a transport failure, without replaying a signed request", async () => {
    const urls: string[] = [];
    const transport = fetchOf(async (input, init) => {
      const request = new Request(input, init);
      urls.push(request.url);
      expect(request.body).toBeNull();
      expect(request.headers.has("authorization")).toBe(false);
      if (new URL(request.url).origin === node) throw new TypeError("Failed to fetch");
      return Response.json({ protocol: 1 });
    });
    expect(await selectNewSessionHosts(node, transport)).toEqual([tee]);
    expect(urls).toEqual([`${node}/info`, `${tee}/info`]);
  });

  test("stops after the one fallback also fails", async () => {
    const urls: string[] = [];
    const transport = fetchOf(async (input) => { urls.push(String(input)); throw new TypeError("Failed to fetch"); });
    await expect(selectNewSessionHosts(node, transport)).rejects.toThrow("Couldn't connect to TinyCloud");
    expect(urls).toEqual([`${node}/info`, `${tee}/info`]);
  });

  test("a readable fallback rejection remains an HTTP error, not another connectivity attempt", async () => {
    const urls: string[] = [];
    const transport = fetchOf(async (input) => {
      urls.push(String(input));
      if (String(input).startsWith(node)) throw new TypeError("Failed to fetch");
      return new Response(null, { status: 413 });
    });
    await expect(selectNewSessionHosts(node, transport)).rejects.toThrow("HTTP 413");
    expect(urls).toEqual([`${node}/info`, `${tee}/info`]);
  });

  for (const status of [400, 401, 403, 413, 414, 429, 500, 504]) {
    test(`HTTP ${status} is not a connectivity fallback`, async () => {
      const urls: string[] = [];
      const transport = fetchOf(async (input) => { urls.push(String(input)); return new Response(null, { status }); });
      await expect(selectNewSessionHosts(node, transport)).rejects.toThrow(`HTTP ${status}`);
      expect(urls).toEqual([`${node}/info`]);
    });
  }

  for (const error of [new DOMException("Cancelled", "AbortError"), new DOMException("Deadline", "TimeoutError"), new TypeError("Invalid URL"), new Error("application bug")]) {
    test(`${error.name}: ${error.message} does not select another host`, async () => {
      let attempts = 0;
      const transport = fetchOf(async () => { attempts++; throw error; });
      await expect(selectNewSessionHosts(node, transport)).rejects.toBe(error);
      expect(attempts).toBe(1);
    });
  }

  for (const host of [tee, "https://personal.example", "http://127.0.0.1:8000"]) {
    test(`keeps explicit ${host} rather than probing hosted aliases`, async () => {
      const transport = fetchOf(async () => { throw new Error("Explicit hosts must not be probed or replaced"); });
      expect(await selectNewSessionHosts(host, transport)).toEqual([host]);
    });
  }
});

describe("TinyCloud transport error boundary", () => {
  test("a CORS-hidden large-upload failure is clear and never replayed", async () => {
    const body = new Blob([new Uint8Array(2 * 1024 * 1024)]);
    const requests: { url: string; body: BodyInit | null | undefined }[] = [];
    const transport = createTinyCloudFetch(fetchOf(async (input, init) => {
      requests.push({ url: String(input), body: init?.body });
      throw new TypeError("Failed to fetch");
    }));
    await expect(transport(`${node}/invoke`, { method: "POST", body })).rejects.toThrow(TINYCLOUD_CONNECTION_MESSAGE);
    expect(requests).toEqual([{ url: `${node}/invoke`, body }]);
  });

  test("a small signed mutation is not replayed either", async () => {
    let attempts = 0;
    const transport = createTinyCloudFetch(fetchOf(async () => { attempts++; throw new TypeError("Failed to fetch"); }));
    await expect(transport(`${node}/invoke`, { method: "POST", body: "UPDATE settings SET value = 'x'", headers: { authorization: "synthetic" } })).rejects.toThrow("not automatically retried");
    expect(attempts).toBe(1);
  });

  test("unknown-length streams are not read, cloned, or replayed", async () => {
    let pulls = 0;
    const body = new ReadableStream({ pull() { pulls++; } }, { highWaterMark: 0 });
    let attempts = 0;
    const transport = createTinyCloudFetch(fetchOf(async (_input, init) => {
      attempts++;
      expect(init?.body).toBe(body);
      throw new TypeError("Failed to fetch");
    }));
    await expect(transport(`${node}/invoke`, { method: "POST", body })).rejects.toThrow(TINYCLOUD_CONNECTION_MESSAGE);
    expect(attempts).toBe(1);
    expect(pulls).toBe(0);
    expect(body.locked).toBe(false);
  });

  test("an aborted fetch keeps its cancellation rather than becoming a connectivity error", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Stopped", "AbortError");
    const transport = createTinyCloudFetch(fetchOf(async () => { controller.abort(reason); throw new TypeError("Failed to fetch"); }));
    await expect(transport(`${node}/info`, { signal: controller.signal })).rejects.toBe(reason);
  });

  test("readable HTTP errors pass through unchanged and are never retried", async () => {
    for (const status of [400, 413, 414, 500]) {
      let attempts = 0;
      const response = new Response("request rejected", { status });
      const transport = createTinyCloudFetch(fetchOf(async () => { attempts++; return response; }));
      expect(await transport(`${node}/invoke`, { method: "POST", body: "small" })).toBe(response);
      expect(attempts).toBe(1);
    }
  });

  test("unrelated hosts and programming errors keep their original failures", async () => {
    const failure = new TypeError("Failed to fetch");
    const transport = createTinyCloudFetch(fetchOf(async () => { throw failure; }));
    await expect(transport("https://api.tinycloud.chat/api/auth/nonce")).rejects.toBe(failure);
    const invalid = new TypeError("Invalid URL");
    await expect(createTinyCloudFetch(fetchOf(async () => { throw invalid; }))(`${node}/info`)).rejects.toBe(invalid);
  });
});
