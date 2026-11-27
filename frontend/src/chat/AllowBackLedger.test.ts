import { expect, test } from "bun:test";
import { allowBackNeedsBackendLedger } from "./GranolaAllowBack";

test("Google Meet allow-back does not call the backend purge endpoint reserved for other sources", () => {
  expect(allowBackNeedsBackendLedger("google-meet")).toBe(false);
  expect(allowBackNeedsBackendLedger("granola")).toBe(true);
});
