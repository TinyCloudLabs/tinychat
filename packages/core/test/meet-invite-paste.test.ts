import { describe, expect, test } from "bun:test";

import { meetingLinkFromInput } from "../src/index.js";

const SAM_INVITE = "TinyCloud Team Sync Wednesday, October 28 · 8:00 – 8:30am Time zone: America/New_York Google Meet joining info Video call link: https://meet.google.com/yas-buib-ppd Or dial: (DE) +49 30 300195060 PIN: 933 894 199 6748# More phone numbers: https://tel.meet/yas-buib-ppd?pin=9338941996748";

describe("meetingLinkFromInput on a pasted calendar invite", () => {
  test("a calendar invite resolves to its Meet link", () => {
    expect(meetingLinkFromInput(SAM_INVITE)).toBe("https://meet.google.com/yas-buib-ppd");
  });

  test("the first Meet link wins over a dial-in or unrelated link that comes before it", () => {
    expect(meetingLinkFromInput("Dial https://tel.meet/klm-nopq-rst?pin=1 Video https://meet.google.com/abc-defg-hij Backup https://meet.google.com/yas-buib-ppd"))
      .toBe("https://meet.google.com/abc-defg-hij");
    expect(meetingLinkFromInput("Notes https://example.com/notes Video https://meet.google.com/abc-defg-hij"))
      .toBe("https://meet.google.com/abc-defg-hij");
    expect(meetingLinkFromInput("https://meet.google.com/abc-defg-hij is the first call; backup https://meet.google.com/yas-buib-ppd"))
      .toBe("https://meet.google.com/abc-defg-hij");
  });

  test("a first lookup link keeps its nickname and query and is not skipped for a later code", () => {
    expect(meetingLinkFromInput("Join https://meet.google.com/lookup/TeamFirst?authuser=1 Backup https://meet.google.com/yas-buib-ppd"))
      .toBe("https://meet.google.com/lookup/TeamFirst?authuser=1");
    expect(meetingLinkFromInput("Join meet.google.com/lookup/TeamBareFirst?authuser=1 Backup https://meet.google.com/yas-buib-ppd"))
      .toBe("https://meet.google.com/lookup/TeamBareFirst?authuser=1");
  });

  test("a first HTTP lookup link is left as pasted for the service to refuse, not skipped", () => {
    expect(meetingLinkFromInput("Join http://meet.google.com/lookup/TeamFirst Backup https://meet.google.com/yas-buib-ppd"))
      .toBe("http://meet.google.com/lookup/TeamFirst");
  });

  test("lookalike hosts, userinfo hosts and a Meet link inside another site's query are never picked", () => {
    for (const input of [
      "Join https://meet.google.com.evil.com/abc-defg-hij or https://evilmeet.google.com/klm-nopq-rst or https://meet.google.com@evil.com/yas-buib-ppd",
      "Notes https://evil.com/?next=https://meet.google.com/abc-defg-hij More information follows",
    ]) {
      const result = meetingLinkFromInput(input);
      expect(result === null || !/^https:\/\/meet\.google\.com\/[a-z]{3}-/.test(result)).toBe(true);
    }
    // A real Meet link after the lookalikes is still the one picked.
    expect(meetingLinkFromInput("https://meet.google.com.evil.com/abc-defg-hij then https://meet.google.com/yas-buib-ppd"))
      .toBe("https://meet.google.com/yas-buib-ppd");
  });

  test("a link wrapped in brackets or sentence punctuation, or glued to a label, is read through it", () => {
    expect(meetingLinkFromInput("Join (https://meet.google.com/YAS-BUIB-PPD/). Or dial +49 30 300195060")).toBe("https://meet.google.com/yas-buib-ppd");
    expect(meetingLinkFromInput("Calendar(https://meet.google.com/yas-buib-ppd)")).toBe("https://meet.google.com/yas-buib-ppd");
  });

  test("an invite with only a dial-in Meet link still reads as before", () => {
    expect(meetingLinkFromInput("Or dial +49 30 300195060 More numbers https://tel.meet/yas-buib-ppd?pin=9338941996748"))
      .toBe("https://meet.google.com/yas-buib-ppd");
  });
});
