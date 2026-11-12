# The feed in TinyCloud Home: design spec, v0

2026-11-12. It is for Hunter, who decides, and for Home's team, who own the code. It stays close to Home's and TinyCloud's architecture (section 15). Branch `bridge-feed` is pushed at ff075800: changes 1, 2 and 3, merged with Home's main of 11-12 (one Home build, the feed first). Hunter has not yet tried change 3. Checked against the existing architecture on 11-12 (summary in HANDOFF.md). "ADR" below means that check.

**Tags.**
- [D1] to [D9]: Hunter decided (section 16).
- [C1] to [C3]: from the change specs. Tried in the lab, not decided one by one.
- **PROPOSED**: not agreed. This covers P1 to P7, the builders' choices and rules invented here.

Section 13 gives the state, data and architecture of every rule.

## 1. Purpose and tests

Goal: a feed that takes the person's full attention into their work. Today's cards are not set up for quick, good decisions or for switching contexts, and the feed does not show clearly what a tap will do.

- 1.1 **Clear card** [D3]: it shows who is asking, what they need, what a tap will do, and who gets what he writes.
- 1.2 **Quick**: he can decide from the card's face, on one screen.
- 1.3 **Alive**: every tap responds at once. Every answer shows its progress.
- 1.4 **One context at a time**: he sees what changed while he was away.
- 1.5 **Nothing lost**: no answer vanishes. Every agent's thread is easy to find [D4].
- 1.6 **No explaining text** [D8]: no sentence under a control to say what it does. If a control needs one, rename or reshape the control.
- 1.7 **Context at a glance** [D9]: a card sets the scene in one second, by showing the thing, not by adding sentences.

Why: in Hunter's own use, most answers took the agent's suggestion, and most answers in a sitting switched topic.

## 2. Words

