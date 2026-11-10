import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { installDom } from "@/test/dom";
import { openKeyAccountDeletionUrl, openOpenKeyAccountDeletion } from "./openOpenKeyAccountDeletion";

let restoreDom: (() => void) | undefined;

beforeEach(() => { restoreDom = installDom(); });
afterEach(() => {
  mock.restore();
  restoreDom?.();
});

describe("openOpenKeyAccountDeletion", () => {
  test("names OpenKey's deletion page on the configured host", () => {
    expect(openKeyAccountDeletionUrl("https://openkey.so")).toBe("https://openkey.so/dashboard/settings/delete-account");
    expect(openKeyAccountDeletionUrl("http://localhost:5173/")).toBe("http://localhost:5173/dashboard/settings/delete-account");
  });

  test("on web it opens the deletion page in a new tab without giving that page access to the app", async () => {
    const open = spyOn(window, "open").mockImplementation(() => null);
    await openOpenKeyAccountDeletion();
    expect(open).toHaveBeenCalledWith("https://openkey.so/dashboard/settings/delete-account", "_blank", "noopener,noreferrer");
  });
});
