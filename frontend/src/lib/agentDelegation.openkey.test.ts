import { expect, test } from "bun:test";
import { ephemeralAgentSdkConfig } from "./agentDelegation";

const provider = { on() {}, removeListener() {}, request: async () => null };
const base = { web3Provider: provider, sessionStorage: undefined, tinycloudHosts: ["http://127.0.0.1:9"] };

test("the agent consent sign-in goes through OpenKey's versioned authorization, in the frame, when OpenKey is connected", () => {
  const client = { authorizeTinyCloud: async () => { throw new Error("not called in this test"); } };
  const config = ephemeralAgentSdkConfig({ ...base, openkey: client as never });
  expect(config.openkey).toEqual({ client, mode: "iframe" });
  expect(config.providers).toEqual({ web3: { driver: provider } });
});

test("without a connected OpenKey client the config carries no OpenKey sign-in", () => {
  expect("openkey" in ephemeralAgentSdkConfig(base)).toBe(false);
});
