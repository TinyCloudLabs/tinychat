// How it works (/chat/about): every section in lib/about.ts renders as an
// anchor a HowItWorksLink can land on, with a heading the page can focus.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { HowItWorksLink } from "@/components/ui/how-it-works-link";
import { ABOUT_PATH, ABOUT_SECTIONS, aboutHref } from "@/lib/about";
import { ABOUT_BODY, AboutPage, sectionFromHash } from "./AboutPage";

const render = (path: string) =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <AboutPage onBack={() => {}} />
    </MemoryRouter>,
  );

describe("How it works", () => {
  const markup = render(ABOUT_PATH);

  test("every ABOUT_SECTIONS id renders as an anchor, in order, with its title as a focusable heading", () => {
    const anchors = [...markup.matchAll(/<section id="([^"]+)"/g)].map((match) => match[1]);
    expect(anchors).toEqual(ABOUT_SECTIONS.map((section) => section.id));
    for (const section of ABOUT_SECTIONS) {
      expect(markup).toContain(`aria-labelledby="about-${section.id}-heading"`);
      expect(markup).toMatch(new RegExp(`<h2 id="about-${section.id}-heading" tabindex="-1"[^>]*>${section.title}</h2>`));
      // Each section has words of its own.
      expect(ABOUT_BODY[section.id]).toBeTruthy();
    }
  });

  test("a large title and Back, like any pushed page", () => {
    expect(markup).toContain(">How it works<");
    expect(markup).toMatch(/<button type="button"[^>]*>.*Back<\/button>/);
  });

  test("a section's link lands on its anchor", () => {
    for (const section of ABOUT_SECTIONS) {
      const link = renderToStaticMarkup(
        <MemoryRouter>
          <HowItWorksLink section={section.id} />
        </MemoryRouter>,
      );
      expect(link).toContain(`href="${ABOUT_PATH}#${section.id}"`);
      expect(aboutHref(section.id)).toBe(`/chat/about#${section.id}`);
      expect(markup).toContain(`id="${section.id}"`);
    }
  });

  test("prose is set at a readable measure and 16 px", () => {
    expect(markup.match(/max-w-\[65ch\][^"]*text-body/g)).toHaveLength(ABOUT_SECTIONS.length);
  });

  test("an address's hash names a section; a malformed or unknown one names none (the page top)", () => {
    expect(sectionFromHash("#connectors")).toBe("connectors");
    expect(sectionFromHash("connectors")).toBe("connectors");
    expect(sectionFromHash("#%61gent-access")).toBe("agent-access");
    expect(sectionFromHash("")).toBeNull();
    expect(sectionFromHash("#")).toBeNull();
    expect(sectionFromHash("#nope")).toBeNull();
    // A malformed escape throws in decodeURIComponent; it must not take the page down.
    expect(() => decodeURIComponent("%E0%A4%A")).toThrow();
    expect(sectionFromHash("#%E0%A4%A")).toBeNull();
  });

  test("every HowItWorksLink in the app points at a section that exists", () => {
    const ids = new Set<string>(ABOUT_SECTIONS.map((section) => section.id));
    const root = join(import.meta.dir, "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) files.push(path);
      }
    };
    walk(root);
    const used = files.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/<HowItWorksLink section="([^"]+)"/g)].map((match) => match[1]!),
    );
    expect(used.length).toBeGreaterThan(0);
    for (const id of used) expect(ids.has(id)).toBe(true);
  });
});

// The claims this page carries are promises: pin the providers, the deletion
// promises, the limits and where each kind of audio lives, as rendered.
describe("How it works: the canonical claims", () => {
  const markup = render(ABOUT_PATH);
  const text = (id: string) => {
    const start = markup.indexOf(`<section id="${id}"`);
    expect(start).toBeGreaterThan(-1);
    const body = markup.slice(start, markup.indexOf("</section>", start));
    return body
      .replace(/<[^>]+>/g, "")
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ");
  };

  test("voice notes: 60 minutes, saved to the space", () => {
    expect(text("capture")).toContain("A note can run up to 60 minutes; the recorder stops at the limit.");
    expect(text("capture")).toContain("It is saved to your TinyCloud space and shows up in Library.");
  });

  test("where audio goes: the providers, the deletion promises and the limits", () => {
    const where = text("transcription");
    expect(where).toContain("TinyCloud Private Transcription, a dedicated confidential virtual machine on Phala Cloud.");
    expect(where).toContain("It sends short speech segments to Tinfoil for speech-to-text.");
    expect(where).toContain("It states that it does not retain request or response content after responding");
    expect(where).toContain("TinyCloud Private Transcription deletes the audio once transcription finishes or fails.");
    expect(where).toContain("otherwise the transcript is scheduled for deletion 24 hours after transcription.");
    expect(where).toContain("It receives an anonymous account identifier, not your wallet address.");
    expect(where).toContain("It never receives your audio.");
    expect(where).toContain("Private cloud takes voice notes up to 10 minutes, and uploads and desktop recordings up to 2 hours.");
    expect(where).toContain("Exo deletes it at AssemblyAI after saving the transcript to your TinyCloud space.");
    expect(where).toContain("it never stores or logs it.");
    expect(where).toContain("AssemblyAI is not part of TinyCloud’s private transcription.");
    expect(where).toContain("A local recording stays on this Mac.");
  });

  test("uploads: the formats and the 2-hour limit, except with your own AssemblyAI key", () => {
    const uploads = text("uploads");
    expect(uploads).toContain(
      "Private transcription and TinyCloud’s AssemblyAI account take MP3, WAV, OGG, M4A/MP4, WebM or FLAC audio, up to 2 hours.",
    );
    expect(uploads).toContain("With your own AssemblyAI key, most audio and video files work.");
  });

  test("your data: storage is qualified by kind of recording", () => {
    const data = text("your-data");
    expect(data).toContain("Voice notes are saved there, and so is a copy of each file you upload.");
    expect(data).toContain("The audio of a desktop local recording stays on that Mac.");
    expect(data).not.toContain("your recordings");
  });

  test("the notetaker, autojoin and verification keep their specifics", () => {
    expect(text("notetaker")).toContain("If the notetaker hears no one else for five minutes, it ends automatically.");
    expect(text("connectors")).toContain("from one minute before start until five minutes after start or the event ends.");
    expect(text("verification")).toContain("The status turns Backend attested only when all three legs pass.");
    expect(text("verification")).toContain("This proves the endpoint and code identity, not each response byte.");
  });
});
