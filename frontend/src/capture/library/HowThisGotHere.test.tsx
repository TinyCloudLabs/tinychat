// "How this got here" (TC-761, plan §2.7): the route is built only from what the
// row records. Never more nodes than the metadata supports.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { captureRoute, HowThisGotHere } from "./HowThisGotHere";

const labels = (source: string, metadata: Record<string, unknown> | null) => captureRoute(source, metadata).nodes.map((n) => n.label);

describe("captureRoute", () => {
  test("a voice note: the phone, private cloud only when it made the text, then the space", () => {
    expect(labels("exo-voice-note", { capture: { platform: "ios" }, audio: { stored: true } })).toEqual(["iPhone", "Your space"]);
    expect(labels("exo-voice-note", { capture: { platform: "android" } })).toEqual(["Android phone", "Your space"]);
    const transcribed = captureRoute("exo-voice-note", {
      capture: { platform: "ios" },
      audio: { stored: true },
      transcription_engine: "private-cloud",
      transcript_provider: "tinycloud-private-transcription",
      inference_provider: "tinfoil",
    });
    expect(transcribed.nodes.map((n) => n.label)).toEqual(["iPhone", "Private cloud", "Your space"]);
    expect(transcribed.sentence).toBe(
      "Audio saved to your TinyCloud space. A copy was transcribed by TinyCloud Private Transcription; speech-to-text by Tinfoil.",
    );
    expect(transcribed.privateCloud).toBe(true);
  });

  test("an upload: private cloud or AssemblyAI (whose account), from the row", () => {
    expect(labels("exo-upload", { capture: "upload", transcript_provider: "tinycloud-private-transcription" })).toEqual([
      "Upload",
      "Private cloud",
      "Your space",
    ]);
    const own = captureRoute("exo-upload", { capture: "upload", audio: { stored: true }, transcript_provider: "assemblyai", assemblyai_account: "own" });
    expect(own.nodes.map((n) => n.label)).toEqual(["Upload", "AssemblyAI", "Your space"]);
    expect(own.sentence).toContain("transcribed by AssemblyAI with your key.");
    expect(captureRoute("exo-upload", { transcript_provider: "assemblyai", assemblyai_account: "tinycloud" }).sentence).toContain("TinyCloud's account");
  });

  test("a desktop recording: Whisper on this Mac, or private cloud", () => {
    expect(labels("exo-local", { capture: "local", transcript_provider: "whispercpp" })).toEqual(["This Mac", "Whisper on this Mac", "Your space"]);
    expect(labels("exo-local", { capture: "local", transcript_provider: "tinycloud-private-transcription" })).toEqual([
      "This Mac",
      "Private cloud",
      "Your space",
    ]);
  });

  test("the notetaker and the synced sources", () => {
    expect(labels("tinycloud-transcriber", { platform: "google_meet" })).toEqual(["Meeting", "TinyCloud notetaker", "Your space"]);
    expect(labels("fireflies", {})).toEqual(["Fireflies", "Your space"]);
    expect(captureRoute("google-meet", null).sentence).toBe("Synced from Google Meet into your TinyCloud space.");
  });

  test("never more nodes than the metadata supports", () => {
    // Not read yet, or unreadable: the source column alone.
    expect(labels("exo-upload", null)).toEqual(["Upload", "Your space"]);
    expect(labels("exo-voice-note", null)).toEqual(["Phone", "Your space"]);
    // A provider the Library does not know draws no middle node.
    expect(labels("exo-upload", { transcript_provider: "someone-else" })).toEqual(["Upload", "Your space"]);
    expect(labels("granola", { transcript_provider: "assemblyai" })).toEqual(["granola", "Your space"]);
  });
});

describe("HowThisGotHere", () => {
  const render = (read: Parameters<typeof HowThisGotHere>[0]["read"]) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <HowThisGotHere source="exo-upload" read={read} onRetry={() => {}} />
      </MemoryRouter>,
    );

  test("a landed route line, the sentence, and How private cloud works only for private cloud", () => {
    const cloud = render({ status: "ok", metadata: { transcript_provider: "tinycloud-private-transcription" } });
    expect(cloud).toContain(">How this got here</h2>");
    expect(cloud).toContain('aria-label="Where your audio goes"');
    expect(cloud).toContain("data-landed");
    expect(cloud.match(/<li /g)).toHaveLength(3);
    expect(cloud).toContain("How private cloud works");
    expect(render({ status: "ok", metadata: { transcript_provider: "assemblyai" } })).not.toContain("How private cloud works");
  });

  test("while the metadata is read: a skeleton, and no route drawn from the source alone", () => {
    const html = render(undefined);
    expect(html).toContain("Loading where this came from…");
    expect(html).not.toContain('aria-label="Where your audio goes"');
  });

  test("a metadata read that failed: no route at all, and Try again", () => {
    const html = render({ status: "failed" });
    expect(html).toContain("Couldn’t load where this came from.");
    expect(html).toContain('data-testid="how-this-got-here-retry"');
    expect(html).not.toContain('aria-label="Where your audio goes"');
    expect(html).not.toContain("Saved to your TinyCloud space");
  });
});
