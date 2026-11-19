import { describe, expect, test } from "bun:test";

import { addressBits, signedShape } from "./imageAddressBits";

const bits = (address: string, seen = new Set<string>()) => addressBits(new URL(address), seen);

/** Bytes with no pattern: data as it looks once encrypted or compressed. Deterministic. */
function noise(length: number, seed: number): number[] {
  let state = (seed * 2654435761) >>> 0 || 1;
  return Array.from({ length }, () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state & 0xff;
  });
}
/** `bytes` as one big number written in the given alphabet: exactly 8 bits of payload per byte. */
function inAlphabet(bytes: number[], alphabet: string | string[]): string[] {
  let value = bytes.reduce((n, byte) => n * 256n + BigInt(byte), 1n); // the leading 1 keeps leading zero bytes
  const out: string[] = [];
  for (const base = BigInt(alphabet.length); value > 0n; value /= base) out.push(alphabet[Number(value % base)]!);
  return out;
}
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const BASE62 = `0123456789${LOWER}${LOWER.toUpperCase()}`;
const hexOf = (bytes: number[]) => bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");

describe("what a character costs", () => {
  const over = (address: string) => bits(address) - bits("https://a.io/");

  test("more letters, digits or opaque characters cost more; nothing is free", () => {
    expect(over("https://a.io/zebra")).toBeGreaterThan(20);
    expect(over("https://a.io/zebrafinch")).toBeGreaterThan(over("https://a.io/zebra") + 20);
    expect(over("https://a.io/7")).toBeGreaterThan(8);
    expect(over("https://a.io/77777777")).toBeGreaterThan(over("https://a.io/7") + 20);
    expect(over("https://a.io/~")).toBeGreaterThan(0);
  });

  test("by alphabet: a digit costs less than a letter, a letter less than a mixed-case or mixed letter-and-digit character", () => {
    const perChar = (piece: string) => over(`https://a.io/${piece}${piece}`) - over(`https://a.io/${piece}`);
    const digits = perChar("73915826") / 8;
    const hex = perChar("3f9a2b7c") / 8;
    const letters = perChar("zqwmxkvb") / 8;
    const base36 = perChar("x7k2m9p4") / 8;
    const base62 = perChar("X7k2M9p4") / 8;
    expect(digits).toBeCloseTo(Math.log2(11), 1);
    expect(hex).toBeCloseTo(Math.log2(17), 1);
    expect(letters).toBeCloseTo(Math.log2(27), 1);
    expect(base36).toBeCloseTo(Math.log2(37), 1);
    expect(base62).toBeCloseTo(Math.log2(63), 1);
  });

  test("a common URL word costs an index, whatever its length; an unknown word costs its letters", () => {
    expect(over("https://a.io/thumbnails")).toBeLessThan(over("https://a.io/zebra"));
    expect(over("https://a.io/thumbnails")).toBeCloseTo(over("https://a.io/png"), 5);
    expect(over("https://a.io/Thumbnails")).toBeCloseTo(over("https://a.io/thumbnails"), 5);
    expect(over("https://a.io/thumbnailz")).toBeGreaterThan(over("https://a.io/thumbnails") + 30);
  });

  test("characters outside ASCII cost by block: a CJK ideograph about 15 bits, a Cyrillic letter about 9", () => {
    const cjk = (n: number) => over(`https://a.io/${encodeURIComponent("富士山河海空森林".slice(0, n))}`);
    expect(cjk(8) - cjk(4)).toBeCloseTo(60, 5);
    const cyrillic = (n: number) => over(`https://a.io/${encodeURIComponent("москванч".slice(0, n))}`);
    expect(cyrillic(8) - cyrillic(4)).toBeCloseTo(36, 5);
    expect(over(`https://a.io/${encodeURIComponent("😀😁😂🤣")}`)).toBeGreaterThan(4 * 21);
  });

  test("the whole host name is charged, digits and all, and so is a port", () => {
    expect(bits("https://4471902265.a.io/")).toBeGreaterThan(bits("https://a.io/") + 10 * 3.4);
    expect(bits("https://zqwmxkvbtnrh.pages.dev/")).toBeGreaterThan(bits("https://a.pages.dev/") + 11 * 4.7);
    expect(bits("https://a.io:8443/")).toBeGreaterThan(bits("https://a.io/") + 16);
  });

  test("the fragment is not charged: it is never sent", () => {
    expect(bits("https://a.io/zebra#Xk3p9Qw7Rm2Tz8LbN4cWfYd6")).toBe(bits("https://a.io/zebra"));
  });
});

