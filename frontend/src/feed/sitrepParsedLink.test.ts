/**
 * The secret guard tests what a browser would open, not only the text as written: a one-tap approval link spelled with
 * a default port, dot segments, backslashes, a fullwidth or ideographic dot, a soft hyphen, `%2E` in the host, a
 * trailing dot, or a tab inside it parses to the same address, so each is refused in the same places the plain link is.
 */
import { expect, test } from "bun:test";
import { findRecordSecrets, findSecrets, linkify, redactSecrets } from "@tinyboilerplate/core/feed/sitrep";

const KEY = "a".repeat(26);
const SPELLINGS: Record<string, string> = {
  "default port": `https://openkey.so:443/a/${KEY}`,
  "dot segment": `https://openkey.so/./a/${KEY}`,
  backslashes: `https://openkey.so\\a\\${KEY}`,
  "backslash after the scheme": `https:\\\\openkey.so\\a\\${KEY}`,
  "fullwidth dot": `https://openkey\uFF0Eso/a/${KEY}`,
  "ideographic dot": `https://openkey\u3002so/a/${KEY}`,
  "soft hyphen": `https://open\u00ADkey.so/a/${KEY}`,
  "percent-encoded dot in the host": `https://openkey%2Eso/a/${KEY}`,
  "trailing dot in the host": `https://openkey.so./a/${KEY}`,
  "upper case host": `https://OPENKEY.SO/a/${KEY}`,
  "tab inside the link": `https://openkey.so/a/\t${KEY}`,
  "newline inside the link": `https://openkey.so/\na/${KEY}`,
  "a path with no key characters after /a/": "https://openkey.so/a/%2e",
  "percent-encoded a": `https://openkey.so/%61/${KEY}`,
  "percent-encoded capital A": `https://openkey.so/%41/${KEY}`,
  "empty first segment": `https://openkey.so//a/${KEY}`,
  "encoded slash after a": `https://openkey.so/a%2F${KEY}`,
  "a subdomain of openkey.so": `https://www.openkey.so/a/${KEY}`,
  "a path that does not decode": `https://openkey.so/a/%E0%A4%A${KEY}`,
};

test("a one-tap link in any spelling is refused as a field, inside text, and as a card link", () => {
  for (const [name, link] of Object.entries(SPELLINGS)) {
    expect(findSecrets(link), `${name}: as a field`).toHaveLength(1);
    // Inside text, a tab or newline splits the word, so those two are tested as fields only.
    if (!/[\t\n]/.test(link)) expect(findSecrets(`Open ${link} to approve.`), `${name}: in text`).toHaveLength(1);
    expect(findRecordSecrets("ask", { links: [{ label: "Approve", url: link }] }).map((found) => found.path), `${name}: card link`).toEqual(["links.0.url"]);
  }
});

test("such a link never becomes a link chip, and redacting the text removes it", () => {
  for (const [name, link] of Object.entries(SPELLINGS)) {
    if (/[\t\n]/.test(link)) continue;
    expect(linkify(`See ${link}`).some((part) => "href" in part), `${name}: chip`).toBe(false);
    const redacted = redactSecrets(`See ${link} now`);
    expect(findSecrets(redacted), `${name}: redacted`).toEqual([]);
    expect(redacted, `${name}: redacted text`).not.toContain(KEY);
  }
});

test("ordinary links, OpenKey's own pages and a real approval's consent page are untouched", () => {
  for (const link of ["https://github.com/TinyCloudLabs/tinychat/pull/769", "https://linear.app/tinycloud-labs/issue/TC-3242", "https://openkey.so/", "https://openkey.so/about", "https://example.com:443/a/page"]) {
    expect(findSecrets(link), link).toEqual([]);
    expect(findSecrets(`Details at ${link}.`), link).toEqual([]);
  }
  expect(linkify("PR https://github.com/TinyCloudLabs/tinychat/pull/769").some((part) => "href" in part)).toBe(true);
  expect(findRecordSecrets("approval", { url: "https://openkey.so/delegate?user_code=ABCD-1234" })).toEqual([]);
});
