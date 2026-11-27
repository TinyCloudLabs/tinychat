// When a note's calendar link suggests a name for a speaker ("Invited to this meeting"), and when it does not.
import { describe, expect, test } from "bun:test";
import { ambiguousCalendarLink, linkedCalendarLink, parseCalendarLink, unlinkedCalendarLink, type CalendarLink,
  type GoogleCalendarAttendee, type GoogleCalendarEvent } from "@tinyboilerplate/core";

import { parseCallParticipants } from "@/capture/library/callParticipants";
import type { FirefliesSentence } from "@/lib/connectors/firefliesClient";

import { dismissedInviteeLabels, inviteeSuggestion } from "./inviteeSuggestion";

const ME: GoogleCalendarAttendee = { self: true, displayName: "Robin Sample", responseStatus: "accepted", organizer: true };
const KIM: GoogleCalendarAttendee = { displayName: "Kim Lee", responseStatus: "accepted" };
const event = (attendees: GoogleCalendarAttendee[], patch: Partial<GoogleCalendarEvent> = {}): GoogleCalendarEvent => ({
  id: "evt-1", status: "confirmed", summary: "Pricing review",
  start: { dateTime: "2026-11-20T10:00:00Z" }, end: { dateTime: "2026-11-20T10:30:00Z" }, attendees, ...patch,
});
/** The link as a note's row gives it back. */
const linked = (attendees: GoogleCalendarAttendee[], patch: Partial<GoogleCalendarEvent> = {}): CalendarLink | null =>
  parseCalendarLink(JSON.parse(JSON.stringify(linkedCalendarLink(event(attendees, patch), { method: "time_overlap", confidence: "medium", overlap: 1 }, "2026-11-20T11:00:00.000Z"))));

const said = (speaker_name: string | null, start_time: number, end_time: number, extra: Partial<FirefliesSentence> = {}): FirefliesSentence =>
  ({ index: start_time, speaker_name, text: "Some words.", start_time, end_time, ...extra });