describe("what has been seen costs an index", () => {
  test("a piece repeated in one address", () => {
    const once = bits("https://a.io/zebrafinch.png");
    expect(bits("https://a.io/zebrafinch/zebrafinch.png")).toBeLessThan(once + 12);
  });

  test("a host, a folder and a UUID that an earlier image of the reply sent", () => {
    const first = "https://cdn.zebrafinch.example/gallery/4f8a2c1d-7b3e-4a6f-9c2d-1e5f8a7b3c4d/one.png";
    const second = "https://cdn.zebrafinch.example/gallery/4f8a2c1d-7b3e-4a6f-9c2d-1e5f8a7b3c4d/two.png";
    const seen = new Set<string>();
    const alone = bits(second);
    bits(first, seen);
    expect(bits(second, seen)).toBeLessThan(alone / 3);
  });

  test("but never nothing: the index grows with what has been seen", () => {
    const seen = new Set<string>();
    bits("https://a.io/zebra.png", seen);
    const again = bits("https://a.io/zebra.png", seen);
    expect(again).toBeGreaterThan(20);
    for (let i = 0; i < 40; i++) bits(`https://a.io/${LOWER.slice(i % 20, (i % 20) + 6)}${i}.png`, seen);
    expect(bits("https://a.io/zebra.png", seen)).toBeGreaterThan(again);
  });
});

describe("how it was escaped", () => {
  /** What one exception to a habit costs among `places` where it could be. */
  const exception = (places: number) => 1 + Math.log2(places + 1);

  test("an escape the browser would write anyway is no choice", () => {
    // A space and a non-ASCII letter must be escaped: the escapes add nothing to what the characters cost.
    expect(bits("https://a.io/a%20b")).toBe(bits("https://a.io/a,b"));
    expect(bits("https://a.io/caf%C3%A9%C3%A9") - bits("https://a.io/caf%C3%A9")).toBeCloseTo(9, 5);
  });

  test("a letter or digit written as %XX is an exception each time", () => {
    expect(bits("https://a.io/%7A%65bra") - bits("https://a.io/zebra")).toBeCloseTo(2 * exception(5), 5);
  });

  test("punctuation may all be escaped or all be left; each exception to the habit is charged", () => {
    expect(bits("https://a.io/x?a%2Cb%2Cc")).toBe(bits("https://a.io/x?a,b,c"));
    expect(bits("https://a.io/x?a%2Cb,c") - bits("https://a.io/x?a,b,c")).toBeCloseTo(exception(2), 5);
    // The separators are punctuation like any other: "%2F" where "/" would do is a choice.
    expect(bits("https://a.io/a%2Fb") - bits("https://a.io/a/b")).toBeCloseTo(exception(2), 5);
    expect(bits("https://a.io/x?u=https%3A%2F%2Fb.io%2Fc.png") - bits("https://a.io/x?u=https://b.io/c.png")).toBeCloseTo(exception(5), 5);
  });

  test("a % that is not an escape is not the same address as %25", () => {
    expect(bits("https://a.io/x?a%25b%c")).toBeGreaterThan(bits("https://a.io/x?a%25b%25c"));
  });

  test("the case of the hex digits is charged when it is mixed", () => {
    expect(bits("https://a.io/x?a%2cb%2Cc") - bits("https://a.io/x?a%2Cb%2Cc")).toBeCloseTo(exception(2), 5);
  });

  test("bytes that are not UTF-8 are charged as bytes, and never as the text they resemble", () => {
    expect(bits("https://a.io/caf%E9")).toBeGreaterThan(bits("https://a.io/caf%C3%A9"));
    expect(bits("https://a.io/%E4%B8%E4%B8") - bits("https://a.io/%E4%B8")).toBeGreaterThanOrEqual(16);
  });

  test("where the query starts is part of the address: an escaped ? in the path is not the ? that starts a query", () => {
    expect(bits("https://a.io/a%3Fb")).not.toBe(bits("https://a.io/a?b"));
    expect(bits("https://a.io/a%3Fb?c")).toBeGreaterThan(bits("https://a.io/a?bc"));
  });
});

