import { describe, expect, test } from "bun:test";

import { ADDRESS_BIT_LIMIT, IMAGE_BIT_FLOOR, REPLY_BIT_BUDGET } from "./imageAddressBits";
import { HEAVY_HOSTS, HEAVY_THAT_FIT as FIT, heavyImageAddress as heavy } from "./imageBudget.fixture";
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
  /** A reply of heavy images, each on its own host: the first FIT fit in the budget, the last two do not. */
  const heavies = HEAVY_HOSTS.map((host) => heavy(host));

  test("the fixture goes with the limits: a heavy address loads on its own, FIT of them fit in the budget and one more does not", () => {
    const size = bits(heavy("a.example"));
    expect(imageUrlVerdict(heavy("a.example")).kind).toBe("load");
    expect(size).toBeLessThan(ADDRESS_BIT_LIMIT);
    expect(size * FIT).toBeLessThanOrEqual(REPLY_BIT_BUDGET);
    // With room to spare: a piece that an earlier image already sent makes a later one a little cheaper.
    expect(size * 0.95 * (FIT + 1)).toBeGreaterThan(REPLY_BIT_BUDGET);
  });

  test("images load while the room for data in their addresses, added up, stays within the budget; the rest wait, in document order", () => {
    expect(heldSrcs(heavies)).toEqual(heavies.slice(FIT));
    expect(heldImages(heavies)[0]).toEqual({ src: heavies[FIT]!, host: HEAVY_HOSTS[FIT]! });
    expect(heldSrcs(heavies.slice(0, FIT))).toEqual([]);
  });

  test("ordinary images do not wait: five from one site, or five from five sites", () => {
    const wikimedia = ["Golden_Gate_Bridge", "Starry_Night", "Mount_Everest_North_Face", "Tokyo_Tower_at_night", "Photosynthesis_diagram"].map(
      (name) => `https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/${name}.jpg/640px-${name}.jpg`,
    );
    expect(heldSrcs(wikimedia)).toEqual([]);
    expect(heldSrcs(["a", "b", "c", "d", "e"].map((name) => `https://www.${name}-news.example/photos/2026/11/front-page-${name}.jpg`))).toEqual([]);
  });

  test("the budget is one number for the reply: hosts, domains and free hosting tenants all draw on it", () => {
    const oneHost = HEAVY_HOSTS.map((_, i) => heavy("cdn.example", `${i + 1}`));
    const domains = ["one.example", "two.example.org", "three.pages.dev", "four.vercel.app", "five.web.app", "six.example.net", "seven.github.io", "eight.netlify.app", "nine.r2.dev", "ten.example.io"];
    const manyDomains = domains.slice(0, FIT + 2).map((host) => heavy(host));
    expect(manyDomains.map((src) => imageUrlVerdict(src).kind)).toEqual(manyDomains.map(() => "load"));
    expect(heldSrcs(oneHost)).toEqual(oneHost.slice(FIT));
    expect(heldSrcs(manyDomains)).toEqual(manyDomains.slice(FIT));
  });

  test("no image is free: even the smallest addresses use the budget up", () => {
    const tiny = Array.from({ length: REPLY_BIT_BUDGET / IMAGE_BIT_FLOOR + 50 }, (_, i) => `https://a.io/${i}`);
    expect(tiny.map(bits).every((n) => n >= IMAGE_BIT_FLOOR)).toBe(true);
    expect(tiny.length - heldSrcs(tiny).length).toBeLessThanOrEqual(REPLY_BIT_BUDGET / IMAGE_BIT_FLOOR);
    expect(heldSrcs(tiny).length).toBeGreaterThan(0);
  });

  test("what an earlier image of the reply already sent is charged as an index, so a gallery from one site costs little", () => {
    const gallery = Array.from({ length: 24 }, (_, i) => `https://photos.example.com/albums/summer-trip/day-${i + 1}/sunset.jpg`);
    expect(gallery.map(bits).reduce((sum, n) => sum + n, 0)).toBeGreaterThan(REPLY_BIT_BUDGET / 2); // each counted alone
    expect(heldSrcs(gallery)).toEqual([]);
  });

  test("an image that waits is not charged: a small one after it still loads", () => {
    const srcs = [...heavies.slice(0, FIT + 1), img("z.example")];
    expect(heldSrcs(srcs)).toEqual([heavies[FIT]!]);
  });

  test("an address on the allowlist is charged the floor and nothing more, but not nothing", () => {
    const own = Array.from({ length: REPLY_BIT_BUDGET / IMAGE_BIT_FLOOR }, (_, i) => img("node.tinycloud.xyz", `n${i}`));
    expect(heldSrcs(own)).toEqual([]);
    expect(heldSrcs([...own, img("i.imgur.com", "Zk3x1")])).toEqual([img("i.imgur.com", "Zk3x1")]);
    // Enough floors to leave room for all but half of the last heavy address: it waits, the ones before it load.
    const floors = Math.ceil((REPLY_BIT_BUDGET - (FIT - 0.5) * bits(heavy("a.example"))) / IMAGE_BIT_FLOOR);
    expect(heldSrcs([...own.slice(0, floors), ...heavies.slice(0, FIT)])).toEqual([heavies[FIT - 1]!]);
  });

  test("an address that asks or is blocked is judged alone and is not charged", () => {
    const asks = `https://x.example/p.png?d=${"z".repeat(70)}`;
    expect(heldSrcs([asks, "data:image/png;base64,AAAA", ...heavies.slice(0, FIT)])).toEqual([]);
  });

  test("the same address twice is charged once", () => {
    expect(heldSrcs(heavies.slice(0, FIT).flatMap((src) => [src, src]))).toEqual([]);
  });
});

describe("a reply's choices", () => {
  const heavies = HEAVY_HOSTS.map((host) => heavy(host));

  test("the held images are reported once, and again only when they change", () => {
    const budget = new ReplyImageBudget();
    let changes = 0;
    budget.subscribe(() => changes++);
    heavies.forEach((src, i) => budget.claim(`i${i}`, src));
    budget.publish();
    budget.publish();
    expect(budget.waiting().map((held) => held.src)).toEqual(heavies.slice(FIT));
    expect(changes).toBe(1);
    expect(budget.isHeld(heavies[FIT]!)).toBe(true);
    expect(budget.isHeld(heavies[0]!)).toBe(false);
  });

  test("a choice is for the exact address: a changed address is held again", () => {
    const budget = new ReplyImageBudget();
    heavies.forEach((src, i) => budget.claim(`i${i}`, src));
    budget.publish();
    budget.decide(heavies.slice(FIT), "load");
    expect(budget.waiting()).toEqual([]);
    expect(budget.choice(heavies[FIT]!)).toBe("load");
    const changed = heavy(HEAVY_HOSTS[FIT]!, "v2");
    budget.claim(`i${FIT}`, changed);
    budget.publish();
    expect(budget.choice(changed)).toBeUndefined();
    expect(budget.waiting().map((held) => held.src)).toEqual([changed]);
  });

  test("an image that goes away gives up what it was charged, so a stale address never keeps it", () => {
    const budget = new ReplyImageBudget();
    const real = heavy("s.example", "real");
    [...Array.from({ length: FIT }, (_, i) => heavy("s.example", `r${i}`)), real].forEach((src, i) => budget.claim(`i${i}`, src));
    expect(budget.isHeld(real)).toBe(true);
    budget.release("i0");
    budget.release("i1");
    budget.publish();
    expect(budget.isHeld(real)).toBe(false);
    expect(budget.waiting()).toEqual([]);
  });
});
