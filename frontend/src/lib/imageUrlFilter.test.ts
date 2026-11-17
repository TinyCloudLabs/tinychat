import { describe, expect, test } from "bun:test";

import { IMAGE_PROMPT_COPY, imageUrlVerdict, type ImageReason } from "./imageUrlFilter";

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
    "https://example.com:8443/logo.png",
    "https://d111111abcdef8.cloudfront.net/a.png",
    "https://lh3.googleusercontent.com/a.png",
    "https://www.example.co.uk/a.png",
    "https://cdn.example.co.uk/a.png",
    "https://abcdefghijklmnopqrstuvwx.example.com/a.png",
    "https://very-long-registrable-domain-name-that-is-allowed-to-be-long.com/a.png",
    "https://example.com/a.png#a-fragment-that-is-never-sent-to-the-server-and-is-long-enough-to-matter-here",
    "https://example.com/photos/2026/11/team-offsite-group-photo.jpg",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/Example_image_file_name.jpg/320px-Example_image_file_name.jpg",
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
  test("http:, however plain", () => {
    expect(reasons("http://example.com/logo.png")).toEqual(["insecure"]);
    expect(reasons("http://example.com:8080/logo.png")).toEqual(["insecure"]);
  });

  test("more than one label above the registrable domain", () => {
    expect(reasons("https://a.b.example.com/a.png")).toEqual(["host-labels"]);
    expect(reasons("https://a.b.example.co.uk/a.png")).toEqual(["host-labels"]);
    expect(reasons("https://bucket.s3.us-west-2.amazonaws.com/a.png")).toEqual(["host-labels"]);
  });

  test("a label above the registrable domain over 24 characters, not 24", () => {
    expect(reasons(`https://${"a".repeat(24)}.example.com/a.png`)).toBe("load");
    expect(reasons(`https://${"a".repeat(25)}.example.com/a.png`)).toEqual(["host-long"]);
    expect(reasons(`https://${"a".repeat(63)}.example.com/a.png`)).toEqual(["host-long"]);
  });

  test("a label of 16 or more letters and digits mixed, not 15 or all letters", () => {
    expect(reasons("https://a1b2c3d4e5f6g7h.example.com/a.png")).toBe("load"); // 15
    expect(reasons("https://a1b2c3d4e5f6g7h8.example.com/a.png")).toEqual(["host-encoded"]); // 16
    expect(reasons("https://abcdefghijklmnop.example.com/a.png")).toBe("load");
  });

  test("a long mixed label deep in the host is judged too, and reports every host signal that applies", () => {
    expect(reasons(`https://${"q1".repeat(20)}.x.example.com/a.png`)).toEqual(["host-labels", "host-long", "host-encoded"]);
  });

  test("an IP address as the host, in any form", () => {
    expect(reasons("https://1.2.3.4/a.png")).toEqual(["host-ip"]);
    expect(reasons("https://16909060/a.png")).toEqual(["host-ip"]);
    expect(reasons("https://0x1020304/a.png")).toEqual(["host-ip"]);
    expect(reasons("https://[::1]:8443/a.png")).toEqual(["host-ip"]);
    expect(reasons("https://[2001:db8:dead:beef:1234:5678:9abc:def0]/a.png")).toEqual(["host-ip"]);
    expect(reasons("https://[::ffff:10.0.0.1]/a.png")).toEqual(["host-ip"]);
  });

  test("an address inside the address, on any host, whatever the form", () => {
    expect(reasons("https://img.shields.io/endpoint?url=https://x.ee/abcdef")).toEqual(["nested-url"]);
    expect(reasons("https://img.shields.io/endpoint?url=https%3A%2F%2Fx.ee%2Fabc")).toEqual(["nested-url"]);
    expect(reasons("https://img.shields.io/endpoint?url=https%253A%252F%252Fx.ee%252Fabc")).toEqual(["nested-url"]);
    expect(reasons("https://images.unsplash.com/photo-1?mark=https://x.ee/abc")).toEqual(["nested-url"]);
    expect(reasons("https://i.imgur.com/a.png?next=//x.ee/abc")).toEqual(["nested-url"]);
    expect(reasons("https://example.com/image/fetch/https://x.ee/a.png")).toEqual(["nested-url"]);
    expect(reasons("https://img.shields.io/badge/build-passing-brightgreen.svg")).toBe("load");
    expect(reasons("https://example.com/a//b.png")).toBe("load");
  });

  test("a coarse second-level suffix needs a two-letter country code", () => {
    expect(reasons("https://a.b.com.xyz/a.png")).toEqual(["host-labels"]);
    expect(reasons("https://cdn.example.com.au/a.png")).toBe("load");
  });

  test("an allowlisted host is not judged on its host name, but its path and query still are", () => {
    expect(reasons("https://node.tinycloud.xyz/a.png")).toBe("load");
    expect(reasons("https://i.imgur.com/a1b2c3d4e5f6g7h8i9j0.png")).toBe("load");
    expect(reasons(`https://node.tinycloud.xyz/a.png?d=${"x".repeat(70)}`)).toEqual(["long-query"]);
  });

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
    const escaped = (n: number) => "%41".repeat(n);
    expect(reasons(`https://example.com/a.png?q=${escaped(8)}`)).toBe("load");
    expect(reasons(`https://example.com/a.png?q=${escaped(9)}`)).toEqual(["encoded"]);
  });

  test("a base64 run split by dots, commas, tildes or semicolons is still a run", () => {
    const pieces = (separator: string) => [b64(20), b64(20)].join(separator);
    for (const separator of [".", ",", "~", ";", "!", "*"]) {
      expect(reasons(`https://example.com/${pieces(separator)}`)).toEqual(["encoded"]);
    }
  });

  test("parameters may be split by ; as well as &", () => {
    const params = (n: number) => Array.from({ length: n }, (_, i) => `p${i}=1`).join(";");
    expect(reasons(`https://example.com/a.png?${params(9)}`)).toEqual(["many-params"]);
  });

  test("eight words across the path and query, not seven, however they are joined", () => {
    const words = (n: number) => ["red", "blue", "green", "pink", "gold", "gray", "cyan", "teal", "lime"].slice(0, n);
    for (const joiner of ["-", "_", "+", "%20", ".", ",", "~", ";"]) {
      expect(reasons(`https://example.com/a.png?q=${words(7).join(joiner)}`)).toBe("load");
      expect(reasons(`https://example.com/a.png?q=${words(8).join(joiner)}`)).toEqual(["text-like"]);
    }
    expect(reasons(`https://example.com/a.png?q=${words(8).map((w) => w[0]!.toUpperCase() + w.slice(1)).join("")}`)).toEqual(["text-like"]);
  });

  test("words are counted across segments and parameters together, not one place at a time", () => {
    expect(reasons("https://example.com/one-two-three/four-five-six/seven.png?note=eight")).toEqual(["text-like"]);
    expect(reasons("https://example.com/one-two/three-four/five.png?a=six&b=seven&c=eight")).toEqual(["text-like"]);
  });

  test("words need two letters: numbers and single letters do not count", () => {
    expect(reasons("https://example.com/a-b-c-d-e-f-g-h-i-j.jpg")).toBe("load");
    expect(reasons("https://example.com/2026-11-17-10-30-45-12-34-56.jpg")).toBe("load");
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

describe("the reply-level prompt names the sites", () => {
  const title = IMAGE_PROMPT_COPY.more.title;

  test("one image or several, from one site or more", () => {
    expect(title(1, ["e.example"])).toBe("Load 1 more image from e.example?");
    expect(title(3, ["c.example"])).toBe("Load 3 more images from c.example?");
    expect(title(2, ["c.example", "d.example"])).toBe("Load 2 more images from c.example and d.example?");
    expect(title(3, ["c.example", "d.example", "e.example"])).toBe("Load 3 more images from c.example, d.example and e.example?");
  });

  test("past three sites, the rest are counted", () => {
    expect(title(5, ["c.example", "d.example", "e.example", "f.example", "g.example"])).toBe(
      "Load 5 more images from c.example, d.example, e.example and 2 more sites?",
    );
  });
});
