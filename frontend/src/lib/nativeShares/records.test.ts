// TC-3195: the owner's sent-share record and the recipient's received-share record are kept in a space. A share
// token or a link is a bearer secret, and a link's `k` opens its sealed record: none of them may reach either record.
import { describe, expect, test } from "bun:test";

import { parseRecordingDisplay } from "./display";
import { parseReceivedShare, receivedShareRecord, receivedShares, RECEIVED_SHARES_PREFIX } from "./receivedShares";
import type { ClaimedShare, OpenedShareLink } from "./sdk";
import { parseSentShare, sentShareRecord, sentShares, SENT_SHARES_PREFIX } from "./sentShares";
import type { RecordSpace } from "./spaceRecords";

const TOKEN = "tc1:eyJzZWNyZXQiOiJ0b2tlbi1ib2R5In0";
const K = "QmFzZTY0VXJsQ29udGVudEtleUZvclRoZVNlYWxlZFJlY29yZA";
const LINK = `https://tinycloud.one/s/7f3kq9x2m4hz8a1c5vd0wnbe6y#v=4&k=${K}&c=bafyroot`;
const NOW = new Date("2026-11-17T10:00:00.000Z");
const OWNER = { address: "0xd5590000000000000000000000000000000ff412", chainId: 1, spaceId: "tinycloud:pkh:eip155:1:0xd5590000000000000000000000000000000ff412:default" };
const DISPLAY = parseRecordingDisplay({ title: "Product sync with Priya", recordedAt: "2026-11-16T14:00:00.000Z", durationSeconds: 1924, includes: ["transcript", "audio"], source: "meeting" })!;
const PATHS = ["xyz.tinycloud.tinychat/connectors/fireflies/transcript/ff-1", "xyz.tinycloud.tinychat/connectors/fireflies/audio/ff-1/"];

function expectNoSecret(serialized: string) {
  expect(serialized).not.toContain(TOKEN);
  expect(serialized).not.toContain("tc1:");
  expect(serialized).not.toContain(LINK);
  expect(serialized).not.toContain("tinycloud.one/s/");
  expect(serialized).not.toContain(K);
  expect(serialized).not.toMatch(/[#&?]k=/);
  expect(serialized).not.toMatch(/"(token|link|k)"\s*:/);
}

/** A space that records every value written to it. */
function fakeSpace() {
  const written = new Map<string, string>();
  const space = {
    did: "did:pkh:eip155:1:0xd5590000000000000000000000000000000ff412",
    kv: {
      put: async (key: string, value: string) => {
        written.set(key, value);
        return { ok: true, data: undefined };
      },
      delete: async (key: string) => {
        written.delete(key);
        return { ok: true, data: undefined };
      },
    },
  } as unknown as RecordSpace;
  return { space, written };
}

describe("the owner's sent-share record", () => {
  test("is built without the token or the link, and is written as such", async () => {
    const record = sentShareRecord({ recordingId: "row-1", rootCid: "bafyroot", paths: PATHS, linkExpiresAt: "2026-11-24T10:00:00.000Z", accessExpiresAt: "2027-11-17T10:00:00.000Z", now: NOW });
    expectNoSecret(JSON.stringify(record));
    const { space, written } = fakeSpace();
    await sentShares.put(space, { ...record, linkId: "7f3kq9x2m4hz8a1c5vd0wnbe6y" });
    expect([...written.keys()]).toEqual([`${SENT_SHARES_PREFIX}bafyroot`]);
    for (const value of written.values()) expectNoSecret(value);
  });

  test("a stored record carrying a token, a link or k is read back without them", () => {
    const record = sentShareRecord({ recordingId: "row-1", rootCid: "bafyroot", paths: PATHS, linkExpiresAt: "2026-11-24T10:00:00.000Z", accessExpiresAt: "2027-11-17T10:00:00.000Z", now: NOW });
    const parsed = parseSentShare({ ...record, token: TOKEN, link: LINK, k: K });
    expect(parsed).toEqual(record);
    expectNoSecret(JSON.stringify(parsed));
  });
});

describe("the recipient's received-share record", () => {
  // The root's end (from inspectShareToken) is later than the claimed child's: the record keeps the child's.
  const opened: OpenedShareLink = { kind: "recording", display: DISPLAY, token: TOKEN, linkExpiresAt: "2026-11-24T10:00:00.000Z", owner: OWNER, accessExpiresAt: "2027-11-18T10:00:00.000Z", rootCid: "bafyroot" };
  const claimed: ClaimedShare = { delegation: JSON.stringify({ cid: "bafychild", parentCid: "bafyroot", resources: PATHS.map((path) => ({ path })) }), rootCid: "bafyroot", paths: PATHS, accessExpiresAt: "2027-11-17T10:00:00.000Z" };

  test("is built from the opened link's display and owner only, and is written as such", async () => {
    const record = receivedShareRecord(opened, DISPLAY, claimed, NOW, "linkid");
    expect(record).toMatchObject({ id: "bafyroot", linkId: "linkid", owner: OWNER, paths: PATHS, claimedAt: NOW.toISOString(), accessExpiresAt: claimed.accessExpiresAt });
    expectNoSecret(JSON.stringify(record));
    const { space, written } = fakeSpace();
    await receivedShares.put(space, record);
    expect([...written.keys()]).toEqual([`${RECEIVED_SHARES_PREFIX}bafyroot`]);
    for (const value of written.values()) expectNoSecret(value);
  });

  test("a stored record carrying a token, a link or k is read back without them", () => {
    const record = receivedShareRecord(opened, DISPLAY, claimed, NOW, "linkid");
    const parsed = parseReceivedShare({ ...record, token: TOKEN, link: LINK, k: K, display: { ...record.display, token: TOKEN, link: LINK } });
    expect(parsed).toEqual(record);
    expectNoSecret(JSON.stringify(parsed));
  });
});
