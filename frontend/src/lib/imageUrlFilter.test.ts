import { describe, expect, test } from "bun:test";

import { imageUrlVerdict, type ImageReason } from "./imageUrlFilter";

const hex = (n: number) => "a1b2c3d4e5f60718".repeat(Math.ceil(n / 16)).slice(0, n);
const b64 = (n: number) => "Zm9vQmFyMTIzNDU2".repeat(Math.ceil(n / 16)).slice(0, n);

function reasons(src: string): ImageReason[] | "load" | "block" {
  const verdict = imageUrlVerdict(src);
  return verdict.kind === "ask" ? verdict.reasons : verdict.kind;
}

describe("images that load without asking", () => {
  test.each([
    "https://i.imgur.com/AbCd123.png",
    "https://avatars.githubusercontent.com/u/1?v=4",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/Example.jpg/320px-Example.jpg",
    "https://images.unsplash.com/photo-1503023345310-bd7c1de61c7d?w=800&q=80",
    "https://res.cloudinary.com/demo/image/upload/c_fill,w_300,h_200/v1312461204/sample.jpg",
    "https://img.shields.io/badge/build-passing-brightgreen.svg",
    "https://cdn.example.com/d41d8cd98f00b204e9800998ecf8427e.png",
    `https://cdn.example.com/${hex(40)}.jpg`,
    `https://cdn.example.com/${hex(64)}.jpg`,
    "http://example.com:8080/logo.png",
    "https://example.com/a.png#a-fragment-that-is-never-sent-to-the-server-and-is-long-enough-to-matter-here",
    "https://example.com/photos/2026/11/team-offsite-group-photo.jpg",
  ])("%s", (src) => {
    expect(imageUrlVerdict(src)).toEqual({ kind: "load" });
  });
});

describe("addresses that never load", () => {
  test.each([
    "data:image/png;base64,iVBORw0KGgo=",
    "javascript:alert(1)",
    "blob:https://example.com/0b1f",
    "file:///etc/passwd",
    "ftp://example.com/a.png",
    "/relative/a.png",
    "//example.com/a.png",
    "not a url",
    "",
  ])("%s", (src) => {
    expect(imageUrlVerdict(src)).toEqual({ kind: "block" });
  });
});

describe("addresses that ask first", () => {
  test("user:password@", () => {
    expect(reasons("https://user:pw@example.com/a.png")).toEqual(["credentials"]);
    expect(reasons("https://user@example.com/a.png")).toEqual(["credentials"]);
  });

  test("a query string over 64 characters, not at 64", () => {
    expect(reasons(`https://example.com/a.png?d=${"x".repeat(62)}`)).toBe("load"); // "d=" + 62 = 64
    expect(reasons(`https://example.com/a.png?d=${"x".repeat(63)}`)).toEqual(["long-query"]);
  });

  test("more than 8 query parameters, not 8", () => {
    const params = (n: number) => Array.from({ length: n }, (_, i) => `p${i}=1`).join("&");
    expect(reasons(`https://example.com/a.png?${params(8)}`)).toBe("load");
    expect(reasons(`https://example.com/a.png?${params(9)}`)).toEqual(["many-params"]);
  });

  test("a path segment over 64 characters, not at 64", () => {
    expect(reasons(`https://example.com/${"x".repeat(64)}`)).toBe("load");
    expect(reasons(`https://example.com/${"x".repeat(65)}`)).toEqual(["long-path"]);
  });

  test("a whole path over 160 characters made of short segments", () => {
    const segments = (n: number) => Array.from({ length: n }, () => "abcdefghi").join("/"); // 9 chars + "/" each
    expect(reasons(`https://example.com/${segments(16)}`)).toBe("load"); // 1 + 16*9 + 15 = 160
    expect(reasons(`https://example.com/${segments(17)}`)).toEqual(["long-path"]);
  });

  test("a base64 run of 40 or more with upper, lower and digits, in a path segment or a query value or key", () => {
    expect(reasons(`https://example.com/${b64(39)}`)).toBe("load");
    expect(reasons(`https://example.com/${b64(40)}`)).toEqual(["encoded"]);
    expect(reasons(`https://example.com/a.png?k=${b64(40)}`)).toEqual(["encoded"]);
    expect(reasons(`https://example.com/a.png?${b64(40)}=1`)).toContain("encoded");
  });

  test("a hex run is a hash up to 64 and an encoded run past it", () => {
    expect(reasons(`https://example.com/a.png?h=${hex(62)}`)).toBe("load"); // "h=" + 62 = 64
    expect(reasons(`https://example.com/a.png?h=${hex(66)}`)).toEqual(["long-query"]);
    expect(reasons(`https://example.com/a.png?h=${hex(66)}`)).not.toContain("encoded");
  });

  test("more than 8 percent escapes, not 8", () => {
    const escaped = (n: number) => "%C3%A9".repeat(n / 2);
    expect(reasons(`https://example.com/a.png?q=${escaped(8)}`)).toBe("load");
    expect(reasons(`https://example.com/a.png?q=${escaped(10)}`)).toEqual(["encoded"]);
  });

  test("six or more words joined by - _ + or %20, not five", () => {
    expect(reasons("https://example.com/one-two-three-four-five.jpg")).toBe("load");
    expect(reasons("https://example.com/one-two-three-four-five-six.jpg")).toEqual(["text-like"]);
    expect(reasons("https://example.com/a.png?q=one_two_three_four_five_six")).toEqual(["text-like"]);
    expect(reasons("https://example.com/a.png?q=one+two+three+four+five+six")).toEqual(["text-like"]);
    expect(reasons("https://example.com/a.png?q=one%20two%20three%20four%20five%20six")).toEqual(["text-like"]);
  });

  test("words need two letters: numbers and single letters do not count", () => {
    expect(reasons("https://example.com/a-b-c-d-e-f-g-h.jpg")).toBe("load");
    expect(reasons("https://example.com/2026-11-17-10-30-45-12-34.jpg")).toBe("load");
  });

  test("the verdict names the host with its port and the full address", () => {
    const verdict = imageUrlVerdict("https://user:pw@example.com:8443/a.png?q=1");
    expect(verdict).toEqual({
      kind: "ask",
      host: "example.com:8443",
      address: "https://user:pw@example.com:8443/a.png?q=1",
      reasons: ["credentials"],
    });
  });

  test("several signals are all reported", () => {
    const verdict = reasons(`https://example.com/${"x".repeat(70)}?d=${"y".repeat(70)}`);
    expect(verdict).toEqual(["long-query", "long-path"]);
  });
});
