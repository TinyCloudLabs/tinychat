import { expect, test } from "bun:test";
import { FINAL_COPY, PRIVATE_CONSENT_ACTION, PRIVATE_CONSENT_TITLE, privateConsentBody, privateConsentDevice } from "./finalCopy";

test("Build 1 Private disclosure and mode copy are exact on phone and Mac", () => {
  expect(PRIVATE_CONSENT_TITLE).toBe("Use Private transcription?");
  expect(privateConsentBody("phone")).toBe("Private transcription sends this note's audio from this phone to TinyCloud Private Transcription, a sealed hardware enclave. It's deleted there once the transcript is ready. Exo never sees it.");
  expect(privateConsentBody("Mac")).toBe("Private transcription sends this note's audio from this Mac to TinyCloud Private Transcription, a sealed hardware enclave. It's deleted there once the transcript is ready. Exo never sees it.");
  expect(privateConsentBody(privateConsentDevice("web"))).toContain("from this browser");
  expect(privateConsentDevice("ios")).toBe("phone");
  expect(PRIVATE_CONSENT_ACTION).toBe("Use Private transcription");
  expect(FINAL_COPY.modes.privateExplanation).toBe("Sent to a sealed hardware enclave, transcribed, then deleted. Exo never sees it.");
});
