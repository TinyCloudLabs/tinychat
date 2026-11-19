import { describe, expect, test } from "bun:test";

import { ADDRESS_BIT_LIMIT } from "./imageAddressBits";
import { ASK_THRESHOLD, IMAGE_PROMPT_COPY, imageUrlVerdict, type ImageReasonCode } from "./imageUrlFilter";

// What each sign weighs and where its steps are. The corpus (imageUrlFilter.corpus.test.ts) checks whole addresses.

const hex = (text: string) => Array.from(text, (char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("");
const MD5 = "205e460b479e2e5b48aec07710c08d50";
const SHA1 = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
const SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/** An opaque id of exactly `n` characters: letters and digits that are not hex, not words and not encoded text. */
const opaque = (n: number) => "Xk3p9Qw7Rm2Tz8LbN4cWfYd6HsEuGi1Ko5MaXjZt0BqVnCyPlOe7Uh2Sg4Df6Ja8".repeat(2).slice(0, n);

/** The weight the filter gave one sign, or 0 when it did not find it. */
function weight(src: string, code: ImageReasonCode): number {
  const verdict = imageUrlVerdict(src);
  return verdict.reasons.filter((reason) => reason.code === code).reduce((sum, reason) => sum + reason.weight, 0);
}
const kind = (src: string) => imageUrlVerdict(src).kind;
const score = (src: string) => {
  const verdict = imageUrlVerdict(src);
  return verdict.kind === "block" ? NaN : verdict.score;
};

describe("the verdict", () => {
  test("an ordinary address loads with no reasons, and says how much room it has and over what that was counted", () => {
    const src = "https://example.com/photos/2026/11/team-offsite-group-photo.jpg";
    expect(imageUrlVerdict(src)).toEqual({ kind: "load", score: 0, reasons: [], bits: 291, charged: [src] });
  });

  test("weak signs are listed on an address that still loads", () => {
    const verdict = imageUrlVerdict("http://example.com:8080/logo.png");
    expect(verdict.kind).toBe("load");
    expect(verdict.reasons.map((reason) => [reason.code, reason.weight])).toEqual([["insecure", 15], ["port", 35]]);
    expect(score("http://example.com:8080/logo.png")).toBe(50);
  });

  test("weak signs add up: it asks when they reach the threshold, not before", () => {
    expect(ASK_THRESHOLD).toBe(100);
    expect(score("http://example.com:31337/logo.png")).toBe(75); // http 15 + odd port 60
    expect(kind("http://example.com:31337/logo.png")).toBe("load");
    expect(score("http://example.com:31337/pixel.gif")).toBe(105); // + tracking 30
    expect(kind("http://example.com:31337/pixel.gif")).toBe("ask");
  });

  test("an ask names the host with its port, the full address, the score and every reason with its detail", () => {
    const verdict = imageUrlVerdict("https://user:pw@example.com:8443/a.png?q=1");
    expect(verdict).toEqual({
      kind: "ask",
      host: "example.com:8443",
      address: "https://user:pw@example.com:8443/a.png?q=1",
      score: 135,
      reasons: [
        { code: "credentials", weight: 100, detail: "a user name or password before the host" },
        { code: "port", weight: 35, detail: "port 8443" },
      ],
      bits: 225,
    });
  });
});

// The bound under the signs (imageAddressBits.ts, which has its own tests for what each character costs).
describe("room for data", () => {
  const words = "zebra quartz violin harbor meadow copper lantern orchid falcon timber saffron glacier pebble walnut crimson anchor thistle marble ember juniper".split(" ");
  const bits = (src: string) => {
    const verdict = imageUrlVerdict(src);
    return verdict.kind === "block" ? NaN : verdict.bits;
  };

  test("an address with room for more than the limit asks, whatever it looks like", () => {
    // Made-up words: no sign fires on them, fifteen at a time.
    const page = (n: number) => `https://example.com/${Array.from({ length: n }, (_, i) => words.slice(i, i + 15).map((word) => word + words[(i * 7 + 3) % 20]).join("-")).join("/")}.png`;
    expect(score(page(1))).toBe(0);
    expect(bits(page(1))).toBeLessThan(ADDRESS_BIT_LIMIT);
    const big = imageUrlVerdict(page(2));
    expect(big.kind).toBe("ask");
    expect(big.reasons.find((reason) => reason.code === "capacity")).toEqual({
      code: "capacity",
      weight: 100,
      detail: `room for about ${bits(page(2))} bits of data, over the ${ADDRESS_BIT_LIMIT} one address may have`,
    });
  });

  test("no image is free: the smallest address is charged the floor", () => {
    expect(bits("https://a.io/")).toBeGreaterThanOrEqual(32);
    expect(bits("https://lh3.googleusercontent.com/a/x")).toBe(32);
  });

  test("on a CDN whose uploader cannot read its requests, the id is not counted; an address inside it is", () => {
    const id = opaque(100);
    const direct = imageUrlVerdict(`https://lh3.googleusercontent.com/pw/${id}=w1200`);
    expect(direct).toMatchObject({ kind: "load", bits: 32, charged: [] });
    const through = imageUrlVerdict("https://images.unsplash.com/photo-1?mark=https://cdn.example.org/zebra-quartz-violin.png");
    expect(through).toMatchObject({ kind: "load", charged: ["https://cdn.example.org/zebra-quartz-violin.png"] });
    expect(bits("https://images.unsplash.com/photo-1?mark=https://cdn.example.org/zebra-quartz-violin.png")).toBe(bits("https://cdn.example.org/zebra-quartz-violin.png"));
  });

  test("an address inside an ordinary address is counted once, as part of the text the outer host receives", () => {
    const outer = "https://example.com/_next/image?url=https%3A%2F%2Fcdn.example.org%2Fzebra-quartz-violin.png&w=640&q=75";
    expect(imageUrlVerdict(outer)).toMatchObject({ kind: "load", charged: [outer] });
    expect(bits(outer)).toBeGreaterThan(bits("https://cdn.example.org/zebra-quartz-violin.png"));
  });

  test("a signed S3 address loads: its signature is charged as 256 bits, not as text", () => {
    const signed = `https://my-bucket.s3.amazonaws.com/photo.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20261118%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261118T120000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=${SHA256}`;
    expect(kind(signed)).toBe("load");
    expect(bits(signed)).toBeGreaterThan(256 + 100);
    expect(bits(signed)).toBeLessThan(ADDRESS_BIT_LIMIT);
  });
});

describe("addresses that never load", () => {
  test.each(["data:image/png;base64,iVBORw0KGgo=", "javascript:alert(1)", "JaVaScRiPt:alert(1)", "java\tscript:alert(1)", "blob:https://example.com/0b1f", "file:///etc/passwd", "ftp://example.com/a.png", "/relative/a.png", "//example.com/a.png", "not a url", ""])(
    "%s",
    (src) => {
      const verdict = imageUrlVerdict(src);
      expect(verdict.kind).toBe("block");
      expect(verdict.reasons.map((reason) => reason.code)).toEqual(["refused"]);
    },
  );
});

describe("normalisation", () => {
  test("an IPv4 host written as one number, in octal or in hex is still an IP address", () => {
    for (const src of ["https://1.2.3.4/a.png", "https://16909060/a.png", "https://0x1020304/a.png", "https://0001.0002.0003.0004/a.png"]) {
      expect(weight(src, "ip-host")).toBe(100);
    }
  });

  test("the host is judged in lower case and without a trailing dot", () => {
    expect(score("https://EXAMPLE.com/Logo.PNG")).toBe(0);
    expect(weight("https://WEBHOOK.SITE./a.png", "capture-host")).toBe(100);
  });

  test("an international name is judged in its ASCII form and shown in both", () => {
    const verdict = imageUrlVerdict("https://münchen.de/rathaus.jpg");
    expect(verdict.reasons).toEqual([{ code: "idn", weight: 25, detail: 'xn--mnchen-3ya is the international name "münchen"' }]);
  });

  test("each part is percent-decoded once before it is judged", () => {
    expect(score("https://example.com/My%20Vacation%20Photos/Day%201/IMG_0042.JPG")).toBe(0);
    expect(weight(`https://example.com/a.png?d=${encodeURIComponent(btoa("the account balance is 48213"))}`, "encoded-text")).toBe(100);
  });

  test("a second layer of encoding asks, and what is under it is still judged, bytes included", () => {
    const twice = `https://example.com/a.png?d=${encodeURIComponent(encodeURIComponent(`${btoa("the account balance is 48213")}==`))}`;
    expect(weight(twice, "double-encoded")).toBe(100);
    expect(weight(twice, "encoded-text")).toBe(100);
    expect(weight("https://example.com/Annual%252Dreport.jpg", "double-encoded")).toBe(100);
    expect(weight("https://example.com/a.png?d=%258f%25a2%25c1%25ff%2500", "binary")).toBe(100);
    expect(weight("https://example.com/a.png?d=%2541%2542%2543", "escaped-plain")).toBe(100);
  });

  test("the one exception: a space written %2520 and nothing else under the second layer", () => {
    const spaces = "https://media.example.com/photos/6af5f3f6/1:1/pass/Armand%2520Hammer%2520-%2520Snakes%2520and%2520Ladders%2520album%2520art.jpg";
    expect(kind(spaces)).toBe("load");
    expect(weight(spaces, "double-encoded")).toBe(0);
    // Any other byte under the second layer asks, alone or beside a space, in any part of the address.
    for (const other of ["%2541", "%250A", "%252F", "%2509", "%25E4%25B8", "%2525", "%252520"]) {
      expect(weight(`https://media.example.com/photos/Annual%2520report${other}.jpg`, "double-encoded")).toBe(100);
      expect(weight(`https://media.example.com/a.jpg?caption=Annual%2520report&v=${other}`, "double-encoded")).toBe(100);
    }
    // What the spaces separate is still judged as words, exactly as with single encoding: a long sentence asks either way.
    const sentence =
      "the quarterly forecast is down twelve percent and layoffs start monday so please keep this between us until the board meets again next thursday when legal counsel has reviewed every customer contract";
    const twice = `https://media.example.com/${sentence.replace(/ /g, "%2520")}.jpg`;
    const once = `https://media.example.com/${sentence.replace(/ /g, "%20")}.jpg`;
    expect(weight(twice, "text-path")).toBe(weight(once, "text-path"));
    expect(weight(twice, "text-path")).toBe(100);
    expect(kind(twice)).toBe("ask");
  });

  test("bytes that are not UTF-8 have no rule of their own: two are 60 points, and every one is charged as room for data", () => {
    const bits = (src: string) => {
      const verdict = imageUrlVerdict(src);
      return verdict.kind === "block" ? NaN : verdict.bits;
    };
    expect(score("https://e.example/a%E4%B8.png")).toBe(60);
    expect(bits("https://e.example/a%E4%B8.png") - bits("https://e.example/a.png")).toBeGreaterThanOrEqual(16);
    const many = `https://e.example/${Array.from({ length: 90 }, (_, i) => `%E${i % 10}%B${i % 9}`).join("a")}.png`;
    expect(weight(many, "capacity")).toBe(100);
  });

  test("the fragment is never sent, so it is not judged", () => {
    expect(score(`https://example.com/a.png#${btoa("the account balance is 48213")}`)).toBe(0);
  });

  test("a form the browser silently repairs is a sign", () => {
    expect(weight("https:\\\\example.com\\a.png", "malformed")).toBe(60);
    expect(weight("https:example.com/a.png", "malformed")).toBe(60);
    expect(weight("https://exam\u200bple.com/a.png", "malformed")).toBe(60);
    expect(weight("  https://example.com/a.png  ", "malformed")).toBe(0);
  });
});

describe("the host", () => {
  test("credentials", () => {
    expect(weight("https://user:pw@example.com/a.png", "credentials")).toBe(100);
    expect(weight("https://user@example.com/a.png", "credentials")).toBe(100);
  });

  test("loopback, private ranges and local names weigh more than a public IP address", () => {
    for (const src of ["https://127.0.0.1/a.png", "https://10.1.2.3/a.png", "https://172.16.0.1/a.png", "https://192.168.1.1/a.png", "https://169.254.169.254/a.png", "https://[::1]/a.png", "https://[::ffff:10.0.0.1]/a.png", "https://[fd00::1]/a.png", "https://localhost/a.png", "https://printer.local/a.png", "https://intranet/a.png"]) {
      expect(weight(src, "private-host")).toBe(120);
    }
    expect(weight("https://[2001:db8::1]/a.png", "ip-host")).toBe(100);
    expect(weight("https://172.32.0.1/a.png", "ip-host")).toBe(100);
  });

  test("request-capture and tunnel services", () => {
    expect(weight("https://webhook.site/a.png", "capture-host")).toBe(100);
    expect(weight("https://abc123.ngrok-free.app/a.png", "capture-host")).toBe(100);
    expect(weight("https://notwebhook.site/a.png", "capture-host")).toBe(0);
  });

  test("a name in another script that reads as Latin is a look-alike; an ordinary international name is not", () => {
    expect(weight("https://аpple.com/a.png", "idn-lookalike")).toBe(100); // Cyrillic а
    expect(weight("https://xn--80ak6aa92e.com/a.png", "idn-lookalike")).toBe(100); // "аррӏе", all Cyrillic
    expect(weight("https://例え.jp/a.png", "idn-lookalike")).toBe(0);
    expect(weight("https://例え.jp/a.png", "idn")).toBe(25);
    expect(weight("https://пример.рф/a.png", "idn-lookalike")).toBe(0);
  });

  test("ports: the common alternatives weigh less than any other", () => {
    expect(weight("https://example.com/a.png", "port")).toBe(0);
    expect(weight("https://example.com:443/a.png", "port")).toBe(0);
    expect(weight("https://example.com:8443/a.png", "port")).toBe(35);
    expect(weight("https://example.com:4444/a.png", "port")).toBe(60);
  });

  test("labels above the registrable domain: 3 are ordinary, 4, 5 and 7 are steps", () => {
    const deep = (n: number) => `https://${Array.from({ length: n }, (_, i) => `s${i}`).join(".")}.example.com/a.png`;
    expect([3, 4, 5, 6, 7].map((n) => weight(deep(n), "host-depth"))).toEqual([0, 30, 60, 60, 100]);
    expect(weight("https://a.b.c.d.example.co.uk/a.png", "host-depth")).toBe(30);
  });

  test("opaque characters in subdomain labels: 16, 24 and 32 are steps", () => {
    const label = (n: number) => `https://${opaque(n).toLowerCase()}.example.com/a.png`;
    expect([15, 16, 23, 24, 31, 32].map((n) => weight(label(n), "host-data"))).toEqual([0, 40, 40, 70, 70, 100]);
    expect(weight("https://q7w1e9r3t5y2u8i4.o6p0a2s4d6f8g1h3.example.com/a.png", "host-data")).toBe(100); // pooled over labels
    expect(weight("https://cdn.images.example.com/a.png", "host-data")).toBe(0);
  });

  test("a hosting platform's customer label is part of the registered name, not data", () => {
    expect(score(`https://pub-${MD5}.r2.dev/cat.jpg`)).toBe(0);
    expect(score("https://qwmxkzpvbtnrhdjslfcg.supabase.co/storage/v1/object/public/a.png")).toBe(0);
    expect(score("https://my-company-assets.s3.us-west-2.amazonaws.com/a.png")).toBe(0);
    expect(weight(`https://${MD5}.x.r2.dev/cat.jpg`, "host-data")).toBe(100); // a label above the customer's is judged
  });

  test("subdomain labels that decode to text, in hex or base32", () => {
    expect(weight(`https://${hex("jordan pay 120k")}.example.com/a.png`, "encoded-text")).toBe(100);
    expect(weight("https://njxxezdbnyqhaylzeaytembqgaya.example.com/a.png", "encoded-text")).toBe(100); // base32 "jordan pay 120000"
  });

  test("words in subdomain labels: 4 and 6 are steps", () => {
    expect(weight("https://my-company-prod-assets.example.com/a.png", "host-text")).toBe(0); // "assets" is plumbing
    expect(weight("https://my-company-prod-team-assets.example.com/a.png", "host-text")).toBe(40);
    expect(weight("https://jordan.salary.is.very.high.now.example.com/a.png", "host-text")).toBe(100);
  });
});

describe("an address inside the address", () => {
  test("an image proxy carrying a clean address loads; the inner address is judged with the outer", () => {
    expect(score("https://example.com/_next/image?url=https%3A%2F%2Fcdn.example.org%2Fhero.png&w=640&q=75")).toBe(40);
    expect(score("https://substackcdn.com/image/fetch/w_1456,c_limit/https%3A%2F%2Fexample.org%2Fa.png")).toBe(40);
    const inner = imageUrlVerdict("https://example.com/_next/image?url=http%3A%2F%2F203.0.113.9%2Fa.png&w=640");
    expect(inner.reasons.map((reason) => [reason.code, reason.weight])).toEqual([["nested-url", 40], ["insecure", 15], ["ip-host", 100]]);
    expect(inner.reasons[2]!.detail).toBe("inside the address: 203.0.113.9 is an IP address, not a name");
  });

  test("a redirect parameter or a redirector path carrying an address asks", () => {
    for (const src of ["https://example.com/a.png?next=//x.example/a", "https://example.com/a.png?redirect=https://x.example/a", "https://example.com/a.png?Return_To=https%3A%2F%2Fx.example", "https://example.com/url?q=https://x.example/a", "https://example.com/out?u=https://x.example/a"]) {
      expect(weight(src, "redirect")).toBe(100);
    }
    expect(weight("https://example.com/a.png?next=2", "redirect")).toBe(0);
  });

  test("an address hidden behind repeated or odd encoding asks", () => {
    const hidden = (value: string) => weight(`https://example.com/a.png?u=${value}`, "hidden-url");
    for (const value of ["https%253A%252F%252Fx.example", "ht%09tps:%09//x.example", "%5C%5Cx.example", "%EF%BC%8F%EF%BC%8Fx.example", "https%25253A%25252F%25252Fx.example"]) {
      expect(hidden(value)).toBe(100);
    }
    expect(hidden("2")).toBe(0);
  });

  test("an address that is not a web address, a second address, or one nested twice asks", () => {
    expect(weight("https://example.com/a.png?u=ftp:x.example", "nested-url")).toBe(100);
    expect(weight("https://example.com/a.png?u=javascript:alert(1)", "nested-url")).toBe(100);
    expect(weight("https://example.com/a.png?a=https://x.example/1&b=https://y.example/2", "nested-url")).toBe(140);
    expect(weight("https://example.com/fetch/https://x.example/p?u=https%3A%2F%2Fy.example%2Fa", "nested-url")).toBe(140);
  });

  test("an address written in hex or base64 is read and judged as that address", () => {
    const camo = imageUrlVerdict(`https://camo.githubusercontent.com/${SHA1}/${hex("https://example.com/images/logo.png")}`);
    expect(camo.reasons).toEqual([{ code: "nested-url", weight: 40, detail: "carries another address (example.com)" }]);
    expect(kind(`https://images.unsplash.com/photo-1?mark64=${btoa("https://203.0.113.9/a.png").replace(/=+$/, "")}`)).toBe("ask");
  });

  test("a colon or a doubled slash in a path is not an address", () => {
    expect(score("https://upload.wikimedia.org/wikipedia/commons/a/ab/File:Cat.jpg")).toBe(0);
    expect(score("https://example.com/a//b.png")).toBe(0);
    expect(score("https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTx")).toBe(0);
  });

  test("the inner address must be written exactly as a browser writes one, or the address asks and the whole text is judged", () => {
    const inner = (value: string) => imageUrlVerdict(`https://example.com/x?u=${value}`);
    const clean = "https://wikipedia.org/a.png";
    expect(inner(clean).kind).toBe("load");
    expect(inner(encodeURIComponent(clean)).kind).toBe("load");
    for (const value of [
      `${opaque(20)}${clean}`, // text before the scheme
      `${clean}%23${opaque(20)}`, // a fragment: the inner request drops it, the outer host receives it
      `https://wikipedia.org/${opaque(20)}/../a.png`, // a dot-segment: the inner parser removes what is before it
      `https://wikipedia.org/${opaque(20)}/%252e%252e/a.png`,
      "https://WIKIPEDIA.org/a.png", // rewritten by the parser
      "https://wikipedia.org", // the parser adds the slash
      "https://wikipedia.org/a b.png",
    ]) {
      const verdict = inner(value);
      expect(verdict.kind).toBe("ask");
      expect(verdict.reasons.find((reason) => reason.code === "nested-url")?.weight).toBe(100);
    }
    // The whole text is judged when the inner address is not: the blob in front of it counts.
    expect(weight(`https://example.com/x?u=${opaque(60)}${clean}`, "blob")).toBe(100);
    expect(weight(`https://example.com/fetch/x${opaque(60)}${clean}`, "blob")).toBe(100);
  });

  test("an encoded address is read as an address only when it is all the run holds", () => {
    const junk = String.fromCharCode(...Array.from({ length: 30 }, (_, i) => 0x80 + ((i * 37) % 0x70)));
    expect(weight(`https://example.com/x?u=${btoa(`${junk}https://wikipedia.org/a.png`)}`, "encoded-text")).toBe(100);
    expect(kind(`https://example.com/x?u=${btoa("https://wikipedia.org/a.png")}`)).toBe("load");
  });
});

describe("characters outside ASCII", () => {
  const cyrillic = "парольотпочтыхантердваибанковскийпинчетыре";

  test("a Latin word with diacritics is a word; a short word in another script is counted four characters to a word", () => {
    expect(score("https://upload.wikimedia.org/wikipedia/commons/thumb/c/c3/Caf%C3%A9_de_Flore.jpg/640px-Caf%C3%A9_de_Flore.jpg")).toBe(0);
    expect(score("https://example.com/Ayuntamiento_de_M%C3%A1laga_reivindicaci%C3%B3n.jpg")).toBe(0);
    expect(score(`https://example.com/${encodeURIComponent("富士山")}.jpg`)).toBe(0);
    expect(score(`https://example.com/${encodeURIComponent("Москва_ночью")}.jpg`)).toBe(0);
    // 80 Cyrillic letters in words of 10: 20 or more words of four characters.
    const words = Array.from({ length: 8 }, (_, i) => cyrillic.slice(i * 3, i * 3 + 10)).join("_");
    expect(weight(`https://example.com/${encodeURIComponent(words)}.jpg`, "text-path")).toBeGreaterThanOrEqual(60);
  });

  test("their own steps: 64 and 128, with a file name that repeats counted once", () => {
    const han = (n: number) => Array.from({ length: n }, (_, i) => String.fromCharCode(0x4e00 + ((i * 131) % 0x5000)) + (i % 8 === 7 ? "_" : "")).join("");
    const at = (n: number) => weight(`https://example.com/${encodeURIComponent(han(n))}.jpg`, "non-ascii");
    expect([63, 64, 127, 128].map(at)).toEqual([0, 40, 40, 100]);
    const name = encodeURIComponent(han(40));
    expect(weight(`https://example.com/thumb/${name}.jpg/640px-${name}.jpg`, "non-ascii")).toBe(0);
  });

  test("a run with no separator past 32 characters is not a word in any script, and a piece that mixes scripts or digits is opaque", () => {
    expect(weight(`https://example.com/${encodeURIComponent(cyrillic + cyrillic)}.png`, "blob")).toBe(100);
    expect(weight(`https://example.com/${opaque(60)}%C3%A9`, "blob")).toBe(100);
    expect(weight("https://example.com/thepasswordishunter2andherbankpinis4471andthesafecodeis9921%C3%A9.png", "blob")).toBe(100);
    expect(weight(`https://example.com/a.png?v=${opaque(30)}${encodeURIComponent("д")}`, "blob")).toBe(40);
  });

  test("in subdomain labels too", () => {
    expect(weight(`https://${opaque(20).toLowerCase()}é.example.com/a.png`, "host-data")).toBeGreaterThanOrEqual(40);
  });
});

describe("opaque characters", () => {
  test("pooled over the address: 28, 44, 56 and 120 are steps", () => {
    const at = (n: number) => weight(`https://example.com/i/${opaque(n)}.jpg`, "blob");
    expect([27, 28, 43, 44, 55, 56, 119, 120].map(at)).toEqual([0, 40, 40, 70, 70, 100, 100, 130]);
  });

  test("a blob cut across segments and parameters adds up", () => {
    const [a, b, c, d] = [opaque(64).slice(0, 14), opaque(64).slice(14, 28), opaque(64).slice(28, 42), opaque(64).slice(42, 56)];
    expect(weight(`https://example.com/${a}/${b}.png?x=${c}&y=${d}`, "blob")).toBe(100);
    expect(weight(`https://example.com/${a}.png`, "blob")).toBe(0);
  });

  test("the same opaque piece twice counts once", () => {
    const name = opaque(30);
    expect(weight(`https://example.com/thumb/${name}.jpg/120px-${name}.jpg`, "blob")).toBe(40);
  });

  test("hash-shaped names are free: MD5, SHA-1, SHA-256, UUID, object id, fingerprint, signed digest, IPFS content id", () => {
    for (const id of [MD5, SHA1, SHA256, SHA256.toUpperCase(), "4f8a2c1d-7b3e-4a6f-9c2d-1e5f8a7b3c4d", "6257adef93867e50d84d30e2", "3f9a2b", "9N_G8FYaBomXUcIDhE--9zBYGK8=", "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"]) {
      expect(score(`https://cdn.example.com/assets/${id}/logo.png`)).toBe(0);
    }
  });

  test("128 hash-shaped characters are free per address; more count as opaque", () => {
    const md5s = (n: number) => `https://example.com/${Array.from({ length: n }, (_, i) => MD5.slice(i) + MD5.slice(0, i)).join("/")}.png`;
    expect([4, 5, 6].map((n) => weight(md5s(n), "blob"))).toEqual([0, 40, 100]);
  });

  test("hex of another length, or in mixed case, is not a hash", () => {
    expect(weight(`https://example.com/${SHA256}${MD5.slice(0, 8)}.png`, "blob")).toBe(100); // 72 hex
    expect(weight(`https://example.com/${SHA256.replace(/[a-f]/g, (c, i: number) => (i % 2 ? c.toUpperCase() : c))}.png`, "blob")).toBe(100);
  });

  test("a long number counts: more than 20 digits in one piece, or more than 60 in all", () => {
    expect(weight(`https://example.com/a.png?n=${"3141592653589793238462643383".repeat(2)}`, "blob")).toBe(100);
    expect(weight("https://cdn.discordapp.com/attachments/1098765432109876543/1198765432109876543/image.png", "blob")).toBe(0);
  });
});

describe("encoded text", () => {
  const text = "the account balance is 48213";

  test("base64, base64url, hex and base32 that decode to readable text ask, wherever they sit", () => {
    for (const run of [btoa(text), btoa(text).replace(/=+$/, ""), hex(text), hex(text).toUpperCase(), "ORUGKIDBMNRW65LOOQQGEYLMMFXGGZJANFZSANBYGIYTG"]) {
      expect(weight(`https://example.com/a.png?v=${run}`, "encoded-text")).toBe(100);
      expect(weight(`https://example.com/img/${run}.png`, "encoded-text")).toBe(100);
    }
  });

  test("text in the shape of a hash or a UUID is still text", () => {
    expect(weight(`https://example.com/${hex("user password is hunter2 ok!!!!!")}.png`, "encoded-text")).toBe(100); // 64 hex, like a SHA-256
    expect(weight("https://example.com/68656c6c-6f20-7365-6372-657420776f72.png", "encoded-text")).toBe(100); // "hello secret wor"
  });

  test("a prefix glued to the run, or separators inside it, do not hide it", () => {
    expect(weight(`https://example.com/img-${btoa(text).replace(/=+$/, "")}.png`, "encoded-text")).toBe(100);
    expect(weight(`https://example.com/x${hex(text)}.png`, "encoded-text")).toBe(100);
    const pieces = btoa(text).replace(/=+$/, "").match(/.{1,10}/g)!;
    for (const separator of [".", ",", "~", ";", "!", "*", "/"]) {
      expect(weight(`https://example.com/${pieces.join(separator)}`, "encoded-text")).toBe(100);
    }
    expect(weight(`https://example.com/a.png?${pieces.map((piece, i) => `p${i}=${piece}`).join("&")}`, "encoded-text")).toBe(100);
  });

  test("a real hash, a signature and repeated decimals are not text", () => {
    expect(weight(`https://example.com/${SHA256}.png`, "encoded-text")).toBe(0);
    expect(weight(`https://example.com/${opaque(40)}.png`, "encoded-text")).toBe(0);
    expect(score("https://example.com/file/25840497/a.jpg?crop=16.666666666667%2C0%2C66.666666666667%2C100&w=2400")).toBe(0);
  });

  test("an encoded run that is exactly an image's file path is judged as that path, not as text", () => {
    expect(score(`https://img.itch.zone/${btoa("img/31430110.jpg")}/350x196%23c/Zu2lqP.jpg`)).toBe(0);
    expect(weight(`https://img.itch.zone/${btoa("the pin is 4321.jpg")}/a.jpg`, "encoded-text")).toBe(100);
  });
});

describe("text and personal data", () => {
  test("words in query values: a phrase of 3, 4 and 6 words are steps; keywords are free", () => {
    const words = ["red", "blue", "green", "pink", "gold", "gray"];
    const phrase = (n: number) => weight(`https://example.com/a.png?q=${words.slice(0, n).join("+")}`, "text-query");
    expect([2, 3, 4, 5, 6].map(phrase)).toEqual([0, 30, 60, 60, 100]);
    expect(score("https://images.example.com/a.jpg?auto=format&fit=crop&crop=faces&fm=jpg&cs=tinysrgb")).toBe(0);
    expect(score("https://example.com/a.png?lang=en&name=large&parser=parsoid")).toBe(0);
  });

  test("one-word values add up once there are more than three of them", () => {
    expect(weight("https://example.com/a.png?a=jordan&b=lee&c=salary", "text-query")).toBe(0);
    expect(weight("https://example.com/a.png?a=jordan&b=lee&c=salary&d=bonus&e=stock&f=options", "text-query")).toBe(30);
  });

  test("a value that is a path is judged as path", () => {
    expect(score("https://example.com/_next/image?url=%2Ffront-static%2Fpages%2Fhome%2Fteams-agents-hero%2Fpile_1.webp&w=640")).toBe(0);
  });

  test("different words in the path: 16, 20 and 24 are steps", () => {
    const all = "zebra quartz violin harbor meadow copper lantern orchid falcon timber saffron glacier pebble walnut crimson anchor thistle marble ember juniper willow cobalt prairie magnet".split(" ");
    const slug = (n: number) => weight(`https://example.com/${all.slice(0, n).join("-")}.png`, "text-path");
    expect([15, 16, 19, 20, 23, 24].map(slug)).toEqual([0, 40, 40, 60, 60, 100]);
    expect(weight(`https://example.com/${all.slice(0, 12).join("-")}/${all.slice(0, 12).join("_")}.png`, "text-path")).toBe(0); // the same words twice
  });

  test("an email address, but not a file named @2x", () => {
    expect(weight("https://example.com/p.gif?e=jordan@example.com", "email")).toBe(100);
    expect(weight("https://example.com/p.gif?e=jordan%40example.com", "email")).toBe(100);
    expect(weight("https://example.com/img/logo@2x.png", "email")).toBe(0);
    expect(weight("https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f600.png", "email")).toBe(0);
  });

  test("key and token shapes", () => {
    // Made-up values, put together here so that no key-shaped literal sits in the source.
    const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"].join(".");
    for (const value of [jwt, ["sk", "proj", opaque(24)].join("-"), ["ghp", opaque(36)].join("_"), "AKIAIOSFODNN7EXAMPLE"]) {
      expect(weight(`https://example.com/a.png?k=${value}`, "secret")).toBe(100);
    }
  });

  test("serialized data and a parameter named for a payload", () => {
    expect(weight(`https://example.com/a.png?d=${encodeURIComponent('{"a":1}')}`, "structured-data")).toBe(80);
    expect(weight("https://example.com/a.png?prompt=hello", "payload-param")).toBe(40);
    expect(weight("https://example.com/a.png?size=large", "payload-param")).toBe(0);
  });
});

describe("the query and the escapes", () => {
  test("parameters: 8 are ordinary, each one more weighs more", () => {
    const params = (n: number, separator = "&") => `https://example.com/a.png?${Array.from({ length: n }, (_, i) => `p${i}=1`).join(separator)}`;
    expect([8, 9, 10, 14].map((n) => weight(params(n), "params"))).toEqual([0, 30, 45, 105]);
    expect(weight(params(9, ";"), "params")).toBe(30);
  });

  test("tracking parameters and pixel paths", () => {
    expect(weight("https://example.com/a.png?utm_source=newsletter", "tracking")).toBe(30);
    expect(weight("https://example.com/track/open.gif", "tracking")).toBe(30);
    expect(weight("https://example.com/images/open-source.png", "tracking")).toBe(0);
  });

  test("letters and digits written as %XX: one or two, then three or more", () => {
    expect(weight("https://example.com/a.png?q=%41", "escaped-plain")).toBe(60);
    expect(weight("https://example.com/a.png?q=%41%42%43", "escaped-plain")).toBe(100);
    expect(weight("https://example.com/Caf%C3%A9%20de%20Flore.jpg", "escaped-plain")).toBe(0);
  });

  test("escapes that are not text: up to three (an old Latin-1 file name), then more", () => {
    expect(weight("https://example.com/caf%E9.jpg", "binary")).toBe(60);
    expect(weight("https://example.com/a.png?d=%8f%a2%c1%ff%00", "binary")).toBe(100);
  });

  test("a % that is not an escape is a small sign, not a reason to ask", () => {
    expect(score("https://example.com/100%.png")).toBe(20);
  });

  test("length of path and query: 300 and 600 are steps", () => {
    const long = (n: number) => weight(`https://example.com/${"ab-".repeat(n / 3)}`, "long");
    expect([297, 300, 597, 600].map(long)).toEqual([0, 40, 40, 100]);
  });
});

describe("signed URLs, recognised by grammar", () => {
  const sigv4 = "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20261118%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261118T120000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host";

  test("a complete, well-formed signature loads with no reasons, on any host", () => {
    expect(score(`https://my-bucket.s3.amazonaws.com/photo.jpg?${sigv4}&X-Amz-Signature=${SHA256}`)).toBe(0);
    expect(score(`https://files.example.com/photo.jpg?${sigv4}&X-Amz-Signature=${SHA256}`)).toBe(0);
  });

  test("a missing or malformed part means the parameters are judged like any others", () => {
    expect(kind(`https://my-bucket.s3.amazonaws.com/photo.jpg?${sigv4}&X-Amz-Signature=${SHA256}${MD5}`)).toBe("ask");
    expect(kind(`https://my-bucket.s3.amazonaws.com/photo.jpg?${sigv4.replace("host", "host;x-data-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")}&X-Amz-Signature=${SHA256}`)).toBe("ask");
    expect(kind(`https://my-bucket.s3.amazonaws.com/photo.jpg?${sigv4}&X-Amz-Signature=${SHA256}&X-Amz-Signature=${SHA256.toUpperCase()}${MD5}`)).toBe("ask");
  });

  test("a signature that decodes to text is not a signature", () => {
    expect(weight(`https://my-bucket.s3.amazonaws.com/photo.jpg?${sigv4}&X-Amz-Signature=${hex("the balance is 48213 dollars ok!")}`, "encoded-text")).toBe(100);
  });

  test("anything beside the signature is judged: a session token asks", () => {
    expect(kind(`https://my-bucket.s3.amazonaws.com/photo.jpg?${sigv4}&X-Amz-Signature=${SHA256}&X-Amz-Security-Token=${opaque(128)}`)).toBe("ask");
  });
});

describe("image CDNs that name files by opaque ids", () => {
  const id = opaque(100);

  test("a long id loads there and asks elsewhere", () => {
    expect(score(`https://lh3.googleusercontent.com/pw/${id}=w1200-h800-s-no`)).toBe(0);
    expect(kind(`https://cdn.example.com/pw/${id}=w1200-h800-s-no`)).toBe("ask");
    expect(kind(`https://script.googleusercontent.com/macros/echo?user_content_key=${id}`)).toBe("ask");
  });

  test("everything else is still judged there", () => {
    expect(kind(`https://user:pw@lh3.googleusercontent.com/pw/${id}`)).toBe("ask");
    expect(kind(`https://images.unsplash.com/photo-1?mark=https://203.0.113.9/a.png`)).toBe("ask");
    expect(weight("https://images.unsplash.com/photo-1?next=https://x.example/a", "redirect")).toBe(100);
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

  test("exactly four sites leave one uncounted", () => {
    expect(title(4, ["c.example", "d.example", "e.example", "f.example"])).toBe(
      "Load 4 more images from c.example, d.example, e.example and 1 more site?",
    );
  });

  test("past three sites, the rest are counted", () => {
    expect(title(5, ["c.example", "d.example", "e.example", "f.example", "g.example"])).toBe(
      "Load 5 more images from c.example, d.example, e.example and 2 more sites?",
    );
  });
});
