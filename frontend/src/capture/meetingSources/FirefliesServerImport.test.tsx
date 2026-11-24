import { describe, expect, test } from "bun:test";
import { firefliesImportDate } from "@/lib/connectors/firefliesImportCopy";
import { renderToStaticMarkup } from "react-dom/server";

import { FirefliesServerImport } from "./FirefliesServerImport";
import type { FirefliesServerImportPhase, UseFirefliesServerImport } from "./useFirefliesServerImport";

const noop = () => {};
const END = firefliesImportDate("2026-11-29T17:00:00.000Z");
function render(phase: FirefliesServerImportPhase, expiresAt: string | null = "2026-11-29T17:00:00.000Z") {
  const controller: UseFirefliesServerImport = { view: { phase, expiresAt }, turnOn: noop, turnOff: noop, retry: noop };
  return renderToStaticMarkup(<FirefliesServerImport controller={controller} />).replaceAll("&#x27;", "'");
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("the server import row uses the copy owner's words", () => {
  test("off: heading, both paragraphs and the two buttons", () => {
    const html = render("off");
    const words = text(html);
    expect(words).toContain("Import meetings while TinyCloud One is closed");
    expect(words).toContain(
      "When a Fireflies meeting finishes, our server can save it to your TinyCloud even while TinyCloud One is closed. To do that, you give our server two permissions for up to 7 days: one to open your Fireflies key for each import, and one to save meetings into your Fireflies folder. Our server doesn't keep your Fireflies key or a copy of any meeting.",
    );
    expect(words).toContain(
      "The permissions renew each time you open TinyCloud One. If you don't open it for several days, imports pause: at most 7 days after your last visit, sooner if your sign-in is close to ending. Meetings that finished in the meantime are saved the next time you open it. You can turn this off at any time. It's your choice and applies only to your account.",
    );
    expect(html).toContain(">Turn on<");
    expect(html).toContain(">Not now<");
  });

  test("on, paused, unconfirmed and unavailable", () => {
    expect(text(render("on"))).toContain(
      `On until ${END}. Meetings that finish while TinyCloud One is closed are saved to your TinyCloud. Opening TinyCloud One extends this.`,
    );
    expect(render("on")).toContain(">Turn off<");
    expect(text(render("paused"))).toContain(
      "Paused. Meetings that finish while paused are saved the next time you open TinyCloud One.",
    );
    expect(render("paused")).toContain(">Turn on<");
    expect(text(render("off-unconfirmed"))).toContain(
      `Importing is off on our server, but OpenKey couldn't confirm the permissions were withdrawn. They end on ${END} at the latest.`,
    );
    expect(text(render("unavailable"))).toContain("TinyCloud One couldn't reach our server. Try again.");
    expect(render("ending-soon")).toContain(">Keep it on<");
    expect(text(render("ending-soon"))).toContain(`Ends ${END}. Open TinyCloud One to keep it on.`);
  });

  test("nothing shows until the server says the import is on", () => {
    expect(render("hidden")).toBe("");
    expect(render("loading")).toBe("");
  });

  test("no number below 7 appears in the consent words", () => {
    const words = text(render("off"));
    expect(words.match(/\b[0-6]\b/g)).toBeNull();
  });
});
