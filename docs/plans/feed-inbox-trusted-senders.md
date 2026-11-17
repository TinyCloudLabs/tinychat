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
3. The owner sees "<name> wants to send you cards" with the typed name marked as theirs, not verified, and taps Allow (or Not now). Allow signs the grant (section 2). A leaked link adds no one on its own, because the owner's tap is the grant.
4. The invitee is told it is on, and how to post: through their own agent or the CLI's `feed` commands. A hosted "send a card" page is a later slice.

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

What "append-only" means here, honestly: the sender can add cards, publish new revisions of its own, and (because `write` is not create-only) edit or delete its own rows. It cannot read, edit or delete anything else. If the owner wants strict append-only, that needs a node ability (TC-2041); until then the control is the per-sender database, and a deleted card simply disappears from the owner's feed. Decision 3 asks whether that is acceptable.

**Expiry and renewal.** The grant ends at its signed expiry, at most the owner's session window (about 30 days today; the agent grant uses 29). For a standing inbox that means the owner would re-sign about monthly unless the grant is renewed some other way. How any standing grant renews is part of the owner's separate renewal discussion (where the renewal logic lives, and how little the sign-in service has to do for it); this plan does not decide it, and **proposes no OpenKey renewal work**. Until that discussion settles, this plan assumes only today's behaviour: the owner re-signs when the grant expires, and the sender list shows the expiry. Decision 2 is held for that discussion.

**Revocation.** The owner's app records each delegation's CID in the source's registry row and calls `revokeDelegation(cid)` on Remove or Block. If the CID is missing (an older or imported grant), Remove falls back to the signed expiry and says when that is. Revoking stops new writes; it does not by itself touch rows already in the database (section 4).

## 3. How cards are marked

The rule: **identity comes from where a card was written, never from what it says.**

