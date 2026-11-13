import { expect, test } from "bun:test";
import { sameTinyCloudNode } from "../src/index";

test("the two production node names are the same node", () => {
  expect(sameTinyCloudNode("https://node.tinycloud.xyz", "https://tee.node.tinycloud.xyz")).toBe(true);
  expect(sameTinyCloudNode("https://tee.node.tinycloud.xyz/", "https://node.tinycloud.xyz")).toBe(true);
});

test("other hosts match only their own origin", () => {
  expect(sameTinyCloudNode("http://localhost:8000", "http://localhost:8000/")).toBe(true);
  expect(sameTinyCloudNode("http://localhost:8000", "https://node.tinycloud.xyz")).toBe(false);
  expect(sameTinyCloudNode("https://node.tinycloud.xyz.evil.example", "https://node.tinycloud.xyz")).toBe(false);
  expect(sameTinyCloudNode("http://node.tinycloud.xyz", "https://tee.node.tinycloud.xyz")).toBe(false);
  expect(sameTinyCloudNode("not a url", "not a url")).toBe(false);
});

test("only bare origins compare: userinfo, paths, queries, ports and other schemes never match", () => {
  for (const host of ["https://evil@tee.node.tinycloud.xyz", "https://u:p@node.tinycloud.xyz", "https://tee.node.tinycloud.xyz/some/path?q#f",
    "HTTPS://TEE.NODE.TINYCLOUD.XYZ:443", "blob:https://tee.node.tinycloud.xyz/abc", "https://tee.node.tinycloud.xyz\\@evil.com", "https://tee%2enode.tinycloud.xyz"]) {
    expect(sameTinyCloudNode(host, "https://node.tinycloud.xyz")).toBe(false);
  }
});
