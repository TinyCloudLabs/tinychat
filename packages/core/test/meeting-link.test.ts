import { describe, expect, test } from "bun:test";

import { meetingLinkFromInput } from "../src/index.js";

describe("meetingLinkFromInput", () => {
  test("rewrites the pasted forms upstream doesn't recognise", () => {
    const cases: Array<[string, string]> = [
      ["https://google.com/meet/ofj-ahew-paa", "https://meet.google.com/ofj-ahew-paa"],
      ["https://www.google.com/meet/OFJ-AHEW-PAA/", "https://meet.google.com/ofj-ahew-paa"],
      ["google.com/meet/ofj-ahew-paa?authuser=1", "https://meet.google.com/ofj-ahew-paa?authuser=1"],
      ["https://meet.google.com/meet/ofj-ahew-paa", "https://meet.google.com/ofj-ahew-paa"],
      ["meet.google.com/meet/OFJ-AHEW-PAA/?authuser=1", "https://meet.google.com/ofj-ahew-paa?authuser=1"],
      ["Join with Google Meet: meet.google.com/meet/ofj-ahew-paa\nJoin by phone", "https://meet.google.com/ofj-ahew-paa"],
      ["meet.google.com/wmq-jkvr-rmi", "https://meet.google.com/wmq-jkvr-rmi"],
      ["wmq-jkvr-rmi", "https://meet.google.com/wmq-jkvr-rmi"],
      ["  <https://meet.google.com/wmq-jkvr-rmi>. ", "https://meet.google.com/wmq-jkvr-rmi"],
      ["Join with Google Meet: meet.google.com/wmq-jkvr-rmi\nJoin by phone +1 555-0100", "https://meet.google.com/wmq-jkvr-rmi"],
      ["https://www.google.com/url?q=https://meet.google.com/wmq-jkvr-rmi&sa=D&source=calendar", "https://meet.google.com/wmq-jkvr-rmi"],
      ["https://www.google.com/url?q=https%3A%2F%2Fgoogle.com%2Fmeet%2Fwmq-jkvr-rmi", "https://meet.google.com/wmq-jkvr-rmi"],
      ["https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fzoom.us%2Fj%2F123%3Fpwd%3Dabc&data=x", "https://zoom.us/j/123?pwd=abc"],
      ["zoom.us/j/123456789?pwd=AbC", "https://zoom.us/j/123456789?pwd=AbC"],
      ["Join Zoom Meeting https://us02web.zoom.us/j/123?pwd=AbC Meeting ID: 123", "https://us02web.zoom.us/j/123?pwd=AbC"],
      ["www.teams.live.com/meet/9876", "https://www.teams.live.com/meet/9876"],
    ];
    for (const [input, expected] of cases) expect(meetingLinkFromInput(input)).toBe(expected);
  });

  test("returns any other link exactly as pasted, apart from surrounding space", () => {
    for (const link of [
      "https://MEET.jit.si/room/?b=2&a=1#fragment",
      "https://signal.link/call/#key=AbC_dEf-123",
      "https://us02web.zoom.us/j/123?pwd=AbC.1",
      "http://meet.google.com/wmq-jkvr-rmi",
      "https://meet.google.com/lookup/abc",
    ]) expect(meetingLinkFromInput(` ${link} `)).toBe(link);
  });

  test("refuses input with no http(s) link in it", () => {
    for (const input of ["", "   ", "not a url", "notaurl", "ftp://x/y", "javascript:alert(1)", "mailto:a@b.co", "https://", "Join the meeting"]) {
      expect(meetingLinkFromInput(input)).toBeNull();
    }
  });
});
