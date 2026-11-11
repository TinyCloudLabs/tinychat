import { expect, test } from "bun:test";
import { BASE_PATH, publicUrl } from "./basePath";

test("a root deployment keeps its absolute public paths", () => {
  expect(BASE_PATH).toBe("/");
  expect(publicUrl("icons/pwa-192.png")).toBe("/icons/pwa-192.png");
});
