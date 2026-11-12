# Home feed: handoff from the `bridge-feed` branch

2026-11-12. For the Home team, to continue this work. Hunter set the direction. The branch, the spec and the mock were made with him in two days of fast iteration, so some of it is rough. This note says what is solid and what is not.

## What is here

- **The branch `bridge-feed`.** Three screen changes to the Home feed. It was last merged with `main` at 16:10 UTC on 11-12 (main at 6fdff2f6, which includes #630, #650 and #660). `main` moves fast, so check again. It changes the screen only: no store, schema, manifest or back-end file is touched, and it writes the same records as `main`.
- **`FEED-SPEC.md`.** The design as numbered rules. Each rule says who decided it, whether it is built, what data it needs, and how it sits against the existing architecture.
- **`mock/feed.html`.** A tappable phone mock ("Mock 4"): one self-contained file with made-up cards and a simulated agent. Open it in a browser at phone width. It is ahead of the code and shows where the design is going. Four screenshots sit beside it.

## What the branch does today

1. **One-tap answers.** A tap on an option sends it after a 4-second count with Undo. The card then folds to "You chose …" and shows steps: Sent, the agent received it, Completed.
2. **One place to write.** One box, "Reply to <agent>", replaces the three boxes on a typed card. The conversation stays on the folded row. Tapping an agent's name opens everything between the person and that agent, and there is an Agents list. Filters sit behind one "Filter" control.
3. **The open card as one piece.** One raised card is open and the rest are one-line rows. Each agent has its own letter mark. Where a card carries it, the agent's platform shows with its mark and name, with details on tap. Times are short.
4. **A feed lab.** `VITE_FEED_LAB=true` adds the route `/feed-lab`, with made-up cards and a simulated agent, so every state can be tried without signing in. A build without the flag contains none of it.

Checks after that merge: `cd frontend && bun test src/feed src/home` passes (290 tests) and `tsc` is clean.

Main files, in `frontend/src/feed/`:
- new: `AnswerOptions.tsx`, `AnswerSteps.tsx`, `CardReply.tsx`, `CardActions.tsx`, `AgentConversation.tsx`, `AgentMark.tsx`, `ShortTime.tsx`, `cardStatus.ts`, `FeedLab.tsx`, `feedLabSource.ts`;
- changed: `SitrepCard.tsx`, `HomeFeedEntries.tsx`, `HomeCardThread.tsx`, `FeedView.tsx`.

Also `frontend/src/lib/feedLab.ts`, `frontend/src/lib/basePath.ts`, and `frontend/public/platforms/` (five marks and `SOURCES.txt`).

## What Hunter decided

- **D1.** An answer is one tap, with a short count and Undo. Then the card folds and shows its steps.
- **D2.** One place to write on a card, and it says who gets the words. No "Note to owner" box. A note to yourself lives only inside "Remind me later".
- **D3.** Every card shows who is asking, what they need, what a tap will do, and who gets what the person writes. No ids or wiring words on the card face.
- **D4.** The conversation with an agent is easy to get back to later.
- **D5.** An agent is shown by a short name the person gave or approved, plus a few words on what it does.
- **D6.** Open cards must not blur together: one open card as one piece, the others as rows.
- **D7.** The card shows which agent is acting and on which platform, with the platform's own mark.
- **D8.** No explaining text under a control. If a control needs a sentence, it is the wrong control. "Comment" is the wrong word for a message to an agent.
- **D9.** A card sets the scene at a glance. It should be a little richer than a bare question.

He also asked that the work stay close to the underlying architecture: one identity per agent, grants the person approves, records in the person's own space, and messages only to approved destinations.

## Where the mock is ahead of the code

All of this is in Mock 4 and none of it is built. Hunter had not finished reacting to it when this was written.

- **One button, "Message <agent>".** It opens one line. There is no always-visible box and no separate "answer in your own words".
- **The card shows whose turn it is.** After the person sends a message, the card reads "Waiting on <agent>" and leaves "Needs you" until the agent replies or finishes. The agent decides what the words meant. It is the same message record as today; only the status on screen is new.
- **Context at a glance.** A project tag, the kind of decision, the thing itself shown (the first lines of a draft, an amount, a strip of checked facts) and up to three chips. A Plain / Context switch compares the two. Our own read is that the Context card overshoots: keep the tag, the kind and the thing shown, and drop chips that repeat it.
- **A List / Focus switch.** Focus shows one card per screen.
- **A disconnected agent's card** offers "Message <another agent> instead" as a choice the person taps. Nothing is redirected for them.

## This branch and the draft #610

#610 redesigns the same screen, and the two collide. A trial merge of #610 into this branch conflicts in 8 files and 72 places: `HomeFeedEntries.tsx` (14), `SitrepCard.tsx` (10), `HomeCardThread.tsx` (4), `FeedView.tsx` (3), and the tests `SitrepFeed.test.tsx` (23), `HomeFeed.test.tsx` (10), `HomeFeedEmpty.test.tsx` (5) and `HomeReview.test.tsx` (3).

Our recommendation is to make #610 the base and add this branch's parts on top. Hunter has not decided this.

- **Take from #610:** the count with its Undo pill, the outbox that keeps an answer when the page closes, the re-check when a card changed during the count, held notes, the comment data path, and its tests.
- **Add from this branch:** one open card with rows; agent marks, platform and details; the agent's page and the Agents list; the receipt steps; the feed lab.
- **Change in both, under D8:** no caption under the composer, and the control is called "Message <agent>".

Section 17 of the spec has the two side by side.

## Against the architecture

We checked every change against the existing model. Everything on the branch fits, with two small exceptions:

1. **Held notes are no longer written.** With no approved route for a card's owner, the one box sends to the publisher and nothing is held. Two routing tests in `SitrepFeed.test.tsx` were rewritten and no longer assert the held note. Either put the held note back or take #610's path, which keeps it.
2. **A label promises more than the route.** On a crew card the box reads "Reply to <member>", while the message goes to the publisher. Name the real destination, or give each member its own connection.

One addition: `payload.agent {kind, model, runsOn}` is a new optional, display-only key on a card. The public guide would have to name it. What the person approved (name, when it connected, when its access ends) is better read from the registry than from the card.

Proposed things, not built, and where they would stand:

- **An automatic fallback to a "main agent"** works against "held, never redirected". An explicit choice that the person taps each time fits.
- **Messages that belong to no card** would need a format change. One standing conversation card per agent fits the format as it is.
- **A crew behind one relay** has the shape of the existing relay. But replies handed on by `from` name, and typed cards from an outside publisher, do not fit. One feed connection per crew member is closest, and it costs the person no extra approval.
- **Grouping by project:** typed cards have `group`. Plain cards would use `payload.project`, which the guide does not name yet.
- **"Always do this"** needs a record the agent can read, confirmed by a standing-instruction card.

## Known gaps on the branch

- The open card is still busy next to the mock: a tall text box, a sentence explaining the count, a "Send answer" button and three more buttons. D8 removes the sentence, and Mock 4 shows the target.
- The last step says "Completed". The spec says "Done".
- Closing the page during the count can lose the answer. #610's outbox fixes this.
- Platform marks exist for five platforms only (`frontend/public/platforms/SOURCES.txt`). The others show their name. Each owner's brand rules need a check before Home shows any mark in public.
- The agent's details show four facts. "Connected", "Access ends" and "Disconnect" need registry and grant data that the page does not have.
- In the lab, two made-up agents share a colour, and a long option label is cut during the count.
- Existing tests were changed (`HomeFeed`, `HomeFeedEmpty`, `HomeFeedLocal`, `HomeReview`, `SitrepFeed`, `RootErrorBoundary`), so a pull request needs a `test-ruling` line. Changesets are in `.changeset/`. The new strings have had no copy review.
- The branch has only ever run with made-up cards. It has not run against a signed-in feed.

## Suggested next steps

1. Choose the base: #610 plus this branch's additions (our recommendation), or this branch plus #610's outbox and held notes.
2. Rebuild the card under D8 and Mock 4: no captions, "Message <agent>", and the turn status.
3. Settle how much context a card shows at a glance (D9), then which fields carry it.
4. Put held notes back and fix the crew label.
5. Agent facts: the registry for what the person approved, `payload.agent` for what the agent reports, and a line in the guide.
6. Run it against a signed-in feed.

## Not in this folder

This repository is public, so two things were left out: the full record of the existing decisions we checked against (44 entries with file and line evidence), and the day-by-day build notes. Hunter has both.
