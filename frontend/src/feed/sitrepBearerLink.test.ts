/**
 * An OpenKey one-tap approval link holds a bearer key in its fragment. It is not an approval link a card may carry, so
 * the board's secret guard (the check every board write goes through) refuses it in every field of every kind of card.
 */
import { expect, test } from "bun:test";
import { findRecordSecrets } from "@tinyboilerplate/core/feed/sitrep";

const LINK = `https://openkey.so/a/${"a".repeat(26)}#v=4&k=${"A".repeat(43)}&c=bafkrei${"a".repeat(52)}`;

test("a one-tap approval link is refused in a card's text, its links and its title, on every kind, bare or inside other text", () => {
  for (const kind of ["ask", "incident", "work", "ship", "approval"]) {
    expect(findRecordSecrets(kind, { body: `Open ${LINK} to approve.` }).map((found) => found.path), `${kind} body`).toEqual(["body"]);
    expect(findRecordSecrets(kind, { links: [{ label: "Approve", url: LINK }] }).map((found) => found.path), `${kind} links`).toEqual(["links.0.url"]);
  }
  expect(findRecordSecrets("ask", { title: `https://openkey.so/a/${"a".repeat(26)}` }).map((found) => found.path)).toEqual(["title"]);
});

test("an approval cannot take a one-tap link as its own link, while an OpenKey consent page still is its link", () => {
  expect(findRecordSecrets("approval", { url: LINK }).map((found) => found.path)).toEqual(["url"]);
  expect(findRecordSecrets("approval", { url: "https://openkey.so/delegate?user_code=ABCD-1234" })).toEqual([]);
});