- **The key the owner approved.** Each sender database has one delegate. A card in `feed_output_<token>` was written by that DID, and a hook event names the writing DID as its `actor`. The name on the card face is the owner's own label for that source ("the name you gave them"), not the card's `from` text.
- **What the card says about itself** (`from`, a typed record's crew name, avatar text) is **claimed**. It is shown as a second, lighter line only when it differs, for example "Says it is: Ana", and is never used to group or colour the card.
- **An agent acting for a person.** The name line is the person (the owner's grouping label), and the second line says which agent: "Dana · via Dana's agent". The label chain comes from the owner's registry, not the card.
- **Wording.** "Verified" is the wrong word: the check is "this is the key you approved", not that a human is who they say. The card shows the owner's label plus a small "Invited by you" mark for people, and no mark for the owner's own agents. Copy goes to the copy owner, then the product owner, before it ships.
- **Links and media** in a trusted sender's card render by the same rules as any card. Remote images from a sender are the sender's server learning that the owner opened the card (and from where): they load only after a tap for any sender who is not the owner's own agent (decision 5).

## 4. Limits, mute, block, and what revoke does to cards already posted

Because the node enforces no size or rate limit (see Today), limits are in the reader, plus one gap that needs the node.

- **Per card:** the parser caps from TC-2048 apply to every sender, and a sender's card over the cap is skipped and counted, not rendered. Proposed starting values for a person sender: card JSON 16 KiB, title 140 characters, 8 links.
- **Per sender:** proposed starting values: at most 30 new cards per hour and 200 per day are shown; the rest collapse into one row "N more from <name>" that the owner can open. The cap is on display, not on storage.
- **Storage is the gap.** A sender who writes without limit consumes the owner's space quota (the SDK has a space-level quota, `TinyCloudQuota`; no per-delegation cap is known). Until the node can cap a delegation, the safe controls are: few senders, short grants, and an owner-visible per-sender count with Block. A per-delegation write cap is a node ticket (see Unknowns).
- **Mute** hides a sender's new cards from Needs you, sends no wake to the owner's agents, and keeps the grant. Cards still arrive and stay readable under that sender.
- **Block** is Remove plus hide: revoke the delegation, stop reading the database, and drop the sender from every list. Re-adding is a new invite.
- **Cards already posted when access ends.** Three options, chosen per removal and shown in plain words: keep them as history (default; they stay readable, marked "sender removed"), hide them (kept in the owner's space, not shown), or delete them (the owner deletes the database; this cannot be undone). A card the owner has answered keeps the owner's answer either way.

## 5. The feed's model: closer to an inbox

What changes in the data model, small and additive:

- **Unread** is "no `seenAt` for the card's current revision" (`FeedOwnerView` already records it). A new revision is unread again. Needs you stays a view of cards that wait on the owner; **Inbox** is the view of everything unread plus the owner's pinned cards.
- **Archive** is a per-card owner flag, beside `snoozedUntil`: "done with this". Cards that need no answer can be archived without a decision; archive is reversible from History. It writes only the owner's private state.
- **Sender grouping** is a filter, not a new screen: a sender list (with counts) across the top of All and History, plus "Mute" and "Block" there. Grouping uses the owner's label and `principal`, never a card's claimed name.
- **The post stream.** A card's one-line `post` is the row's second line already planned for the feed mock; for a person's card it is the line they write. A sender's card with no `post` falls back to its lead line.
- **No change to answered cards.** An answer is still a response row in the card's responses database; for a person sender it goes back only if the owner has turned replies on.

## 6. Waking the owner's agents, and the injection angle

**Wake.** The owner's agents subscribe to a hook on `feed_output_<token>` for the senders the owner marks "wake my agents" (off by default, off for muted senders). A `HookEvent` already names the writer (`actor`) and the database; it lacks a card ID, which is TC-3123. Until that ships, a woken agent reads the sender's recent rows after the last event index it handled. The wake carries only identifiers (source, card ID, revision), never card text, so the event itself holds no sender content.

**A trusted sender's card is outside content.** "Trusted" says who may post, not that the text is safe: a sender's key or agent can be compromised, and an agent reading the web may paste what it read into a card. When the owner's agent reads such a card:

- It arrives wrapped like web results in the Main bot plan, with the sender's owner-given label, labelled as written by someone else, and carries no authority: it cannot change a tool allowlist, a budget, a grant or the owner's settings.
- It is not an order. A card that asks the owner's agent to do something becomes a request the owner approves in the feed, outside the model; the agent does not act on it directly.
- A conversation that has read such a card is marked as holding outside content, so the exfil rules in the Main bot plan (decision 5) and the reply-rendering rule (decision 8) apply to it; if it also holds the owner's data, web fetch and search are off for the rest of that conversation.
- A sender with a mute or block stops waking agents at once; the owner's agents re-check the source's state before reading, not only when subscribed.

## Risks, stated plainly

- A trusted sender can flood the owner's space until revoked (no per-delegation cap yet).
- A trusted sender can edit or delete its own cards after the owner has seen them.
- Remote media in a card tells the sender's server the owner opened it.
- A compromised trusted sender is a source of injected text for the owner's agents; the wrapper and approval rules reduce this and do not remove it.
- The invite link and the typed display name are unverified input: the name is shown as theirs, and only the owner's tap grants anything.

## Unknowns to confirm before any build

1. Whether the node permits a sender's delegation to target exactly one SQL resource and no other (the design relies on it; the shipped bot grants used KV prefixes).
2. Whether an agent acting for a person can instead receive a sub-delegation from the person; this plan avoids needing it.
3. Whether a per-delegation write cap or a create-only ability can be added in the node (a node ticket, TC-2041 for create-only).
4. The delegation lifetime ceiling and the renewal path for a standing send-only grant (the 30-day session window is today's limit). Held for the owner's renewal discussion; no OpenKey renewal work is proposed here.
5. Which OpenKey flow shows the approval when the owner signs a grant to someone else's DID, and whether it needs the cross-app warning screen (the owner's own feed space is TinyChat's prefix, so it may not).
6. Whether the owner's registry can hold the CID, the `principal` label and the sender state (mute, block, wake) in the existing registry tables or needs a new table.

## Build order (each step its own PR, behind a flag)

1. Sender list in the feed: label, mute, block, per-sender count; uses sources that exist today. No new grant.
2. Reader caps: per-card size and per-sender display caps (TC-2048), for every source.
3. Claimed versus approved naming on the card (section 3): the owner's label first, the card's own name second.
4. Inbox model: unread, archive, sender filter (section 5, "The feed's model").
5. Invite and grant: the invite link, the owner's Allow, the delegation, CID recording and Remove. Needs decisions 1 to 3, the OpenKey answer (unknown 5) and a security review.
6. Wake for senders: after TC-3123's card ID, with the injection rules above and a security review.

## Decisions for the owner

1. **Who may be invited.** Anyone the owner chooses by link or DID (this plan), or only people already in the owner's address book or in a shared team.
2. **Standing grant renewal. Held: it sits under the owner's renewal discussion, and this plan proposes no OpenKey renewal work.** The only question left for this plan is what the sender list shows meanwhile: the expiry, and a prompt to re-sign when it has passed.
3. **Edit and delete by the sender.** Accept that a sender can edit or delete its own cards (no create-only ability today), or hold the feature until the node adds one.
4. **Replies to a person.** Default send-only (this plan) with replies per sender, or replies on by default for people the owner invites.
5. **Remote media from senders.** Load only after a tap for any sender who is not the owner's own agent (this plan), or load as for connected agents.
6. **Default for removed senders' cards.** Keep as history (this plan), hide, or delete.
7. **Wake default.** Trusted senders do not wake the owner's agents until the owner turns it on for each (this plan), or they do once added.
