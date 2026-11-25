import { describe, expect, test } from "bun:test";
import { spaceDisplayName } from "./preview";

describe("the space name", () => {
  test("is the name at the end of the space id, plainly", () => {
    expect(spaceDisplayName("tinycloud:pkh:eip155:1:0xabc:feed")).toEqual({ name: "Feed", fallback: false });
    expect(spaceDisplayName("tinycloud:pkh:eip155:1:0x00000000000000000000000000000000000abcd1:default")).toEqual({ name: "Default", fallback: false });
  });

  test("an id with no name at the end comes back whole, and says so", () => {
    for (const odd of ["feed", "tinycloud:feed", "https://node.tinycloud.xyz/space/feed", "tinycloud:pkh:eip155:1:0xabc:", "tinycloud:pkh:eip155:1:0xabc:a b"]) {
      expect(spaceDisplayName(odd)).toEqual({ name: odd, fallback: true });
    }
  });
});
