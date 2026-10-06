// The route control: what it offers in each private cloud state, and that the
// longer explanation is one link away (How it works), never a paragraph here.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { aboutHref } from "@/lib/about";
import { TranscriptionRouteControl } from "./TranscriptionRouteControl";
import type { VoiceNoteTranscriptionProps } from "./transcriptionProps";

const noop = () => {};

function transcription(patch: Partial<VoiceNoteTranscriptionProps> = {}): VoiceNoteTranscriptionProps {
  return { availability: "available", consented: true, maxSeconds: 600, jobs: new Map(), onTranscribe: noop, onConsent: noop, onTurnOff: noop, onRecheck: noop, ...patch };
}

function render(value: VoiceNoteTranscriptionProps | undefined, defaultAsking?: boolean): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TranscriptionRouteControl transcription={value} defaultAsking={defaultAsking} />
    </MemoryRouter>,
  );
}

const segments = (html: string) => (html.match(/role="radio"/g) ?? []).length;

describe("TranscriptionRouteControl", () => {
  test("hidden (no private cloud for this build or account): audio only, no choice offered", () => {
    for (const value of [undefined, transcription({ availability: "hidden", consented: false })]) {
      const html = render(value);
      expect(html).toContain(">Transcription</h3>");
      expect(segments(html)).toBe(0);
      expect(html).toContain("Audio only.");
      expect(html).toContain('data-route="off"');
    }
  });

  test("checking: nothing to choose yet", () => {
    expect(segments(render(transcription({ availability: "checking", consented: false })))).toBe(0);
    expect(render(transcription({ availability: "checking", consented: true }))).toContain("Checking private cloud…");
  });

  test("failed for someone who chose private cloud: told, with Check again; nobody else hears of it", () => {
    const html = render(transcription({ availability: "failed", consented: true }));
    expect(html).toContain("Private cloud is unavailable right now.");
    expect(html).toContain('data-testid="voice-note-transcription-recheck"');
    expect(render(transcription({ availability: "failed", consented: false }))).not.toContain("unavailable");
  });

  test("available and on: Off · Private cloud with Private cloud chosen, and its route", () => {
    const html = render(transcription());
    expect(segments(html)).toBe(2);
    expect(html).toMatch(/aria-checked="true"[^>]*>.*?Private cloud/);
    expect(html).toContain('data-route="private-cloud"');
    expect(html).toContain(">Private cloud</span>");
    expect(html).toContain("Private cloud transcribes notes up to 10 minutes.");
    expect(html).not.toContain("voice-note-transcription-consent");
  });

  test("available without consent: Off is chosen; choosing Private cloud asks once, in one sentence", () => {
    const off = render(transcription({ consented: false }));
    expect(off).toContain('data-route="off"');
    expect(off).not.toContain("voice-note-transcription-enable");
    const asking = render(transcription({ consented: false }), true);
    expect(asking).toContain('data-testid="voice-note-transcription-consent"');
    expect(asking).toContain("After you stop, TinyCloud Private Transcription turns notes up to 10 minutes into text.");
    expect(asking).toContain(">Use private cloud</button>");
    // The disclosure itself is on How it works, not here.
    expect(asking).not.toContain("Tinfoil");
  });

  test("the explanation is a link to How it works → Where your audio goes", () => {
    for (const html of [render(undefined), render(transcription()), render(transcription({ consented: false }), true)]) {
      expect(html).toContain(`href="${aboutHref("transcription")}"`);
    }
  });
});