/** A call of two: the user on the microphone, one voice on the other side. */
const TWO: FirefliesSentence[] = [
  said("Me", 0, 5, { channel: 0 }), said("Speaker 1", 6, 20, { channel: 1, speaker_id: "A" }), said("Me", 21, 24, { channel: 0 }),
];
const IN_CALL = parseCallParticipants({ v: 1, source: "call_window", app: "google-meet", truncated: false,
  people: [{ id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Kim Lee" }] });

describe("the invitee suggested for a speaker", () => {
  test("a meeting of two whose other invitee accepted, on a transcript with one remote voice: that invitee, for that voice", () => {
    expect(inviteeSuggestion(linked([ME, KIM]), null, TWO)).toEqual({ label: "Speaker 1", name: "Kim Lee" });
    // Someone who declined is not coming, and a room is nobody.
    expect(inviteeSuggestion(linked([ME, KIM, { displayName: "Noor Haddad", responseStatus: "declined" }, { displayName: "Room 4", resource: true }]), null, TWO))
      .toEqual({ label: "Speaker 1", name: "Kim Lee" });
    // The user picked the event themselves.
    const picked = parseCalendarLink(JSON.parse(JSON.stringify(linkedCalendarLink(event([ME, KIM]), "user", "2026-11-20T11:00:00.000Z"))));
    expect(inviteeSuggestion(picked, null, TWO)).toEqual({ label: "Speaker 1", name: "Kim Lee" });
  });

  test("names from the call window stand in its place: nothing is suggested from the calendar", () => {
    expect(IN_CALL).not.toBeNull();
    expect(inviteeSuggestion(linked([ME, KIM]), IN_CALL, TWO)).toBeNull();
  });

  test("nothing unless exactly one other invitee is coming, accepted, has a name, and the guest list is whole and marks the user", () => {
    const none = (attendees: GoogleCalendarAttendee[], patch: Partial<GoogleCalendarEvent> = {}) =>
      expect(inviteeSuggestion(linked(attendees, patch), null, TWO)).toBeNull();
    none([ME, KIM, { displayName: "Timo Varela", responseStatus: "tentative" }]);
    none([ME, KIM, { displayName: "Timo Varela", responseStatus: "needsAction" }]);
    none([ME, KIM, { responseStatus: "accepted" }]);
    none([ME, { ...KIM, responseStatus: "tentative" }]);
    none([ME, { ...KIM, responseStatus: "needsAction" }]);
    none([ME, { ...KIM, responseStatus: "declined" }]);
    none([ME, KIM], { attendeesOmitted: true });
    none([ME, { responseStatus: "accepted" }]);
    none([ME, { displayName: "kim@example.com", responseStatus: "accepted" }]);
    none([ME, { displayName: "Speaker 1", responseStatus: "accepted" }]);
    // Nobody is marked as the user: either of the two could be them.
    none([{ displayName: "Robin Sample", responseStatus: "accepted" }, KIM]);
    none([KIM]);
    none([ME]);
  });

  test("nothing for a note that waits for the user's pick, that the user unlinked, or that has no link", () => {
    expect(inviteeSuggestion(ambiguousCalendarLink([event([ME, KIM])]), null, TWO)).toBeNull();
    expect(inviteeSuggestion(unlinkedCalendarLink("2026-11-20T11:00:00.000Z"), null, TWO)).toBeNull();
    expect(inviteeSuggestion(null, null, TWO)).toBeNull();
  });

  test("nothing unless the transcript has exactly one voice that is not the user's", () => {
    const link = linked([ME, KIM]);
    // A second remote voice, however little it says.
    expect(inviteeSuggestion(link, null, [...TWO, said("Speaker 2", 25, 27, { channel: 1, speaker_id: "B" })])).toBeNull();
    expect(inviteeSuggestion(link, null, [...TWO, said("Unknown speaker", 25, 27, { channel: 1 })])).toBeNull();
    // The one voice says too little to be named, or there is no transcript.
    expect(inviteeSuggestion(link, null, [said("Me", 0, 5, { channel: 0 }), said("Speaker 1", 6, 9, { channel: 1, speaker_id: "A" })])).toBeNull();
    expect(inviteeSuggestion(link, null, [])).toBeNull();
    // "Them" is one person only when the engine looked for several voices.
    expect(inviteeSuggestion(link, null, [said("Me", 0, 5, { channel: 0 }), said("Them", 6, 30, { channel: 1 })])).toBeNull();
    expect(inviteeSuggestion(link, null, [said("Me", 0, 5, { channel: 0 }), said("Them", 6, 30, { channel: 1, speaker_id: "A" })]))
      .toEqual({ label: "Them", name: "Kim Lee" });
  });

  test("the user's own side is never the label", () => {
    const link = linked([ME, KIM]);
    for (const own of ["Me", "You"]) {
      expect(inviteeSuggestion(link, null, [said(own, 0, 60)])).toBeNull();
      expect(inviteeSuggestion(link, null, [said(own, 0, 60), said("Speaker 1", 60, 90)])).toEqual({ label: "Speaker 1", name: "Kim Lee" });
    }
    // The only numbered speaker is the microphone side of a two-sided note.
    expect(inviteeSuggestion(link, null, [said("Speaker 1", 0, 60, { channel: 0 })])).toBeNull();
    // A one-sided note (an upload, a phone memo) with one speaker: that speaker may be the user.
    expect(inviteeSuggestion(link, null, [said("Speaker 1", 0, 60)])).toBeNull();
    // The user's own entry is never the name, even where it is the only one with a name.
    expect(inviteeSuggestion(linked([ME, { responseStatus: "accepted" }]), null, TWO)).toBeNull();
  });
});

describe("a dismissed invitee suggestion", () => {
  test("counts for the event it was dismissed for, and for no other", () => {
    const metadata = { invitee_suggestion_dismissed: { event_id: "evt-1", labels: ["Speaker 1", 7] } };
    expect(dismissedInviteeLabels(metadata, "evt-1")).toEqual(["Speaker 1"]);
    expect(dismissedInviteeLabels(metadata, "evt-2")).toEqual([]);
    expect(dismissedInviteeLabels({ invitee_suggestion_dismissed: ["Speaker 1"] }, "evt-1")).toEqual([]);
    expect(dismissedInviteeLabels(null, "evt-1")).toEqual([]);
  });
});
