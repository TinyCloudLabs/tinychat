import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { StaticRecorderProvider } from "../RecorderProvider";
import { LazyPhoneRecorder, LoadFailed } from "./LazyPhoneRecorder";

describe("LazyPhoneRecorder", () => {
  test("shows an Opening recorder… status while the recorder's chunk is fetched", () => {
    const html = renderToStaticMarkup(
      <StaticRecorderProvider value={{ phase: "recording" }}>
        <LazyPhoneRecorder load={() => new Promise(() => {})} />
      </StaticRecorderProvider>,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Opening recorder…");
  });

  test("a chunk that cannot be fetched is a visible alert that says the recording continues", () => {
    const html = renderToStaticMarkup(
      <StaticRecorderProvider value={{ phase: "recording" }}>
        <LoadFailed onRetry={() => {}} />
      </StaticRecorderProvider>,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Couldn&#x27;t open the recorder.");
    expect(html).toContain("Your recording continues.");
    expect(html).toContain("Try again");
  });
});