- 2.1 **Card**: a question, approval or update from an agent.
- 2.2 **Answer**: picking an option.
- 2.3 **Reply**: words he writes to an agent.
- 2.4 **Agent**: a named helper: "Sprocket · Bridge engineering".
- 2.5 **Platform**: what the agent runs on, such as Claude, Codex, Grok or Muse.
- 2.6 **Coordinator**: one connected agent he names once, such as Nimbus. When no agent can act on a card, the card offers to send his words to it. **PROPOSED** (P6). It is not called "Main": in Home, "Main" is the hosted bot behind the "What do you want done?" box (#639). That bot sits outside the feed and cannot read cards.
- 2.7 **Status**: one word per card [D3]: "Needs you", "Waiting on <agent>" or "Done". **PROPOSED**: also "Failed", "Back at 19:00", "Expired" or "Not needed", and none on updates. "Information", "Closed" and "Snoozed" tell him nothing.
- 2.8 **Never on a card face** [D3]: ids, "publisher", "authenticated", "owner registry", "unrouted", "immutable", "issuance", "revision", "payload", "token", seconds, and "owner" meaning him. These go behind "Details". **PROPOSED**: also "relay", "via CLI" and "via MCP".

## 3. The feed screen

- 3.1 Above the first card: the title, then the view, "Agents" and "Filter" [C2].
- 3.2 Sections: "Needs you", "Updates" (nothing to answer) and "Done" (answered today). **PROPOSED** (P2). The branch has the first two.
- 3.3 Headings show counts: "Needs you · 3" [C3].
- 3.4 "Needs you" keeps Home's order: pinned first, then most urgent, then oldest. For projects, see 10.1.
- 3.5 One card is open at a time: the first in "Needs you", unless he chose another. **PROPOSED** (P1). Home's main already works this way.
- 3.6 Other cards are rows [D6, D7]. A row shows the agent's mark and the title. Under them are the agent's name and the platform's mark and name. The status shows if it differs from the heading.
- 3.7 A "Done" row reads "✓ You chose Ship tonight · Sprocket · 9:04". It leaves at midnight; the agent's page keeps it. **PROPOSED**: the simplest window.
- 3.8 With no agents yet: Home's welcome, with how to connect one.
- 3.9 With nothing to answer: "Nothing needs you" and the time of the last update. **PROPOSED**: an empty feed must still look alive.
- 3.10 A new card never moves the open card or the row under his finger. It slides in with a brief highlight. **PROPOSED**: nothing jumps under a tap.
- 3.11 A new version of the open card updates in place: "Updated 9:12". **PROPOSED**.

## 4. The open card, top to bottom

For each part: what it does, then where its data comes from.
- 4.1 **Raised surface** around the whole card, with a gap before the list [D6]. It stops the blur.
- 4.2 **Agent line**: mark, name, platform chip, time and status [D5, D7]. It shows who is asking. Data: the connection's label or the card's `from`; the platform (8.6); the status, from his answer and the agent's receipts.
- 4.3 **Role words**: "Bridge engineering" [D5]. They say what the agent does. Home has no data for them yet (15.1).
- 4.4 **Question**: the title, on one line if possible. It says what they need.
- 4.5 **Why lines**: the background, why now, and what happens with no answer. Data: typed `context` or plain `body`.
- 4.6 **Evidence**: the main link, named by what it is ("The draft"). Data: `links` or `payload.source`. **PROPOSED** placement (11.5).
- 4.7 **Options** as choices [D6]: filled rows with a round marker, a label and one line on what happens; "Suggested" marks the agent's pick. They show what a tap will do. Data: typed `options` and `recommend`; plain cards have labels only.
- 4.8 **Reply box**: "Reply to <agent>" [D2]. It says who gets his words.
- 4.9 **Foot**: "Remind me later", "Next card" and "Details" [C3].
- 4.10 **Details**, closed [D3]: who posted, routing, ids, private priority and history.
- 4.11 Nothing else is on the card. "Accept recommendation" goes, since tapping "Suggested" does the same. "Drop question" becomes "Not needed" in the foot, with the count and Undo. **PROPOSED**: one way to answer.
- 4.12 Approvals keep a deliberate button. **PROPOSED**: access approvals say "Approve on OpenKey".
- 4.13 **Context line, the thing shown, fact chips** [D9] (Mock 4). The project in its own colour and the kind of decision (ship, design, message, money, access, plan). A small preview of the thing being decided: two thumbnails, the first lines of a draft, the amount, a strip of checked facts. At most three chips, and one on a row. **PROPOSED** form. Data: project, kind, deadline, cost and links exist; previews such as thumbnails need one optional display field.

## 5. Answering

- 5.1 One tap on an option answers. There is no Save [D1].
- 5.2 The option shows "Sending to Sprocket in 4s", Undo and a shrinking line. Other options dim. Nothing moves [D1].
- 5.3 If he taps Undo in time, nothing is sent [D1].
- 5.4 Leaving during the count sends at once. **PROPOSED** (builder): an answer is never lost.
- 5.5 Typed words go with the tapped option. **PROPOSED** (builder).
- 5.6 The card folds to "✓ You chose Ship tonight · Sent to Sprocket" and "Show card" [D1].
- 5.7 The steps, with short times: Sent, Sprocket received it, Done [D1]. The branch says "Completed", which needs fixing.
- 5.8 The agent's result line sits under the steps [C1].
- 5.9 **The send fails**: the choice stays, with "Not sent. Check your connection." and "Try again". A retry never doubles an answer. **PROPOSED** wording (today the raw error shows).
- 5.10 **Nobody picks it up**: with no "received" after 60 s, the step says "Not picked up yet". The card stays "Waiting on Sprocket", and he need do nothing. **PROPOSED**: the live receipt took 15 s.
- 5.11 **The card changed**: the answer keeps the version he saw, and the agent decides. The fold adds "Sprocket had updated this card." **PROPOSED**.
- 5.12 **The card closed**: Home refuses the answer. The fold says "This card closed first. Nothing was sent." and shows the reply box. **PROPOSED**.
- 5.13 He changes an answer by replying. On plain cards, "Add follow-up" becomes "Reply to <agent>". **PROPOSED**: one box (D2).

## 6. Replying

- 6.9 **Changing: one quiet control, "Leave a comment for <agent>"** [D8]. It opens one line and Send, with no always-visible box and no caption under it. The name says both things the caption used to say: it is a comment, and it is for that agent. Hunter chose this wording on 11-12 over "Message <agent>", which Mock 4 shows. Mock 4 also tried a status that follows whose turn it is ("Waiting on <agent>" after he writes). That is not decided, and a comment does not answer a card. The rules below describe the branch as built.

- 6.1 There is one box per card: "Reply to <agent>". He never picks a recipient [D2].
- 6.2 On an open question it sits under the options ("Write instead of choosing, or as well"). After the answer, it takes replies [D2].
- 6.3 A reply goes to the agent that can act: a crew member he approved a link to, or else the agent that posted. It is never broadcast [D2].
- 6.4 Labels:
  - a. The agent that posted: "Reply to Studio agent" [D2].
  - b. A crew member posting through another agent: "Reply to Sprocket through Crew", so the face names where the words really go. With one feed connection per crew member (15.2) it is simply "Reply to Sprocket". **PROPOSED** (the branch says "Reply to Sprocket"; ADR item 3).
  - c. No agent can act: his words are kept as a held note, as Home does today, and the card offers "Send to Nimbus instead". He taps that each time; nothing is redirected for him. It lands in Nimbus's own conversation. **PROPOSED** (P6, changed after the ADR record: Home's rule is "held, never redirected").
  - d. A closed card: "This card is closed. Reply on Sprocket's page." **PROPOSED**: it shows where he can write.
