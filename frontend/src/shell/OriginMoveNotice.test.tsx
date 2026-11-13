import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { installReactTestEnv, mount } from "@/capture/recorder/final/shell/hookTestUtil";
import { isOriginMoveDeferred, NO_LOCAL_WORK, type LocalRecordingWork } from "@/lib/originMove";
import { OriginMoveHold, OriginMoveNotice, originMoveNoticeText, useOriginMoveDeferral } from "./OriginMoveNotice";

const work = (patch: Partial<LocalRecordingWork>): LocalRecordingWork => ({ ...NO_LOCAL_WORK, signedIn: true, ...patch });
const MOVED = "TinyCloud One has moved to home.tinycloud.xyz.";
const CLOSER = "This tab stays here while these recordings are only in this browser.";

function render(w: LocalRecordingWork): string {
  return renderToStaticMarkup(<MemoryRouter><OriginMoveNotice work={w} /></MemoryRouter>);
}

/** The notice's text as a reader gets it: tags dropped, entities decoded. */
const textOf = (html: string) => html.replace(/<[^>]+>/g, "").replaceAll("&#x27;", "'").replaceAll("&amp;", "&");

/** Each link in the notice: its text and where it goes. */
const linksOf = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map(([, href, text]) => ({ text, href }));

test("nothing shows before a count arrives or when nothing is left to count", () => {
  // Before its first check reports (effects do not run here) the hold shows nothing.
  expect(renderToStaticMarkup(<OriginMoveHold />)).toBe("");
  expect(renderToStaticMarkup(<OriginMoveNotice work={NO_LOCAL_WORK} />)).toBe("");
  expect(renderToStaticMarkup(<OriginMoveNotice work={work({})} />)).toBe("");
});

test("main.tsx mounts the hold for a held visitor inside the router, and moves a clear one before rendering", () => {
  const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
  expect(main).toContain('{move.kind === "hold" && <OriginMoveHold />}');
  expect(main.indexOf("<OriginMoveHold />")).toBeLessThan(main.indexOf("</BrowserRouter>"));
  expect(main).toContain("decideOriginMove({ location: window.location, opener: window.opener != null })");
  expect(main.indexOf("window.location.replace(move.url)")).toBeLessThan(main.indexOf("createRoot("));
});

test("the notice is a status naming the new home and how many recordings are still saving", () => {
  const html = render(work({ saving: 2, localAudio: ["a"], unclaimed: 3, otherAccount: 1 }));
  expect(html).toContain('role="status"');
  // Saving comes first: it finishes by itself, and the other reasons show once it has.
  expect(textOf(html)).toBe(`${MOVED} 2 recordings in this browser are still saving here; you'll move automatically once they're saved.`);
  expect(html).not.toContain("<button");
  expect(linksOf(html)).toEqual([]);
  expect(originMoveNoticeText(work({ saving: 1 })))
    .toBe(`${MOVED} 1 recording in this browser is still saving here; you'll move automatically once it's saved.`);
  expect(originMoveNoticeText(work({ saving: Number.POSITIVE_INFINITY })))
    .toBe(`${MOVED} Recordings in this browser may still be saving here; you'll move automatically once they're saved.`);
});

test("audio only in this browser: one recording links to that note, several to the Library's filter, and no closer", () => {
  const one = render(work({ localAudio: ["rec-1"] }));
  expect(textOf(one)).toBe(`${MOVED} The audio of 1 recording is only in this browser, so this tab stays here until you upload it: open the recording and choose Upload audio to TinyCloud.`);
  expect(linksOf(one)).toEqual([{ text: "1 recording", href: "/chat/capture/library/on-phone%3Arec-1" }]);

  const many = render(work({ localAudio: ["rec-1", "rec-2", "rec-3"] }));
  expect(textOf(many)).toBe(`${MOVED} The audio of 3 recordings is only in this browser, so this tab stays here until you upload them: open each recording and choose Upload audio to TinyCloud.`);
  expect(linksOf(many)).toEqual([{ text: "3 recordings", href: "/chat/capture/library?show=local-audio" }]);
  expect(textOf(many)).not.toContain(CLOSER);
});

test("unclaimed recordings, signed in: the count links to the Recording tab, and the closer follows", () => {
  const many = render(work({ unclaimed: 2 }));
  expect(textOf(many)).toBe(`${MOVED} 2 recordings in this browser aren't in any account yet. On the Recording tab, under Recorded while signed out, choose Save to this account for each one. ${CLOSER}`);
  expect(linksOf(many)).toEqual([{ text: "2 recordings", href: "/chat/capture" }]);

  const one = render(work({ unclaimed: 1 }));
  expect(textOf(one)).toBe(`${MOVED} 1 recording in this browser isn't in any account yet. On the Recording tab, under Recorded while signed out, choose Save to this account. ${CLOSER}`);
  expect(linksOf(one)).toEqual([{ text: "1 recording", href: "/chat/capture" }]);
});

