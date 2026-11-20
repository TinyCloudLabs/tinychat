# Feed as an inbox: cards from trusted senders

Design only: nothing here is built, no grant is issued, and no data path changes. Related: TC-3134 (send a card to a teammate's feed), TC-2041 (create-only ability), TC-2048 (per-card and per-sender caps), TC-3123 (hook events carry no card or response ID), TC-2998 (sender line on a card), TC-2575 (shared space primitive).

## Goal

The product direction: the feed should be closer to an inbox, and trusted parties (a teammate, and their agents) can put cards into an owner's feed. This plan answers six questions: who counts as trusted and how they are added and removed; what grant they hold; how their cards are marked; what limits apply and what happens when access ends; what an inbox changes in the feed's model; and how a trusted sender's card wakes the owner's agents without becoming an instruction channel.

Non-goals: no list view (the feed mock's card and row stay as they are), no change to how agents the owner already connected post, no read access for senders to anything but their own outbox, and no claim about what a sender's card contains being true.

## Today (read from the code, not run)

- **One database per source.** The feed service names two SQL resources per agent: `<prefix>/feed_output_<token>` (the agent writes cards) and `<prefix>/feed_responses_<token>` (the owner writes answers; the agent reads them), `feedResourceNames` in js-sdk `packages/sdk-services/src/feed/resources.ts`. TinyChat's prefix is `xyz.tinycloud.tinychat/home_feed` (`frontend/src/feed/feedStore.ts`). The token is alphanumeric, underscore or hyphen only.
- **A source is a registry row the owner holds.** `FeedSource` is `{ sourceId, agentDid, label, output, responses }` (`types.ts`). The label is the owner's, and one source has exactly one agent DID.
- **Publishing needs read and write on the sender's own output database.** `publishFeedCard` runs `INSERT ... ON CONFLICT (card_id, revision, issuance_id) DO NOTHING` and then a `SELECT` to read the row back (`store.ts`). A card is addressed by card ID, revision and issuance ID, so a newer revision of the same card is a new row.
- **There is no create-only ability.** The node has `tinycloud.sql/read`, `write`, `admin` and `schema`; `write` includes `UPDATE` and `DELETE` on that database (TC-2041; the first bot design used put-only KV prefixes with `ifNoneMatch` instead). A sender can therefore edit or delete its own rows in its own database, and nothing else.
- **No node-side size limit.** A probe on a loopback node (TC-2048 thread) found no body-size limit up to 20 MiB, so caps are the reader's job: check size before download, skip oversize cards, bound a list per source per poll. TinyChat's parser enforced none when TC-2048 was filed; this plan does not assume they have since landed.
- **Delegation lifetime.** Agent grants are minted for 29 days so they stay inside the owner's 30-day session window (`frontend/src/lib/agentDelegation.ts`). The web SDK exposes `revokeDelegation(cid)` for the owner (`tcw.ts`, `TinyCloudNode.ts`); revoking needs the CID of the delegation the owner issued, so TinyChat has to record it. The hosted MCP's gap (no revoke route there, TC-1156) is a separate path.
- **How a card names its sender today.** `cardAuthor` in `HomeFeedEntries.tsx` shows the card's own `from` text as the name when it differs from the source label, and the source label as "via". So the name line is whatever the card says; only the "via" line is the owner's.
- **Owner state is private and per card.** `FeedOwnerView` holds `seenAt` and `snoozedUntil` per card identity, stored in the owner's registry database. Cards expire into History through `expiresAt`. There is a typed `post` line for the feed mock's one-line post (`payload.sitrep.record.post`, tinychat #746).
- **Hooks.** A hook subscription on a database fires a `HookEvent` with `space`, `service`, `ability`, `path` or `databasePath`, **`actor`** (the DID that wrote), `epoch`, `eventIndex` and `timestamp`. It has no card or response ID, so a woken agent has to scan (TC-3123). A listener over the SDK's feed handoff exists for responses (`listener.ts`).

## 1. Who is trusted, and how the owner adds and removes them

**Three kinds of sender, one mechanism.** A person (a teammate), an agent that belongs to the owner (already supported), and an agent that acts for a person. Each is an agent DID with its own source. A person's agent is added as its own sender and grouped under the person in the registry (a `principal` label the owner sets); it does not receive a sub-delegation from the person, so nothing depends on the node's sub-delegation rules (see Unknowns).

**Invite flow, one tap for each side, nothing automatic.**
1. The owner taps "Invite someone to send you cards". TinyChat creates an invite: a single-use link carrying a random token and no authority. The backend keeps only a hash of the token, an expiry (24 hours) and the owner's address.
2. The invitee opens the link, signs in, and sees: who invited them, "You can send cards to <owner>'s feed. You can't see anything else in it. They can stop it at any time.", and an optional display name they type. They tap Accept. Their DID and typed name go back to the owner as a pending request; nothing is granted yet.
3. The owner sees "<name> wants to send you cards". The Allow screen shows the invitee's DID (short form, full on tap, copyable) beside the typed name, which is labelled "name chosen by the sender, not checked". An invite may carry an intended handle or label the owner entered when making it; Allow for a different DID says "this is not <intended>". The first Accept consumes the token and later Accepts are refused, so the owner never decides between two requests on one link. The device signs exactly the DID shown on that screen, read from the pending request the screen holds and not fetched again, so what is displayed is what is granted. The label the owner stores is typed or confirmed by the owner, never copied from the invitee's name (see section 3). Allow signs the grant (section 2). A leaked link adds no one on its own, because the owner's tap is the grant and the owner can see whose DID it is.
4. The invitee is told it is on, and how to post: through their own agent or the CLI's `feed` commands. A hosted "send a card" page is a later slice and gets its own security review, because that page would hold the sender's key or act as the sender.

An owner may also add a sender directly by DID or address-book handle (TC-3134's address-book route), skipping steps 1 and 2.

**Removing.** In the feed's sender list the owner can Mute, Block or Remove each sender (section 4). Remove ends the grant now (revoke by CID) rather than waiting for its expiry.

**What the invitee sees afterwards.** Their senders list shows each owner who allowed them, the date, and the expiry; they can leave. They never see the owner's feed, other senders, or whether a card was read, unless the owner separately turns on replies (section 2).

## 2. The grant

One delegation from the owner to the sender's DID, scoped to that sender's own databases:

| Resource | Abilities | Why |
| --- | --- | --- |
| `<prefix>/feed_output_<token>` in the owner's feed space | `tinycloud.sql/read`, `tinycloud.sql/write` | Publishing reads its row back (`store.ts`). The database holds only that sender's cards. |
| `<prefix>/feed_responses_<token>` | `tinycloud.sql/read`, **off by default** | The owner's answers and comments reach the sender only if the owner turns replies on for that sender (TC-3134). Default is send-only. |

No `admin` and no `schema`: the owner creates the databases and their tables when the invite is allowed (`initializeFeedDatabases`), so the sender cannot alter a schema or create other databases. The token is derived from the sender's DID (a hash), so one sender can never write into another's database, and the delegation names no other resource.

What "append-only" means here, honestly: the sender can add cards, publish new revisions of its own, and (because `write` is not create-only) edit or delete its own rows. It cannot read, edit or delete anything else. If the owner wants strict append-only, that needs a node ability (TC-2041); until then the reader has to be safe against edits, because owner state keys on a card's identity and an edit keeps the identity. So: the reader stores a content hash per card identity, in the owner's private state, the first time it shows the card. A changed hash for a card the owner has seen shows "edited after you saw it", counts as unread again, and drops any "answered" look and any pending answer; the owner's answer keeps the text it was given against, shown as what was answered. An approval-style answer binds to the revision and content hash on screen. A deleted card disappears. The reader's freshness check for a sender database uses a content tally (for example the sum of row lengths and a hash of the last rows) and never `count` and `max(rowid)` alone, which an `UPDATE`, or a delete and re-insert of the last row, leaves unchanged. The tally is only a trigger to re-read, and it misses a same-length edit to an older row, so the content hash is checked on every full read of a sender's rows, and a full re-read runs on a fixed period whatever the tally says. Decision 3 asks whether the sender's edit and delete is acceptable at all.

**Expiry and renewal.** The grant ends at its signed expiry, at most the owner's session window (about 30 days today; the agent grant uses 29). For a standing inbox that means the owner would re-sign about monthly unless the grant is renewed some other way. How any standing grant renews is part of the owner's separate renewal discussion (where the renewal logic lives, and how little the sign-in service has to do for it); this plan does not decide it, and **proposes no OpenKey renewal work**. Until that discussion settles, this plan assumes only today's behaviour: the owner re-signs when the grant expires, and the sender list shows the expiry. Decision 2 is held for that discussion.

**Revocation.** The owner's app records each delegation's CID in the source's registry row and calls `revokeDelegation(cid)` on Remove or Block. The Allow step records the CID first and refuses to issue the grant if it cannot be saved. If a grant has no CID (an older or imported one), the sender list does not show a plain Remove: it says "cannot stop this sender until <expiry date>", up to 29 days away, so the owner does not believe a sender is removed while it can still write. The same row offers Block right away (hide the sender's cards and stop reading its database), so the owner can stop seeing the sender even though the grant cannot yet be revoked. The grant carries no `delegate` capability, so the sender cannot hand it on; whether revoking also stops writes from sessions already minted from it is an Unknown. Revoking stops new writes; it does not by itself touch rows already in the database (section 4).

## 3. How cards are marked

The rule: **identity comes from where a card was written, never from what it says.**

- **The key the owner approved.** Each sender database has one delegate. A card in `feed_output_<token>` was written by that DID, and a hook event names the writing DID as its `actor`. The name on the card face is the owner's own label for that source ("the name you gave them"), not the card's `from` text.
- **What the card says about itself** (`from`, a typed record's crew name, avatar text) is **claimed**. It is shown as a second, lighter line only when it differs, for example "Says it is: Ana", and is never used to group or colour the card.
- **An agent acting for a person.** The name line is the person (the owner's grouping label), and the second line says which agent: "Dana · via Dana's agent". The label chain comes from the owner's registry, not the card.
- **Wording.** "Verified" is the wrong word: the check is "this is the key you approved", not that a human is who they say. The card shows the owner's label plus a small "Invited by you" mark for people, and no mark for the owner's own agents. The label is chosen or confirmed by the owner, is unique among the owner's senders and agents, and cannot be the owner's own name or a reserved name ("TinyChat", "System", "Security", "You"). The "Invited by you" mark and the "Says it is" line are drawn by the app and are never card fields, so a card cannot pass as the owner's or as a system card. Copy goes to the copy owner, then the product owner, before it ships.
- **Which cards a sender may post.** From a sender who is not the owner's own agent, the reader renders only plain, post, question and task cards. Approval, secret and go cards, claim, delivery and message-route cards, officer events and any typed card that names crew or avatars render as a plain "card from <label>" with the text only and no action button. The approval flow reads as the owner's or the system's decision, so a sender cannot author one. A kind added later is barred until it is listed.
- **Links.** A link in a sender's card shows the real host beside its text whenever the text looks like an address or a host, so `[https://bank.example](https://evil.example)` reads as `https://bank.example (evil.example)`. There is no allowlist. An external link shows its host before it opens.
- **Media.** No remote image, avatar, poster, favicon, link preview or font from a sender's card loads before the owner allows it. It is the same component and the same warning wording as tinychat #745, with the host and the full address shown. #745 asks per exact address in chat and per site, with the full warning, in notes; a sender's card uses the chat grain (per exact address), so an Allow never covers an address the owner did not see. A card that carries no remote URL needs nothing. A sender's server learns the owner opened a card (and from where) only after that allow. The gate lands before step 6 of the build order, and the default for the owner's own agents follows decision 5.

## 4. Limits, mute, block, and what revoke does to cards already posted

Because the node enforces no size or rate limit (see Today), limits are in the reader, plus one gap that needs the node.

- **Per card:** the parser caps from TC-2048 apply to every sender, and a sender's card over the cap is skipped and counted, not rendered. Proposed starting values for a person sender: card JSON 16 KiB, title 140 characters, 8 links. The cap is enforced where the row is read: the reader selects with `WHERE length(card_json) <= cap`, so an oversized row never reaches the owner's device (today the read selects the whole `card_json`, and the node refuses a result over about 10 MB, which would fail the page).
- **Per sender, shown:** proposed starting values: at most 30 new cards per hour and 200 per day are shown; the rest collapse into one row "N more from <name>" that the owner can open.
- **Per sender, read:** each sender's database is read with a row and byte budget per poll and a bound on paging (today the reader pages the whole table, 1000 rows at a time). A sender over budget shows as one row "<name> sent more than can be shown" with Mute and Remove.
- **One sender never fails the others.** Each sender is read on its own (settled one by one, not all together), so a sender whose read fails, times out or returns malformed rows shows as a single "couldn't load <name>" row with Remove and Block, and every other source and the sender list load as usual. The sender list and Remove do not depend on a card read succeeding.
- **Storage is the gap.** A sender who writes without limit consumes the owner's space quota (the SDK has a space-level quota, `TinyCloudQuota`; no per-delegation cap is known). Until the node can cap a delegation, the safe controls are: few senders, short grants, and an owner-visible per-sender row and byte count beside Block, so Block is one tap from the count. A per-delegation write cap is a node ticket (see Unknowns).
- **Mute** hides a sender's new cards from Needs you, sends no wake to the owner's agents, and keeps the grant. Cards still arrive and stay readable under that sender.
- **Block** is Remove plus hide: revoke the delegation, stop reading the database, and drop the sender from every list. Re-adding is a new invite.
- **Cards already posted when access ends.** Chosen per removal and shown in plain words. After Remove the default is keep them as history (they stay readable, marked "sender removed"). After Block the default is hide them (kept in the owner's space, not shown). The other choices are delete (the owner deletes the database; this cannot be undone) and, for Remove, hide. Rows stay in the owner's space quota until deleted, and the sender list says so. A card the owner has answered keeps the owner's answer either way.

## 5. The feed's model: closer to an inbox

What changes in the data model, small and additive:

- **Unread** is "no `seenAt` for the card's current revision and content" (`FeedOwnerView` already records `seenAt`; the content hash comes from section 2). A new revision, or edited content, is unread again. Needs you stays a view of cards that wait on the owner; **Inbox** is the view of everything unread plus the owner's pinned cards.
- **Archive** is a per-card owner flag, beside `snoozedUntil`: "done with this". Cards that need no answer can be archived without a decision; archive is reversible from History. It writes only the owner's private state.
- **Sender grouping** is a filter, not a new screen: a sender list (with counts) across the top of All and History, plus "Mute" and "Block" there. Grouping uses the owner's label and `principal`, never a card's claimed name.
- **The post stream.** A card's one-line `post` is the row's second line already planned for the feed mock; for a person's card it is the line they write. A sender's card with no `post` falls back to its lead line.
- **No change to answered cards.** An answer is still a response row in the card's responses database; for a person sender it goes back only if the owner has turned replies on.

## 6. Waking the owner's agents, and the injection angle

**Wake.** The owner's agents subscribe to a hook on `feed_output_<token>` for the senders the owner marks "wake my agents" (off by default, off for muted senders). A `HookEvent` already names the writer (`actor`) and the database; it lacks a card ID, which is TC-3123. Until that ships, a woken agent reads the sender's recent rows after the last event index it handled. The wake carries only identifiers (source, card ID, revision), never card text, so the event itself holds no sender content. Wakes are rate-limited per sender and collapsed (at most one wake per sender per N minutes, carrying a count), because each wake can start an agent turn and a flood would cost tokens.

**A trusted sender's card is outside content.** "Trusted" says who may post, not that the text is safe: a sender's key or agent can be compromised, and an agent reading the web may paste what it read into a card. When the owner's agent reads such a card:

- It arrives inside the single outside-content mark the chat uses (tinychat #745 and the Main bot plan), with the sender's owner-given label, labelled as written by someone else, and carries no authority: it cannot change a tool allowlist, a budget, a grant or the owner's settings. If that mark changes, this section follows it.
- It is not an order. No tool call and no approval follows from a sender's card without a structured owner step. A card that asks the owner's agent to do something becomes a request the owner approves in the feed, outside the model, and the approval text is built from structured fields the agent fills (action, target, amount) with the sender's words quoted separately and marked as the sender's, never as the approval's own text. The agent does not act on the card directly.
- A conversation that has read such a card is marked as holding outside content, so the exfil rules in the Main bot plan (decision 5) and the reply-rendering rule (decision 8) apply to it; if it also holds the owner's data, web fetch and search are off for the rest of that conversation.
- A sender with a mute or block stops waking agents at once; the owner's agents re-check the source's state before reading, not only when subscribed.

## Risks, stated plainly

- A trusted sender can flood the owner's space until revoked (no per-delegation cap yet).
- A trusted sender can edit or delete its own cards after the owner has seen them; the reader's content hash makes an edit visible and unanswers it, and does not stop it.
- Remote media in a card tells the sender's server the owner opened it; it loads only after the owner allows that exact address.
- One sender can fail or slow the owner's feed load (oversized or malformed rows, a flood); each sender is read in isolation with a size filter and a budget.
- A compromised trusted sender is a source of injected text for the owner's agents; the wrapper and approval rules reduce this and do not remove it.
- The invite link and the typed display name are unverified input: the name is shown as the sender's, the owner sees the DID that will be granted, and only the owner's tap grants anything.

## Unknowns to confirm before any build

1. Whether the node permits a sender's delegation to target exactly one SQL resource and no other (the design relies on it; the shipped bot grants used KV prefixes), and that `write` on it cannot set `sequence`, `rowid` or `created_at`, or run `ATTACH`, `PRAGMA`, triggers or virtual tables (see 8).
2. Whether an agent acting for a person can instead receive a sub-delegation from the person; this plan avoids needing it.
3. Whether a per-delegation write cap or a create-only ability can be added in the node (a node ticket, TC-2041 for create-only).
4. The delegation lifetime ceiling and the renewal path for a standing send-only grant (the 30-day session window is today's limit). Held for the owner's renewal discussion; no OpenKey renewal work is proposed here.
5. Which OpenKey flow shows the approval when the owner signs a grant to someone else's DID, and whether it needs the cross-app warning screen (the owner's own feed space is TinyChat's prefix, so it may not).
6. Whether the owner's registry can hold the CID, the `principal` label and the sender state (mute, block, wake) in the existing registry tables or needs a new table.
7. Whether revoking a delegation also stops writes from any session already minted from it, and whether a sender can hand the grant on (the grant carries no `delegate` capability, so it should not).
8. Whether a sender, through `write`, can set `sequence`, `rowid` or `created_at` explicitly, or run `ATTACH`, `PRAGMA`, triggers or virtual tables against its own database. If it can set `sequence`, rows can be placed behind the reader's cursor or paging stalled with a huge value. The check is a build blocker for step 6: the sender must not be able to, or the reader sorts by a value it controls. The reader also ignores `feed_handling` rows for response IDs the owner did not issue, since that table sits in the sender-writable database. Unknowns 7 and 8 are answered from the node's code or a recorded test against a real node, with file and line or the run output, not assumed.

## Build order (each step its own PR, behind a flag)

1. Sender list in the feed: label, mute, block, per-sender count; uses sources that exist today. No new grant.
2. Reader caps and isolation, for every source: per-card size filter in the query, per-sender display cap, per-sender row and byte budget with bounded paging, and each sender read on its own so one failing sender cannot fail the others or hide Remove (section 4). Required before step 6.
3. Claimed versus approved naming on the card (section 3): the owner's label first, the card's own name second, the app-drawn marks, the list of card kinds a sender may post, and real hosts beside link text.
4. Remote media gate for sender cards (section 3, "Media"): the chat gate from #745 (per exact address, host and full address shown), for every remote asset a card carries. Required before step 6.
5. Inbox model: unread, archive, sender filter, and the content hash with "edited after you saw it" (sections 2 and 5).
6. Invite and grant: the invite link, the owner's Allow with the DID shown, the delegation, CID recorded before the grant, and Remove. Needs decisions 1 to 3, the OpenKey answer (unknown 5), unknowns 7 and 8 answered with evidence, and its own security review.
7. Wake for senders: after TC-3123's card ID, with the injection rules above, the per-sender wake limit and its own security review.

## Decisions for the owner

1. **Who may be invited.** Anyone the owner chooses by link or DID (this plan), or only people already in the owner's address book or in a shared team.
2. **Standing grant renewal. Held: it sits under the owner's renewal discussion, and this plan proposes no OpenKey renewal work.** The only question left for this plan is what the sender list shows meanwhile: the expiry, and a prompt to re-sign when it has passed.
3. **Edit and delete by the sender.** Accept that a sender can edit or delete its own cards, with edits shown as "edited after you saw it" and answers unbound by an edit (this plan), or hold the feature until the node adds a create-only ability.
4. **Replies to a person.** Default send-only (this plan) with replies per sender, or replies on by default for people the owner invites.
5. **Remote media from senders.** Load only after the owner allows that exact address, with the host and full address shown, for any sender who is not the owner's own agent (this plan), or load as for connected agents.
6. **Default for removed senders' cards.** After Remove keep as history, after Block hide (this plan), or one default for both, or delete.
7. **Wake default.** Trusted senders do not wake the owner's agents until the owner turns it on for each (this plan), or they do once added.
