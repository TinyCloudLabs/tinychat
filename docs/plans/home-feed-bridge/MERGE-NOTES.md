# Merge notes: feed lab → the real Home feed

A living list for porting this branch's lab (`/feed-lab`, made-up cards only) into the real feed on `main`, which #610 ("Home feed: a list of cards with one-tap answers and comments") is now part of. Kept up to date with each lab build. Nothing here is merged; the port starts after the lab is approved.

Each entry says what the real feed needs: new card fields, the response and outbox paths, and what exists only in the mock.

## Ground rules for the port

- **Base:** `main` (with #610). Bring the lab's parts on top of it, not the other way round. `HANDOFF.md` lists where the two collide.
- **Lab-only fields:** everything under "New card fields" is read from `payload` today and the public card guide names none of it. Each needs a line in the guide (and in `@tinycloud/sdk-services` types if it becomes first-class) before an agent can rely on it.
- **Mock-only code:** `feedLabSource.ts`, `feedLabJsonSource.ts`, `FeedLab.tsx`, the lab media in `public/lab-media`, and the `FEED_LAB` build switches in `vite.config.ts` and `main.tsx` (no service worker in lab builds) stay out of the port.

## New card fields (all optional, all in `payload` today)

| Field | Shape | Used by | Notes |
|---|---|---|---|
| `summary` | string | compact card's description | Falls back to the body. |
| `page` | `{ image, imageAlt, questions[{ id, header?, question, media?[{ type, src, caption?, poster? }], options?[{ label, description?, recommended?, image? }], multi?, notePrompt? }] }`, card `kind: "page"` | post tile, `PostPage.tsx` | Post answers go to the agent as one text block today; the port should send structured per-question data. The "1 of 2 answered" count lives only in memory. |
| `replies[]` | `{ text, at, replyTo? }`; `replyTo` = the comment's `responseId` | `CardConversation.tsx` | A reply with `replyTo` sits under that comment and is not repeated as a quote in the card body. Agents re-publish the card with replies; `replyOnlyRevision.ts` keeps the answer across those revisions. |
| `agent` | `{ kind, model?, runsOn?, job? }` | agent mark, Details | Display-only, what the agent says about itself. What the owner approved should come from the registry. |
| `project` | string | Filter by project | Typed cards use `group`. |
| `report` | URL | "Report" link | |
| `brief` | `{ title, markdown? , url? }` | brief sheet | See "Briefs". |
| `expiresAt` | ISO time ("relevant until") | feed, History, sort | See "Expiry and deadline". |
| `deadline` | ISO time | compact card "Due …", sort | See "Expiry and deadline". |
| `priority` | integer 0 (highest) to 5 | "P0"…"P5" mark, Filter, sort | Typed sitrep records have urgency and importance instead; the lab doesn't map them to this. |

## Features

### Undo and countdown on every answer

- **Lab:** every path that sends something to an agent waits out the same 4-second count with Undo before it writes: options, your own answer, "Accept recommendation", "Drop question", and on typed cards "Give the go", "Save code", "I completed this step", task done, claim decisions, blocker cleared and hold lift. Private actions stay immediate (task step ticks, private acknowledgement and priority, Ask me later, which has its own Undo). Comments send at once.
- **Lab:** the count sends at once when the card unmounts or the page is hidden or closed (`pagehide`, `visibilitychange` to hidden). Switching apps during the count therefore sends it, which ends the chance to undo.
- **Lab:** a go re-checks when the count ends that it is still open, the same issuance and not past `expiresAt`. If not, nothing is written: "This approval expired before it was sent. Nothing was sent." or "This approval closed before it was sent. Nothing was sent."
- **Port:** use main's path, `saveResponse(entry, response, payload, { hold: true })` with `answerOutbox.ts` (`holdAnswer` before the first await, `flushHeldAnswers` at the next launch) and `cardKit.tsx`'s `pagehide` flush. Better still, hold at the tap with a release time, so Undo removes it from the outbox and a killed page finishes it at the next launch. The release must run the approval re-check above, and commands keep their idempotency keys through the outbox.
- **Mock-only:** the lab's hold lives in component memory; a closed lab page loses its made-up answers by design.
- **Tests to update in the port:** `SitrepFeed.test.tsx` (go, save code, keep claim, blocker cleared, and the test that pins "gives the go at once") and `HomeReview.test.tsx` (save code, step completed) expect an immediate write.

### "Received" means delivered; "Send again"

- **Lab:** a comment shows "Received" only once the agent acknowledges it. A comment with no acknowledgement and no reply 30 seconds after it went (`UNCONFIRMED_AFTER_MS`) shows "Not confirmed · may arrive twice if sent again" and "Send again" under it, even when it isn't your latest comment. A later comment with the same words counts as the copy and takes over the status.
- **Port:** "Received" must be the agent's `FeedHandling { phase: "acknowledged" }`, written only after the comment really reached the agent (for a relayed agent, after its watcher confirms delivery). "Send again" posts the same text as a new `message` response; on typed cards, a `sitrep.thread` payload with `resendOf` set to the first `messageId`.
- **Port:** plain cards have no `resendOf`; the lab pairs a copy with its original by matching words, so sending the same words twice on purpose reads as a resend. Add `resendOf` to the response schema if that matters. Typed cards already carry it (`usePostReply` now passes it).
- **Port:** older typed threads whose messages have no response header count as unacknowledged and will read "Not confirmed". Decide whether history before the port is treated as confirmed.
- **Port:** set `UNCONFIRMED_AFTER_MS` to the watcher's real delivery time (30 s is a guess). Resends send at once, without the undo window; route them through the outbox like any send.
- **Mock-only:** the lab agent acknowledges new comments on a timer, and one seeded comment on the water filter card is never acknowledged, to show the state.

### Briefs

- **Lab:** a card with `payload.brief` shows "Read the brief", which opens the brief inside the app: full screen on phones, a large dialog on wider screens. `markdown` renders inline; a `url` is fetched (Markdown rendered, HTML in a sandboxed frame).
- **Lab:** `briefOf` (`BriefSheet.tsx`) checks the field: a title up to 200 characters; `markdown` up to 100,000 characters (it wins over `url`); `url` a path on this host, this origin or any https address ending `.md`, `.markdown`, `.html` or `.htm`. `BriefMarkdown.tsx` renders headings, lists, quotes, code, tables, emphasis and links; raw HTML shows as text, images as their alt text, and only http, https and mailto become links. An `.html` brief shows in a sandboxed frame with no scripts.
- **Lab:** the room card's brief is inline Markdown (mock-only content). Opening a brief writes nothing, so it needs no outbox or undo.
- **Port:** typed cards' `links` still open in a new tab; same-host `.md` and `.html` links there could open in the same sheet.
- **Port:** decide where brief pages live (a file in the agent's TinyCloud space, read with the owner's grant, is the natural home) and whether `url` may point off-host. Name `brief` in the card guide.

### Expiry and deadline

- **Lab:** two separate optional times. Past `expiresAt`, a card leaves every view and shows only in History, marked "Expired". `deadline` shows as "Due …" on a card that needs you. An opened card lists "Due …", "Relevant until …" and its priority. Filter can order by "Due first" or "Expires first"; cards without the time go last.
- **Open question (flag for the merge):** whether expiry and deadline are one thing. Kept as two fields until decided.
- **Port:** the expiry check runs in the browser against the clock; the real feed should also let the agent close the card (a new revision) and tell the poster it expired, as the sitrep board's expiry pass does.

### Priority

- **Lab:** `payload.priority` 0 to 5, set by the agent, shown as "P0"…"P5" on the compact card. Filter: "Any priority", "P0 only", "P0 to P1" … "P0 to P4"; order "Priority first".
- **Port:** decide how it relates to `urgency` (the SDK's one number) and to typed cards' urgency and importance. The lab treats them as unrelated.

### Earlier in the lab (unchanged by this round)

- Compact, Full and Grid views with the density morph (`densityMorph.tsx`, `motion`), the Information | All | Needs action slider, the floating header, history pull with "Go to current", snooze that hides cards with a Snoozed filter and "Bring back now", Details sheet with the card's timeline, post pages, the chat-style conversation. Each is presentational over the existing store; the history load (`loadMore`) is lab-only and needs a real store query.

## Not ported

The sitrep board's other views (Ship, Holds, Releases, Interviews, Claims, Effectiveness) stay out of the feed.
