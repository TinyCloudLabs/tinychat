import { describe, expect, test } from "bun:test";
import { debugEvents, setDebugLogEnabledForTests } from "../debugLog";
import { FINISH_SETUP_BANNER_COPY, REGISTRY_CONSENT_COPY, REGISTRY_CONSENT_MODAL_ENABLED } from "./copy";
import { registryPublishConfig } from "./config";
import { requestRegistryConsent } from "./broker";

describe("the consent switch", () => {
  // The consent words are a draft nobody with authority has approved. Flipping this switch is a decision, not a refactor:
  // when the approved words are in copy.ts this test changes with the switch.
  test("is OFF", () => {
    expect(REGISTRY_CONSENT_MODAL_ENABLED).toBe(false);
  });

  test("off: no SDK config is added, so no callback is registered", () => {
    expect(registryPublishConfig()).toEqual({});
  });

  test("on: the consent and the error hook are registered, and an SDK error reaches the session log", () => {
    const { registryPublish } = registryPublishConfig(true);
    expect(registryPublish?.onRegistryPublishConsent).toBe(requestRegistryConsent);
    setDebugLogEnabledForTests(true);
    try {
      const before = debugEvents().length;
      registryPublish?.onRegistryPublishError?.(new Error("registry 503"));
      expect(debugEvents().slice(before).some((event) => event.operation === "registry_publish")).toBe(true);
    } finally {
      setDebugLogEnabledForTests(false);
    }
  });

  test("the buttons are the ones the draft names", () => {
    expect(REGISTRY_CONSENT_COPY.publish).toBe("Publish and continue");
    expect(REGISTRY_CONSENT_COPY.notNow).toBe("Not now");
  });

  test("names the product TinyCloud One, never TinyCloud Home", () => {
    const words = [
      REGISTRY_CONSENT_COPY.title, REGISTRY_CONSENT_COPY.body, REGISTRY_CONSENT_COPY.publish, REGISTRY_CONSENT_COPY.notNow,
      ...Object.values(REGISTRY_CONSENT_COPY.previewLabels), ...Object.values(FINISH_SETUP_BANNER_COPY),
    ].join(" ");
    expect(words).not.toContain("TinyCloud Home");
    expect(REGISTRY_CONSENT_COPY.body).toContain("outside TinyCloud One");
    expect(REGISTRY_CONSENT_COPY.body).toContain("Anyone who knows your account address can see it, along with the names of your spaces.");
  });

  test("the line the dialog cannot show after Not now is the banner's supporting text", () => {
    expect(FINISH_SETUP_BANNER_COPY.support).toBe("Apps outside TinyCloud One can't find your space until you publish this.");
  });
});
