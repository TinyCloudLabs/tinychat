// Explorer inside One reads only (TC-3675): One never delegates it a write or delete, on any platform.
import { describe, expect, test } from "bun:test";
import { oneAppsFor, type FramedOneApp } from "./registry";

const WRITES = ["put", "del", "write"];
const OWNER = { address: "0x0000000000000000000000000000000000000001", chainId: 1 };

function explorerOn(platform: string): FramedOneApp | undefined {
  const app = oneAppsFor(platform).find((entry) => entry.id === "xyz.tinycloud.explorer");
  return app?.kind === "framed" ? app : undefined;
}

describe("Explorer inside One", () => {
  for (const platform of ["web", "ios", "android"]) {
    test(`${platform}: no ceiling entry writes or deletes, and applications can still be read`, () => {
      const explorer = explorerOn(platform);
      expect(explorer).toBeDefined();
      const entries = explorer!.ceiling(OWNER);
      for (const { permission } of entries) {
        expect(permission.actions.filter((action) => WRITES.includes(action))).toEqual([]);
      }
      const appsKv = entries.find(({ permission }) => permission.service === "tinycloud.kv" && permission.space === "applications");
      expect(appsKv?.permission.actions).toEqual(["get", "list"]);
    });
  }
});
