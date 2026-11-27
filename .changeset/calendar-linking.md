---
"@tinychat/frontend": patch
---

Recordings and imported meetings can show which Google Calendar event they belong to. Link Google Calendar is its own read-only connection, separate from Calendar autojoin and from the Google Meet connector: it never joins a meeting, sends a notetaker or changes your calendar, and its token stays in your space. A note links to one event when both share a meeting code, or when it clearly overlaps one event in time; otherwise the note asks "Which meeting was this?" and you pick, or choose None of these. Every link can be changed or removed from the note. The event's guests are kept on the note as invited people, apart from the names seen in the call and the names you gave: they can be offered as a suggestion ("Invited to this meeting") and as spelling help for suggested speaker names, and nothing is renamed until you choose Use. No guest's email address is read or stored.

Unlinking stops the calendar reads at once and deletes the token. Google access itself is removed only when no other TinyCloud One Google feature uses it; the same now holds when you disconnect Google Meet while your calendar is linked.

This is behind a build flag (`VITE_CALENDAR_LINKING`) that is off in production, so released builds do not change yet.
