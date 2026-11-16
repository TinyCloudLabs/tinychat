import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { NO_LOCAL_WORK, type LocalRecordingWork } from "@/lib/originMove";
import { OriginMoveNotice, originMoveNoticeText } from "./OriginMoveNotice";

const work = (patch: Partial<LocalRecordingWork>): LocalRecordingWork => ({ ...NO_LOCAL_WORK, signedIn: true, ...patch });
const MOVED = "TinyCloud One has moved to home.tinycloud.xyz.";

test("held answers, unsent answers and post drafts each say why the tab stays", () => {
  expect(originMoveNoticeText(work({ heldAnswers: 1 }))).toBe(`${MOVED} 1 answer is still sending from this tab. The tab moves on its own once it's sent.`);
  expect(originMoveNoticeText(work({ heldAnswers: 2 }))).toBe(`${MOVED} 2 answers are still sending from this tab. The tab moves on its own once they're sent.`);
  expect(originMoveNoticeText(work({ unsentAnswers: 1 }))).toBe(`${MOVED} 1 answer wasn't sent. Open your Feed to see it. This tab stays here until you do.`);
  expect(originMoveNoticeText(work({ unsentAnswers: 3 }))).toBe(`${MOVED} 3 answers weren't sent. Open your Feed to see them. This tab stays here until you do.`);
  expect(originMoveNoticeText(work({ postDrafts: 1 }))).toBe(`${MOVED} 1 post has answers you haven't sent. Send them, and this tab moves.`);
  expect(originMoveNoticeText(work({ postDrafts: 2 }))).toBe(`${MOVED} 2 posts have answers you haven't sent. Send them, and this tab moves.`);
});

test("\"Open your Feed\" links to this site's Feed in the same tab", () => {
  const html = renderToStaticMarkup(<MemoryRouter><OriginMoveNotice work={work({ unsentAnswers: 1 })} /></MemoryRouter>);
  expect([...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map(([whole, href, text]) => ({ text, href, newTab: whole.includes("target=") })))
    .toEqual([{ text: "Open your Feed", href: "/chat/feed", newTab: false }]);
});

test("answers alone show the notice, after any recording lines", () => {
  expect(renderToStaticMarkup(<MemoryRouter><OriginMoveNotice work={work({ postDrafts: 1 })} /></MemoryRouter>)).toContain('role="status"');
  expect(originMoveNoticeText(work({ otherAccount: 1, heldAnswers: 1, unsentAnswers: 1, postDrafts: 1 }))).toBe([
    MOVED,
    "1 recording in this browser belongs to another TinyCloud account. Sign in to that account here to save it.",
    "This tab stays here while this recording is only in this browser.",
    "1 answer is still sending from this tab. The tab moves on its own once it's sent.",
    "1 answer wasn't sent. Open your Feed to see it. This tab stays here until you do.",
    "1 post has answers you haven't sent. Send them, and this tab moves.",
  ].join(" "));
});

test("the closer is singular when one recording keeps the tab here, plural otherwise", () => {
  const single = "This tab stays here while this recording is only in this browser.";
  const plural = "This tab stays here while these recordings are only in this browser.";
  expect(originMoveNoticeText(work({ unclaimed: 1 }))).toEndWith(single);
  expect(originMoveNoticeText(work({ otherAccount: 1 }))).toEndWith(single);
  expect(originMoveNoticeText(work({ unclaimed: 1, otherAccount: 1 }))).toEndWith(plural);
  expect(originMoveNoticeText(work({ otherAccount: 2 }))).toEndWith(plural);
});

test("each reason is its own block line, spaced apart in a column", () => {
  const html = renderToStaticMarkup(<MemoryRouter><OriginMoveNotice work={work({ otherAccount: 1, heldAnswers: 2, unsentAnswers: 3, postDrafts: 1 })} /></MemoryRouter>);
  expect(html).toMatch(/<p role="status" class="[^"]*\bflex flex-col gap-1\.5\b/);
  expect(html.match(/<span class="block">/g)).toHaveLength(6);
});

test("main.tsx clears the moved answers right before it leaves", () => {
  const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
  expect(main).toContain("clearMovedAnswers();\n    window.location.replace(move.url);");
});
