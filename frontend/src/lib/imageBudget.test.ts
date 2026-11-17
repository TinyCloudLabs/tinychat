import { describe, expect, test } from "bun:test";

import { isAllowlistedImageHost } from "./imageHosts";
import { heldImages, ReplyImageBudget, SILENT_THIRD_PARTY_IMAGES } from "./imageBudget";

const img = (host: string, name = "a") => `https://${host}/${name}.png`;
const heldSrcs = (srcs: string[]) => heldImages(srcs).map((held) => held.src);

describe("allowlisted hosts", () => {
  test.each(["tinycloud.one", "app.tinycloud.one", "tinycloud.chat", "www.tinycloud.chat", "node.tinycloud.xyz", "tinycloud.xyz", "i.imgur.com", "avatars.githubusercontent.com"])(
    "%s",
    (host) => expect(isAllowlistedImageHost(host)).toBe(true),
  );

  test.each(["evil-tinycloud.one", "tinycloud.one.evil.example", "tinycloud.xyz.evil.example", "xtinycloud.chat", "example.com", "", "evil.i.imgur.com", "imgur.com", "raw.githubusercontent.com", "res.cloudinary.com", "upload.wikimedia.org", "img.shields.io", "images.unsplash.com", "api.tinycloud.chat", "share.tinycloud.xyz", "tee.node.tinycloud.xyz"])(
    "%s is not",
    (host) => expect(isAllowlistedImageHost(host)).toBe(false),
  );
});

describe("the images of a reply that must wait", () => {
  test("the first two from other hosts load, the rest wait, in document order", () => {
    const srcs = ["a", "b", "c", "d", "e"].map((name) => img(`${name}.example`));
    expect(SILENT_THIRD_PARTY_IMAGES).toBe(2);
    expect(heldSrcs(srcs)).toEqual(srcs.slice(2));
    expect(heldImages(srcs)[0]).toEqual({ src: srcs[2]!, host: "c.example" });
  });

  test("two images do not wait", () => {
    expect(heldSrcs([img("a.example"), img("b.example")])).toEqual([]);
  });

  test("our own hosts never count, however many", () => {
    const own = Array.from({ length: 6 }, (_, i) => img("node.tinycloud.xyz", `n${i}`));
    expect(heldSrcs([...own, img("a.example"), img("b.example")])).toEqual([]);
    expect(heldSrcs([img("a.example"), ...own, img("b.example"), img("c.example")])).toEqual([img("c.example")]);
  });

  test("a trusted third-party host does not use the budget either", () => {
    const trusted = ["i.imgur.com", "avatars.githubusercontent.com"].map((h) => img(h));
    expect(heldSrcs([...trusted, img("a.example"), img("b.example")])).toEqual([]);
  });

  test("an imgix-backed host is budgeted: a base64 overlay address is not readable, so it must not be free", () => {
    const overlay = "https://images.unsplash.com/photo-1?mark64=aHR0cHM6Ly94LmVlL2FiY2RlZmdoaWprbG0";
    expect(heldSrcs([img("a.example"), img("b.example"), overlay])).toEqual([overlay]);
  });

  test("an address that asks or is blocked is judged alone and does not use the budget", () => {
    const asks = `https://x.example/p.png?d=${"z".repeat(70)}`;
    const srcs = [asks, "data:image/png;base64,AAAA", img("a.example"), img("b.example")];
    expect(heldSrcs(srcs)).toEqual([]);
  });

  test("the same address twice counts once; different ports or paths on one host count separately", () => {
    expect(heldSrcs([img("a.example"), img("a.example"), img("b.example")])).toEqual([]);
    expect(heldSrcs([img("a.example", "1"), img("a.example", "2"), img("a.example", "3")])).toEqual([img("a.example", "3")]);
  });
});

describe("a reply's choices", () => {
  const four = ["a", "b", "c", "d"].map((name) => img(`${name}.example`));

  test("the held images are reported once, and again only when they change", () => {
    const budget = new ReplyImageBudget();
    let changes = 0;
    budget.subscribe(() => changes++);
    four.forEach((src, i) => budget.claim(`i${i}`, src));
    budget.publish();
    budget.publish();
    expect(budget.waiting().map((held) => held.src)).toEqual(four.slice(2));
    expect(changes).toBe(1);
    expect(budget.isHeld(four[2]!)).toBe(true);
    expect(budget.isHeld(four[0]!)).toBe(false);
  });

  test("a choice is for the exact address: a changed address is held again", () => {
    const budget = new ReplyImageBudget();
    four.forEach((src, i) => budget.claim(`i${i}`, src));
    budget.publish();
    budget.decide([four[2]!, four[3]!], "load");
    expect(budget.waiting()).toEqual([]);
    expect(budget.choice(four[2]!)).toBe("load");
    const changed = img("c.example", "streamed-longer");
    budget.claim("i2", changed);
    budget.publish();
    expect(budget.choice(changed)).toBeUndefined();
    expect(budget.waiting().map((held) => held.src)).toEqual([changed]);
  });

  test("an image that goes away gives its slot up, so a stale address never keeps one", () => {
    const budget = new ReplyImageBudget();
    ["https://e", "https://ev", "https://evil.example/real.png"].forEach((src, i) => budget.claim(`i${i}`, src));
    expect(budget.isHeld("https://evil.example/real.png")).toBe(true);
    budget.release("i0");
    budget.release("i1");
    budget.publish();
    expect(budget.isHeld("https://evil.example/real.png")).toBe(false);
    expect(budget.waiting()).toEqual([]);
  });
});
