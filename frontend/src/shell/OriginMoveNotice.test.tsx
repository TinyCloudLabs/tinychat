import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { installReactTestEnv, mount } from "@/capture/recorder/final/shell/hookTestUtil";
import { isOriginMoveDeferred } from "@/lib/originMove";
import { OriginMoveHold, OriginMoveNotice, originMoveNoticeText, useOriginMoveDeferral } from "./OriginMoveNotice";

test("nothing shows before a count arrives or when nothing is left to count", () => {
  // Before its first check reports (effects do not run here) the hold shows nothing.
  expect(renderToStaticMarkup(<OriginMoveHold />)).toBe("");
  expect(renderToStaticMarkup(<OriginMoveNotice work={{ saving: 0, localAudio: 0 }} />)).toBe("");
});

test("main.tsx mounts the hold for a held visitor, and moves a clear one before rendering", () => {
  const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
  expect(main).toContain('{move.kind === "hold" && <OriginMoveHold />}');
  expect(main).toContain("decideOriginMove({ location: window.location, opener: window.opener != null })");
  expect(main.indexOf("window.location.replace(move.url)")).toBeLessThan(main.indexOf("createRoot("));
});

test("the notice is a status naming the new home and how many recordings are still saving", () => {
  const html = renderToStaticMarkup(<OriginMoveNotice work={{ saving: 2, localAudio: 3 }} />);
  expect(html).toContain('role="status"');
  expect(html).toContain("TinyCloud Home has moved to home.tinycloud.xyz. 2 recordings in this browser are still saving here; you&#x27;ll move automatically");
  expect(html).not.toContain("<button");
  expect(originMoveNoticeText({ saving: 1, localAudio: 0 }))
    .toContain("1 recording in this browser is still saving here; you'll move automatically once it's saved.");
  expect(originMoveNoticeText({ saving: Number.POSITIVE_INFINITY, localAudio: 0 }))
    .toContain("Recordings in this browser may still be saving here");
});

test("audio kept only on tinycloud.chat says the visitor stays, with no promise of moving", () => {
  expect(originMoveNoticeText({ saving: 0, localAudio: 1 })).toBe(
    "TinyCloud Home has moved to home.tinycloud.xyz. This browser keeps the audio of 1 recording only here on tinycloud.chat, so you'll stay here.");
  const many = originMoveNoticeText({ saving: 0, localAudio: 4 });
  expect(many).toContain("keeps the audio of 4 recordings only here on tinycloud.chat, so you'll stay here.");
  expect(many).not.toContain("move automatically");
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
