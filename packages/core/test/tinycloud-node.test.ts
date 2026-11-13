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
