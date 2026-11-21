import { describe, expect, test } from "bun:test";
import { bucketFor } from "../rate-limits.js";

const KEY = "0123456789abcdef0123456789abcdef";

describe("which bucket a request to a bot other than Main is counted in", () => {
  test("a send is counted as a paid send, like a send to Main", () => {
    expect(bucketFor("POST", "/api/bots/main/messages")).toBe("paidChat");
    expect(bucketFor("POST", `/api/bots/${KEY}/messages`)).toBe("paidChat");
    expect(bucketFor("POST", `/api/bots/${KEY}/messages/`)).toBe("paidChat");
  });

  test("nothing else under /api/bots is counted as a paid send", () => {
    const others: Array<[method: string, path: string]> = [
      ["GET", `/api/bots/${KEY}/messages`],
      ["GET", "/api/bots"],
      ["POST", "/api/bots"],
      ["PATCH", `/api/bots/${KEY}`],
      ["DELETE", `/api/bots/${KEY}`],
      ["POST", `/api/bots/${KEY}`],
      ["POST", `/api/bots/${KEY}/history/grant`],
      ["POST", `/api/bots/${KEY}/history/notice/ack`],
      ["POST", `/api/bots/${KEY}/messages/more`],
      ["POST", `/api/bots/${KEY}0/messages`],
      ["POST", "/api/bots/research/messages"],
      ["POST", `/api/other/${KEY}/messages`],
    ];
    for (const [method, path] of others) {
      expect([method, path, bucketFor(method, path) === "paidChat"]).toEqual([method, path, false]);
    }
  });
});
