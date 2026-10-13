import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ViaMenu } from "../ViaMenu";
import { DesktopRing } from "./DesktopRing";

const subscribeLevel = () => () => {};
const input = [{ id: "mic", name: "MacBook Microphone", kind: "built_in" as const }];

describe("Mac recorder levels", () => {
  test("Them trace exists only for live system capture", () => {
    const ring = (captured: boolean, state: "live" | "paused" = "live") => renderToStaticMarkup(
      <DesktopRing ring={state} flat={false} theme="day" size={214} subscribeLevel={subscribeLevel}
        systemAudioCaptured={captured} action={null} glyph={null} />,
    );
    expect(ring(true)).toContain('aria-label="Them audio level"');
    expect(ring(false)).not.toContain('aria-label="Them audio level"');
    expect(ring(true, "paused")).not.toContain('aria-label="Them audio level"');
  });

  test("via names this Mac's audio only while it is captured", () => {
    const via = (captured: boolean) => renderToStaticMarkup(
      <ViaMenu inputs={input} currentId="mic" currentName="MacBook Microphone" recording theme="day"
        subscribeLevel={subscribeLevel} systemAudioCaptured={captured} emphasis={false} disabled={false}
        onSelect={() => {}} />,
    );
    expect(via(true)).toContain('data-testid="desktop-system-audio-label"');
    expect(via(true)).toContain('· + this Mac&#x27;s audio');
    expect(via(false)).not.toContain("this Mac");
  });
});