- 6.5 Send counts down 4 s with Undo, then the message shows its steps. If a send fails, his words stay, with "Try again" [C2].
- 6.6 The agent's replies show under his message. The conversation opens once it has one [C2].
- 6.7 A message still unconfirmed after 2 minutes shows "Send again · It may arrive twice."
- 6.8 Plain cards get the same conversation. **PROPOSED** (15.4).

## 7. Remind me later

- 7.1 "Remind me later" is in the foot: In 1 hour, Tonight, Tomorrow morning, Next week. **PROPOSED**: plain cards get it too (today they have "Snooze for 1 hour").
- 7.2 Inside it: "Add a note to yourself. Only you see this." [D2]
- 7.3 There is no other private note on a card [D2]. Words for someone with no approved route are still kept as a held note, as on Home's main. The branch stopped writing them; put that back. **PROPOSED** (ADR items 4 and 9).
- 7.4 While waiting, the card leaves "Needs you" and reads "Back at 19:00". **PROPOSED**: "Snoozed" does not say when.
- 7.5 It returns to "Needs you" with his note: "Your note · only you see it" [C3].
- 7.6 Add "In 2 days". **PROPOSED**: it has been asked for.

## 8. The agent

- 8.1 Each agent has a short name he gave or approved, and what it does: "Sprocket · Bridge engineering". No ids, no generated nicknames [D5].
- 8.2 An agent with no given name is shown by its work: "Agent on the pricing page". **PROPOSED**.
- 8.3 Crew members show under their own names, however the crew connects (15.2). The agent they post through is in Details only. **PROPOSED**: "via Crew" is wiring.
- 8.4 Each agent has its own mark: its first letter, in its own colour, everywhere. **PROPOSED** [C3]: a whole crew can be on one platform, and its members must still look different.
- 8.5 The platform's official mark and name appear on the card and on rows [D7]. Use only official files, unchanged; otherwise show the name.
- 8.6 Two sources, split by who says it. What he approved (name, when it connected, when its access ends, and the platform if he states it) comes from his own record of the agent. What the agent reports about itself (platform, model, machine) comes from the card, shown "as the agent reports it". Nothing is guessed, and neither is treated as identity. **PROPOSED** (ADR question b; the branch reads the card only).
- 8.7 Tapping the name shows what it is, its model, where it runs, when it connected, what it can do, when its access ends, and "Disconnect" [D7]. The branch shows four of these.
- 8.8 The agent's page shows its cards, his answers and the messages both ways, in time order, with one reply box [D4].
- 8.9 The Agents list shows each agent's mark, name, platform, "Needs you: 2" and latest line, newest first [D4].
- 8.10 The agent's page loads its whole history. **PROPOSED**.

## 9. Liveness

