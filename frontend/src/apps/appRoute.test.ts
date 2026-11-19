import { describe, expect, test } from "bun:test";
import { screenFor } from "../shell/routes";
import { appRoute, ONE_APPS } from "./registry";

describe("framed app routes", () => {
  test("every app's route opens the Apps destination naming that app", () => {
    for (const app of ONE_APPS.filter((candidate) => candidate.kind === "framed")) {
      expect(screenFor(appRoute(app))).toEqual({ id: "apps", destination: "apps", noteId: null, appId: app.id });
    }
  });

  test("the Apps page itself names no app, and a malformed escape stays literal", () => {
    expect(screenFor("/chat/apps").appId).toBeUndefined();
    expect(screenFor("/chat/apps/%E0%A4%A").appId).toBe("%E0%A4%A");
  });
});
