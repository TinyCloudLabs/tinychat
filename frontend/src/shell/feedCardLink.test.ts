import { describe, expect, test } from "bun:test";

import { FEED_ALIAS_PATH, PATHS, feedAliasTarget, feedCardPath, feedCardTarget, screenFor } from "./routes";

const ID = "3f2b8c1e-6a4d-5e07-9b1c-0d4e7a8f2c33";

describe("the address of one Feed card", () => {
  test("a card's address round-trips, and is always under the Feed", () => {
    expect(feedCardPath(ID)).toBe(`/chat/feed/${ID}`);
    expect(feedCardTarget(feedCardPath(ID))).toBe(ID);
    expect(screenFor(feedCardPath(ID))).toEqual({ id: "feed", destination: "feed", noteId: null });
  });

  test("a trailing slash and capital letters still name the card, as the lowercase id", () => {
    expect(feedCardTarget(`${feedCardPath(ID)}/`)).toBe(ID);
    expect(feedCardTarget(`/chat/feed/${ID.toUpperCase()}`)).toBe(ID);
  });

  test("anything that is not exactly one card id is the plain Feed", () => {
    for (const pathname of [
      PATHS.feed, `${PATHS.feed}/`, `${PATHS.feed}/not-a-card`, `${PATHS.feed}/${ID}/more`, `${PATHS.feed}//${ID}`, `${PATHS.feed}/${ID}x`,
      `${PATHS.feed}/${ID.slice(1)}`, `${PATHS.feed}/https://evil.example/`, `${PATHS.feed}/javascript:alert(1)`, `${PATHS.feed}/%2F%2Fevil.example`,
      `${PATHS.feed}/%E0%A4%A`, `${PATHS.feed}/%`, `/chat/apps/${ID}`, `/chat/${ID}`, `/feed/${ID}`,
    ]) expect(feedCardTarget(pathname), pathname).toBeNull();
  });

  test("a card id is never read back out of a path that merely contains one", () => {
    expect(feedCardTarget(`/chat/feed/${ID}?next=https://evil.example`)).toBeNull();
    expect(feedCardTarget(`/chat/feed/${ID}#x`)).toBeNull();
  });
});

describe("the short address", () => {
  test("/feed/<card id> names the same card as /chat/feed/<card id>", () => {
    expect(FEED_ALIAS_PATH).toBe("/feed");
    expect(feedAliasTarget(ID)).toBe(feedCardPath(ID));
    expect(feedAliasTarget(ID.toUpperCase())).toBe(feedCardPath(ID));
  });

  test("anything else lands on the plain Feed, and never carries the text onward", () => {
    for (const segment of [undefined, "", "not-a-card", "https://evil.example", "//evil.example", "javascript:alert(1)", "%E0%A4%A", `${ID}/x`]) {
      expect(feedAliasTarget(segment), String(segment)).toBe(PATHS.feed);
    }
  });
});
