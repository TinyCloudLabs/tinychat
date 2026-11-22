import { describe, expect, test } from "bun:test";
import { PREVIEW } from "./testClient.fixture";
import { previewRows, serverAddressBeyondHost, serverHost, shortSubject, spaceDisplayName } from "./preview";

describe("the owner's address", () => {
  test("is 0x… and the last four of the address in the DID", () => {
    expect(shortSubject("did:pkh:eip155:1:0x00000000000000000000000000000000000abcd1")).toBe("0x…bcd1");
  });
});

describe("the server that holds the space", () => {
  test("is the node's host", () => {
    expect(serverHost("https://node.tinycloud.xyz")).toBe("node.tinycloud.xyz");
    expect(serverHost("http://localhost:8000")).toBe("localhost");
  });

  test("an origin that is not a URL is shown as given", () => {
    expect(serverHost("not a url")).toBe("not a url");
  });

  test("the server address row is dropped when the URL only repeats the host", () => {
    expect(serverAddressBeyondHost("https://node.tinycloud.xyz")).toBeNull();
    expect(serverAddressBeyondHost("https://node.tinycloud.xyz/")).toBeNull();
    expect(serverAddressBeyondHost("not a url")).toBeNull();
  });

  test("it stays when the URL says more than the host: a port, a path or another scheme", () => {
    expect(serverAddressBeyondHost("https://node.tinycloud.xyz:8443")).toBe("https://node.tinycloud.xyz:8443");
    expect(serverAddressBeyondHost("https://node.tinycloud.xyz/v1")).toBe("https://node.tinycloud.xyz/v1");
    expect(serverAddressBeyondHost("http://node.tinycloud.xyz")).toBe("http://node.tinycloud.xyz");
  });
});

describe("the space name", () => {
  test("is the name at the end of the space id, plainly", () => {
    expect(spaceDisplayName("tinycloud:pkh:eip155:1:0xabc:feed")).toEqual({ name: "Feed", fallback: false });
    expect(spaceDisplayName(PREVIEW.space)).toEqual({ name: "Default", fallback: false });
  });

  test("an id with no name at the end comes back whole, and says so", () => {
    for (const odd of ["feed", "tinycloud:feed", "https://node.tinycloud.xyz/space/feed", "tinycloud:pkh:eip155:1:0xabc:", "tinycloud:pkh:eip155:1:0xabc:a b"]) {
      expect(spaceDisplayName(odd)).toEqual({ name: odd, fallback: true });
    }
  });
});

describe("the rows", () => {
  test("address, host, space name: the full address row is dropped for a plain https origin", () => {
    expect(previewRows(PREVIEW).map((row) => [row.label, row.value])).toEqual([
      ["Your account address", "0x…bcd1"],
      ["Server that holds your space", "node.tinycloud.xyz"],
      ["Space name", "Default"],
    ]);
  });

  test("the server address row shows when it adds something", () => {
    const rows = previewRows({ ...PREVIEW, nodeOrigin: "https://node.tinycloud.xyz:8443" });
    expect(rows.map((row) => row.key)).toEqual(["subject", "host", "address", "space"]);
    expect(rows[2]).toMatchObject({ label: "Server address", value: "https://node.tinycloud.xyz:8443" });
  });

  test("a space id with no name is shown whole, never dropped", () => {
    const rows = previewRows({ ...PREVIEW, space: "tinycloud:odd" });
    expect(rows.at(-1)).toMatchObject({ label: "Space name", value: "tinycloud:odd" });
  });
});