Live test, 11-11: "received" at 15 s, reply at 19 s, "done" at 26 s. CLI calls took 2 to 4 s each; the watcher quit after about 62 s. Home reloads 50 ms after a change.
- 9.1 A tap shows at once: the pressed option and the count [D1].
- 9.2 "Sent" ticks when the save returns [C1].
- 9.3 Later steps tick, with a small motion, as receipts land. There is no reload [C1].
- 9.4 A waiting step pulses softly. It is the only motion, and it is off under reduced motion. **PROPOSED**: alive, not noisy.
- 9.5 While the agent works, the card says "Waiting on Sprocket", with its latest progress line if sent. **PROPOSED** (15.6).
- 9.6 Agent replies appear under the card and on the fold as they land [C2].
- 9.7 Times and status words change in place. Nothing else moves. **PROPOSED**.
- 9.8 If the link is down: "Reconnecting · last update 9:12". **PROPOSED**: old steps must not look current.
- 9.9 Agents keep one live connection, and a stopped watcher restarts. Target: "received" within 5 s. **PROPOSED** (outside Home; the target is invented).

## 10. Switching contexts

- 10.1 "Needs you" groups cards by project ("Bridge · 3"). Groups are ordered by earliest real deadline. **PROPOSED** (P4).
- 10.2 "Next card" stays in the project until it is clear. **PROPOSED** (P4).
- 10.3 **Focus view**: one card fills the screen. Answering brings the next; "3 left" counts down; "List" goes back. **PROPOSED** (P3).
- 10.4 It has the same card and the same tap. A swipe never answers. **PROPOSED**: no accidents.
- 10.5 **Since you last looked**: a line at the top, "Since 9:02: 2 done, 1 new, 1 reply". Tap it to see them. **PROPOSED**.
- 10.6 **Where was I**: under each project, his last decision there, such as "You said on 11-09: use the short blurb". **PROPOSED**.

## 11. The card standard

