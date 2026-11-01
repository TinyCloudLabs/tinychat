import { describe, expect, test } from "bun:test";
import { ephemeralAgentSdkConfig } from "./agentDelegation";

// Both fresh sign-in mints build a short-lived TinyCloudWeb. Neither may draw the SDK's floating button.
describe("agent mint TinyCloudWeb config", () => {
  test("hides the TinyCloud button", () => {
    const config = ephemeralAgentSdkConfig({ web3Provider: {} as never, sessionStorage: {} as never });
    expect(config.ui).toEqual({ button: false, platform: "web" });
  });

  test("asks for the native panel layout inside the native apps", () => {
    const config = ephemeralAgentSdkConfig({ web3Provider: {} as never, sessionStorage: {} as never, uiPlatform: "native" });
    expect(config.ui).toEqual({ button: false, platform: "native" });
  });
});
