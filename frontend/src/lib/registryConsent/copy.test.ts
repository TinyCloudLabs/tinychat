import { describe, expect, test } from "bun:test";
import { debugEvents, setDebugLogEnabledForTests } from "../debugLog";
import { FINISH_SETUP_BANNER_COPY } from "./copy";
import { registryPublishConfig } from "./config";

describe("the registry publish config", () => {
  test("the error hook is registered, nothing else is, and an SDK error reaches the session log", () => {
    const { registryPublish } = registryPublishConfig();
    expect(Object.keys(registryPublish)).toEqual(["onRegistryPublishError"]);
    setDebugLogEnabledForTests(true);
    try {
      const before = debugEvents().length;
      registryPublish.onRegistryPublishError?.(new Error("registry 503"));
      expect(debugEvents().slice(before).some((event) => event.operation === "registry_publish")).toBe(true);
    } finally {
      setDebugLogEnabledForTests(false);
    }
  });

  test("the banner words name the product TinyCloud One, never TinyCloud Home", () => {
    expect(Object.values(FINISH_SETUP_BANNER_COPY).join(" ")).not.toContain("TinyCloud Home");
  });

  test("the banner words are Monica's", () => {
    expect(FINISH_SETUP_BANNER_COPY).toEqual({
      lead: "Let your apps find your space",
      support: "Apps outside TinyCloud One can't find your space until you publish where it lives. This is a public record: anyone can see your account address, the names of your spaces and which servers hold them. It doesn't include anything stored in your spaces.",
      action: "Publish",
    });
  });
});