This is for agents that ask. It goes in Home's `tinycloud-feed` skill and in the crew kit.
- 11.1 The question fits one line and states the decision. **PROPOSED** (P5).
- 11.2 The suggestion has a one-line reason. **PROPOSED** (P5).
- 11.3 Each option says what happens. **PROPOSED** (P5).
- 11.4 The card gives a deadline or the cost of waiting, if any. **PROPOSED** (P5).
- 11.5 The main evidence link is on the face; the rest is in "Details". **PROPOSED**: P5 hid all evidence, but he wants a link to see for himself.
- 11.6 The face has 40 words or fewer. **PROPOSED** (the Bridge's crew cards are several times longer today).
- 11.7 No ids, codes or internal numbers on the face [D3].
- 11.8 The agent first checks: is it decided, is it done, is it still true? The card says "Checked 12:30". **PROPOSED**.

When a card falls short:
- 11.9 The screen guesses nothing: no suggestion, no "Suggested"; no detail, the label alone [C3]. **PROPOSED**: with no option and no reply route, "You can't answer this here."
- 11.10 Agents check their cards before posting, so the screen shows him no warnings. **PROPOSED**: he shouldn't have to police cards.

## 12. Later

- 12.1 **"Always do this"**, offered on the fold after 3 identical answers, makes the answer a standing rule. Cards it covers show in "Updates" as "Handled by your rule", with "Stop this rule". **PROPOSED** (P7; the 3 is invented).
- 12.2 **Digest**: one morning card of what did not need him: finished work, rule-handled cards and answers nobody picked up. **PROPOSED**.
- 12.3 **Notifications**: a buzz only for a real deadline today. Never for updates, or for cards gone before he looks. **PROPOSED**: today nearly every card buzzes.
- 12.4 **"Take all suggestions"** in one project, with Undo. **PROPOSED**.

## 13. Every rule: state, data, architecture

**State:**
- "built" means pushed on `bridge-feed`, with its commit.
- "main" means already in Home's main branch.
- Change 3 (2e3669d1, 98c495e7, 63b9f570) was pushed on 11-12. Hunter has not tried it yet.
- "mock" means drawn in a mock only.
- "proposed" means not built.

**Who decided:** a D or C tag, PROPOSED, or "Home" (already Home's own design).

**Data:**
- "has": already in Home's feed.
- "field": a new optional field.
- "record": a new record.
- "rule": a change to a rule or to the agents' guide.
- "outside": outside Home.

**Architecture:** fits, extends or departs. "Screen only" is for layout and wording. Rows that name an ADR item carry the verdict of the architecture check (11-12; summary in HANDOFF.md). The rest are this draft's own reads.

| Rule | Who decided | State | Data | Architecture: fits / extends / departs |
|---|---|---|---|---|
| 3.1 | C2 | built 6f2e1397, 33e8b15d | has | screen only |
| 3.2 | PROPOSED P2 | built 63b9f570 (2 of 3 sections) | has | screen only |
| 3.3 | C3 | built 63b9f570 | has | screen only |
| 3.4 | Home | main | has | fits |
| 3.5 | PROPOSED P1 | main | has | screen only |
| 3.6 | D6, D7 | built 63b9f570, 98c495e7 | has; platform: field | screen only |
| 3.7 | PROPOSED | proposed | has | screen only |
| 3.8 | Home | main | has | screen only |
| 3.9 | PROPOSED | proposed | has | screen only |
| 3.10 | PROPOSED | proposed (main keeps the open card on reload) | has | screen only |
| 3.11 | PROPOSED | proposed | has (revisions) | fits |
| 4.1 | D6 | built 63b9f570 | has | screen only |
| 4.2 | D5, D7 | built 98c495e7; status word built c8264d0a | has; platform: field | screen only |
| 4.3 | D5 | mock (an earlier mock) | record (15.1) | extends |
| 4.4 | Home | main | has | screen only |
| 4.5 | Home | main | has | screen only |
| 4.6 | PROPOSED | main (links show); placement proposed | has | screen only |
| 4.7 | D6 | built 63b9f570 | has; plain-card detail: field | screen only |
| 4.8 | D2 | built c8264d0a | has | fits |
| 4.9 | C3 | built 63b9f570 | has | screen only |
| 4.10 | D3 | built c8264d0a; priority moved 63b9f570 | has | screen only |
| 4.11 | PROPOSED | proposed | has | screen only |
| 4.12 | Home; PROPOSED (OpenKey line) | main; proposed | has | fits |
| 4.13 | D9; PROPOSED (form) | mock (Mock 4) | has; previews: field | extends, small |
| 5.1 | D1 | built 46f6a49e, a7c53400 | has | fits |
| 5.2 | D1 | built 46f6a49e | has | screen only |
| 5.3 | D1 | built 46f6a49e | has | fits (nothing written before the count ends) |
| 5.4 | PROPOSED (builder) | built 46f6a49e | has | screen only |
| 5.5 | PROPOSED (builder) | built 46f6a49e | has | fits |
| 5.6 | D1 | built 6b8bfc98 | has | screen only |
| 5.7 | D1 | built 3a7eb694 (says "Completed") | has | screen only |
| 5.8 | C1 | built 6b8bfc98 | has | fits |
| 5.9 | Home; PROPOSED (wording) | main (same-id retry) | has | fits |
| 5.10 | PROPOSED | proposed | has (receipt times) | screen only |
| 5.11 | PROPOSED | proposed | has (answer keeps its revision) | fits |
| 5.12 | PROPOSED | proposed | has | fits |
| 5.13 | PROPOSED | proposed | has (Home's follow-up) | screen only |
| 6.1 | D2 | built c8264d0a | has | fits |
| 6.2 | D2 | built c8264d0a | has | screen only |
| 6.3 | D2 | built c8264d0a | has (approved links) | fits |
| 6.4a | D2 | built c8264d0a | has | fits |
| 6.4b | PROPOSED (builder) | built c8264d0a | has | departs, small (ADR item 3): the label names a crew member, the message goes to the agent it posts through |
| 6.4c | PROPOSED P6 | proposed | record (15.3) | departs, medium, as an automatic fallback (ADR item 13); fits as a choice he taps |
| 6.4d | PROPOSED | proposed | has | screen only |
| 6.5 | C2 | built c8264d0a | has | fits |
| 6.6 | C2 | built c8264d0a, 2da228cc | has | fits |
| 6.7 | Home | main | has | fits |
| 6.8 | PROPOSED | proposed | has | fits (ADR item 16: the format takes a message on any card) |
| 6.9 | D8 | mock (Mock 4 shows the earlier wording) | has | fits (the same message record) |
| 7.1 | Home; PROPOSED (plain cards) | main (typed cards) | has | fits |
| 7.2 | D2 | built c8264d0a | has | fits |
| 7.3 | D2 | built c8264d0a | has | fits for private notes; departs, small: held notes are no longer written (ADR items 4, 9) |
| 7.4 | PROPOSED | proposed | has | screen only |
| 7.5 | C3 | built 63b9f570 | has | fits |
| 7.6 | PROPOSED | proposed | has | fits |
| 8.1 | D5 | name: main; role words: mock | record (15.1) | extends |
| 8.2 | PROPOSED | proposed | rule (agents' guide) | screen only |
| 8.3 | PROPOSED | proposed (the branch shows "via") | has (`from`) | fits while the card says "Willow via Crew"; departs, small, if "via" is hidden without per-member connections (ADR item 15) |
| 8.4 | PROPOSED (C3) | built 98c495e7 | has | screen only |
| 8.5 | D7 | built 98c495e7 (5 marks; the rest by name) | field now, record later | extends |
| 8.6 | PROPOSED | built 98c495e7 (reads the card only) | record (15.1); card: field | extends, small (ADR item 11, question b) |
| 8.7 | D7 | built 98c495e7 (4 facts); mock (connected, access ends, Disconnect) | record and grant facts (15.1, 15.5) | extends |
| 8.8 | D4 | built 33e8b15d | has | fits |
| 8.9 | D4 | built 33e8b15d; marks 98c495e7 | has | fits |
| 8.10 | PROPOSED | proposed | has | fits |
| 9.1 | D1 | built 46f6a49e | has | screen only |
| 9.2 | C1 | built 3a7eb694 | has | fits |
| 9.3 | C1 | built 3a7eb694, with main's live updates | has | fits |
| 9.4 | PROPOSED | proposed | has | screen only |
| 9.5 | PROPOSED | proposed | rule (15.6) | extends |
| 9.6 | C2 | built 2da228cc | has | fits |
| 9.7 | PROPOSED | proposed | has | screen only |
| 9.8 | PROPOSED | proposed | has | screen only |
| 9.9 | PROPOSED | proposed | outside (15.10) | fits |
| 10.1 | PROPOSED P4 | proposed | field (15.7) | extends, small (ADR item 18) |
| 10.2 | PROPOSED P4 | proposed | field (15.7) | screen only |
| 10.3 | PROPOSED P3 | proposed | has | screen only |
| 10.4 | PROPOSED | proposed | has | screen only |
| 10.5 | PROPOSED | proposed | has (seen marks) | fits |
| 10.6 | PROPOSED | proposed | has; needs the project field | fits |
| 11.1 | PROPOSED P5 | proposed | rule (agents' guide) | fits |
| 11.2 | PROPOSED P5 | proposed | field (15.8) | extends |
| 11.3 | PROPOSED P5 | proposed | has on typed asks; field on plain cards (15.8) | fits |
| 11.4 | PROPOSED P5 | proposed | has on typed asks | fits |
| 11.5 | PROPOSED | main (links show on the face) | has | screen only |
| 11.6 | PROPOSED | proposed | rule (agents' guide) | fits |
| 11.7 | D3 | proposed for the guides | rule (agents' guide) | fits |
| 11.8 | PROPOSED | proposed | field (15.8) | extends |
| 11.9 | C3; PROPOSED (wording) | built 98c495e7; main | has | screen only |
| 11.10 | PROPOSED | proposed | rule (agents' guide) | fits |
| 12.1 | PROPOSED P7 | proposed | record (15.9) | extends, medium (ADR item 20) |
| 12.2 | PROPOSED | proposed | has (an update card) | fits |
| 12.3 | PROPOSED | proposed | record (15.11) | extends |
| 12.4 | PROPOSED | proposed | has | fits |

Counts, by the first state in each row: 39 built on the branch (13 of them in change 3, not yet tried by Hunter), 12 in Home's main branch, 3 mock only (4.3, 4.13, 6.9; the role words in 8.1 are mock too), 40 proposed. 94 rules in all. Architecture, after the ADR record: 38 screen only, 41 fit, 12 extend, 3 depart. The three: 6.4b and 7.3 (small, both built) and 6.4c (medium, not built). The ADR record adds that nothing on the branch changes a store, a format or a back-end file.

## 14. Open questions for Hunter

Each has a recommended answer and a one-line reason.
- 14.1 **One open card at a time (P1)?** Yes. Home already works this way, and it is what stops the blur (D6).
- 14.2 **Sections in the order "Needs you", "Updates", "Done" (P2)?** Yes. Decisions are the work, and updates can wait.
- 14.3 **Focus view (P3)?** Yes, as a "Focus" button on the "Needs you" heading, with the list kept as the default. Try it in the lab before it changes the default.
- 14.4 **Group by project (P4)?** Yes, once cards carry a project. Most of his answers in a sitting switched topic.
- 14.5 **The card standard (P5), with the main link on the face?** Yes. He wants a link to see for himself.
- 14.6 **A coordinator (P6): when no agent can act, offer "Send to Nimbus instead"?** Yes, as a choice he taps each time, not an automatic fallback. Home's rule is that such words are held and never redirected, and its "Main" is a hosted bot that cannot read the feed.
- 14.7 **"Always do this" (P7), offered after 3 identical answers?** Yes, after the other items in this list. He takes the suggestion most of the time.
- 14.8 **Leaving a card during the count sends at once?** Yes. An answer is never lost, and Undo is still on screen for 4 seconds.
- 14.9 **"Done", not "Completed", as the last step?** "Done". The step then uses the same word as the status.
- 14.10 **The agent's own letter mark as well as the platform mark?** Both. A whole crew can be on one platform.
- 14.11 **Remove "Accept recommendation", and turn "Drop question" into "Not needed" in the foot?** Yes. There is then one way to answer.
- 14.12 **Platform and machine on the agent's record, the model on the card?** Yes. The agent writes them once and they match everywhere, while the model can change.

- 14.13 **Build on the draft redesign #610 (section 17)?** Yes. It is Home's own redesign of the same screen, and it keeps an answer when the page closes during the count, which the branch does not. Put the branch's additions on top of it.
- 14.14 **How the crew connects (15.2)?** Each member as its own feed connection, with the Bridge holding them all. No extra approvals, and each member's name becomes one he approved.

## 15. Where this touches the underlying architecture

This section covers each rule that needs data or behaviour beyond what Home's feed and TinyCloud give today. For each, it gives the way that stays closest to the architecture:
- one identity per agent;
- grants approved by the person;
- records in the person's own space;
- messages only to destinations the person approved.

- 15.1 **What an agent is** (4.3, 8.1, 8.5 to 8.7). It needs role words, platform, machine, and when it connected.
  - **Closest (ADR question b):** both places, split by who says it.
  - His own record of the agent, in Home's private state, holds what he approved: name, identity, when it connected, when its grant ends, role words, and the platform if he states it. Home's registry already holds the token, label and identity.
  - The card holds what the agent reports about itself: the optional `payload.agent {kind, model, runsOn}` (on the branch). It is display only, and the agents' guide must name it.
- 15.2 **Crews of agents** (6.4b, 8.3). The ADR record weighed three options. The choice is Hunter's (14.14):
  - **One relay posts for all.** There is one connection and one grant. Members are named in each card's `from`. Replies reach a member through the approved links Home already has.
  - **Each member connects on its own.** Each member has its own identity and grant. That means more approvals.
  - **One approval, with each member delegated under it.** The person approves once. Each member then holds its own narrower grant and identity, delegated from that one.
  - In all three, the screen shows each member under its own name (8.3).
  - **ADR answer:** each member connecting on its own is closest. It costs no extra approval: one approval covers every agent he connects, renewed every 30 days at most. A variant keeps the Bridge simple: its relay holds every member's connection and posts as each. One relay for all is acceptable (Home's own crew posts that way), but names and reply routes then rest on a display name. Delegating under one approval is furthest: Home could not tell the members apart.
- 15.3 **Coordinator** (6.4c). The ADR record judged an automatic fallback a departure, medium. Home holds words that have no approved route and never redirects them. Its "Main" is a hosted bot outside the feed, and no connected agent can stand in for it.
  - **Closest:** keep the held note. Offer "Send to <agent> instead", which he taps each time. It writes a message on that agent's standing conversation card, in that agent's own channel.
  - **Needs:** one small record in his space naming his coordinator, and one standing conversation card per agent.
- 15.4 **Replies on plain cards** (6.8). Home's typed cards already save a message as an answer row of the kind "message". Closest: plain cards use the same kind, with plain text. The ADR record confirms the format takes a message on any card, and the draft #610 already sends plain-card comments this way.
- 15.5 **Disconnect and access end** (8.7). Both come from the agent's grant, which the person approved and can revoke. Today that happens at account.tinycloud.xyz. Closest: the page revokes the same grant with his own session and removes the feed connection. No new authority is needed.
- 15.6 **A "working" step** (9.5). Home's receipts know received, done and failed. Closest: the agent writes a progress line into its own receipts, either as a new phase or as a fixed detail format.
- 15.7 **Projects** (10.1, 10.2, 10.6). Home filters by `payload.project` today, but that field is not documented, and typed cards have only `group`.
  - **Closest:** a project list that the person owns, in his own space.
  - Each card carries a project key from that list in `payload.project`.
  - The ADR record: typed cards already have `group`; plain cards use `payload.project`, which the agents' guide must name. Grouping happens on the screen only.
- 15.8 **Richer cards** (11.2, 11.3, 11.8). These are optional fields: a one-line reason for the suggestion, and a "checked at" time.
  - **Closest:** typed asks already carry what each option does, so agents should send typed asks rather than plain cards growing new fields.
  - Typed cards refuse unknown keys, so each new field needs a version of the typed format.
- 15.9 **Standing rules** (12.1). Closest: a decision record in the person's space. Agents read it under their own grant before they ask. This is a "decide once" memory. The ADR record adds: the rule must sit where the agent can read it, since Home's private state is closed to agents. The agent confirms it by posting a standing-instruction card, a kind Home already has.
- 15.10 **Fast pickup** (9.9). This is outside Home. Closest: each agent's runner keeps one live connection under that agent's own identity.
- 15.11 **Notifications** (12.3). Home has no push today. Closest: the person's devices and his push choices are kept in his own space. Only a card's own deadline (`urgency` now, or `decideBy` today) triggers a push.

## 16. Decision log

| Date | Decided by Hunter |
|---|---|
| 11-11 | Bring the Bridge's behaviours into Home's feed, on a branch. The branch may be pushed; a pull request waits for his word |
| 11-11 | D1: one tap, a 4-second count with Undo, a fold to "You chose …", then the steps Sent, received, Done |
| 11-11 | D2: one place to write, to the agent that can act. No "Note to owner". A note to yourself only inside "Remind me later". D3: the clear-card test |
| 11-11 | D4: the folded row keeps the latest line and a way to write. Tapping a name opens everything with that agent. There is an Agents list |
| 11-11 | D5: a short name he gave or approved, plus role words. Never an id or nickname |
| 11-12 | D6: the open card is one raised surface. Options look like choices. Other cards are one-line rows |
| 11-12 | D7: the platform's official mark and name on the card and each row, and agent details on tap |
| 11-12 | Stay close to the underlying architecture. Each rule is checked against it (sections 13 and 15) |
| 11-12 | D8: no explaining text under a control. The comment control names who it is for: "Leave a comment for <agent>" (6.9) |
| 11-12 | D9: a card gives context at a glance (form in 4.13) |

## 17. The draft redesign #610

Draft pull request #610 (TC-2600), "Home feed: a list of cards with one-tap answers and comments", last changed 11-11, not merged. It rewrites the same components as this branch. A trial merge collides in 8 files, in 72 places.

| | Draft #610 | This branch |
|---|---|---|
| Cards | every card in one list, each opening in place; "Needs you" and "Earlier" | one open card as a raised piece, the rest as one-line rows |
| Top row | "Needs you N", "All", "Done", and a filter button | a view selector, "Agents", "Filter" |
| Answer | one tap, "Undo · 5", then "You chose …" with "Change answer" | one tap, 4 seconds, then a fold with the steps Sent, received, Done |
| The page closes during the count | the answer is kept on the device and sent the next time Home opens | the answer can be lost |
| The card changed during the count | checked again; nothing is sent, and the card says so | not built (5.11, 5.12) |
| Writing | "Answer in your own words", and "Comment" with a line saying who receives it | one box, "Reply to <agent>" |
| Words with no approved route | held privately | sent to the agent that posted; nothing held |
| Private note | off the card; old ones under More, Details | the same |
| Agent marks, platform, agent details, agent's page, Agents list | none | built |
| Receipts | "{agent} got it." | Sent, received, Done, with times |
| Tests | about 2,000 new lines, with a file that runs against the real store | 290 tests |

**PROPOSED:** make #610 the base and put this branch's additions on top: the open card and rows, the agent's marks and details, the agent's page, the Agents list, the steps, and the lab. Where both do the same job (the count and Undo, keeping an answer, held notes, who receives a comment), take the draft's version.