describe("shapes that are charged by their grammar", () => {
  test("a UUID is 128 bits, in either case", () => {
    const uuid = "4f8a2c1d-7b3e-4a6f-9c2d-1e5f8a7b3c4d";
    const cost = bits(`https://a.io/${uuid}`) - bits("https://a.io/");
    expect(cost).toBeGreaterThanOrEqual(128);
    expect(cost).toBeLessThan(140);
    expect(bits(`https://a.io/${uuid.toUpperCase()}`)).toBe(bits(`https://a.io/${uuid}`));
  });

  test("text written as hex costs what the text costs, not twice that", () => {
    const text = "https://img.shields.io/npm/v/next.svg?style=flat";
    const asHex = bits(`https://a.io/${hexOf(Array.from(text, (char) => char.charCodeAt(0)))}`);
    expect(asHex).toBeLessThan(bits(`https://a.io/${hexOf(noise(text.length, 3))}`) - 80);
    expect(asHex).toBeGreaterThan(bits("https://a.io/") + 150);
  });

  const sigv4 = (signature: string, keyId = "AKIAIOSFODNN7EXAMPLE") =>
    `X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${keyId}%2F20261118%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261118T120000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=${signature}`;

  test("a complete AWS Signature V4 is charged its fields, about 550 bits, not its text", () => {
    const signed = bits(`https://a.io/p.jpg?${sigv4(hexOf(noise(32, 5)))}`) - bits("https://a.io/p.jpg");
    expect(signed).toBeGreaterThan(256 + 103 + 46); // the signature, the key id and the date at the very least
    expect(signed).toBeLessThan(600);
    // One field off its grammar and the whole query is text again.
    const asText = bits(`https://a.io/p.jpg?${sigv4(hexOf(noise(33, 5)))}`) - bits("https://a.io/p.jpg");
    expect(asText).toBeGreaterThan(1000);
  });

  test("the names must be exact and each present once", () => {
    const params = (query: string) => query.split("&").map((param) => param.split("=").map(decodeURIComponent) as [string, string]);
    const good = sigv4(hexOf(noise(32, 5)));
    expect(signedShape(params(good))?.bits).toBe(520);
    expect(signedShape(params(good.replace("X-Amz-Signature", "x-amz-signature")))).toBeUndefined();
    expect(signedShape(params(`${good}&X-Amz-Expires=1`))).toBeUndefined();
    expect(signedShape(params(good.replace("us-east-1", "zqwmxkvbtnrhdjsl")))).toBeUndefined();
    expect(signedShape(params(`${good}&x-id=GetObject`))?.names.has("x-id")).toBe(true);
  });
});

