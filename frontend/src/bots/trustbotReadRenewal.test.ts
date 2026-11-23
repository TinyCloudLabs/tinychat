import { expect, test } from "bun:test";

import { botGrantLifetime } from "./botGrantLifetime";
import { readAreasDueForRenewal, type ReadSettings } from "./trustbotReadGrant";

test("read grants renew past half-life or on expiry only when the parent can extend them", () => {
  const day = 86_400_000;
  const now = Date.parse("2026-11-23T12:00:00Z");
  const expiresAt = now + day;
  const renewAfter = now;
  const siweUntil = (at: number) => `Expiration Time: ${new Date(at).toISOString()}`;
  const renewedSession = siweUntil(now + 2 * day);
  const saved: ReadSettings = {
    expiresAt, grantCid: "old", serviceDid: "service", areas: { meetings: "on", feed_chats: "off" },
  };

  expect(readAreasDueForRenewal(saved, renewAfter, renewedSession, now)).toEqual([]);
  expect(readAreasDueForRenewal(saved, renewAfter, renewedSession, now + 1)).toEqual(["meetings"]);
  expect(readAreasDueForRenewal(saved, renewAfter, siweUntil(expiresAt), now + 1)).toEqual([]);
  expect(readAreasDueForRenewal(saved, renewAfter, siweUntil(now), now + 1)).toEqual([]);
  expect(readAreasDueForRenewal({ ...saved, areas: { meetings: "off", feed_chats: "off" } }, renewAfter, renewedSession, now + 1)).toEqual([]);

  const ended: ReadSettings = { ...saved, areas: { meetings: "ended", feed_chats: "ended" } };
  expect(readAreasDueForRenewal(ended, renewAfter, renewedSession, expiresAt)).toEqual(["meetings", "feed_chats"]);
  expect(botGrantLifetime(renewedSession, now)).toBe(2 * day);
  expect(botGrantLifetime(siweUntil(now + 30 * day), now)).toBe(7 * day);
});