test("unclaimed recordings, signed out: sign in first", () => {
  expect(originMoveNoticeText(work({ unclaimed: 2, signedIn: false }))).toBe(
    `${MOVED} 2 recordings in this browser aren't in any account yet. Sign in, then on the Recording tab, under Recorded while signed out, choose Save to this account for each one. ${CLOSER}`);
  expect(originMoveNoticeText(work({ unclaimed: 1, signedIn: false }))).toBe(
    `${MOVED} 1 recording in this browser isn't in any account yet. Sign in, then on the Recording tab, under Recorded while signed out, choose Save to this account. ${CLOSER}`);
  expect(linksOf(render(work({ unclaimed: 1, signedIn: false })))).toEqual([{ text: "1 recording", href: "/chat/capture" }]);
});

test("another account's recordings: the count links to the Recording tab, and the closer follows", () => {
  const many = render(work({ otherAccount: 2 }));
  expect(textOf(many)).toBe(`${MOVED} 2 recordings in this browser belong to another TinyCloud account. Sign in to that account here to save them. ${CLOSER}`);
  expect(linksOf(many)).toEqual([{ text: "2 recordings", href: "/chat/capture" }]);
  // The singular says "save it"; the plural keeps "save them".
  const one = render(work({ otherAccount: 1, signedIn: false }));
  expect(textOf(one)).toBe(`${MOVED} 1 recording in this browser belongs to another TinyCloud account. Sign in to that account here to save it. ${CLOSER}`);
  expect(linksOf(one)).toEqual([{ text: "1 recording", href: "/chat/capture" }]);
});

test("mixed reasons: one moved sentence, then audio, unclaimed and another account in that order, then one closer", () => {
  const html = render(work({ localAudio: ["rec-1", "rec-2"], unclaimed: 1, otherAccount: 3 }));
  expect(textOf(html)).toBe([
    MOVED,
    "The audio of 2 recordings is only in this browser, so this tab stays here until you upload them: open each recording and choose Upload audio to TinyCloud.",
    "1 recording in this browser isn't in any account yet. On the Recording tab, under Recorded while signed out, choose Save to this account.",
    "3 recordings in this browser belong to another TinyCloud account. Sign in to that account here to save them.",
    CLOSER,
  ].join(" "));
  expect(linksOf(html)).toEqual([
    { text: "2 recordings", href: "/chat/capture/library?show=local-audio" },
    { text: "1 recording", href: "/chat/capture" },
    { text: "3 recordings", href: "/chat/capture" },
  ]);
  // The banner lets taps through to the page under it, except on its links.
  expect(html).toContain("pointer-events-none");
  expect(html.match(/<a [^>]*class="[^"]*pointer-events-auto/g)).toHaveLength(3);

  expect(originMoveNoticeText(work({ localAudio: ["rec-1"], otherAccount: 1, signedIn: false }))).toBe([
    MOVED,
    "The audio of 1 recording is only in this browser, so this tab stays here until you upload it: open the recording and choose Upload audio to TinyCloud.",
    "1 recording in this browser belongs to another TinyCloud account. Sign in to that account here to save it.",
    CLOSER,
  ].join(" "));
  expect(originMoveNoticeText(work({ unclaimed: 2, otherAccount: 2, signedIn: false }))).toBe([
    MOVED,
    "2 recordings in this browser aren't in any account yet. Sign in, then on the Recording tab, under Recorded while signed out, choose Save to this account for each one.",
    "2 recordings in this browser belong to another TinyCloud account. Sign in to that account here to save them.",
    CLOSER,
  ].join(" "));
});

test("useOriginMoveDeferral defers the move only while active and while mounted", async () => {
  const restore = installReactTestEnv();
  const Busy = ({ active }: { active: boolean }) => { useOriginMoveDeferral(active); return null; };
  const root = mount();
  try {
    await root.render(<Busy active={false} />);
    expect(isOriginMoveDeferred()).toBe(false);
    await root.render(<Busy active />);
    expect(isOriginMoveDeferred()).toBe(true);
    await root.render(<Busy active={false} />);
    expect(isOriginMoveDeferred()).toBe(false);
    await root.render(<Busy active />);
    await root.unmount();
    expect(isOriginMoveDeferred()).toBe(false);
  } finally {
    restore();
  }
});
