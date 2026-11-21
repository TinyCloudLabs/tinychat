import { describe, expect, test } from "bun:test";
import { oneAppsFor, type FramedOneApp } from "./registry";

const READ_ONLY = ["get", "list"];
const OWNER = { address: "0x0000000000000000000000000000000000000001", chainId: 1 };

function accountOn(platform: string): FramedOneApp | undefined {
  const app = oneAppsFor(platform).find((entry) => entry.id === "xyz.tinycloud.account");
  return app?.kind === "framed" ? app : undefined;
}

describe("Account inside One", () => {
  for (const platform of ["web", "android"]) {
    test(`${platform}: every ceiling entry is get or list, so Account can write nothing`, () => {
      const account = accountOn(platform);
      expect(account).toBeDefined();
      const entries = account!.ceiling(OWNER);
      expect(entries.length).toBeGreaterThan(0);
      for (const { permission } of entries) {
        expect(permission.actions.length).toBeGreaterThan(0);
        expect(permission.actions.filter((action) => !READ_ONLY.includes(action))).toEqual([]);
      }
    });
  }

  test("ios does not offer Account", () => {
    expect(accountOn("ios")).toBeUndefined();
  });
});
