import { describe, expect, test } from "bun:test";
import { parseFeed } from "./feedData";

const post = { v: 1, id: "one", at: "2026-10-25T12:00:00Z", author: { name: "Aster" }, render: "post", lead: "A little note." };

describe("sample feed parser", () => {
  test("accepts five card kinds and strips unrecognized fields", () => {
    const cards = parseFeed([
      { ...post, secret: "discard", author: { name: "Aster", extra: "discard" } },
      { ...post, id: "two", render: "image", image: { src: "/home-feed-shapes.svg", alt: "Shapes" } },
      { ...post, id: "three", render: "thread", replies: [{ author: "Birch", text: "Reply", at: post.at }] },
      { ...post, id: "four", render: "article", title: "An article", summary: "Summary", markdown: "**Details**" },
      { ...post, id: "five", render: "link", url: "https://example.org/story", tldr: "A short summary" },
    ]);
    expect(cards.map((card) => card.render)).toEqual(["post", "image", "thread", "article", "link"]);
    expect(cards[0]).toEqual(post);
    expect(cards[2]?.replies).toEqual([{ author: "Birch", text: "Reply", at: post.at }]);
  });

  test("skips malformed cards without throwing", () => {
    expect(parseFeed([null, 42, { ...post, render: "video" }, { ...post, at: "tomorrow" }, { ...post, author: {} }, post])).toEqual([post]);
    expect(parseFeed({ cards: [post] })).toEqual([]);
  });

  test("unsafe links become plain text and remote images do not load", () => {
    const [link, image] = parseFeed([
      { ...post, render: "link", url: "javascript:alert(1)", source: { label: "Outside", url: "data:text/html,hello" } },
      { ...post, id: "two", render: "image", image: { src: "https://example.org/track.png", alt: "Remote" }, author: { name: "Aster", avatar: "//example.org/avatar" } },
    ]);
    expect(link?.url).toBe("javascript:alert(1)");
    expect(link?.source).toEqual({ label: "Outside" });
    expect(image?.image).toBeUndefined();
    expect(image?.author.avatar).toBeUndefined();
  });
});