// Each case puts a known number of random bits into an address some way, and the charge must be at least that number.
describe("the charge is never less than what the address holds", () => {
  const payload = noise(96, 11); // 768 bits
  const carried = payload.length * 8;
  const letters = inAlphabet(payload, LOWER).join("");
  const cut = (text: string, size: number) => text.match(new RegExp(`.{1,${size}}`, "g")) ?? [];

  const cases: Record<string, string> = {
    "hex in the path": `https://e.example/${hexOf(payload)}.png`,
    "upper-case hex in a query value": `https://e.example/a.png?v=${hexOf(payload).toUpperCase()}`,
    "base62 in the path": `https://e.example/${inAlphabet(payload, BASE62).join("")}.png`,
    "base62 in a query key": `https://e.example/a.png?${inAlphabet(payload, BASE62).join("")}=1`,
    "decimal digits": `https://e.example/a.png?n=${inAlphabet(payload, "0123456789").join("")}`,
    "one long run of lower-case letters": `https://e.example/${letters}.png`,
    "made-up lower-case words of 11 letters": `https://e.example/${cut(letters, 11).join("-")}.png`,
    "made-up words as folders": `https://e.example/${cut(letters, 7).join("/")}/a.png`,
    "made-up words as one- and two-word query keys": `https://e.example/a.png?${cut(letters, 6).map((word, i) => `${word}=${i % 3}`).join("&")}`,
    "capitalised and upper-case words": `https://e.example/${cut(letters, 8).map((word, i) => (i % 2 ? word.toUpperCase() : word[0]!.toUpperCase() + word.slice(1))).join("_")}.png`,
    "mixed-case letters": `https://e.example/${inAlphabet(payload, LOWER + LOWER.toUpperCase()).join("")}.png`,
    "digit groups in subdomain labels": `https://${cut(inAlphabet(payload, "0123456789").join(""), 10).join("-").match(/.{1,60}(?:-|$)/g)!.map((label) => label.replace(/-$/, "")).join(".")}.e.example/a.png`,
    "hex in subdomain labels": `https://${cut(hexOf(payload), 60).join(".")}.e.example/a.png`,
    "letters in the name of a free hosting tenant": `https://${cut(letters, 50).join(".")}.pages.dev/a.png`,
    "CJK ideographs": `https://e.example/${encodeURIComponent(inAlphabet(payload, Array.from({ length: 16384 }, (_, i) => String.fromCharCode(0x4e00 + i))).join(""))}.png`,
    "Cyrillic letters": `https://e.example/${encodeURIComponent(inAlphabet(payload, Array.from("абвгдежзийклмнопрстуфхцчшщъыьэюя")).join(""))}.png`,
    "UUIDs": `https://e.example/${cut(hexOf(payload), 32).map((id) => id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5")).join("/")}`,
    "a path, a query and a host together": `https://${hexOf(payload.slice(0, 24))}.e.example/${inAlphabet(payload.slice(24, 60), BASE62).join("")}?${cut(inAlphabet(payload.slice(60), LOWER).join(""), 9).join("=1&")}`,
    "inside an address inside the address": `https://e.example/fetch?url=${encodeURIComponent(`https://cdn.e.example/${inAlphabet(payload, BASE62).join("")}.png`)}`,
    "hex of hex": `https://e.example/${hexOf(Array.from(hexOf(payload.slice(0, 48)), (char) => char.charCodeAt(0)))}${hexOf(payload.slice(48))}`,
  };

  test.each(Object.entries(cases))("%s", (_name, address) => {
    expect(bits(address)).toBeGreaterThanOrEqual(carried);
  });

  test("a made-up signature: the signature and the key id are charged in full", () => {
    const signature = hexOf(noise(32, 21));
    const keyId = inAlphabet(noise(12, 22), "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ").join("").padEnd(20, "A").slice(0, 20);
    const address = `https://e.example/a.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${keyId}%2F20261118%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261118T120000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=${signature}`;
    expect(signedShape([...new URL(address).searchParams])).toBeDefined();
    expect(bits(address) - bits("https://e.example/a.png")).toBeGreaterThanOrEqual(256 + 96);
  });

  test("escaping chosen letter by letter: one bit carried per letter costs at least that", () => {
    const flags = noise(8, 31).flatMap((byte) => Array.from({ length: 8 }, (_, i) => (byte >> i) & 1));
    const word = LOWER.repeat(3).slice(0, flags.length);
    const address = `https://e.example/${Array.from(word, (char, i) => (flags[i] ? `%${char.charCodeAt(0).toString(16)}` : char)).join("")}.png`;
    expect(bits(address) - bits(`https://e.example/${word}.png`)).toBeGreaterThanOrEqual(flags.length);
  });

  test("spread over the images of a reply, with everything already seen: the total is still at least what was carried", () => {
    const seen = new Set<string>();
    const pieces = cut(inAlphabet(payload, BASE62).join(""), 8);
    const total = pieces.reduce((sum, piece, i) => sum + bits(`https://e.example/gallery/${piece}/${i % 2 ? "a" : "b"}.png`, seen), 0);
    expect(total).toBeGreaterThanOrEqual(carried);
  });

  // A piece that happens to be 36 units long, like a UUID.
  const pick = (alphabet: string[], count: number, seed: number) =>
    noise(count * 2, seed).reduce((text, byte, i, bytes) => (i % 2 ? text + alphabet[((bytes[i - 1]! << 8) | byte) % alphabet.length]! : text), "");
  const han = Array.from({ length: 16384 }, (_, i) => String.fromCharCode(0x4e00 + i));
  const extensionB = Array.from({ length: 4096 }, (_, i) => String.fromCodePoint(0x20000 + i));

  test("a piece that is as long as a UUID but is not one is charged for what it holds", () => {
    const over = (piece: string) => bits(`https://e.example/${encodeURIComponent(piece)}.png`) - bits("https://e.example/.png");
    expect(over(pick(BASE62.split(""), 36, 41))).toBeGreaterThanOrEqual(36 * Math.log2(62));
    expect(over(pick(han, 36, 42))).toBeGreaterThanOrEqual(36 * 14);
    // 36 UTF-16 units, 32 characters: four outside the basic plane and 28 inside it.
    expect(over(pick(extensionB, 4, 43) + pick(han, 28, 44))).toBeGreaterThanOrEqual(4 * 12 + 28 * 14);
    expect(over(pick(extensionB, 18, 45))).toBeGreaterThanOrEqual(18 * 12);
  });

  test("2,000 random addresses of mixed pieces: none is charged less than the random choices in it", () => {
    const alphabets = [
      LOWER.split(""),
      (LOWER + LOWER.toUpperCase()).split(""),
      BASE62.split(""),
      "0123456789abcdef".split(""),
      "0123456789".split(""),
      han,
      extensionB,
      Array.from({ length: 400 }, (_, i) => String.fromCharCode(0xc0 + i)), // Latin with diacritics
      Array.from({ length: 512 }, (_, i) => String.fromCodePoint(0x1f300 + i)), // emoji
    ];
    let state = 20261119;
    const below = (limit: number) => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state % limit;
    };
    let lowest = Infinity;
    for (let i = 0; i < 2000; i++) {
      let carried = 0;
      const part = (pieces: number, separators: string) => {
        let text = "";
        for (let n = 0; n < pieces; n++) {
          const alphabet = alphabets[below(alphabets.length)]!;
          const length = 1 + below(40);
          carried += length * Math.log2(alphabet.length);
          text += (n ? separators[below(separators.length)] : "") + encodeURIComponent(Array.from({ length }, () => alphabet[below(alphabet.length)]).join(""));
        }
        return text;
      };
      const address = `https://e.example/${part(1 + below(5), "/-._")}${below(2) ? `?${part(1 + below(3), "=&")}` : ""}`;
      lowest = Math.min(lowest, bits(address) / carried);
    }
    expect(lowest).toBeGreaterThanOrEqual(1);
  });
});
