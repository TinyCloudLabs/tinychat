import { describe, expect, test } from "bun:test";

import {
  BACKEND_INGEST_CONSENT_COPY,
  BACKGROUND_SYNC_CONSENT_COPY,
} from "./consentCopy";

// TC-2778: queued meeting IDs and the purge ledger are stored unsealed, so the copy must not say
// deleted items stay in storage "in encrypted form".
describe("Fireflies retention consent copy makes no storage-encryption claim", () => {
  const strings = [
    BACKGROUND_SYNC_CONSENT_COPY.intro,
    BACKEND_INGEST_CONSENT_COPY.intro,
    BACKEND_INGEST_CONSENT_COPY.disconnectNote ?? "",
  ];
  test("no string says deleted items or IDs stay stored encrypted", () => {
    for (const text of strings) {
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/encrypted/i);
      expect(text).not.toMatch(/stay in our storage/i);
    }
  });
  test("removing the sentence leaves no doubled space", () => {
    for (const text of strings) expect(text).not.toMatch(/ {2}|\.\./);
  });
});
