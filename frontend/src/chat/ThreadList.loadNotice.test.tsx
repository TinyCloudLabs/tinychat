import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ThreadListLoadNotice } from "./ThreadList";

describe("ThreadListLoadNotice", () => {
  it("shows the load-failed message and a Try again button when no chats could be loaded", () => {
    const markup = renderToStaticMarkup(
      <ThreadListLoadNotice state={{ status: "error", hasCache: false }} onRetry={() => {}} />,
    );
    expect(markup).toContain("Couldn&#x27;t load your chats. They&#x27;re still saved.");
    expect(markup).toContain(">Try again</button>");
    expect(markup).not.toContain("Showing what was loaded before");
    expect(markup).not.toContain("No chats yet");
  });

  it("shows the small refresh-failed notice with a Try again link when a cached list is shown", () => {
    const markup = renderToStaticMarkup(
      <ThreadListLoadNotice state={{ status: "error", hasCache: true }} onRetry={() => {}} />,
    );
    expect(markup).toContain("Couldn&#x27;t refresh your chats. Showing what was loaded before.");
    expect(markup).toContain(">Try again</button>");
    expect(markup).not.toContain("still saved");
  });

  it("renders nothing when the load is fine", () => {
    expect(renderToStaticMarkup(<ThreadListLoadNotice state={{ status: "ok" }} onRetry={() => {}} />)).toBe("");
  });
});
