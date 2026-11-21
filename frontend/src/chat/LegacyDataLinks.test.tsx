import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LegacyDataLinks } from "./LegacyDataLinks";

const hrefs = (hostname: string) => [...renderToStaticMarkup(<LegacyDataLinks hostname={hostname} />).matchAll(/href="([^"]+)"/g)].map((m) => m[1]);

test("tinycloud.one Settings links to each old address with ?legacy=1, which keeps that page from moving", () => {
  expect(hrefs("tinycloud.one")).toEqual(["https://tinycloud.chat/?legacy=1", "https://home.tinycloud.xyz/?legacy=1"]);
});

test("the links are not shown on an old address, in the app shell or in development", () => {
  for (const hostname of ["tinycloud.chat", "home.tinycloud.xyz", "localhost"]) expect(hrefs(hostname)).toEqual([]);
});
