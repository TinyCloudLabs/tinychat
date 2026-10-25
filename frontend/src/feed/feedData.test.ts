import { describe, expect, test } from "bun:test";
import * as feedData from "./feedData";
const { parseFeed } = feedData;

const key = "aster/2026-10/2026-10-25T120000Z-note";
const card = { v: 1, at: "2026-10-25T12:00:00Z", render: "post", lead: { text: "A little note." } };
const entry = (value: unknown, path = key) => ({ key: path, value });
const profile = entry({ v: 1, name: "Aster agent", client: "claude-code", about: "A sample" }, "aster/profile");

describe("KV feed entries", () => {
  test("joins a bot profile to cards and strips unknown fields", () => {
    const [post] = parseFeed([profile, entry({ ...card, secret: "discard", lead: { text: "A little note.", extra: "discard", image: "aster/assets/note.svg" } })]);
    expect(post).toEqual({ key, at: card.at, author: { name: "Aster agent" }, render: "post", lead: { text: "A little note.", image: "aster/assets/note.svg" } });
  });

  test("missing or malformed profile falls back to the folder slug; malformed cards do not interrupt the feed", () => {
    const cards = parseFeed([null, entry({ v: 2, name: "Wrong" }, "aster/profile"), entry({ ...card, lead: {} }), entry({ ...card, at: "tomorrow" }), entry(card)]);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.author.name).toBe("aster");
    expect(parseFeed({ cards: [entry(card)] })).toEqual([]);
  });

  test("accepts post, image, thread, article and link data; unknown/video renderers keep the lead", () => {
    const cards = parseFeed([
      entry({ ...card, render: "image", lead: { text: "Caption", image: "aster/assets/shapes.svg" } }),
      entry({ ...card, render: "thread", replies: [{ text: "Reply" }, { text: "Another" }] }, "aster/2026-10/2026-10-25T120001Z-thread"),
      entry({ ...card, render: "article", title: "Article", body: "aster/articles/note.md" }, "aster/2026-10/2026-10-25T120002Z-article"),
      entry({ ...card, render: "link", url: "https://example.org/story" }, "aster/2026-10/2026-10-25T120003Z-link"),
      entry({ ...card, render: "video" }, "aster/2026-10/2026-10-25T120004Z-video"),
    ]);
    expect(cards.map((item) => item.render)).toEqual(["image", "thread", "article", "link", "unknown"]);
    expect(cards[2]?.body).toBe("aster/articles/note.md");
    expect(cards[1]?.replies).toEqual([{ text: "Reply" }, { text: "Another" }]);
    expect(cards[0]?.lead.image).toBe("aster/assets/shapes.svg");
    expect(cards[4]?.lead.text).toBe("A little note.");
  });

  test("rejects external or cross-bot media keys; source refs stay plain and unsafe URLs are not links", () => {
    const [local, remote, cross] = parseFeed([
      entry({ ...card, lead: { text: "cross", image: "birch/assets/a.svg" }, source: { label: "Record", ref: "other/entry" } }),
      entry({ ...card, lead: { text: "remote", image: "https://example.org/a.svg" }, source: { label: "Outside", url: "data:text/html,hello" } }, "aster/2026-10/2026-10-25T115900Z-remote"),
      entry({ ...card, lead: { text: "local", image: "aster/../birch/a.svg" }, source: { label: "Web", url: "https://example.org/story" } }, "aster/2026-10/2026-10-25T115800Z-local"),
    ]);
    expect(cross?.lead.image).toBeUndefined();
    expect(cross?.source).toEqual({ label: "Record", ref: "other/entry" });
    expect(remote?.lead.image).toBeUndefined();
    expect(remote?.source).toEqual({ label: "Outside" });
    expect(local?.lead.image).toBeUndefined();
    expect(local?.source?.url).toBe("https://example.org/story");
  });

  test("newest first with stable key tiebreak; rejects malformed keys and invalid UTC timestamps", () => {
    const cards = parseFeed([
      entry(card, "aster/2026-10/2026-10-25T120000Z-zed"),
      entry(card, "aster/2026-10/2026-10-25T120000Z-alpha"),
      entry({ ...card, at: "2026-10-25T13:00:00Z" }, "aster/2026-10/2026-10-25T130000Z-later"),
      entry(card, "aster/2026-10/../bad"),
      entry({ ...card, at: "2026-10-25T25:00:00Z" }, "aster/2026-10/2026-10-25T250000Z-invalid"),
    ]);
    expect(cards.map((item) => item.key)).toEqual([
      "aster/2026-10/2026-10-25T130000Z-later",
      "aster/2026-10/2026-10-25T120000Z-alpha",
      "aster/2026-10/2026-10-25T120000Z-zed",
    ]);
  });

  test("real entries replace sample cards; none retain dummy cards and get-started state", () => {
    const samples = [profile, entry(card)];
    expect(feedData.selectFeed([], samples)).toMatchObject({ sample: true, cards: [{ key }] });
    expect(feedData.selectFeed([entry({ ...card, lead: { text: "Real card" } })], samples)).toMatchObject({ sample: false, cards: [{ lead: { text: "Real card" } }] });
  });
});
