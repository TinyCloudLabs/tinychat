import { expect, test } from "bun:test";

import { BACKEND_INGEST_CONSENT_COPY } from "./consentCopy";

// TC-2778: the server keeps a finished meeting for 14 days; the consent text must not say 90.
test("the Fireflies server-side consent text says up to 14 days and never 90", () => {
  expect(BACKEND_INGEST_CONSENT_COPY.intro).toContain("a copy of each finished meeting for up to 14 days");
  expect(BACKEND_INGEST_CONSENT_COPY.intro).not.toMatch(/\b90\b/);
});
