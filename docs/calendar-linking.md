# Calendar linking

Links a recording or an imported meeting to one event instance of the user's primary Google
calendar, and keeps the event's invitees on the note. Read-only, optional, separate from Calendar
autojoin and from the Google Meet connector. No bot, no worker, no server-held token.

## Switches

- Frontend build flag `VITE_CALENDAR_LINKING=true`. Off (the default): no runner, no settings row,
  no chip on a note, no invitee candidates or suggestions, even where a link is already stored.
- The shared Google OAuth routes must be mounted: `GOOGLE_MEET_OAUTH_ENABLED=true` gates
  `/api/connectors/google/oauth/*` for every purpose. With it off the settings row says linking is
  unavailable on this server. Calendar autojoin does not have to be configured or enabled.

## Consent and custody

- Purpose `calendar-link` on `/start`, `/desktop/start`, `/exchange` and `/revoke`.
- Scope: `https://www.googleapis.com/auth/calendar.events.owned.readonly openid`, without
  `include_granted_scopes`. `openid` yields only the Google subject, which the revoke guard needs;
  no `email` is requested. Both scopes are already registered for autojoin in the Google project.
- The refresh token is stored in the user's vault (`REFRESH_TOKEN`, scope `google-calendar-link`)
  beside the backend's opaque grant binding (digests only). Access tokens come from the stateless
  `/refresh` proxy and live in memory.
- The exchange for this purpose never calls the autojoin connection: it cannot disable autojoin
  and does not replace the Meet connector's browser binding.

## What is read and stored

`events.list` on `primary` with `singleEvents=true`, `showDeleted=false` and a `fields` mask
(`CALENDAR_LINK_EVENT_FIELDS` in `packages/core/src/calendar-link.ts`). The mask asks for no email
address, description, location, attachment or web link.

`connector_meeting.metadata.calendar_link` (shape and states in the same file):

- linked: `event_id` (the instance), `recurring_event_id`, `original_start`, `ical_uid`, `title`,
  `start`, `end`, `conference`, `invitees` (`name`, `response`, `organizer`, `self`, `optional`),
  `attendees_omitted`, `match` (`meeting_code`/high, `time_overlap`/medium, or `user`);
- waiting for the user's pick: up to three `candidates`;
- the user's "none": `match.method = "user"` without an event. Nothing links that note again.

A deleted event keeps its stored snapshot with `event_missing: true`. A Google Meet import's
meeting code is resolved once through `spaces.get` and kept as `metadata.meeting_code`.

To the naming model go invitee display names only, never the user's own entry, an address, the
event title, times or responses.

## Matching

`matchCalendarEvent` in core. In order: the same meeting code with an overlap in time; else one
event that covers at least half the note, or that the note starts with (10 minutes before to 15
after its start), and that has a conference or is the only event the note overlaps; else the user
picks. An event whose known meeting code differs from the note's is never matched on time.
All-day, cancelled, declined, non-default (focus time, out of office) and conference-less "free"
events are never linked.

## When linking runs

One runner per signed-in space (`frontend/src/lib/calendarLink/linkRunner.ts`), in the browser:

- a note is saved or changed (`library-changed`) or opened: calls are gathered for a moment and
  the calendar is listed once for the batch;
- a Google Meet sync run ends: the notes of the sync's 30-day window are linked with one listing;
- after connecting, and from Settings ("Link existing notes"): every note without a link, with
  one paged listing over their whole range (40 pages at most per run);
- a linked note is opened: its event is read again, once per session, and the stored title,
  times and invitees follow it.

Notes that can link: any `connector_meeting` row with an exact start time, except pasted
transcripts and combined meetings. A note that matches nothing gets no write. Fireflies and
Granola imports are not announced per row by their syncs, so they link when opened or from
Settings. An automatic write applies only to a row without a `calendar_link`, so a link, a
pending pick and the user's "none" are never written over.

## Disconnect and revocation

Unlinking stops the reads at once, deletes the vault secret and keeps stored links unless the user
also removes calendar details from notes.

Google revokes per user and project, not per scope, so a plain revoke of the linking token would
also end the Meet connector's and autojoin's access. The backend therefore revokes upstream only
on a positive decision:

| Caller | Upstream revoke happens when |
|---|---|
| `/revoke` with `purpose: "calendar-link"` | the token's grant binding is valid, the grant index is trusted, no live autojoin custody holds the same Google subject, and the browser did not report a connected Meet connector |
| `/revoke` (Meet) and `/autojoin/disconnect` | as before, unless the browser sends `calendarLinkConnected: true`: then local teardown runs and every upstream revoke is skipped |

Reasons are logged as `code=grant_revoke … reason=…` without token material. The UI never
promises an immediate, feature-only revoke and points to Google Account, Third-party connections.

Limits of the guard:

- Browser-held holders (Meet connector, calendar link) are known only to the space that holds
  them. Two TinyCloud accounts that connected the same Google account are protected from each
  other only for server-held autojoin custody.
- After a backend restart the grant index is untrusted until its backfill completes; a linking
  revoke in that window is kept, not sent.

## Not verified against Google

- That `calendar.events.owned.readonly` returns every invitation on `primary`, including events
  organised outside the user's domain. Autojoin already reads invited events with this scope.
- That `spaces.get` returns `meetingCode` for an imported conference record within 30 days.
- The desktop call-window reader does not capture a Meet code or Zoom id yet. The runner reads
  `call_participants.meeting_code` when present; until the reader writes it, desktop recordings
  link by time.
