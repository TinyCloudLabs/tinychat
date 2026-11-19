import { describe, expect, test } from "bun:test";

import { IMAGE_BIT_FLOOR, REPLY_BIT_BUDGET } from "./imageAddressBits";
import { heavyImageAddress as heavy } from "./imageBudget.fixture";
import { isAllowlistedImageHost } from "./imageHosts";
import { heldImages, ReplyImageBudget } from "./imageBudget";
import { imageUrlVerdict } from "./imageUrlFilter";

const img = (host: string, name = "a") => `https://${host}/${name}.png`;
const heldSrcs = (srcs: string[]) => heldImages(srcs).map((held) => held.src);
const bits = (src: string) => {
  const verdict = imageUrlVerdict(src);
  return verdict.kind === "block" ? NaN : verdict.bits;
};

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
  test("the fixture: an address that loads on its own, three of which fit in the budget and four of which do not", () => {
    expect(imageUrlVerdict(heavy("a.example")).kind).toBe("load");
    expect(bits(heavy("a.example"))).toBeGreaterThan(REPLY_BIT_BUDGET / 4);
    expect(bits(heavy("a.example"))).toBeLessThan(REPLY_BIT_BUDGET / 3);
  });

  test("images load while the room for data in their addresses, added up, stays within the budget; the rest wait, in document order", () => {
    const srcs = ["a", "b", "c", "d", "e"].map((name) => heavy(`${name}.example`));
    expect(heldSrcs(srcs)).toEqual(srcs.slice(3));
    expect(heldImages(srcs)[0]).toEqual({ src: srcs[3]!, host: "d.example" });
    expect(heldSrcs(srcs.slice(0, 3))).toEqual([]);
  });

  test("ordinary images do not wait: five from one site, or five from five sites", () => {
    const wikimedia = ["Golden_Gate_Bridge", "Starry_Night", "Mount_Everest_North_Face", "Tokyo_Tower_at_night", "Photosynthesis_diagram"].map(
      (name) => `https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/${name}.jpg/640px-${name}.jpg`,
    );
    expect(heldSrcs(wikimedia)).toEqual([]);
    expect(heldSrcs(["a", "b", "c", "d", "e"].map((name) => `https://www.${name}-news.example/photos/2026/11/front-page-${name}.jpg`))).toEqual([]);
  });

  test("the budget is one number for the reply: hosts, domains and free hosting tenants all draw on it", () => {
    const oneHost = ["1", "2", "3", "4", "5"].map((name) => heavy("cdn.example", name));
    const manyDomains = ["one.example", "two.example.org", "three.pages.dev", "four.vercel.app", "five.example.co.uk"].map((host) => heavy(host));
    expect(heldSrcs(oneHost)).toEqual(oneHost.slice(3));
    expect(heldSrcs(manyDomains)).toEqual(manyDomains.slice(3));
  });

  test("no image is free: even the smallest addresses use the budget up", () => {
    const tiny = Array.from({ length: 200 }, (_, i) => `https://a.io/${i}`);
    expect(tiny.map(bits).every((n) => n >= IMAGE_BIT_FLOOR)).toBe(true);
    expect(tiny.length - heldSrcs(tiny).length).toBeLessThanOrEqual(REPLY_BIT_BUDGET / IMAGE_BIT_FLOOR);
    expect(heldSrcs(tiny).length).toBeGreaterThan(0);
  });

  test("what an earlier image of the reply already sent is charged as an index, so a gallery from one site costs little", () => {
    const gallery = Array.from({ length: 8 }, (_, i) => `https://photos.example.com/albums/summer-trip/day-${i + 1}/sunset.jpg`);
    expect(gallery.map(bits).reduce((sum, n) => sum + n, 0)).toBeGreaterThan(REPLY_BIT_BUDGET / 2); // each counted alone
    expect(heldSrcs(gallery)).toEqual([]);
  });

  test("an image that waits is not charged: a small one after it still loads", () => {
    const srcs = [heavy("a.example"), heavy("b.example"), heavy("c.example"), heavy("d.example"), img("e.example")];
    expect(heldSrcs(srcs)).toEqual([srcs[3]!]);
  });

  test("an address on the allowlist is charged the floor and nothing more, but not nothing", () => {
    const own = Array.from({ length: 100 }, (_, i) => heavy("node.tinycloud.xyz", `n${i}`));
    expect(heldSrcs(own)).toEqual([]);
    // Forty floors (1,280 bits) leave room for two heavy addresses, not three.
    expect(heldSrcs([...own.slice(0, 40), heavy("a.example"), heavy("b.example"), heavy("c.example")])).toEqual([heavy("c.example")]);
    const many = Array.from({ length: REPLY_BIT_BUDGET / IMAGE_BIT_FLOOR + 5 }, (_, i) => img("i.imgur.com", `Zk3x${i}`));
    expect(heldSrcs(many)).toEqual(many.slice(REPLY_BIT_BUDGET / IMAGE_BIT_FLOOR));
  });

  test("an address that asks or is blocked is judged alone and is not charged", () => {
    const asks = `https://x.example/p.png?d=${"z".repeat(70)}`;
    const srcs = [asks, "data:image/png;base64,AAAA", heavy("a.example"), heavy("b.example"), heavy("c.example")];
    expect(heldSrcs(srcs)).toEqual([]);
  });

  test("the same address twice is charged once", () => {
    expect(heldSrcs([heavy("a.example"), heavy("a.example"), heavy("b.example"), heavy("b.example"), heavy("c.example")])).toEqual([]);
  });
});

describe("a reply's choices", () => {
  const five = ["a", "b", "c", "d", "e"].map((name) => heavy(`${name}.example`));

  test("the held images are reported once, and again only when they change", () => {
    const budget = new ReplyImageBudget();
    let changes = 0;
    budget.subscribe(() => changes++);
    five.forEach((src, i) => budget.claim(`i${i}`, src));
    budget.publish();
    budget.publish();
    expect(budget.waiting().map((held) => held.src)).toEqual(five.slice(3));
    expect(changes).toBe(1);
    expect(budget.isHeld(five[3]!)).toBe(true);
    expect(budget.isHeld(five[0]!)).toBe(false);
  });

  test("a choice is for the exact address: a changed address is held again", () => {
    const budget = new ReplyImageBudget();
    five.forEach((src, i) => budget.claim(`i${i}`, src));
    budget.publish();
    budget.decide([five[3]!, five[4]!], "load");
    expect(budget.waiting()).toEqual([]);
    expect(budget.choice(five[3]!)).toBe("load");
    const changed = heavy("d.example", "streamed-longer");
    budget.claim("i3", changed);
    budget.publish();
    expect(budget.choice(changed)).toBeUndefined();
    expect(budget.waiting().map((held) => held.src)).toEqual([changed]);
  });

  test("an image that goes away gives up what it was charged, so a stale address never keeps it", () => {
    const budget = new ReplyImageBudget();
    const real = heavy("s.example", "real");
    [heavy("s.example", "r"), heavy("s.example", "re"), heavy("s.example", "rea"), real].forEach((src, i) => budget.claim(`i${i}`, src));
    expect(budget.isHeld(real)).toBe(true);
    budget.release("i0");
    budget.release("i1");
    budget.publish();
    expect(budget.isHeld(real)).toBe(false);
    expect(budget.waiting()).toEqual([]);
  });
});
