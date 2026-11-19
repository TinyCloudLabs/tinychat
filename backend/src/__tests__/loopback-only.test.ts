import { describe, expect, test } from "bun:test";
import { loopbackOnly } from "./helpers/loopback-only.js";

/** A stand-in for fetch that records what reached it. Nothing is sent anywhere. */
function recording() {
  const reached: string[] = [];
  const inner = (async (input: Parameters<typeof fetch>[0]) => {
    reached.push(input instanceof Request ? input.url : String(input));
    return new Response("ok");
  }) as typeof fetch;
  return { reached, inner };
}

describe("a test that must stay on this machine", () => {
  test("a request to 127.0.0.1 goes through unchanged", async () => {
    const { reached, inner } = recording();
    const guard = loopbackOnly(inner);
    const response = await guard.fetch("http://127.0.0.1:18126/info", { method: "GET" });
    expect([await response.text(), reached, guard.refused]).toEqual(["ok", ["http://127.0.0.1:18126/info"], []]);
  });

  test("a request to any other host is refused and recorded, and never sent", async () => {
    const { reached, inner } = recording();
    const guard = loopbackOnly(inner);
    const elsewhere: Array<[input: Parameters<typeof fetch>[0], host: string]> = [
      ["https://registry.tinycloud.xyz/v1/locations/did:pkh:eip155:1:0xabc", "registry.tinycloud.xyz"],
      ["https://node.tinycloud.xyz/info", "node.tinycloud.xyz"],
      ["http://127.0.0.1.example.com/", "127.0.0.1.example.com"],
      ["http://localhost:8000/", "localhost"],
      ["http://127.0.0.2/", "127.0.0.2"],
      [new URL("https://registry.tinycloud.xyz/"), "registry.tinycloud.xyz"],
      [new Request("https://account.tinycloud.xyz/storage"), "account.tinycloud.xyz"],
    ];
    for (const [input, host] of elsewhere) {
      await expect(guard.fetch(input)).rejects.toThrow(`request left this machine: ${host}`);
    }
    expect(reached).toEqual([]);
    expect(guard.refused).toEqual(elsewhere.map(([, host]) => host));
  });

  test("an address that cannot be read is refused too", async () => {
    const { reached, inner } = recording();
    const guard = loopbackOnly(inner);
    await expect(guard.fetch("not a url")).rejects.toThrow("request left this machine");
    expect([reached, guard.refused]).toEqual([[], ["not a url"]]);
  });
});
