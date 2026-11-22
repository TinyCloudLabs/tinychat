# @tinychat/frontend

## Unreleased

### Minor Changes

- TC-2206: Home reads agent cards from SQLite and saves inline choices, text answers, and explicit follow-ups in owner response databases. Answer saved, Agent received, and Completed or Failed are separate states. Information / Both / Needs action views include agent, type, and project filters, snooze history, and an account-synced configurable default.
- TC-2208: Add typed ask, task, approval, incident, work, ship, order, claim, hold, and progress cards with their own actions and histories. Approval codes use private payloads; task ticks, private notes, and priority stay in owner storage. Explicit messages and resends retain approved destinations, while publisher outcomes and per-recipient receipts remain separate.

### Patch Changes

- TC-2206: Keep the focused question issuance and draft when a newer issuance replaces it in the feed; refresh the original answer and outcome from storage until the user navigates away. Next card advances through the full list. Feed subscriptions reconnect using the current hook service after native session restoration.
- TC-2208: The portable Home model rejects owner-private fields in output wrappers and same-key immutable history rewrites, retains deleted-source answers without restoring dispatch authority, and scopes answers by kind and ID. Accepted ISO offsets now compare as instants. Original timestamp fields and exact issuance identity are retained, along with first-answer ties, deterministic state ties, inclusive issuance/exclusive expiry, and provided-order state deltas.
- TC-2208: Keep focused approval controls, including code-less confirmations, and consent-link interactions bound to their original issuance until explicit navigation; retain archive-only answers, threads, claims, and commands in History; isolate group priority by registered source or validated archive origin.
- TC-2204: Web sign-in and restoration use the manifest shipped with the frontend, so web-only updates request Home SQL and feed subscriptions in the existing approval. Owners with older grants are asked to sign in again with explicit consent before Home storage opens.
- TC-2204: Native audience checks accept Home's three exact SQL hook subscriptions only alongside an existing TinyChat data grant.
- TC-2499: The Home mirror adapter persists close receipts using node-compatible NULL/non-NULL compare-and-set predicates. If the KV mirror is already exactly closed but its receipt is missing, recovery records the original publication ETag without writing the KV copy again, before any gated child handoff. The CLI reports JSON error class, safe message, code, HTTP status when available, and operation step; private SQL bodies and nested causes remain redacted. Exit 2 identifies invalid input, exit 6 known transient failures (including NODE_BUSY and REQUEST_TIMEOUT without HTTP metadata), and exit 1 other runtime failures or OUTCOME_UNKNOWN. Unclassified errors are not labelled bad input; no failure confirms delivery or authorizes an automatic retry.

## 0.17.0-beta.1

### Minor Changes

- 1571ac5: Home shows the "What do you want done?" box and the Agents pill without Show hidden features turned on in Settings.

  Details: TC-3119

## 0.16.2-beta.0

### Patch Changes

- d3970bf: TinyCloud One can show the Ship ledger, a read-only view of where each task stands and what it is waiting on. The tile appears only for an account whose TinyCloud holds a ship board.

  Details: TC-3768

## 0.16.1

### Patch Changes

- 49239bf: The app retries a failed agent status check after 10 seconds. A second failure waits 4 minutes; later failures wait 5 minutes.

  Details: TC-3739

- 2abe7e5: Inside One, Explorer can read your apps' data but can't change or delete it. Editing stays in Explorer's own tab.

  Details: TC-3675

## 0.16.1-beta.1

### Patch Changes

- 49239bf: The app retries a failed agent status check after 10 seconds. A second failure waits 4 minutes; later failures wait 5 minutes.

  Details: TC-3739

## 0.16.1-beta.0

### Patch Changes

- 2abe7e5: Inside One, Explorer can read your apps' data but can't change or delete it. Editing stays in Explorer's own tab.

  Details: TC-3675

## 0.16.0

### Minor Changes

- 764dd74: On the web, TinyCloud One has an Apps grid and a bar with Pin on every open app. On a phone-sized screen the bar is a floating tab bar that holds your first two pinned apps. The phone and desktop apps get the same in their next builds.

  Details: TC-3650

### Patch Changes

- 09f336a: When a Feed answer fails to send, the app keeps a short note of why on your device: an error code and status, never what you wrote. It keeps the last 20, so the cause can be traced.

  Details: TC-3723

- 09f336a: A Feed answer that fails to send while you're in another app is sent once more when you come back, and it's never recorded twice.

  Details: TC-3723

- d818fd0: You can bring your meetings in from Granola and keep them in sync: connect Granola in Meeting sources.

  Details: TC-3292

- c12869d: When your session expires, signing you out keeps the work this device has not sent yet: post drafts, answers waiting to be sent, finished transcripts waiting to be saved and the records of uploads and transcriptions in progress. It is kept for your account only. Another account that signs in on the same device can't see it or send it, and it is there again when you sign back in. Signing out yourself removes all of it, even while an expired session is signing out. Opening a new chat signs you out only when the server refuses your session. On the phone apps it first tries once to renew the session, unless the session began or was renewed in the last minute or a failed renewal is waiting to retry. On tinycloud.chat and home.tinycloud.xyz, the notice that holds a tab before it moves to the new address counts only your own unsent answers; another account's unsent answers get a line of their own and keep the tab there for up to 7 days.

  Details: TC-3743

- c04a852: TinyCloud One pages can't be shown inside another site's frame.

  Details: TC-3547

- 7817452: Tapping the status bar in the iPhone app scrolls the screen you are on back to the top.

  Details: TC-3722

- 8f8ca25: The TinyChat retrieval skill's setup treats a `tc context` session in the `renewed` state (the original grant has ended but the owner's renewal is still running) like a `present` one.

  Details: TC-2904

- cd2f663: If you use the desktop app on version 0.13.0 or older, or on a beta of 0.14.0, update to 0.15 or later before November 25. If you test on TestFlight, update to the latest build. From November 25, older versions can't open your saved bot chat history and show an error. Nothing is deleted, and updating the app brings the history back.

  Details: TC-2518

- b9bf1e9: On a phone, lifting your finger after pinning or unpinning an app with a long press in Apps opens no app.

  Details: TC-3752

## 0.16.0-beta.7

### Patch Changes

- d818fd0: You can bring your meetings in from Granola and keep them in sync: connect Granola in Meeting sources.

  Details: TC-3292

## 0.16.0-beta.6

### Patch Changes

- b9bf1e9: On a phone, lifting your finger after pinning or unpinning an app with a long press in Apps opens no app.

  Details: TC-3752

## 0.16.0-beta.5

### Patch Changes

- c12869d: When your session expires, signing you out keeps the work this device has not sent yet: post drafts, answers waiting to be sent, finished transcripts waiting to be saved and the records of uploads and transcriptions in progress. It is kept for your account only. Another account that signs in on the same device can't see it or send it, and it is there again when you sign back in. Signing out yourself removes all of it, even while an expired session is signing out. Opening a new chat signs you out only when the server refuses your session. On the phone apps it first tries once to renew the session, unless the session began or was renewed in the last minute or a failed renewal is waiting to retry. On tinycloud.chat and home.tinycloud.xyz, the notice that holds a tab before it moves to the new address counts only your own unsent answers; another account's unsent answers get a line of their own and keep the tab there for up to 7 days.

  Details: TC-3743

## 0.16.0-beta.4

### Patch Changes

- 09f336a: When a Feed answer fails to send, the app keeps a short note of why on your device: an error code and status, never what you wrote. It keeps the last 20, so the cause can be traced.

  Details: TC-3723

- 09f336a: A Feed answer that fails to send while you're in another app is sent once more when you come back, and it's never recorded twice.

  Details: TC-3723

- 7817452: Tapping the status bar in the iPhone app scrolls the screen you are on back to the top.

  Details: TC-3722

## 0.16.0-beta.3

### Patch Changes

- 8f8ca25: The TinyChat retrieval skill's setup treats a `tc context` session in the `renewed` state (the original grant has ended but the owner's renewal is still running) like a `present` one.

  Details: TC-2904

## 0.16.0-beta.2

### Minor Changes

- 764dd74: On the web, TinyCloud One has an Apps grid and a bar with Pin on every open app. On a phone-sized screen the bar is a floating tab bar that holds your first two pinned apps. The phone and desktop apps get the same in their next builds.

  Details: TC-3650

## 0.15.4-beta.1

### Patch Changes

- c04a852: TinyCloud One pages can't be shown inside another site's frame.

  Details: TC-3547

## 0.15.4-beta.0

### Patch Changes

- cd2f663: If you use the desktop app on version 0.13.0 or older, or on a beta of 0.14.0, update to 0.15 or later before November 25. If you test on TestFlight, update to the latest build. From November 25, older versions stop working with your data.

  Details: TC-2518

## 0.15.3

### Patch Changes

- 2b8966c: In the phone app, Explorer opens inside TinyCloud One.

  Details: TC-3568

- 4a67fd5: In the phone app, apps that don't open inside TinyCloud One open in a sheet over it, so you stay in One.

  Details: TC-3568

- 0cd1ccc: The agent setup guide at tinycloud.one/agents/setup.md, the agent setup error messages and the meetings skill name TinyCloud One. The meetings skill is published as version 0.1.1-onboarding.29 and keeps its install name, folders and tool names.

  Details: TC-3659

- 8ba7ee3: The Allow Connectors card says that OpenKey also asks to unlock encrypted data, and says so when that permission is left out.

  Details: TC-3674

- d011402: Your card.md text is carried over as it is when its stored version doesn't match its text.

  Details: TC-3685

## 0.15.3-beta.4

### Patch Changes

- 8ba7ee3: The Allow Connectors card says that OpenKey also asks to unlock encrypted data, and says so when that permission is left out.

  Details: TC-3674

- d011402: Your card.md text is carried over as it is when its stored version doesn't match its text.

  Details: TC-3685

## 0.15.3-beta.3

### Patch Changes

- 0cd1ccc: The agent setup guide at tinycloud.one/agents/setup.md, the agent setup error messages and the meetings skill name TinyCloud One. The meetings skill is published as version 0.1.1-onboarding.29 and keeps its install name, folders and tool names.

  Details: TC-3659

## 0.15.3-beta.2

No changes in this release.

## 0.15.3-beta.1

### Patch Changes

- 2b8966c: In the phone app, Explorer opens inside TinyCloud One.

  Details: TC-3568

## 0.15.3-beta.0

### Patch Changes

- 4a67fd5: In the phone app, apps that don't open inside TinyCloud One open in a sheet over it, so you stay in One.

  Details: TC-3568

## 0.15.2

### Patch Changes

- defebb9: The agent guides are built from the latest published set of TinyCloud guides.

  Details: TC-3278

- c8d1e5d: The agent guides are built from the latest published set of TinyCloud guides.

  Details: TC-3558

- 49f8456: Powerful transcriptions that the provider can't take right away wait and finish by themselves. The server keeps the audio and retries (after 1, 2, 5 and 10 minutes, then every 10) for up to 24 hours, and never sends the same paid request twice when the outcome is unclear. While it waits, the note and the upload sheet show "Transcription delayed" and say it will finish automatically.

  Details: TC-2131

- 95b5f15: Main can read web pages and search the web. It's off until you turn it on: in Main's chat, tap Web access and choose a setting. You can limit it to sites you list.

  Details: TC-2808

- 36ba6ff: Private Transcription uploads reach the transcription service at its current address.
- d519be5: Background memory extraction asks each model for its lowest reasoning setting, which keeps hidden reasoning tokens down on short turns; the turn's total includes the extraction once it settles.

  Details: TC-2002

- 15e207c: Main's Web access setting stays out of sight until the service it talks to supports it.

## 0.15.2-beta.5

### Patch Changes

- c8d1e5d: The agent guides are built from the latest published set of TinyCloud guides.

  Details: TC-3558

## 0.15.2-beta.4

### Patch Changes

- 36ba6ff: Private Transcription uploads reach the transcription service at its current address.
- 15e207c: Main's Web access setting stays out of sight until the service it talks to supports it.

## 0.15.2-beta.3

### Patch Changes

- 95b5f15: Main can read web pages and search the web. It's off until you turn it on: in Main's chat, tap Web access and choose a setting. You can limit it to sites you list.

  Details: TC-2808

## 0.15.2-beta.2

### Patch Changes

- d519be5: Background memory extraction asks each model for its lowest reasoning setting, which keeps hidden reasoning tokens down on short turns; the turn's total includes the extraction once it settles.

  Details: TC-2002

## 0.15.2-beta.1

### Patch Changes

- 49f8456: Powerful transcriptions that the provider can't take right away wait and finish by themselves. The server keeps the audio and retries (after 1, 2, 5 and 10 minutes, then every 10) for up to 24 hours, and never sends the same paid request twice when the outcome is unclear. While it waits, the note and the upload sheet show "Transcription delayed" and say it will finish automatically.

  Details: TC-2131

## 0.15.2-beta.0

### Patch Changes

- defebb9: The agent guides are built from the latest published set of TinyCloud guides.

  Details: TC-3278

## 0.15.1

### Patch Changes

- be731d0: The agent guides are built from the latest published set of TinyCloud guides.

  Details: TC-3278

- 7b5b37a: Courier opens inside TinyCloud One as a read-only view of your threads, orders and requests. Approving, denying and saving orders open Courier in a new tab.

  Details: TC-3337

- ba6fcea: After you allow deleted meetings back, the confirmation says they can return from your next Granola sync or CSV upload.

  Details: TC-3292

- 298c5b1: Import meetings from a Granola CSV export. Meetings you've deleted aren't imported again unless you allow them back.

  Details: TC-3292

- 298c5b1: Importing a Granola CSV leaves notes synced from Granola's API unchanged. A meeting you deleted stays out of later Granola syncs and CSV imports until you choose "Allow deleted meetings back" and confirm.

  Details: TC-3292

- 05459bb: Enable Granola imports and API sync in production.

  Details: TC-3292

- 403b28f: Granola sync stops checking deleted meetings when you stop the sync or the check times out. A failed check leaves your sync progress unchanged.

  Details: TC-3292

- 221ffca: Hide the Granola import until its API sync is verified.

  Details: TC-3292

- 414c37a: If your sign-in method can't support this device's sync, sync now stops quietly for that session instead of retrying. Syncing everything to this device after sign-in can take a little longer to finish. A new account no longer logs connector errors on its first sign-in.

  Details: TC-2685

- 4444996: Main gives earlier messages more time to load when it starts. It shows "Loading earlier messages…" while they load, and you can send a message in the meantime.
- 227860b: tinycloud.one serves its agent discovery files, and a missing discovery file answers 404.

## 0.15.1-beta.7

### Patch Changes

- be731d0: The agent guides are built from the latest published set of TinyCloud guides.

  Details: TC-3278

## 0.15.1-beta.6

### Patch Changes

- 221ffca: Hide the Granola import until its API sync is verified.

  Details: TC-3292

## 0.15.1-beta.5

### Patch Changes

- 05459bb: Enable Granola imports and API sync in production.

  Details: TC-3292

## 0.15.1-beta.4

### Patch Changes

- 403b28f: Granola sync stops checking deleted meetings when you stop the sync or the check times out. A failed check leaves your sync progress unchanged.

  Details: TC-3292

## 0.15.1-beta.3

### Patch Changes

- ba6fcea: After you allow deleted meetings back, the confirmation says they can return from your next Granola sync or CSV upload.

  Details: TC-3292

## 0.15.1-beta.2

### Patch Changes

- 7b5b37a: Courier opens inside TinyCloud One as a read-only view of your threads, orders and requests. Approving, denying and saving orders open Courier in a new tab.

  Details: TC-3337

- 414c37a: If your sign-in method can't support this device's sync, sync now stops quietly for that session instead of retrying. Syncing everything to this device after sign-in can take a little longer to finish. A new account no longer logs connector errors on its first sign-in.

  Details: TC-2685

- 4444996: Main gives earlier messages more time to load when it starts. It shows "Loading earlier messages…" while they load, and you can send a message in the meantime.

## 0.15.1-beta.1

### Patch Changes

- 227860b: tinycloud.one serves its agent discovery files, and a missing discovery file answers 404.

## 0.15.1-beta.0

### Patch Changes

- 298c5b1: Import meetings from a Granola CSV export. Meetings you've deleted aren't imported again unless you allow them back.

  Details: TC-3292

- 298c5b1: Importing a Granola CSV leaves notes synced from Granola's API unchanged. A meeting you deleted stays out of later Granola syncs and CSV imports until you choose "Allow deleted meetings back" and confirm.

  Details: TC-3292

## 0.15.0

### Minor Changes

- 74889d5: A Feed card has an address: `tinycloud.one/chat/feed/<card id>`, and the shorter `tinycloud.one/feed/<card id>`. Opening it (signed out, you sign in first and land on the same card) shows the Feed with that card open and outlined for a moment, under History or Snoozed if that is where it lives. If the card isn't in your feed (it was removed or expired, or it's in someone else's feed), the Feed opens as usual with a short note you can dismiss. Details: TC-3279.
- a9e1b3d: Feed: cards can show what kind of task they are, and messages from another team over Courier are marked. An agent can label a card Spend, Publish, Send, Access, Rule, Ship, Do, Review, Direction, Answer, News or Alert. The label shows at the top right of the card in the list and Cards views, and beside the title of an open card. Spend, Publish, Send and Access, where your tap sends something out, are outlined with an arrow; Alert uses the warning colour; the rest are grey. A message relayed over Courier starts with the Courier mark and its sender, and the open card adds "via" the agent that passed it on. The mark appears only on cards that come from your Courier connection. Filter offers "Task" when any card has a label. A label the app doesn't recognise doesn't change the card and is listed in Details as not shown.
- 74889d5: Feed: answering a card takes it out of the list at once, with one pill at the top of the list that names what you answered, with Undo and a five-second countdown. A second answer sends the first at once, and the pill then says where it went ("Sent to" and the agent's name). Acknowledge, Drop this card and Ask me later (Show me later on an update) use the same pill and never say "Sent to". Counts drop when you answer and come back if you Undo. An answered card waits in Pending at the end of the list ("You chose …", with the post and "Waiting on" the agent's name); Pending is always open and a tap on a row opens the card again, where Change answer lives. A card that asks now has "See N options" under its row, which opens the same card as tapping the post and turns into "Hide options" while it is open.
- 74889d5: Feed: a collapsed card now shows just its post, up to four lines (or its title if the agent wrote no post), in a flat list that runs edge to edge. The agent's name, the time and the title no longer appear on the collapsed row. Nothing opens by itself: Needs you starts with every card collapsed. An open card shows the post first, then the title, then the rest. Updates in All are listed newest first. The Cards and Expanded views show the post too.
- 74889d5: An open Feed card is easier to scan. "Known so far" and an approval's steps are collapsed sections you can open, the expiry shows in UTC, and tapping the suggested option accepts it, so there's no separate Accept recommendation button.

  Details: TC-3300

- 74889d5: The Feed is one list: Needs you, Updates, Pending and History, one under the other, each with a heading that stays in view while you scroll its section. The island at the top shows Needs you, Updates and History with their counts. Tap one to jump to it, and the highlight follows as you scroll. An empty section is dimmed on the island and can't be tapped. When nothing needs you, Needs you still comes first and says so. The old Needs you, All and History views are gone.

  Details: TC-3300

- 8ec6a58: Web sign-in goes through OpenKey's own sign-in window. When that window offers automatic renewal and the owner leaves it on, the session renews for up to 90 days without another sign-in. Otherwise a sign-in lasts its usual 30 days.

  Details: TC-2872

- 74889d5: You can share a meeting or voice note recording with a link. People who open it sign in, find it under Shared with me in their Library, and can read the transcript and play the audio until 30 days after you create the link, or until you stop sharing. You choose how long the link can be opened: 1, 7 or 30 days. On iOS and Android, tinycloud.one/s/ links open in the app.

  Details: TC-3195

- 3bf909b: tinycloud.one serves the TinyCloud agent guides and discovery metadata, including `/llms.txt` and `/agents/abilities/`.

### Patch Changes

- 27e5641: Internal changes for tests; nothing in the app changes.

  Details: TC-3337

- 3b7d871: TinyCloud One's agent guides are built from the earlier published set of TinyCloud guides.

  Details: TC-3278

- 1b34214: The agent guides are built from the latest published set of TinyCloud guides.

  Details: TC-3278

- 3f59ffe: The agent guides are built from the latest published set of TinyCloud guides.

  Details: TC-3278

- a720d94: Settings has a card.md: one note for your whole Feed on how agents make cards for you and what you prefer. It starts from a default that explains how to write a card, with an example of each kind. You can edit it, clear it or reset it to the default. Agents read it before they post and see each saved version, including agents connected before this change.

  Details: TC-3345

- 74889d5: Links in the Feed open in a sheet inside the app. On the web the page rises from the bottom over the Feed, with Open in browser and Close at the top; a site that doesn't allow being shown inside another page says so, with the same Open in browser button. In the iPhone and Android apps the page opens in the phone's in-app browser over the app. Cmd-click, Ctrl-click and middle click still open a new tab, and email links work as before.

  Details: TC-3404

- 74889d5: On a computer with a mouse, a Feed card opens over the dimmed Feed instead of inside the list. The X, Escape or a tap outside closes it.

  Details: TC-3300

- 74889d5: On a phone, the Feed opens one row at a time. Opening a row folds the one that was open, dims the others and brings the open row up under its section heading. "Show less" at the foot of an open card folds it and brings its row back into view. With reduced motion nothing animates, and the open row still comes into view. An answer that's still counting down is still sent when you open another row.

  Details: TC-3300

- 74889d5: Updates has an Acknowledge all button, and you have 5 seconds to undo it.

  Details: TC-3300

- 74889d5: Opening or folding a card in the Feed keeps the keyboard with it: focus moves to the open card's Show less and back to its row, and Escape folds an open card.

  Details: TC-3300

- 74889d5: Feed section buttons are easier to tap on phones.

  Details: TC-3300

- 4893c98: The Feed welcome card's agent prompt asks the agent to follow the Feed guide.

  Details: TC-3392

- 74889d5: The Fireflies row now says that connecting imports your meetings from Fireflies. Details: TC-2778
- 51274a8: Fireflies consent text says our server keeps meeting copies for up to 14 days.

  Details: TC-2778

- 74889d5: If you disconnect Fireflies and connect it again, Sync now imports your older meetings again.

  Details: TC-2778

- 74889d5: Internal changes for Fireflies sync; nothing in the app changes. Details: TC-2778
- 74889d5: Internal changes for Granola meeting sync; nothing in the app changes. Details: TC-3292
- 59e0b09: Import meetings from a Granola CSV export. Meetings you've deleted aren't imported again unless you allow them back.

  Details: TC-3292

- 74889d5: Connectors no longer lists Granola, which couldn't be connected.

  Details: TC-3292

- 7973a69: The secret guard reads a one-tap approval link the way a browser opens it.

  Details: TC-3242

- 74889d5: Feed: when a collapsed card has no summary, its second line shows the card's title instead of the start of its body or its "why now" line.
- 4712b3f: Returning visitors on the Home address see the page during an update.

  Details: TC-3450

- 22e42aa: Some images in chat replies and notes now ask before they load, and say which site they come from. In a chat reply, images appear once the reply has finished.

  Details: TC-3144

- 1676a13: Leaving an app inside TinyCloud One, or signing out with one open, doesn't ask you to sign anything. One tells the app to stop using its access right away, and that access ends within an hour.

  Details: TC-3483

- e26e84c: Stopping a recording from outside the app closes the recorder and shows the saved note, like its own Done. This covers the Live Activity's Stop on the Lock Screen or Dynamic Island, "Stop recording" from Siri or Shortcuts and the Android notification's Stop or Discard. When the app comes back to the foreground, it checks with the phone whether the recording on screen is still running.

  Details: TC-3118

- 5e64d15: Notetaker: when Google Meet doesn't let the notetaker into a meeting, the recording says so and points to the host's Meeting access setting.

  Details: TC-2443

- 74889d5: Internal changes for build checks; nothing in the app changes.

  Details: TC-2778

- 620ad17: One Apps is on in TinyCloud One on the web. The iOS, Android and desktop apps are unchanged.

  Details: TC-3337

- 9b37cea: When a One App asks for more access and OpenKey doesn't add it, One says why, using lines it already shows: "Couldn't ask for permission. Nothing changed. Try again." when another try can help, the different-account line when another OpenKey account was picked, and otherwise "{App} can't do this without that access."

  Sending to Main after the session has ended says "Your session expired. Sign in again to talk to Main."

  The Conversation Canvas permission error shows only its own sentence.

  Details: TC-3445

- 93b8799: The TinyCloud One web build completes again, with the agent guide pages included.

  Details: TC-3471

- 27e5641: One Apps behind VITE_ONE_APPS (off in production): the Apps page becomes the "TinyCloud apps" launcher with Pin and Unpin, and the navigation holds Feed, Chat and Apps plus the apps each account pins (Recording, Connectors and the TinyCloud apps). The phone tab bar shows at most five items; the rail and sidebar show every pin.

  Details: TC-3337

- 27e5641: One Apps behind VITE_ONE_APPS (off in production): TinyCloud's own apps open inside One with the access they need from One's session, asking first when an app wants more. Also fixes `vite dev` pages crashing on start; production builds are unchanged.

  Details: TC-3337

- 74889d5: Internal changes for sign-in; nothing in the app changes.

  Details: TC-3030

- a26bd95: Missing build files return a real 404, so a Home page left open across a deploy doesn't get the app's page back for a missing script. A failed lazy load (the TinyCloud panel's "This didn't load.", a screen that couldn't open) offers "New version available — Reload" when a newer build is live.
- 9ad1572: "Delete OpenKey account" first deletes your meeting recordings, voice notes and uploads, then opens OpenKey. If a deletion is still running or can't be confirmed, a notice says what's left, and you can try again or continue to OpenKey. The notetaker service's sign-in is still removed before OpenKey opens.

  Details: TC-3136

- 74889d5: When TinyCloud is already running as many bots as it can, a message to a bot now says so and that it wasn't sent, with a Try again button, instead of the general "couldn't start" line.

  Details: TC-3325

- 74889d5: Internal changes for bots; nothing in the app changes.

  Details: TC-3325

- 74889d5: In the bot view, a small line between the messages says what the bot did on its computer, such as "Ran 3 commands" or "Changed 1 file", and it is still there after a reload. The bot's name at the top opens a panel with the bot's avatar, its activity with times (newest first), and where it runs, such as "Private · asleep". The panel is a column beside the chat on wide screens and a sheet on smaller ones. From the panel you can change a bot's name, shape and colour, or delete the bot after a confirmation (Main can't be deleted).

  Details: TC-3325

- 74889d5: Settings has a Chat view card where you can choose Classic or Bots. Classic stays the default. With Bots, your bots are listed under Chat in the sidebar, on the rail and above the chat on a phone, and Chat opens the bot you had open last. New bot is turned off, with the reason, once you have as many bots as your account allows.

  Details: TC-3325

- 74889d5: The Chat tab can show a bot's own chat in place of the classic chat, behind a "Chat view" choice kept per account on each device. Classic stays the default, so nothing changes unless an account picks Bots and is let into bots. The bot view has the same composer as Main's chat, keeps a reply going when you switch bots, saves history into your space the same way, and offers Try again when a reply fails.

  Details: TC-3325

- ad02ee7: Disconnect agent in Settings > Agent access ends the access of an agent connected through the TinyCloud connector, and shows Disconnected once the agent can no longer use it. An agent whose access you removed somewhere else shows as not connected. Settings > Agent access also explains what the access is for.

  Details: TC-2196

- 79b2d17: The note above the prompt you paste into an agent and the prompt itself say your TinyCloud One Feed, and the note shown where stored credentials are not available in the app reads "This uses stored credentials, which you set up in TinyCloud One on the web or desktop. Everything you connect there works here."

## 0.15.0-beta.16

### Patch Changes

- 1676a13: Leaving an app inside TinyCloud One, or signing out with one open, doesn't ask you to sign anything. One tells the app to stop using its access right away, and that access ends within an hour.

  Details: TC-3483

- ad02ee7: Disconnect agent in Settings > Agent access ends the access of an agent connected through the TinyCloud connector, and shows Disconnected once the agent can no longer use it. An agent whose access you removed somewhere else shows as not connected. Settings > Agent access also explains what the access is for.

  Details: TC-2196

## 0.15.0-beta.15

### Patch Changes

- a720d94: Settings has a card.md: one note for your whole Feed on how agents make cards for you and what you prefer. It starts from a default that explains how to write a card, with an example of each kind. You can edit it, clear it or reset it to the default. Agents read it before they post and see each saved version, including agents connected before this change.

  Details: TC-3345

## 0.15.0-beta.14

### Patch Changes

- 93b8799: The TinyCloud One web build completes again, with the agent guide pages included.

  Details: TC-3471

- 9ad1572: "Delete OpenKey account" first deletes your meeting recordings, voice notes and uploads, then opens OpenKey. If a deletion is still running or can't be confirmed, a notice says what's left, and you can try again or continue to OpenKey. The notetaker service's sign-in is still removed before OpenKey opens.

  Details: TC-3136

## 0.15.0-beta.13

### Patch Changes

- 59e0b09: Import meetings from a Granola CSV export. Meetings you've deleted aren't imported again unless you allow them back.

  Details: TC-3292

## 0.15.0-beta.12

### Patch Changes

- 3f59ffe: The agent guides are built from the latest published set of TinyCloud guides.

  Details: TC-3278

## 0.15.0-beta.11

### Patch Changes

- 79b2d17: The note above the prompt you paste into an agent and the prompt itself say your TinyCloud One Feed, and the note shown where stored credentials are not available in the app reads "This uses stored credentials, which you set up in TinyCloud One on the web or desktop. Everything you connect there works here."

## 0.15.0-beta.10

### Patch Changes

- e26e84c: Stopping a recording from outside the app closes the recorder and shows the saved note, like its own Done. This covers the Live Activity's Stop on the Lock Screen or Dynamic Island, "Stop recording" from Siri or Shortcuts and the Android notification's Stop or Discard. When the app comes back to the foreground, it checks with the phone whether the recording on screen is still running.

  Details: TC-3118

- 5e64d15: Notetaker: when Google Meet doesn't let the notetaker into a meeting, the recording says so and points to the host's Meeting access setting.

  Details: TC-2443

## 0.15.0-beta.9

### Patch Changes

- 51274a8: Fireflies consent text says our server keeps meeting copies for up to 14 days.

  Details: TC-2778

- 7973a69: The secret guard reads a one-tap approval link the way a browser opens it.

  Details: TC-3242

- a26bd95: Missing build files return a real 404, so a Home page left open across a deploy doesn't get the app's page back for a missing script. A failed lazy load (the TinyCloud panel's "This didn't load.", a screen that couldn't open) offers "New version available — Reload" when a newer build is live.

## 0.15.0-beta.8

### Minor Changes

- 74889d5: A Feed card has an address: `tinycloud.one/chat/feed/<card id>`, and the shorter `tinycloud.one/feed/<card id>`. Opening it (signed out, you sign in first and land on the same card) shows the Feed with that card open and outlined for a moment, under History or Snoozed if that is where it lives. If the card isn't in your feed (it was removed or expired, or it's in someone else's feed), the Feed opens as usual with a short note you can dismiss. Details: TC-3279.
- 74889d5: Feed: answering a card takes it out of the list at once, with one pill at the top of the list that names what you answered, with Undo and a five-second countdown. A second answer sends the first at once, and the pill then says where it went ("Sent to" and the agent's name). Acknowledge, Drop this card and Ask me later (Show me later on an update) use the same pill and never say "Sent to". Counts drop when you answer and come back if you Undo. An answered card waits in Pending at the end of the list ("You chose …", with the post and "Waiting on" the agent's name); Pending is always open and a tap on a row opens the card again, where Change answer lives. A card that asks now has "See N options" under its row, which opens the same card as tapping the post and turns into "Hide options" while it is open.
- 74889d5: Feed: a collapsed card now shows just its post, up to four lines (or its title if the agent wrote no post), in a flat list that runs edge to edge. The agent's name, the time and the title no longer appear on the collapsed row. Nothing opens by itself: Needs you starts with every card collapsed. An open card shows the post first, then the title, then the rest. Updates in All are listed newest first. The Cards and Expanded views show the post too.
- 74889d5: An open Feed card is easier to scan. "Known so far" and an approval's steps are collapsed sections you can open, the expiry shows in UTC, and tapping the suggested option accepts it, so there's no separate Accept recommendation button.

  Details: TC-3300

- 74889d5: The Feed is one list: Needs you, Updates, Pending and History, one under the other, each with a heading that stays in view while you scroll its section. The island at the top shows Needs you, Updates and History with their counts. Tap one to jump to it, and the highlight follows as you scroll. An empty section is dimmed on the island and can't be tapped. When nothing needs you, Needs you still comes first and says so. The old Needs you, All and History views are gone.

  Details: TC-3300

- 74889d5: You can share a meeting or voice note recording with a link. People who open it sign in, find it under Shared with me in their Library, and can read the transcript and play the audio until 30 days after you create the link, or until you stop sharing. You choose how long the link can be opened: 1, 7 or 30 days. On iOS and Android, tinycloud.one/s/ links open in the app.

  Details: TC-3195

### Patch Changes

- 74889d5: Links in the Feed open in a sheet inside the app. On the web the page rises from the bottom over the Feed, with Open in browser and Close at the top; a site that doesn't allow being shown inside another page says so, with the same Open in browser button. In the iPhone and Android apps the page opens in the phone's in-app browser over the app. Cmd-click, Ctrl-click and middle click still open a new tab, and email links work as before.

  Details: TC-3404

- 74889d5: On a computer with a mouse, a Feed card opens over the dimmed Feed instead of inside the list. The X, Escape or a tap outside closes it.

  Details: TC-3300

- 74889d5: On a phone, the Feed opens one row at a time. Opening a row folds the one that was open, dims the others and brings the open row up under its section heading. "Show less" at the foot of an open card folds it and brings its row back into view. With reduced motion nothing animates, and the open row still comes into view. An answer that's still counting down is still sent when you open another row.

  Details: TC-3300

- 74889d5: Updates has an Acknowledge all button, and you have 5 seconds to undo it.

  Details: TC-3300

- 74889d5: Opening or folding a card in the Feed keeps the keyboard with it: focus moves to the open card's Show less and back to its row, and Escape folds an open card.

  Details: TC-3300

- 74889d5: Feed section buttons are easier to tap on phones.

  Details: TC-3300

- 74889d5: The Fireflies row now says that connecting imports your meetings from Fireflies. Details: TC-2778
- 74889d5: If you disconnect Fireflies and connect it again, Sync now imports your older meetings again.

  Details: TC-2778

- 74889d5: Internal changes for Fireflies sync; nothing in the app changes. Details: TC-2778
- 74889d5: Internal changes for Granola meeting sync; nothing in the app changes. Details: TC-3292
- 74889d5: Connectors no longer lists Granola, which couldn't be connected.

  Details: TC-3292

- 74889d5: Feed: when a collapsed card has no summary, its second line shows the card's title instead of the start of its body or its "why now" line.
- 4712b3f: Returning visitors on the Home address see the page during an update.

  Details: TC-3450

- 74889d5: Internal changes for build checks; nothing in the app changes.

  Details: TC-2778

- 9b37cea: When a One App asks for more access and OpenKey doesn't add it, One says why, using lines it already shows: "Couldn't ask for permission. Nothing changed. Try again." when another try can help, the different-account line when another OpenKey account was picked, and otherwise "{App} can't do this without that access."

  Sending to Main after the session has ended says "Your session expired. Sign in again to talk to Main."

  The Conversation Canvas permission error shows only its own sentence.

  Details: TC-3445

- 74889d5: Internal changes for sign-in; nothing in the app changes.

  Details: TC-3030

- 74889d5: When TinyCloud is already running as many bots as it can, a message to a bot now says so and that it wasn't sent, with a Try again button, instead of the general "couldn't start" line.

  Details: TC-3325

- 74889d5: Internal changes for bots; nothing in the app changes.

  Details: TC-3325

- 74889d5: In the bot view, a small line between the messages says what the bot did on its computer, such as "Ran 3 commands" or "Changed 1 file", and it is still there after a reload. The bot's name at the top opens a panel with the bot's avatar, its activity with times (newest first), and where it runs, such as "Private · asleep". The panel is a column beside the chat on wide screens and a sheet on smaller ones. From the panel you can change a bot's name, shape and colour, or delete the bot after a confirmation (Main can't be deleted).

  Details: TC-3325

- 74889d5: Settings has a Chat view card where you can choose Classic or Bots. Classic stays the default. With Bots, your bots are listed under Chat in the sidebar, on the rail and above the chat on a phone, and Chat opens the bot you had open last. New bot is turned off, with the reason, once you have as many bots as your account allows.

  Details: TC-3325

- 74889d5: The Chat tab can show a bot's own chat in place of the classic chat, behind a "Chat view" choice kept per account on each device. Classic stays the default, so nothing changes unless an account picks Bots and is let into bots. The bot view has the same composer as Main's chat, keeps a reply going when you switch bots, saves history into your space the same way, and offers Try again when a reply fails.

  Details: TC-3325

## 0.15.0-beta.7

### Minor Changes

- 8ec6a58: Web sign-in goes through OpenKey's own sign-in window. When that window offers automatic renewal and the owner leaves it on, the session renews for up to 90 days without another sign-in. Otherwise a sign-in lasts its usual 30 days.

  Details: TC-2872

## 0.15.0-beta.6

### Patch Changes

- 620ad17: One Apps is on in TinyCloud One on the web. The iOS, Android and desktop apps are unchanged.

  Details: TC-3337

## 0.15.0-beta.5

### Patch Changes

- 27e5641: Internal changes for tests; nothing in the app changes.

  Details: TC-3337

- 27e5641: One Apps behind VITE_ONE_APPS (off in production): the Apps page becomes the "TinyCloud apps" launcher with Pin and Unpin, and the navigation holds Feed, Chat and Apps plus the apps each account pins (Recording, Connectors and the TinyCloud apps). The phone tab bar shows at most five items; the rail and sidebar show every pin.

  Details: TC-3337

- 27e5641: One Apps behind VITE_ONE_APPS (off in production): TinyCloud's own apps open inside One with the access they need from One's session, asking first when an app wants more. Also fixes `vite dev` pages crashing on start; production builds are unchanged.

  Details: TC-3337

## 0.15.0-beta.4

### Minor Changes

- a9e1b3d: Feed: cards can show what kind of task they are, and messages from another team over Courier are marked. An agent can label a card Spend, Publish, Send, Access, Rule, Ship, Do, Review, Direction, Answer, News or Alert. The label shows at the top right of the card in the list and Cards views, and beside the title of an open card. Spend, Publish, Send and Access, where your tap sends something out, are outlined with an arrow; Alert uses the warning colour; the rest are grey. A message relayed over Courier starts with the Courier mark and its sender, and the open card adds "via" the agent that passed it on. The mark appears only on cards that come from your Courier connection. Filter offers "Task" when any card has a label. A label the app doesn't recognise doesn't change the card and is listed in Details as not shown.

## 0.15.0-beta.3

### Patch Changes

- 3b7d871: TinyCloud One's agent guides are built from the earlier published set of TinyCloud guides.

  Details: TC-3278

## 0.15.0-beta.2

### Patch Changes

- 1b34214: The agent guides are built from the latest published set of TinyCloud guides.

  Details: TC-3278

- 4893c98: The Feed welcome card's agent prompt asks the agent to follow the Feed guide.

  Details: TC-3392

## 0.15.0-beta.1

### Patch Changes

- 22e42aa: Some images in chat replies and notes now ask before they load, and say which site they come from. In a chat reply, images appear once the reply has finished.

  Details: TC-3144

## 0.15.0-beta.0

### Minor Changes

- 3bf909b: tinycloud.one serves the TinyCloud agent guides and discovery metadata, including `/llms.txt` and `/agents/abilities/`.

## 0.14.0

### Minor Changes

- b589ec8: Android: add a Quick Settings "Record" tile that opens TinyCloud Home and starts a voice note, and relabel the launcher shortcut "Record".
- eed0f62: TinyCloud Home on iPhone and Android now opens with Face ID, Touch ID or the phone's screen lock instead of signing in again. A signed-in app asks when it opens, and when you come back after 5 minutes away (Settings › App lock: 1, 5 or 15 minutes, or an hour). Your feed and recordings load behind the lock screen and appear the moment you unlock; on iPhone and Android 13 and later the app switcher shows a blank screen while the lock is on. Cancelling keeps the lock screen up with a button to try again, and never signs you out. The lock is on by default where Face ID, Touch ID or a fingerprint is set up, and can be turned off in Settings. Recording from a shortcut starts without waiting for the unlock. Details: TC-2738
- 657b2ef: Settings → Account has "Delete OpenKey account" (TC-2721, App Store 5.1.1(v)). It opens OpenKey's deletion page, `https://openkey.so/dashboard/settings/delete-account` on the configured `VITE_OPENKEY_HOST`, in the system browser sheet on the phone or a new tab on the web. The row isn't shown on desktop, which has no fixed-URL opener for it yet.
- 680789e: TinyCloud Home for Mac starts a recording from anywhere: press ⌘⇧⌥R (Command-Shift-Option-R), or choose Start recording from its menu-bar icon. The app comes to the front with the recorder open and recording; if a recording is already going, it opens that recorder instead. The menu-bar icon also has Open TinyCloud Home.
- 73a32e0: The Feed's Filter panel has a View switch: Compact (the rows the Feed has always had, still the default), Expanded (every card open in full, one after another), and Cards (tiles). The choice is kept on this device. Details: TC-3199.
- fc1ba3e: Home Feed gets the new card design.
  - **Views:** an Information | All | Needs action slider stays in reach as you scroll. "View" shows cards Compact (the default), as Full cards, or as a Grid, and keeps your place when you switch. History, Snoozed, priority and order sit under Filter.
  - **Compact cards:** each shows the agent, a relative time, where the card stands, a P0/P1 priority mark, when it's due, and how many times the agent replied.
  - **Open cards:** a card can carry a one-page brief that opens in the app. Comments read as a conversation. A comment shows "Received" only once the agent confirms it, and offers "Send again" if it isn't confirmed within two minutes.
  - **5 s Undo on every send:** that covers answers, comments, approvals, codes, and claim and task actions. A go-ahead is checked again before it's sent, and an approval that expired or closed in the meantime sends nothing.
  - **Card actions:** a decision can be dropped and an update acknowledged; either can be brought back later. Each takes the card away at once with Undo at the bottom of the screen, then tells the agent, and the card moves to History, marked Dropped or Acknowledged. Cards past their expiry move there too, marked Expired.
  - **Posts:** a post opens as a page with media and questions. Answers go to the agent per question, and unsent answers stay on the device.

- 79579b6: The Home site signs in with only the permissions Feed, Chat and Apps use (`manifest.home.json`): no secrets, no decrypt grant, and no access to the connectors, canvas, details, summaries or transcripts databases. Recording and Connectors stay on Home and ask for their own permissions in place the first time they are opened, in one OpenKey approval; once a feature has been used on a device, the next sign-in asks for it too. Background work for Recording or Connectors starts only once that feature's permissions are in place. Agent access, Canvas and Local copy stay off on Home. tinycloud.chat keeps the full grant and behaves as before. Existing Home sessions sign in once more (revision `home-1`). Linear: TC-2501
- 7db69c7: TinyCloud Home opens from the device: the Feed, chat histories and Library show their last copy at once and refresh in the background. What you open is fetched first; background copying waits for it and pauses while the app is hidden. The Feed loads with far fewer requests.
- acbf475: tinycloud.one is the canonical address. Visitors on tinycloud.chat or home.tinycloud.xyz move to tinycloud.one once nothing is left only in their browser; anyone with recordings or answers still on the old address stays there, with a notice, until they are saved or sent. Opening the old address with `?legacy=1` keeps the app there so that data can be saved. Each release now checks that all three addresses serve it. Details: TC-3108.

  Settings for this device (theme, notes view, capture preferences and consents) are kept separately for each address, so they start fresh on tinycloud.one. Settings on tinycloud.one links to the old addresses for anything left there. A page with unsaved text, an unsaved title or an answer that can still be undone stays where it is until that's done.

- 20598f6: One TinyCloud Home: home.tinycloud.xyz, tinycloud.chat, the desktop app and the mobile apps now run the same build. The `VITE_HOME_SITE` build flag, its separate production upload job and the Home-only sign-in grant (`manifest.home.json`) are gone.
  - Every platform opens on Feed, named Home, with the tabs Home, Chat, Apps, Recording and Connectors in that order. Signed out on the web you see the Home front page with its demo feed, and the install prompt waits until you have signed in.
  - Every web build signs in with `manifest.json`'s storage, without the connector secrets or the decrypt grant until this device has used Connectors. Opening Connectors the first time asks OpenKey for them in place, once. Recording no longer asks for its own permission, and Local copy, Agent access, Conversation Canvas and every Settings section are available on home.tinycloud.xyz too. If you signed in on home.tinycloud.xyz under the narrower Home grant, you sign in once more. The desktop and mobile apps sign in as before.
  - tinycloud.chat moves you to home.tinycloud.xyz with the same path, query and `#` link. If this browser still holds recordings that are only saved on tinycloud.chat, you stay there with a notice and move automatically once they are saved.

  Details: TC-2050

- cf05789: The app links TinyCloud's privacy policy, `https://tinycloud.xyz/privacy` (TC-2876, App Store 5.1.1(i), Play User Data policy). The link appears in Settings → Account (signed in, and the signed-out phone Settings) and in How it works → Your data. It opens in the in-app browser on iOS and Android, in the system browser on desktop (a fixed-URL Tauri command), and in a new tab on the web.

  The iOS privacy manifest now also declares Name, Purchase History, Product Interaction and Performance Data, to match the App Store privacy answers. The HealthKit purpose strings are now added to Debug builds only, and `ios-build.yml` fails a Release archive that has them.

- e5f9e06: Share links you open or create are now kept in your TinyCloud space (`xyz.tinycloud.tinychat/threads/shared-with-me/`, inside the existing `threads/` grant), so they follow your account to other devices and to the new Home address (TC-2830). The browser keeps only a per-account copy, which is cleared at sign-out. The first account to sign in on a browser takes over that browser's old list, once. A link opened while signed out is saved only if you then sign in on that same page.
- 4fb80fa: Home no longer shows the "What do you want done?" box or the Agents pill by default. Settings has a new "Show hidden features" switch (off by default, this device only) that brings them back. Details: TC-3119.
- ab71584: Native sign-in offers "Continue with Apple" once OpenKey lists Apple in `GET /api/auth/providers`; it opens Sign in with Apple in the existing OpenKey sheet (TC-1233). Updates `@openkey/sdk-capacitor` to the release that accepts `loginMethod: "apple"`.
- 4b2a0e3: Home's feed is now a list of cards. Every card shows at once, grouped under "Needs you" and "Earlier", with Needs you, All and Done above them and a filter for agent, project and type. A question answers with one tap on an option, or in your own words. The answer waits 5 seconds with an Undo button, then it's sent. Close the page during those 5 seconds and the answer is still sent, at once or the next time you open Home, unless the request changed in between. Comments sit under each card, one reply deep, as on the sitrep board, and an agent's replies show there too. The private note is gone from the card. Cards use plain words throughout. Empty and loading states are cards, and the signed-out demo uses the same card.
- aaf1236: iOS: TinyCloud Home ships recording shortcuts that work right after install (TC-2740). Siri, Spotlight, the Shortcuts app and the Action button get **Record** ("Start recording in TinyCloud Home", "Record a note in TinyCloud Home") and **Stop Recording**; Control Center and the Lock Screen get a **Record a Voice Note** control that records without unlocking; the home-screen quick action uses the same start. Every recording shows a Live Activity with a timer and a Stop button. The test-only "TinyCloud Home probe" control and shortcut are gone.
- abe8e22: Save bot chat history encrypted in the owner's TinyCloud space, with verified model receipts and storage acknowledgments. Notify the owner in Main's chat when expired TinyCloud permission schedules local history deletion, and resume copying after reconnection. Details: TC-2808.
- 033a30f: Tiny bots, slice 1 (TC-2808), off by default. For accounts on `BOTS_TEST_ACCOUNTS` with `BOTS_ENABLED=true`, Home shows a "What do you want done?" box that sends to Main, the owner's main bot, and opens Main's chat with the reply streaming in. The backend adds `/api/bots/status` and `/api/bots/main/messages`, which forward to the new bots service (`bots/`). Everyone else sees no change.
- f8823ef: Exo is now TinyCloud Home everywhere you can see it: the web app's title, install name and sign-in, the desktop app (now `TinyCloud Home.app`), the Android and iOS app names, notifications, permission prompts and error messages. Home opens on Feed on the web, on desktop and on iOS and Android, on a fresh install and after signing in, unless you chose Apps as your first screen in Settings. Feed and Apps are no longer experimental: they are in the navigation for everyone, and Settings › Home holds the first-screen choice. App id, bundle ids, URL schemes and every data path are unchanged. Details: TC-2050, TC-2040
- 98e2480: TinyCloud Home is now TinyCloud One everywhere you can see it: the web app's title, install name and sign-in, the desktop app (now `TinyCloud One.app`; `exo-update` replaces an existing `TinyCloud Home.app`), the Android and iOS app names, widgets, Siri phrases ("Start recording in TinyCloud One"), notifications, permission prompts and error messages. The main screen is now called Feed, and Settings › Start screen holds the first-screen choice. You stay signed in: the app id, bundle ids, URL schemes, installed web app id and every data path are unchanged, and nobody has to sign in again.

### Patch Changes

- a45470c: How it works, Your data, goes back to the text it had before the paragraph about end-to-end encryption was added. Details: TC-3121.
- 609603c: On web and desktop, voice notes that aren't saved yet stay on the device for your account when you sign out, or you can delete them. Notes recorded while signed out wait until you save each one to an account.

  Details: TC-2785

- 40534a9: Home feed: a card you acknowledge or drop no longer comes back as an open row for a few seconds while the app is still saving it. It stays out of Updates until it is saved, and is then in History as Acknowledged or Dropped. If the save fails, the card comes back with the message that it didn't reach the agent.
- 8fcb036: The "Use with your agent" page (`/agents`) calls the product TinyCloud One in its title, header, intro and setup steps instead of TinyChat, and the agent-facing `setup.md` names TinyCloud One's agent-access setting in one sentence. The published skill pack, its tool names and the approval message it prints are unchanged.
- f6f65ac: Sign-in works again on Android phones with an outdated System WebView (before Chromium 130, such as the stock WebView 113 on Android 14). Those WebViews read `xyz.tinycloud.exo://openkey/callback` with an empty host, so the OpenKey SDK refused the redirect URI with "Private-use redirect URI must have a host" before sign-in started, and a stored session couldn't be restored either. `patches/` now carries a fix to `@openkey/sdk-capacitor@0.2.0-beta.0` that reads the host from the path when the WebView leaves it empty, and still rejects a hostless redirect or a callback to another host or path. The same fix is going upstream to OpenKey. When the SDK release containing it lands, remove the patch, its `patchedDependencies` entry, and the `COPY patches` line in `backend/Dockerfile`.
- 7b41d89: Android: TinyCloud Home's package is now `xyz.tinycloud.home`, the same id as the iPhone app, ahead of its first Google Play release. To Android it is a new app: an installed debug or sideloaded `xyz.tinycloud.exo` build does not update in place. Open the old build and let its pending recordings upload, then uninstall it (uninstalling deletes its local data, and both builds answer the same `xyz.tinycloud.exo://` sign-in link), install the new one and sign in again. Sign-in and Google return links are unchanged. Details: TC-2846
- f11e6ca: Feed: once the agent acknowledges your answer, a card's status reads "Answered" instead of "Waiting", until the agent reports it done or failed. A Rocinante card closed after you answered it also reads "Answered".
- 8371a8d: Feed: a Rocinante card its agent has closed (answered, replaced, done, resolved…) leaves All and Needs action and shows in History, marked as closed, like cards you dropped or that expired. A closed card that still carries an answer of yours that was never sent stays in the feed until you've seen its "Not sent" line.
- b5d30c6: Home's feed puts less code in the startup script, so the startup script is back under its size budget. The card animations' code, a post's page and the brief reader now load from their own files once the feed has shown. Cards still show at once, and they animate as before once that code has loaded.
- 3b35dd3: In the Feed's Expanded view, a card counts as seen only after at least half of it (or, for a very tall card, nearly all that fits) has stayed on screen for a second. Scrolling quickly past cards no longer marks them seen or clears their unread comments. Details: TC-3199.
- 56edd41: Home Feed on a new device opens its live-update stream once, after the first load names the agents, instead of first for the registry alone and again for the agents (two node requests fewer per new-device open). Adds a per-PR gate on how many node requests and dependent rounds a Feed open costs (warm, new device, first ready, and an idle minute with the node's stream reconnect).
- be21a74: Connecting Google on tinycloud.one now finishes on tinycloud.one: the popup and same-tab flows tag their return with `one.`/`onetab.`. tinycloud.chat and home.tinycloud.xyz tag as before.
- 522a554: Feed: an answer you gave just as you left the app is never lost silently. When you come back, the card says "Not sent" with your answer if the card has changed or closed, even if you had it open when it changed; an answer you wrote in words is shown in the line so you can say it again. If the app could not reach the server, the card says the answer isn't sent yet and it goes the next time you open the app. If the agent is no longer connected, a notice says so until you dismiss it. If you leave before you have seen any of these, they appear the next time you open the feed.
- 58a6f2a: The Feed's question card shows why now and what happens if you don't answer as two labelled cells, folds the facts behind the question ("Known so far", open on a wide card), shows the answers as buttons, one per row at every width, puts links under the brief as compact one-line chips (label, host, arrow out; a long host is cut off inside the chip), links Linear ticket numbers in the card's text, and moves the source line into Details. "Your own answer" turns into the text field in its own place instead of opening a box below. A card opens inside its row of the list instead of as a separate rounded card. An update card's first line says what moved. A folded row's second line says why the question is asked now. The Feed column is wider on a desktop screen; the phone layout is the same.
- 7e763b6: Home loads the Feed first when it opens on the Feed. The chat list refresh, the first-screen, word fixes and Canvas settings reads, the memory check, the transcriber library sync and the background chat history copy now wait until the Feed's first network load has shown (at most 3 s), so the Feed's reads no longer queue behind them at the node. Lists stored on the device still show at once, and opening Chat or any other screen releases the waiting reads immediately. Two overlapping automatic model lookups now share one request.
- 273a4cb: Home Feed loads once per open. A live-update connect, reconnect or resume no longer reloads the whole Feed: the first load waits for the live-update stream, and each later stream compares a one-request-per-database fingerprint with the last one and reloads only when something changed. A resume within 60 s makes no requests.
- 50e57be: The Home Feed refreshes in one round of requests instead of three or more. On open it reads the agent registry and every agent the device already knows at the same time, one request per database, and no longer waits for the live-update stream first: each read carries its own freshness fingerprint, so the stream's first ready compares instead of loading again. Answers, follow-ups and agent receipts come with those reads instead of one request each, in sequence. A new device reads the Feed before it creates its tables; the one-time schema batch runs after the first load.
- 9f8d98b: Home now checks every card it shows for secrets and approval links, not only the cards it writes. A card from a connected agent that carries a one-tap approval link, a key or a credential is shown without its links, options or approval button. Details: TC-3236.
- c5ed3f3: Home opens its connections to the TinyCloud node and the backend while the app bundle loads (`preconnect` and `dns-prefetch` hints for the build's configured origins), so the first request after the session restores no longer also pays DNS, TCP and TLS.
- 2bfd082: Opening Home no longer runs schema checks or table creation in front of its first reads. The chat list and settings read at once on a new device; only a read that finds its table missing creates the tables and reads again, and the full schema check runs in the background after the open's reads. Voice-note setup (its two schema statements and definition check) runs once per account and schema version on each device, after the open's reads when there is nothing to save, instead of on every open; later opens only sweep archived duplicates in the background.
- 77dab54: The phone apps keep the app-lock settings, the record of being signed in and a pending sign-out in the device's app storage as well as the WebView's, so they survive a change of the app's WebView origin. A session restored when the app opens now locks like any cold launch when the app lock is on, including when the app opened without its record of being signed in. Details: TC-3045.
- 85e83ce: The iOS and Android apps no longer link to or open a purchase page (App Store 3.1.1, Google Play Payments). Manage storage, Upgrade, Manage plan, the pricing dialog and the usage chip's plans link are gone there. Storage-full surfaces keep Save now and Transcribe again, and say "Manage your plan on the web at tinycloud.xyz." as plain text. The TinyCloud panel's storage link and its storage-full toast link are hidden too. Web and desktop are unchanged.
- f8b488c: The iOS and Android apps get a native local store for your TinyCloud data: an encrypted SQLite copy kept outside the web view, with one file and one device-only key per account. Nothing uses it yet (it is switched off until the TinyCloud SDK can read from it), and signing out deletes that account's copy and its key. Details: TC-2862
- 97dbe56: iOS and Android: a returning user's Feed no longer waits for the TinyCloud node to re-activate a delegation it already holds (TC-2865). Once a launch has seen the node accept the current delegation, later launches still send `/delegate`, but in the background. On the iOS simulator, the time to the first Feed card dropped from about 3.0 s to about 0.6 s. If a background activation fails, the next launch waits for activation again and shows its error. Sign-in and renewal still wait for activation.
- 8974164: In Needs you, an open card at urgency 4 or higher now sits above every other card, whatever its pin, deadline, production flag, unblock weight or whether it waits on someone else; urgent cards are ordered by urgency times importance. A card below urgency 4 keeps its place. The reason line for an urgent card reads "urgent: U4·I3".
- e667585: TinyCloud Home and the backend treat `https://node.tinycloud.xyz` and `https://tee.node.tinycloud.xyz` as the same TinyCloud node. Stored backend grants, bot history receipts, native delegations and agent CLI profiles on either name keep working when the default node name changes. The reviewer seed and the TinyChat retrieval skill (now 0.1.1-onboarding.26) default to `https://node.tinycloud.xyz`. Production still runs on `https://tee.node.tinycloud.xyz`; nothing changes for users.

  Details: TC-2923

- 7e4a103: On tinycloud.chat, Home answers still waiting to be sent, answers marked "Not sent" that you have not seen yet, and post answers you have not sent now keep the tab there (with a notice saying why) instead of being left behind by the move to home.tinycloud.xyz; each stops holding 7 days after it was written. When the tab moves, what is left of them on tinycloud.chat is removed.
- 87f3e3f: The minimised recorder bar on the phone and in the browser is back to how it was before TC-2077: the timer, the moving level bars, the stop time under them, and the larger Pause and Stop. The small bar with "Stops in" and the stop time on hover stays on the desktop: the sidebar dock and the Mac app's floating bar. Details: TC-2077
- 17f9687: TC-3166: "Delete my recordings first" (the bulk `DELETE /api/transcriber/meetings`) now also deletes the account's private cloud transcription jobs, so voice notes and uploads left behind by a failed or cancelled run are cleared on account deletion. Queued or running jobs are cancelled, transcripts are deleted, and the call only succeeds once TinyCloud Private Transcription's own list for the account is empty; otherwise it is a 503 and safe to retry. The response gains `privateCloudDeleted` (a count, or `null` when private cloud transcription is not used), which the step requires, so an older backend can never produce a "deleted" claim for voice notes and uploads; with `null` the step says nothing about them. The bulk delete is also mounted when private cloud transcription is on and the meeting transcriber is off. A new `GET /api/transcriber/meetings/scope` (config only) tells the step whether the deployment keeps private cloud jobs, so its intro and failure line name voice notes and uploads only where they are kept; the step waits for it before showing anything.
- 7b5db01: TC-3136: removing a notetaker recording now deletes the capture provider's copy (audio, video, transcript and derived artifacts) and only counts it as gone after reading it back not-found. A delete that cannot be confirmed yet stays listed as "deleting" and is retried with backoff, never dropped. Settings → Account gains "Delete my recordings first", a bulk `DELETE /api/transcriber/meetings`, ahead of deleting the OpenKey account. A recording shared with you is only removed from your list. A recording the notetaker service cannot attribute to you is removed from your list but not deleted there, and says so on its row.
- ae08fc0: Streamed replies from confidential models now show an "Enclave verified" mark once the gateway's signed receipt checks out, or a note if it can't be confirmed. Details: TC-2196
- e4c47d6: The reviewer seed CLI no longer defaults to the production node: pass `--host <origin>`, or `--production` for `https://tee.node.tinycloud.xyz`. Neither, or both, is a usage error.
- 47e3ecf: Reviewer seed: check the grant's signed UCAN payload against the request before use, match resumed chat messages by their ids, and state the requested KV scope exactly.
- faad27f: Add a reviewer seed CLI (`frontend/scripts/reviewer-seed`) that fills one fresh, explicitly confirmed TinyCloud Home space with fixed demo Feed cards, a chat and a transcript-only voice note through Home's own write paths, using only a short delegation the space owner grants to the run.
- 38f26f3: An approval card may carry two optional fields: `redeemedAt` (when its grant was used) and `grantLifetime` (how long the access lasts: a whole number of hours or days, up to 30 days). Cards carrying them are now read, imported and archived instead of refused, and the card shows "Used …" and "Access lasts …".
- 38f26f3: A sitrep card may carry an optional `post`: one line of up to 280 characters, for a card to lead with. Cards with a `post` are now read, imported and archived; a `post` that is empty, over 280 characters or contains a control character other than a newline is refused.
- 94fbf3b: TinyCloud Home starts with less JavaScript. The startup script drops from 10.1 MB to 7.4 MB. The TinyCloud SDK's WebAssembly is now a separate file in the app bundle, fetched while the page loads, instead of 1.9 MB of base64 decoded at startup. Chat, Recording, Connectors, Apps, Settings and How it works load from their own files once Feed is up. The web app precaches everything an offline launch needs, and the desktop and phone apps load it all from the app bundle. An installed web app opened offline loads again: since the desktop quit guard (October), the startup script imported a desktop-only file the offline cache leaves out, so the page stayed blank. One copy of `@tinycloud/replica` (0.4.4, the SDK's) is installed instead of two. CI fails a build whose startup script goes over 7.6 MB or inlines WebAssembly again. Details: TC-2882
- f4853a8: Add an explicit exact-email transcript share action to note detail, with read-only immutable encrypted snapshots, SDK-valid note-title filenames capped at 128 UTF-8 bytes with a nonempty fallback, and no audio inclusion.

  Adopt the published TinyCloud Web, Node, Core and Services SDKs at 3.11.0 (Share SDK 1.4.4 and Share Envelope 1.5.0, as pinned by those releases) for exact Share-key runtime consent, and remove the obsolete local NodeSDK sign-in patch now included upstream.

  Keep transcript-share dialogs open through same-owner, same-session runtime-grant refreshes. Reject stale account/content completions and surface interrupted shares without exposing the prior recipient or link. Treat an OpenKey cancellation of exact-key consent as a cancelled share.

  Discard underlying SDK errors at the transcript-share boundary so diagnostic cause chains contain only the sanitized failure message.

  Freeze speaker aliases in the shared copy using the transcript's existing display, Copy and export mapping. Reject semantic alias changes during sharing, including unused labels, and validate the same projection against persisted metadata without rewriting stored sentences.

  Details: TC-2192

- 749f7bf: Keep TinyCloud permission prompts accessible while Main's chat is open, then restore chat focus without losing the draft. Details: TC-2835.
- 4143792: Remove the transcript-share action from note detail. Transcript sharing returns through the TC-2525 SDK adoption.

  Details: TC-2845, TC-2192

- a4ab606: Adopt the published SDK graph and support browser restore with explicit owner-signed renewal leases. Details: TC-2872
- e84dd3b: Allow first-use bot history approval with fresh SDK session snapshots while refusing owner or session-key changes. Details: TC-2895.
- c0aaaea: The startup bundle no longer carries a Node crypto library the browser never runs: about 435 KB less to download and parse on every launch. Details: TC-2935.
- a6240ab: Home's top bar, rebuilt: Needs you · All · History with a Filter icon. Needs you opens its first card, the rest are rows by urgency, and an answered card makes way for the next. All shows Needs you, Updates and Done today. The chat box shows only when Main's chat works, Filter lists its dropdowns first, answered cards that are waiting or done wait in one Pending card at the end, and the Agents pill opens each agent's page. Details: TC-2941.
- b599417: Feed: every open card shows what it doesn't draw. "Details" in the card's foot carries a "+N" when the card holds data the card doesn't show. Details now unfolds inside the card and lists those fields under "Not shown on the card", exactly as the agent sent them (as text: links aren't opened and images aren't loaded), along with the card's facts, its history, and the whole card as sent ("Card data", with Copy). A Rocinante card the app can't read now points to Details, which lists everything it carries, instead of only "Ask your agent about this card."
- 931849e: Feed: a Rocinante card's timing line reads "Due 13 Nov, 6:00 PM · Expires 14 Nov, 2:48 PM · in 2 h" instead of "Deadline …" and "Legacy expiry …"; a card that never expires no longer says "No automatic expiry".
- 092bbfc: Feed: on a Rocinante question, "Drop this card" now tells Rocinante to drop it (the same answer "Skip this question" sent), then the card moves to History marked Dropped. "Skip this question" is removed, so one control does it. Before, Drop only hid the card here and Rocinante never heard.
- df99598: When Main's earlier messages fail to load, the browser console now records why. The chat still shows the same failure message. Details: TC-3019.
- fae976b: A restored session never sets up a TinyCloud account, whatever page it runs on. Details: TC-3019.
- 1160a72: After a page reload, opening Main's chat no longer fails with "Couldn't load your earlier messages with Main." It asks for the same approval as a new session, then loads the earlier messages. The transcript writer also renews again after a reload. Details: TC-3019.
- 487602b: Main's earlier messages load faster: the app fetches and decrypts up to four of them at a time instead of one after another. Every check on each message is unchanged, and the first failure still stops the whole load. Details: TC-3054.
- 31c1323: tinycloud.chat notice: one recording that belongs to another account now reads "…Sign in to that account here to save it." The Library's "Audio only in this browser" filter, when empty, says "No recordings have audio only in this browser." Details: TC-2050
- b557fb0: tinycloud.chat: the notice on a tab kept there says why, one line per reason (audio only in this browser, recordings in no account yet, another account's recordings), and each count links to where to deal with them. Several recordings with audio only in this browser open the Library's new "Audio only in this browser" filter. Details: TC-2050
- 0dd3bf2: Shorten connector consent screens and remove obsolete consent checkboxes.
- 451ae7e: Native sign-in on iOS and Android asks for every applications-space KV, SQL and hook entry of the manifest, the same grant as the web sign-in, so the Home feed works on the phone apps (TC-2720). Space info stays web-only until the backend accepts it. A CI job checks the native request against production OpenKey's ceiling.
- 8a1d52e: Wait for restored private-agent access to settle before routing the first chat send.
- ee74379: Playback diagnostics (TC-2857): an opt-in, on-device log of how a note's audio plays, for diagnosing choppy playback. Off by default; Settings reveals it after seven taps on the build line. It records the iOS audio session (category, mode, route, interruptions, thermal state, Low Power Mode), the note player's events and its clock against the wall clock, the audio source type and size, and main-thread blocks during playback, and exports as JSON lines with Share or Copy. No note content or file path is recorded.
- 0cb46eb: The TinyChat retrieval skill (now 0.1.1-onboarding.27) and the reviewer seed default to `https://tee.node.tinycloud.xyz` again, pending the node-host privacy decision. A CLI profile on `https://node.tinycloud.xyz` still works.

  Details: TC-2923

- 631a8bb: iOS: ship the app as TinyCloud Home with bundle ID `xyz.tinycloud.home` (dev `xyz.tinycloud.home.dev`) under the TinyCloud, Inc. team (TC-518).
- 9d13c13: How it works now says that your TinyCloud space is not end-to-end encrypted: the node that hosts it, and the apps and services you authorize, can read your content in order to serve it to you. Ending an app's or agent's access stops future reads; it cannot recall copies already read.
- 761a6ba: The web build includes connector secret permissions and the decrypt permission at sign-in for devices that have used Connectors. First use requests access through OpenKey in place. Remove the unused custom AssemblyAI key permission from the manifest.
- f53e7c8: Home in a desktop Chromium browser opens to the Feed again without waiting about a second and a half for the node. Production web builds no longer bind the local copy of transcripts at sign-in or session restore, because web-sdk 3.11.2 holds the restore until that bind and the node's `/info` answer (TC-2773 removes the wait in web-sdk 3.12). A copy already on the device is kept, not deleted; signing out still erases it. The switch for the local copy is hidden while binding is paused. Details: TC-2883

## 0.14.0-beta.79

### Patch Changes

- 9f8d98b: Home now checks every card it shows for secrets and approval links, not only the cards it writes. A card from a connected agent that carries a one-tap approval link, a key or a credential is shown without its links, options or approval button. Details: TC-3236.

## 0.14.0-beta.78

### Minor Changes

- acbf475: tinycloud.one is the canonical address. Visitors on tinycloud.chat or home.tinycloud.xyz move to tinycloud.one once nothing is left only in their browser; anyone with recordings or answers still on the old address stays there, with a notice, until they are saved or sent. Opening the old address with `?legacy=1` keeps the app there so that data can be saved. Each release now checks that all three addresses serve it. Details: TC-3108.

  Settings for this device (theme, notes view, capture preferences and consents) are kept separately for each address, so they start fresh on tinycloud.one. Settings on tinycloud.one links to the old addresses for anything left there. A page with unsaved text, an unsaved title or an answer that can still be undone stays where it is until that's done.

## 0.14.0-beta.77

### Patch Changes

- 3b35dd3: In the Feed's Expanded view, a card counts as seen only after at least half of it (or, for a very tall card, nearly all that fits) has stayed on screen for a second. Scrolling quickly past cards no longer marks them seen or clears their unread comments. Details: TC-3199.

## 0.14.0-beta.76

### Patch Changes

- 17f9687: TC-3166: "Delete my recordings first" (the bulk `DELETE /api/transcriber/meetings`) now also deletes the account's private cloud transcription jobs, so voice notes and uploads left behind by a failed or cancelled run are cleared on account deletion. Queued or running jobs are cancelled, transcripts are deleted, and the call only succeeds once TinyCloud Private Transcription's own list for the account is empty; otherwise it is a 503 and safe to retry. The response gains `privateCloudDeleted` (a count, or `null` when private cloud transcription is not used), which the step requires, so an older backend can never produce a "deleted" claim for voice notes and uploads; with `null` the step says nothing about them. The bulk delete is also mounted when private cloud transcription is on and the meeting transcriber is off. A new `GET /api/transcriber/meetings/scope` (config only) tells the step whether the deployment keeps private cloud jobs, so its intro and failure line name voice notes and uploads only where they are kept; the step waits for it before showing anything.

## 0.14.0-beta.75

### Minor Changes

- 73a32e0: The Feed's Filter panel has a View switch: Compact (the rows the Feed has always had, still the default), Expanded (every card open in full, one after another), and Cards (tiles). The choice is kept on this device. Details: TC-3199.

## 0.14.0-beta.74

### Patch Changes

- 7b5db01: TC-3136: removing a notetaker recording now deletes the capture provider's copy (audio, video, transcript and derived artifacts) and only counts it as gone after reading it back not-found. A delete that cannot be confirmed yet stays listed as "deleting" and is retried with backoff, never dropped. Settings → Account gains "Delete my recordings first", a bulk `DELETE /api/transcriber/meetings`, ahead of deleting the OpenKey account. A recording shared with you is only removed from your list. A recording the notetaker service cannot attribute to you is removed from your list but not deleted there, and says so on its row.

## 0.14.0-beta.73

### Patch Changes

- 38f26f3: An approval card may carry two optional fields: `redeemedAt` (when its grant was used) and `grantLifetime` (how long the access lasts: a whole number of hours or days, up to 30 days). Cards carrying them are now read, imported and archived instead of refused, and the card shows "Used …" and "Access lasts …".
- 38f26f3: A sitrep card may carry an optional `post`: one line of up to 280 characters, for a card to lead with. Cards with a `post` are now read, imported and archived; a `post` that is empty, over 280 characters or contains a control character other than a newline is refused.

## 0.14.0-beta.72

### Minor Changes

- 4fb80fa: Home no longer shows the "What do you want done?" box or the Agents pill by default. Settings has a new "Show hidden features" switch (off by default, this device only) that brings them back. Details: TC-3119.

## 0.14.0-beta.71

### Patch Changes

- 58a6f2a: The Feed's question card shows why now and what happens if you don't answer as two labelled cells, folds the facts behind the question ("Known so far", open on a wide card), shows the answers as buttons, one per row at every width, puts links under the brief as compact one-line chips (label, host, arrow out; a long host is cut off inside the chip), links Linear ticket numbers in the card's text, and moves the source line into Details. "Your own answer" turns into the text field in its own place instead of opening a box below. A card opens inside its row of the list instead of as a separate rounded card. An update card's first line says what moved. A folded row's second line says why the question is asked now. The Feed column is wider on a desktop screen; the phone layout is the same.
- 8974164: In Needs you, an open card at urgency 4 or higher now sits above every other card, whatever its pin, deadline, production flag, unblock weight or whether it waits on someone else; urgent cards are ordered by urgency times importance. A card below urgency 4 keeps its place. The reason line for an urgent card reads "urgent: U4·I3".

## 0.14.0-beta.70

### Patch Changes

- 8fcb036: The "Use with your agent" page (`/agents`) calls the product TinyCloud One in its title, header, intro and setup steps instead of TinyChat, and the agent-facing `setup.md` names TinyCloud One's agent-access setting in one sentence. The published skill pack, its tool names and the approval message it prints are unchanged.

## 0.14.0-beta.69

### Patch Changes

- a45470c: How it works, Your data, goes back to the text it had before the paragraph about end-to-end encryption was added. Details: TC-3121.

## 0.14.0-beta.68

### Patch Changes

- 9d13c13: How it works now says that your TinyCloud space is not end-to-end encrypted: the node that hosts it, and the apps and services you authorize, can read your content in order to serve it to you. Ending an app's or agent's access stops future reads; it cannot recall copies already read.

## 0.14.0-beta.67

### Patch Changes

- 7e4a103: On tinycloud.chat, Home answers still waiting to be sent, answers marked "Not sent" that you have not seen yet, and post answers you have not sent now keep the tab there (with a notice saying why) instead of being left behind by the move to home.tinycloud.xyz; each stops holding 7 days after it was written. When the tab moves, what is left of them on tinycloud.chat is removed.

## 0.14.0-beta.66

### Patch Changes

- 522a554: Feed: an answer you gave just as you left the app is never lost silently. When you come back, the card says "Not sent" with your answer if the card has changed or closed, even if you had it open when it changed; an answer you wrote in words is shown in the line so you can say it again. If the app could not reach the server, the card says the answer isn't sent yet and it goes the next time you open the app. If the agent is no longer connected, a notice says so until you dismiss it. If you leave before you have seen any of these, they appear the next time you open the feed.

## 0.14.0-beta.65

### Patch Changes

- 487602b: Main's earlier messages load faster: the app fetches and decrypts up to four of them at a time instead of one after another. Every check on each message is unchanged, and the first failure still stops the whole load. Details: TC-3054.

## 0.14.0-beta.64

### Minor Changes

- 98e2480: TinyCloud Home is now TinyCloud One everywhere you can see it: the web app's title, install name and sign-in, the desktop app (now `TinyCloud One.app`; `exo-update` replaces an existing `TinyCloud Home.app`), the Android and iOS app names, widgets, Siri phrases ("Start recording in TinyCloud One"), notifications, permission prompts and error messages. The main screen is now called Feed, and Settings › Start screen holds the first-screen choice. You stay signed in: the app id, bundle ids, URL schemes, installed web app id and every data path are unchanged, and nobody has to sign in again.

## 0.14.0-beta.63

### Patch Changes

- 77dab54: The phone apps keep the app-lock settings, the record of being signed in and a pending sign-out in the device's app storage as well as the WebView's, so they survive a change of the app's WebView origin. A session restored when the app opens now locks like any cold launch when the app lock is on, including when the app opened without its record of being signed in. Details: TC-3045.

## 0.14.0-beta.62

### Patch Changes

- fae976b: A restored session never sets up a TinyCloud account, whatever page it runs on. Details: TC-3019.

## 0.14.0-beta.61

### Patch Changes

- 40534a9: Home feed: a card you acknowledge or drop no longer comes back as an open row for a few seconds while the app is still saving it. It stays out of Updates until it is saved, and is then in History as Acknowledged or Dropped. If the save fails, the card comes back with the message that it didn't reach the agent.

## 0.14.0-beta.60

### Patch Changes

- 1160a72: After a page reload, opening Main's chat no longer fails with "Couldn't load your earlier messages with Main." It asks for the same approval as a new session, then loads the earlier messages. The transcript writer also renews again after a reload. Details: TC-3019.

## 0.14.0-beta.59

### Patch Changes

- c0aaaea: The startup bundle no longer carries a Node crypto library the browser never runs: about 435 KB less to download and parse on every launch. Details: TC-2935.

## 0.14.0-beta.58

### Patch Changes

- 092bbfc: Feed: on a Rocinante question, "Drop this card" now tells Rocinante to drop it (the same answer "Skip this question" sent), then the card moves to History marked Dropped. "Skip this question" is removed, so one control does it. Before, Drop only hid the card here and Rocinante never heard.

## 0.14.0-beta.57

### Patch Changes

- 931849e: Feed: a Rocinante card's timing line reads "Due 13 Nov, 6:00 PM · Expires 14 Nov, 2:48 PM · in 2 h" instead of "Deadline …" and "Legacy expiry …"; a card that never expires no longer says "No automatic expiry".

## 0.14.0-beta.56

### Patch Changes

- 8371a8d: Feed: a Rocinante card its agent has closed (answered, replaced, done, resolved…) leaves All and Needs action and shows in History, marked as closed, like cards you dropped or that expired. A closed card that still carries an answer of yours that was never sent stays in the feed until you've seen its "Not sent" line.

## 0.14.0-beta.55

### Patch Changes

- b599417: Feed: every open card shows what it doesn't draw. "Details" in the card's foot carries a "+N" when the card holds data the card doesn't show. Details now unfolds inside the card and lists those fields under "Not shown on the card", exactly as the agent sent them (as text: links aren't opened and images aren't loaded), along with the card's facts, its history, and the whole card as sent ("Card data", with Copy). A Rocinante card the app can't read now points to Details, which lists everything it carries, instead of only "Ask your agent about this card."

## 0.14.0-beta.54

### Patch Changes

- f11e6ca: Home feed: once the agent acknowledges your answer, a card's status reads "Answered" instead of "Waiting", until the agent reports it done or failed. A Rocinante card closed after you answered it also reads "Answered".

## 0.14.0-beta.53

### Patch Changes

- df99598: When Main's earlier messages fail to load, the browser console now records why. The chat still shows the same failure message. Details: TC-3019.

## 0.14.0-beta.52

### Patch Changes

- a6240ab: Home's top bar, rebuilt: Needs you · All · History with a Filter icon. Needs you opens its first card, the rest are rows by urgency, and an answered card makes way for the next. All shows Needs you, Updates and Done today. The chat box shows only when Main's chat works, Filter lists its dropdowns first, answered cards that are waiting or done wait in one Pending card at the end, and the Agents pill opens each agent's page. Details: TC-2941.

## 0.14.0-beta.51

### Patch Changes

- a4ab606: Adopt the published SDK graph and support browser restore with explicit owner-signed renewal leases. Details: TC-2872

## 0.14.0-beta.50

### Patch Changes

- e4c47d6: The reviewer seed CLI no longer defaults to the production node: pass `--host <origin>`, or `--production` for `https://tee.node.tinycloud.xyz`. Neither, or both, is a usage error.

## 0.14.0-beta.49

### Patch Changes

- be21a74: Connecting Google on tinycloud.one now finishes on tinycloud.one: the popup and same-tab flows tag their return with `one.`/`onetab.`. tinycloud.chat and home.tinycloud.xyz tag as before.

## 0.14.0-beta.48

### Patch Changes

- 0cb46eb: The TinyChat retrieval skill (now 0.1.1-onboarding.27) and the reviewer seed default to `https://tee.node.tinycloud.xyz` again, pending the node-host privacy decision. A CLI profile on `https://node.tinycloud.xyz` still works.

  Details: TC-2923

## 0.14.0-beta.47

### Patch Changes

- e667585: TinyCloud Home and the backend treat `https://node.tinycloud.xyz` and `https://tee.node.tinycloud.xyz` as the same TinyCloud node. Stored backend grants, bot history receipts, native delegations and agent CLI profiles on either name keep working when the default node name changes. The reviewer seed and the TinyChat retrieval skill (now 0.1.1-onboarding.26) default to `https://node.tinycloud.xyz`. Production still runs on `https://tee.node.tinycloud.xyz`; nothing changes for users.

  Details: TC-2923

## 0.14.0-beta.46

### Patch Changes

- f6f65ac: Sign-in works again on Android phones with an outdated System WebView (before Chromium 130, such as the stock WebView 113 on Android 14). Those WebViews read `xyz.tinycloud.exo://openkey/callback` with an empty host, so the OpenKey SDK refused the redirect URI with "Private-use redirect URI must have a host" before sign-in started, and a stored session couldn't be restored either. `patches/` now carries a fix to `@openkey/sdk-capacitor@0.2.0-beta.0` that reads the host from the path when the WebView leaves it empty, and still rejects a hostless redirect or a callback to another host or path. The same fix is going upstream to OpenKey. When the SDK release containing it lands, remove the patch, its `patchedDependencies` entry, and the `COPY patches` line in `backend/Dockerfile`.
- 56edd41: Home Feed on a new device opens its live-update stream once, after the first load names the agents, instead of first for the registry alone and again for the agents (two node requests fewer per new-device open). Adds a per-PR gate on how many node requests and dependent rounds a Feed open costs (warm, new device, first ready, and an idle minute with the node's stream reconnect).

## 0.14.0-beta.45

### Patch Changes

- c5ed3f3: Home opens its connections to the TinyCloud node and the backend while the app bundle loads (`preconnect` and `dns-prefetch` hints for the build's configured origins), so the first request after the session restores no longer also pays DNS, TCP and TLS.

## 0.14.0-beta.44

### Patch Changes

- b5d30c6: Home's feed puts less code in the startup script, so the startup script is back under its size budget. The card animations' code, a post's page and the brief reader now load from their own files once the feed has shown. Cards still show at once, and they animate as before once that code has loaded.

## 0.14.0-beta.43

### Patch Changes

- 749f7bf: Keep TinyCloud permission prompts accessible while Main's chat is open, then restore chat focus without losing the draft. Details: TC-2835.

## 0.14.0-beta.42

### Minor Changes

- fc1ba3e: Home Feed gets the new card design.
  - **Views:** an Information | All | Needs action slider stays in reach as you scroll. "View" shows cards Compact (the default), as Full cards, or as a Grid, and keeps your place when you switch. History, Snoozed, priority and order sit under Filter.
  - **Compact cards:** each shows the agent, a relative time, where the card stands, a P0/P1 priority mark, when it's due, and how many times the agent replied.
  - **Open cards:** a card can carry a one-page brief that opens in the app. Comments read as a conversation. A comment shows "Received" only once the agent confirms it, and offers "Send again" if it isn't confirmed within two minutes.
  - **5 s Undo on every send:** that covers answers, comments, approvals, codes, and claim and task actions. A go-ahead is checked again before it's sent, and an approval that expired or closed in the meantime sends nothing.
  - **Card actions:** a decision can be dropped and an update acknowledged; either can be brought back later. Each takes the card away at once with Undo at the bottom of the screen, then tells the agent, and the card moves to History, marked Dropped or Acknowledged. Cards past their expiry move there too, marked Expired.
  - **Posts:** a post opens as a page with media and questions. Answers go to the agent per question, and unsent answers stay on the device.

## 0.14.0-beta.41

### Patch Changes

- 94fbf3b: TinyCloud Home starts with less JavaScript. The startup script drops from 10.1 MB to 7.4 MB. The TinyCloud SDK's WebAssembly is now a separate file in the app bundle, fetched while the page loads, instead of 1.9 MB of base64 decoded at startup. Chat, Recording, Connectors, Apps, Settings and How it works load from their own files once Feed is up. The web app precaches everything an offline launch needs, and the desktop and phone apps load it all from the app bundle. An installed web app opened offline loads again: since the desktop quit guard (October), the startup script imported a desktop-only file the offline cache leaves out, so the page stayed blank. One copy of `@tinycloud/replica` (0.4.4, the SDK's) is installed instead of two. CI fails a build whose startup script goes over 7.6 MB or inlines WebAssembly again. Details: TC-2882

## 0.14.0-beta.40

### Patch Changes

- 7e763b6: Home loads the Feed first when it opens on the Feed. The chat list refresh, the first-screen, word fixes and Canvas settings reads, the memory check, the transcriber library sync and the background chat history copy now wait until the Feed's first network load has shown (at most 3 s), so the Feed's reads no longer queue behind them at the node. Lists stored on the device still show at once, and opening Chat or any other screen releases the waiting reads immediately. Two overlapping automatic model lookups now share one request.

## 0.14.0-beta.39

### Patch Changes

- e84dd3b: Allow first-use bot history approval with fresh SDK session snapshots while refusing owner or session-key changes. Details: TC-2895.

## 0.14.0-beta.38

### Patch Changes

- 2bfd082: Opening Home no longer runs schema checks or table creation in front of its first reads. The chat list and settings read at once on a new device; only a read that finds its table missing creates the tables and reads again, and the full schema check runs in the background after the open's reads. Voice-note setup (its two schema statements and definition check) runs once per account and schema version on each device, after the open's reads when there is nothing to save, instead of on every open; later opens only sweep archived duplicates in the background.

## 0.14.0-beta.37

### Patch Changes

- 50e57be: The Home Feed refreshes in one round of requests instead of three or more. On open it reads the agent registry and every agent the device already knows at the same time, one request per database, and no longer waits for the live-update stream first: each read carries its own freshness fingerprint, so the stream's first ready compares instead of loading again. Answers, follow-ups and agent receipts come with those reads instead of one request each, in sequence. A new device reads the Feed before it creates its tables; the one-time schema batch runs after the first load.

## 0.14.0-beta.36

### Patch Changes

- ee74379: Playback diagnostics (TC-2857): an opt-in, on-device log of how a note's audio plays, for diagnosing choppy playback. Off by default; Settings reveals it after seven taps on the build line. It records the iOS audio session (category, mode, route, interruptions, thermal state, Low Power Mode), the note player's events and its clock against the wall clock, the audio source type and size, and main-thread blocks during playback, and exports as JSON lines with Share or Copy. No note content or file path is recorded.

## 0.14.0-beta.35

### Patch Changes

- f53e7c8: Home in a desktop Chromium browser opens to the Feed again without waiting about a second and a half for the node. Production web builds no longer bind the local copy of transcripts at sign-in or session restore, because web-sdk 3.11.2 holds the restore until that bind and the node's `/info` answer (TC-2773 removes the wait in web-sdk 3.12). A copy already on the device is kept, not deleted; signing out still erases it. The switch for the local copy is hidden while binding is paused. Details: TC-2883

## 0.14.0-beta.34

### Patch Changes

- f8b488c: The iOS and Android apps get a native local store for your TinyCloud data: an encrypted SQLite copy kept outside the web view, with one file and one device-only key per account. Nothing uses it yet (it is switched off until the TinyCloud SDK can read from it), and signing out deletes that account's copy and its key. Details: TC-2862

## 0.14.0-beta.33

### Patch Changes

- 273a4cb: Home Feed loads once per open. A live-update connect, reconnect or resume no longer reloads the whole Feed: the first load waits for the live-update stream, and each later stream compares a one-request-per-database fingerprint with the last one and reloads only when something changed. A resume within 60 s makes no requests.

## 0.14.0-beta.32

### Patch Changes

- 87f3e3f: The minimised recorder bar on the phone and in the browser is back to how it was before TC-2077: the timer, the moving level bars, the stop time under them, and the larger Pause and Stop. The small bar with "Stops in" and the stop time on hover stays on the desktop: the sidebar dock and the Mac app's floating bar. Details: TC-2077

## 0.14.0-beta.31

### Patch Changes

- 97dbe56: iOS and Android: a returning user's Feed no longer waits for the TinyCloud node to re-activate a delegation it already holds (TC-2865). Once a launch has seen the node accept the current delegation, later launches still send `/delegate`, but in the background. On the iOS simulator, the time to the first Feed card dropped from about 3.0 s to about 0.6 s. If a background activation fails, the next launch waits for activation again and shows its error. Sign-in and renewal still wait for activation.

## 0.14.0-beta.30

### Patch Changes

- 85e83ce: The iOS and Android apps no longer link to or open a purchase page (App Store 3.1.1, Google Play Payments). Manage storage, Upgrade, Manage plan, the pricing dialog and the usage chip's plans link are gone there. Storage-full surfaces keep Save now and Transcribe again, and say "Manage your plan on the web at tinycloud.xyz." as plain text. The TinyCloud panel's storage link and its storage-full toast link are hidden too. Web and desktop are unchanged.

## 0.14.0-beta.29

### Minor Changes

- cf05789: The app links TinyCloud's privacy policy, `https://tinycloud.xyz/privacy` (TC-2876, App Store 5.1.1(i), Play User Data policy). The link appears in Settings → Account (signed in, and the signed-out phone Settings) and in How it works → Your data. It opens in the in-app browser on iOS and Android, in the system browser on desktop (a fixed-URL Tauri command), and in a new tab on the web.

  The iOS privacy manifest now also declares Name, Purchase History, Product Interaction and Performance Data, to match the App Store privacy answers. The HealthKit purpose strings are now added to Debug builds only, and `ios-build.yml` fails a Release archive that has them.

## 0.14.0-beta.28

### Minor Changes

- 4b2a0e3: Home's feed is now a list of cards. Every card shows at once, grouped under "Needs you" and "Earlier", with Needs you, All and Done above them and a filter for agent, project and type. A question answers with one tap on an option, or in your own words. The answer waits 5 seconds with an Undo button, then it's sent. Close the page during those 5 seconds and the answer is still sent, at once or the next time you open Home, unless the request changed in between. Comments sit under each card, one reply deep, as on the sitrep board, and an agent's replies show there too. The private note is gone from the card. Cards use plain words throughout. Empty and loading states are cards, and the signed-out demo uses the same card.

## 0.14.0-beta.27

### Minor Changes

- abe8e22: Save bot chat history encrypted in the owner's TinyCloud space, with verified model receipts and storage acknowledgments. Notify the owner in Main's chat when expired TinyCloud permission schedules local history deletion, and resume copying after reconnection. Details: TC-2808.

## 0.14.0-beta.26

### Patch Changes

- 31c1323: tinycloud.chat notice: one recording that belongs to another account now reads "…Sign in to that account here to save it." The Library's "Audio only in this browser" filter, when empty, says "No recordings have audio only in this browser." Details: TC-2050

## 0.14.0-beta.25

### Patch Changes

- b557fb0: tinycloud.chat: the notice on a tab kept there says why, one line per reason (audio only in this browser, recordings in no account yet, another account's recordings), and each count links to where to deal with them. Several recordings with audio only in this browser open the Library's new "Audio only in this browser" filter. Details: TC-2050

## 0.14.0-beta.24

### Minor Changes

- 20598f6: One TinyCloud Home: home.tinycloud.xyz, tinycloud.chat, the desktop app and the mobile apps now run the same build. The `VITE_HOME_SITE` build flag, its separate production upload job and the Home-only sign-in grant (`manifest.home.json`) are gone.
  - Every platform opens on Feed, named Home, with the tabs Home, Chat, Apps, Recording and Connectors in that order. Signed out on the web you see the Home front page with its demo feed, and the install prompt waits until you have signed in.
  - Every web build signs in with `manifest.json`'s storage, without the connector secrets or the decrypt grant until this device has used Connectors. Opening Connectors the first time asks OpenKey for them in place, once. Recording no longer asks for its own permission, and Local copy, Agent access, Conversation Canvas and every Settings section are available on home.tinycloud.xyz too. If you signed in on home.tinycloud.xyz under the narrower Home grant, you sign in once more. The desktop and mobile apps sign in as before.
  - tinycloud.chat moves you to home.tinycloud.xyz with the same path, query and `#` link. If this browser still holds recordings that are only saved on tinycloud.chat, you stay there with a notice and move automatically once they are saved.

  Details: TC-2050

## 0.14.0-beta.23

### Patch Changes

- 7b41d89: Android: TinyCloud Home's package is now `xyz.tinycloud.home`, the same id as the iPhone app, ahead of its first Google Play release. To Android it is a new app: an installed debug or sideloaded `xyz.tinycloud.exo` build does not update in place. Open the old build and let its pending recordings upload, then uninstall it (uninstalling deletes its local data, and both builds answer the same `xyz.tinycloud.exo://` sign-in link), install the new one and sign in again. Sign-in and Google return links are unchanged. Details: TC-2846

## 0.14.0-beta.22

### Patch Changes

- 4143792: Remove the transcript-share action from note detail. Transcript sharing returns through the TC-2525 SDK adoption.

  Details: TC-2845, TC-2192

## 0.14.0-beta.21

### Minor Changes

- e5f9e06: Share links you open or create are now kept in your TinyCloud space (`xyz.tinycloud.tinychat/threads/shared-with-me/`, inside the existing `threads/` grant), so they follow your account to other devices and to the new Home address (TC-2830). The browser keeps only a per-account copy, which is cleared at sign-out. The first account to sign in on a browser takes over that browser's old list, once. A link opened while signed out is saved only if you then sign in on that same page.

## 0.14.0-beta.20

### Patch Changes

- f4853a8: Add an explicit exact-email transcript share action to note detail, with read-only immutable encrypted snapshots, SDK-valid note-title filenames capped at 128 UTF-8 bytes with a nonempty fallback, and no audio inclusion.

  Adopt the published TinyCloud Web, Node, Core and Services SDKs at 3.11.0 (Share SDK 1.4.4 and Share Envelope 1.5.0, as pinned by those releases) for exact Share-key runtime consent, and remove the obsolete local NodeSDK sign-in patch now included upstream.

  Keep transcript-share dialogs open through same-owner, same-session runtime-grant refreshes. Reject stale account/content completions and surface interrupted shares without exposing the prior recipient or link. Treat an OpenKey cancellation of exact-key consent as a cancelled share.

  Discard underlying SDK errors at the transcript-share boundary so diagnostic cause chains contain only the sanitized failure message.

  Freeze speaker aliases in the shared copy using the transcript's existing display, Copy and export mapping. Reject semantic alias changes during sharing, including unused labels, and validate the same projection against persisted metadata without rewriting stored sentences.

  Details: TC-2192

## 0.14.0-beta.19

### Patch Changes

- 8a1d52e: Wait for restored private-agent access to settle before routing the first chat send.

## 0.14.0-beta.18

### Minor Changes

- 033a30f: Tiny bots, slice 1 (TC-2808), off by default. For accounts on `BOTS_TEST_ACCOUNTS` with `BOTS_ENABLED=true`, Home shows a "What do you want done?" box that sends to Main, the owner's main bot, and opens Main's chat with the reply streaming in. The backend adds `/api/bots/status` and `/api/bots/main/messages`, which forward to the new bots service (`bots/`). Everyone else sees no change.

## 0.14.0-beta.17

### Patch Changes

- 609603c: On web and desktop, voice notes that aren't saved yet stay on the device for your account when you sign out, or you can delete them. Notes recorded while signed out wait until you save each one to an account.

  Details: TC-2785

## 0.14.0-beta.16

### Patch Changes

- ae08fc0: Streamed replies from confidential models now show an "Enclave verified" mark once the gateway's signed receipt checks out, or a note if it can't be confirmed. Details: TC-2196

## 0.14.0-beta.15

### Patch Changes

- 47e3ecf: Reviewer seed: check the grant's signed UCAN payload against the request before use, match resumed chat messages by their ids, and state the requested KV scope exactly.

## 0.14.0-beta.14

### Minor Changes

- 7db69c7: TinyCloud Home opens from the device: the Feed, chat histories and Library show their last copy at once and refresh in the background. What you open is fetched first; background copying waits for it and pauses while the app is hidden. The Feed loads with far fewer requests.

## 0.14.0-beta.13

### Minor Changes

- eed0f62: TinyCloud Home on iPhone and Android now opens with Face ID, Touch ID or the phone's screen lock instead of signing in again. A signed-in app asks when it opens, and when you come back after 5 minutes away (Settings › App lock: 1, 5 or 15 minutes, or an hour). Your feed and recordings load behind the lock screen and appear the moment you unlock; on iPhone and Android 13 and later the app switcher shows a blank screen while the lock is on. Cancelling keeps the lock screen up with a button to try again, and never signs you out. The lock is on by default where Face ID, Touch ID or a fingerprint is set up, and can be turned off in Settings. Recording from a shortcut starts without waiting for the unlock. Details: TC-2738

## 0.14.0-beta.12

### Minor Changes

- 680789e: TinyCloud Home for Mac starts a recording from anywhere: press ⌘⇧⌥R (Command-Shift-Option-R), or choose Start recording from its menu-bar icon. The app comes to the front with the recorder open and recording; if a recording is already going, it opens that recorder instead. The menu-bar icon also has Open TinyCloud Home.

## 0.14.0-beta.11

### Patch Changes

- faad27f: Add a reviewer seed CLI (`frontend/scripts/reviewer-seed`) that fills one fresh, explicitly confirmed TinyCloud Home space with fixed demo Feed cards, a chat and a transcript-only voice note through Home's own write paths, using only a short delegation the space owner grants to the run.

## 0.14.0-beta.10

### Patch Changes

- 761a6ba: The web build includes connector secret permissions and the decrypt permission at sign-in for devices that have used Connectors. First use requests access through OpenKey in place. Remove the unused custom AssemblyAI key permission from the manifest.

## 0.14.0-beta.9

### Minor Changes

- aaf1236: iOS: TinyCloud Home ships recording shortcuts that work right after install (TC-2740). Siri, Spotlight, the Shortcuts app and the Action button get **Record** ("Start recording in TinyCloud Home", "Record a note in TinyCloud Home") and **Stop Recording**; Control Center and the Lock Screen get a **Record a Voice Note** control that records without unlocking; the home-screen quick action uses the same start. Every recording shows a Live Activity with a timer and a Stop button. The test-only "TinyCloud Home probe" control and shortcut are gone.

## 0.14.0-beta.8

### Minor Changes

- b589ec8: Android: add a Quick Settings "Record" tile that opens TinyCloud Home and starts a voice note, and relabel the launcher shortcut "Record".

## 0.14.0-beta.7

### Minor Changes

- f8823ef: Exo is now TinyCloud Home everywhere you can see it: the web app's title, install name and sign-in, the desktop app (now `TinyCloud Home.app`), the Android and iOS app names, notifications, permission prompts and error messages. Home opens on Feed on the web, on desktop and on iOS and Android, on a fresh install and after signing in, unless you chose Apps as your first screen in Settings. Feed and Apps are no longer experimental: they are in the navigation for everyone, and Settings › Home holds the first-screen choice. App id, bundle ids, URL schemes and every data path are unchanged. Details: TC-2050, TC-2040

## 0.14.0-beta.6

No changes in this release.

## 0.14.0-beta.5

### Patch Changes

- 451ae7e: Native sign-in on iOS and Android asks for every applications-space KV, SQL and hook entry of the manifest, the same grant as the web sign-in, so the Home feed works on the phone apps (TC-2720). Space info stays web-only until the backend accepts it. A CI job checks the native request against production OpenKey's ceiling.

## 0.14.0-beta.4

### Minor Changes

- 657b2ef: Settings → Account has "Delete OpenKey account" (TC-2721, App Store 5.1.1(v)). It opens OpenKey's deletion page, `https://openkey.so/dashboard/settings/delete-account` on the configured `VITE_OPENKEY_HOST`, in the system browser sheet on the phone or a new tab on the web. The row isn't shown on desktop, which has no fixed-URL opener for it yet.

## 0.14.0-beta.3

### Minor Changes

- ab71584: Native sign-in offers "Continue with Apple" once OpenKey lists Apple in `GET /api/auth/providers`; it opens Sign in with Apple in the existing OpenKey sheet (TC-1233). Updates `@openkey/sdk-capacitor` to the release that accepts `loginMethod: "apple"`.

## 0.14.0-beta.2

### Patch Changes

- 0dd3bf2: Shorten connector consent screens and remove obsolete consent checkboxes.

## 0.14.0-beta.1

### Minor Changes

- 79579b6: The Home site signs in with only the permissions Feed, Chat and Apps use (`manifest.home.json`): no secrets, no decrypt grant, and no access to the connectors, canvas, details, summaries or transcripts databases. Recording and Connectors stay on Home and ask for their own permissions in place the first time they are opened, in one OpenKey approval; once a feature has been used on a device, the next sign-in asks for it too. Background work for Recording or Connectors starts only once that feature's permissions are in place. Agent access, Canvas and Local copy stay off on Home. tinycloud.chat keeps the full grant and behaves as before. Existing Home sessions sign in once more (revision `home-1`). Linear: TC-2501

## 0.13.1-beta.0

### Patch Changes

- 631a8bb: iOS: ship the app as TinyCloud Home with bundle ID `xyz.tinycloud.home` (dev `xyz.tinycloud.home.dev`) under the TinyCloud, Inc. team (TC-518).

## 0.13.0

### Minor Changes

- af1916e: Adds the TinyCloud Home site build (`VITE_HOME_SITE=true`) and a production deploy job that uploads it to its own Cloudflare Pages project. Details: TC-2387
- adcb383: Add the owner Home feed over registered SQLite output/response pairs, with typed ask, task, approval, incident, work, ship, order, claim, hold and progress cards. Preserve exact issuance-bound drafts and private approval payloads; keep owner state, archive history, scoped priorities, answer persistence, delivery acknowledgement and outcomes distinct.

  Adopt the published TinyCloud SDK 3.8.0-beta.22 history and response APIs with explicit frontend and relay dependencies. Remove the obsolete Node SDK beta.13 session-key patch because the published beta.22 artifacts contain the same fix.

  Add the owner-operated same-UUID sitrep mirror adapter and gated relay. Closing responses require a verified conditional mirror close before an external handoff; uncertain handoffs are not automatically repeated. Owner provisioning, relay configuration, signed-in acceptance and production deployment remain separate operations. No storage fence, watcher exclusion or exactly-once guarantee is added.

  Details: TC-2204

## 0.13.0-beta.1

### Minor Changes

- af1916e: Adds the TinyCloud Home site build (`VITE_HOME_SITE=true`) and a production deploy job that uploads it to its own Cloudflare Pages project. Details: TC-2387

## 0.13.0-beta.0

### Minor Changes

- adcb383: Add the owner Home feed over registered SQLite output/response pairs, with typed ask, task, approval, incident, work, ship, order, claim, hold and progress cards. Preserve exact issuance-bound drafts and private approval payloads; keep owner state, archive history, scoped priorities, answer persistence, delivery acknowledgement and outcomes distinct.

  Adopt the published TinyCloud SDK 3.8.0-beta.22 history and response APIs with explicit frontend and relay dependencies. Remove the obsolete Node SDK beta.13 session-key patch because the published beta.22 artifacts contain the same fix.

  Add the owner-operated same-UUID sitrep mirror adapter and gated relay. Closing responses require a verified conditional mirror close before an external handoff; uncertain handoffs are not automatically repeated. Owner provisioning, relay configuration, signed-in acceptance and production deployment remain separate operations. No storage fence, watcher exclusion or exactly-once guarantee is added.

  Details: TC-2204

## 0.12.0

### Minor Changes

- 228a804: Rename the speakers on any transcript. Tap a speaker label in a note's transcript to give that speaker a name, for example "Me" becomes your name and "Them" becomes "Alice, Bob". The name shows on every line of that speaker, is saved with the note so it follows it across devices, and can be undone. Copy, copy with timestamps and Markdown export use the names. The stored transcript keeps its original labels. Details: TC-2189

### Patch Changes

- 944bbf4: Paste a whole Google Calendar invite into the notetaker's meeting-link field. The first Google Meet link in the text is used, ahead of dial-in numbers and unrelated links, and a lookup link stays as pasted. The field now accepts the full pasted text, and a single link reads as before. Details: TC-2181
- adddc69: Show fixed meeting-code guidance for Meet lookup links rejected by the transcriber.

## 0.12.0-beta.2

### Patch Changes

- adddc69: Show fixed meeting-code guidance for Meet lookup links rejected by the transcriber.

## 0.12.0-beta.1

### Minor Changes

- 228a804: Rename the speakers on any transcript. Tap a speaker label in a note's transcript to give that speaker a name, for example "Me" becomes your name and "Them" becomes "Alice, Bob". The name shows on every line of that speaker, is saved with the note so it follows it across devices, and can be undone. Copy, copy with timestamps and Markdown export use the names. The stored transcript keeps its original labels. Details: TC-2189

### Patch Changes

- 944bbf4: Paste a whole Google Calendar invite into the notetaker's meeting-link field. The first Google Meet link in the text is used, ahead of dial-in numbers and unrelated links, and a lookup link stays as pasted. The field now accepts the full pasted text, and a single link reads as before. Details: TC-2181

## 0.11.5

### Patch Changes

- 56ce78e: TinyChat retrieval pack 0.1.1-onboarding.25: the skill uses the TinyCloud onboarding sign-in (`TC_PROFILE`, else `default`) instead of its own `tinychat-agent` profile, asks once with one OpenKey link when the profile can't read TinyChat yet, and takes the code the owner pastes in chat (`setup.mjs login --code`, stdin, or `tinychat_authorize` with `code`). Breaking for the pack: `--code-file`, `authorize --delivery`, `prepare --new-profile`, the HTML approval file, the OpenCode chat capture and `tinychat_signin_status` are removed, and the pack needs Node.js 22.20 and, for setup, TinyCloud CLI 1.5.0-beta.20 or later. The public setup page and the Settings prompt point to https://agents.tinycloud.xyz/chat.

## 0.11.5-beta.0

### Patch Changes

- 56ce78e: TinyChat retrieval pack 0.1.1-onboarding.25: the skill uses the TinyCloud onboarding sign-in (`TC_PROFILE`, else `default`) instead of its own `tinychat-agent` profile, asks once with one OpenKey link when the profile can't read TinyChat yet, and takes the code the owner pastes in chat (`setup.mjs login --code`, stdin, or `tinychat_authorize` with `code`). Breaking for the pack: `--code-file`, `authorize --delivery`, `prepare --new-profile`, the HTML approval file, the OpenCode chat capture and `tinychat_signin_status` are removed, and the pack needs Node.js 22.20 and, for setup, TinyCloud CLI 1.5.0-beta.20 or later. The public setup page and the Settings prompt point to https://agents.tinycloud.xyz/chat.

## 0.11.4

### Patch Changes

- 8e39260: Simplify chat by removing the header title editor, persistent Agent access status row, View/Chat/Canvas switcher, and promotional Early Access Demo label. Keep conversation titles and history, credit usage, live-recording status, and existing agent recovery and Settings controls. Canvas and artifact data remain stored; the visual Canvas surface is no longer reachable from the removed switcher.

## 0.11.4-beta.0

### Patch Changes

- 8e39260: Simplify chat by removing the header title editor, persistent Agent access status row, View/Chat/Canvas switcher, and promotional Early Access Demo label. Keep conversation titles and history, credit usage, live-recording status, and existing agent recovery and Settings controls. Canvas and artifact data remain stored; the visual Canvas surface is no longer reachable from the removed switcher.

## 0.11.3

### Patch Changes

- 9577d88: Rename a recording from the Home and Library lists and from the note header. The name is stored with the note in your space; auto-titling, re-transcribe, and re-sync keep it, and clearing it returns to the automatic title.

## 0.11.3-beta.0

### Patch Changes

- 9577d88: Rename a recording from the Home and Library lists and from the note header. The name is stored with the note in your space; auto-titling, re-transcribe, and re-sync keep it, and clearing it returns to the automatic title.

## 0.11.2

### Patch Changes

- 8d080e4: On touch, an editable field smaller than 16px can make iOS zoom the whole page, and the zoom can stay after focus leaves. The paste-a-transcript fields, the Fireflies API key and the Meet space code now render 16px on touch (unchanged size with a mouse), matching the composer and the notetaker form.
- 2f94b1b: A pasted transcript opens its note: it is a note page, never the saved recording's sheet or page, and it has no audio player.

## 0.11.2-beta.1

### Patch Changes

- 8d080e4: On touch, an editable field smaller than 16px can make iOS zoom the whole page, and the zoom can stay after focus leaves. The paste-a-transcript fields, the Fireflies API key and the Meet space code now render 16px on touch (unchanged size with a mouse), matching the composer and the notetaker form.

## 0.11.2-beta.0

### Patch Changes

- 2f94b1b: A pasted transcript opens its note: it is a note page, never the saved recording's sheet or page, and it has no audio player.

## 0.11.1

### Patch Changes

- f4455f5: Word fixes: a list in Settings of words to replace in transcripts, for example "tiny cloud" becomes "TinyCloud". Add, edit or delete a pair; matching ignores case, matches whole words and phrases, and the replacement is inserted as typed. The list is saved in your space so it follows you across devices, and it applies to every transcript you read, copy or export, including notes saved earlier. The stored transcript is not changed. Details: TC-2199

## 0.12.0-beta.0

### Minor Changes

- f4455f5: Word fixes: a list in Settings of words to replace in transcripts, for example "tiny cloud" becomes "TinyCloud". Add, edit or delete a pair; matching ignores case, matches whole words and phrases, and the replacement is inserted as typed. The list is saved in your space so it follows you across devices, and it applies to every transcript you read, copy or export, including notes saved earlier. The stored transcript is not changed. Details: TC-2199

## 0.11.0

### Minor Changes

- ec9f26e: Rename a chat from the Chats list or the chat header. The title is saved with the chat in your space, a renamed title is never replaced by the automatic title, and clearing it returns to the automatic title.
- c69435b: Let users choose Feed or Apps as TinyCloud Home's first screen in Settings. The choice is saved with their account settings across devices; direct links retain their destinations. Details: TC-2040
- 69102c7: Add a sample Home Feed with five card layouts and visible-only refresh. Details: TC-2040
- 81211af: TinyCloud Home: the app opens on a feed of sample cards, with Recording, Chat, Apps and Feed in the navigation. Apps open in TinyCloud Share. Details: TC-2040
- 723c72a: Add transcript paste as an Upload choice. Pasted text is committed as a transcript-only note and appears in the Library and meeting chat.
- 9affbdb: The local copy of transcripts on this device is now on by default in supported browsers. Turning it off in Settings is remembered per account and removes the local copy. Details: TC-2055
- bca5df5: TinyCloud Home sign-in manifest: adds the applications-space key-value grant and the two catalog databases (Health Log and Recipes), removes the unused migration record folder, renames the app to TinyCloud Home, and asks for one new sign-in per device. Details: TC-2043
- 94d19ee: The recording view now shows ⚙︎ Capture settings, with a "Stop recording after" default for new recordings on the Mac app, and +15 min, +30 min and No limit next to "Stops at …" to move or cancel the stop time of the running recording. The chat header's microphone is no longer drawn while recording. Details: TC-2182

### Patch Changes

- 253d9d6: Hide Apps and Feed behind a device-local experimental setting, with Chat as the default web entry until enabled.
- 1c140c0: Calendar autojoin now asks Google for Calendar events, openid and email only, and no longer asks for the Meet, Drive and Docs scopes or for previously granted scopes. Enabling it no longer saves a Google Meet token or runs a Meet sync; Google Meet stays a separate connect. Existing autojoin connections are not changed until the user reconnects.
- 49e6c78: A failed or slow chat-list load is retried and, if it still fails, shown as an error with a retry instead of an empty list. Details: TC-2016
- 1029746: Combined meetings get their own summary, made once per combine from the combined text (TC-1152).
- b52f4e4: Google Meet connect now keeps the connection when finishing the sync times out: the connection is saved as connected with a sync error, Drive Notes have their own time budget, and Retry finishes without reconnecting. If the connection itself can't be saved, the dialog says so and offers to connect again.
- 54a136e: Google Meet Notes: one Note's storage write is retried twice with backoff, and a Note that still fails no longer fails the run: the rest are saved, the card reports "N of M Notes saved", and Sync now or Full rescan finishes the rest (a snapshot resumes only the unsaved Notes; an incremental run replays changes since its cursor). The row is recounted after every background run. The session-start sync now reconciles Notes in the background like the connect dialog, so Full rescan and Sync now show the running sync's live progress (including a Notes sync resumed from an earlier page load) and offer to wait instead of failing. "Copy sync log" is on the Connectors card, kept per account across reloads.
- 0b3e6ac: Google Meet connect now finishes in seconds. The connection is saved as soon as the meetings are checked, and Notes by Gemini reconcile in the background: the Drive listing is limited to Google Docs, existing notes are matched in memory instead of one database scan per Doc, Docs are read up to five at a time with per-call timeouts, and progress is checkpointed so Retry resumes instead of restarting. The dialog shows real progress, per-phase counts and elapsed time, and a "Copy sync log" button (counts, timings and error kinds only). A background failure shows on the Google Meet card.
- 104c54e: Google Meet in Meeting sources: a Full rescan or Sync now that another Meet sync refuses (including the run its own vault unlock started) shows that sync's progress and starts by itself when it ends, instead of "Another Google Meet sync is already running". The meeting count is the live count of saved meetings, refreshed at every checkpoint and when a sync settles. The connect dialog says how many Meet recordings synced and how many meetings are saved. The sync log is saved when a run starts and at each checkpoint, so a run a reload cuts short leaves one, and "Copy sync log" is on the row. After a reload the row says "A Notes sync was interrupted at x/y. Sync now resumes it."
- 287a93a: Google Meet in Meeting sources: Sync now and Full rescan return once the Meet records are saved and the Notes finish in the background (own time budget, checkpoints, progress on the row), so a slow storage node no longer hits the 60 s foreground limit and needs several presses. The status line follows the latest run: a finished run clears an earlier "Last sync failed", and "synced" shows when the run ended. The meeting count rises with every saved Note. A request for the Google access token that the network closes is sent once more before the row says it couldn't reach Google.
- 2561378: Hide the Whisper Large Turbo model from the model picker. Models already selected or downloaded stay available.
- 84819aa: Home signs in with the permissions in its manifest, including the requested secret decrypt grant.

  Details: TC-2038

- 8b3b819: Hosted transcription refusals are now classified (rejected key, insufficient balance, rate limit) and reported to operators: one alert when AssemblyAI starts refusing, one when it recovers, one after three failed jobs in a row, a heartbeat every minute, and a read-only status for the monitoring probe. Nothing changes for users yet.
- 0e9f195: The "Keep recording?" prompt now offers "Stop now" and "Keep going". "Stop now" stops and saves the recording immediately; "Keep going" still adds an hour. Closing the prompt with Escape, or ignoring it, leaves the recording to stop at its limit.
- 90ab342: Adds the meeting databases, the migration record folder, the storage info read and the Exo mailbox folders to the sign-in manifest, and asks for one new sign-in per device when a saved session predates them.
- 0cd762b: Send a notetaker accepts every Google Meet link shape: `/meet/<code>`, `/_meet/<code>`, `g.co/meet/<code>`, `tel.meet/<code>`, links wrapped in `accounts.google.com?continue=` or `meet.app.goo.gl?link=`, and a bare code with or without dashes. All become `https://meet.google.com/<code>` (lowercase, no trailing slash). A wrapper whose target is not a Meet link is refused. `meet.google.com/lookup/<nick>` is sent as pasted.
- 1a839fb: Name new voice notes with the date, transcription model and participants.
- 57fb986: Send a notetaker accepts meeting links as people paste them. A link without `https://`, Google's `google.com/meet/<code>` form, a bare Meet code, a Gmail/Calendar or Outlook redirect, or a whole "Join with Google Meet" line now becomes the canonical meeting link before it goes to ptx. These used to fail with "That doesn't look like a meeting link" or "That meeting platform isn't supported yet". Any other link still goes upstream exactly as pasted, so capability links keep their query and fragment. The backend applies the same reading, so links from older clients work too.
- 333a8f1: Show the notetaker stuck-joining state.
- 34720ec: A pasted transcript is shown as saved in the Library.
- 740150e: Pause chat sharing: the Share chat action is offered only for chats that already have a link, and creating a new chat share link is refused. Opening received share links and managing existing links are unchanged.
- 8c04781: A voice note whose audio is on this device plays from that file with seeking, and the Audio/Transcribe-on-device lines are gone. Transcription shows one status in Activity and on the note, with minutes done and time left and one working action. A transcribed note's title is no longer renamed with the transcription model.
- 0f22d69: Update the TinyCloud SDK packages to 3.8.0-beta.9 (replica 0.4.0-beta.3). The local copy now syncs entry names only and fetches a value when something reads it (`replication.contentFetch: "lazy"`), so signing in no longer downloads every transcript body. The sign-in key patch is regenerated for the new SDK version.
- 4cb941a: The local copy starts after the app's first load and brings its prefixes up two at a time, so sign-in and reload are not slowed by a burst of requests.

  The first-load gate listens for the thread store's completed list read, including a warm-cache background revalidation and failed loads, before starting the fill (or after its 45-second deadline).

- 549dcc1: Add an opt-in switch and a wipe button for local copies.
- 8feaa2d: Restores the previous sign-in permissions.
- d171ad6: Details: TC-1977 Revert storing connector credentials under app named keys: web sign-in with the named-key manifest could not complete in the OpenKey sign popup. It returns with a fix and a real-browser sign-in check.
- d401bb6: The minimized recorder bar's open button is a 44px touch target; the bar looks the same. Details: TC-2186
- 4bbe96a: Update the TinyCloud SDK packages to 3.8.0-beta.1 (replica 0.3.5-beta.0) and request sign-in sync only on the declared replication prefixes (`replication.syncScope: "prefixes"`).

  Details: TC-2043

- 6fd545d: Share chats as snapshots: a share holds one chat's title and messages at its own link. Owners can list and revoke their shares from the share dialog. Links created before this change still open.
- abde4ac: Show which transcription model produced a transcript.
- 9fa8a54: The minimized recorder is a smaller bar: timer, pause and stop, with no waveform or status line. It shows "Stops in" with a thin progress line toward the recording limit, and hovering it shows the exact time the recording stops.
- c0e2116: Register the `exo-merged` meeting source in the Library (source list, labels and kind).
- 311fe89: Add the meeting stitcher core (TC-1152 S1); nothing user-visible ships.
- 833e658: Add the combined-meeting data layer (TC-1152 S2b): write, delete, cascade and read-time sweep for `exo-merged` meetings. Purging a connector now also removes combined meetings that list it. Nothing user-visible ships.
- 984d884: Add "Combine with another capture…" to a meeting in the Library: pick an overlapping capture, see why the two look like the same meeting (or don't), and tap Combine to save one combined meeting. A combined meeting opens like any meeting, lists the captures it was made from, and can be deleted without touching them.
- 38b2c37: Combined meetings: in-app meeting chat and the agent retrieval pack (now 0.1.1-onboarding.24) search and cite the combined meeting as one meeting, and no longer return the captures it was combined from. A combined row whose record can't be read hides nothing and is itself left out.
- b083512: Update the web frontend to `@openkey/sdk` 0.12.1 for OpenKey embedded widget layout negotiation (TC-1183).
- 2e51461: Settings → Voice notes: Stop recording after is one compact select, the upload checkbox is aligned with its (i), and one help line follows the checkbox (TC-1618).
- 8a6c29e: Details: TC-1977 Serve TinyChat's key declaration at /.well-known/openkey-manifest.json so OpenKey can verify the app's named keys from the app's own origin.
- 8b6848e: Details: TC-1977 Store connector credentials in app named keys again. Web sign-in runs OpenKey's authorize review inside the embedded OpenKey frame, so it needs no popup or extra approval screen, and the web reads its manifest, with the named-key declaration, from its own /.well-known/openkey-manifest.json, the file OpenKey verifies. The backend's /api/manifest carries no key declaration.
- a43ddc8: Web sign-in is one click again, with no key grants, and connector credentials use the default key. Details: TC-1977
- b4c2b24: Details: TC-1977 Store connector credentials in app named keys and move existing credentials after a separate approval.
- 1dcda46: Give the cached chat-list retry link a minimum 24 px hit area without changing its label.
- 05cac77: Library: a combined meeting replaces its source captures in the list; the combined page lists its sources, each opens its own page (TC-1152)
- 0ccf29d: Combined-meeting summaries use z-ai/glm-5.2 with output caps of 2500 (whole meeting) and 1500 (per chunk), which leave room for the model's reasoning tokens. A reply with no content is reported as a failed summary and nothing is saved (TC-1686).
- 6e64051: Combined-meeting summaries now use a faster model and a per-call output cap. The chat route accepts an optional `max_output_tokens` integer (1 to 4096), forwarded upstream as `max_tokens`. Details: TC-1686
- 6312e16: Add an "Automatic meeting summaries" setting, on by default. When it is off, a combined meeting is saved without a summary and Generate starts one. `GET /api/billing/status` now reports the same usage the chat admission gate uses, and the client refreshes it after a summary run.
- e228022: Local copy syncs every five minutes and serves a local read without syncing when the copy is under fifteen minutes old.

  Details: TC-2054

- f3fd701: Sign in once more after a grants change now shows its notice on the desktop recorder screen, with Sign in and the recorder still available, instead of a generic sign-in failure. A browser whose storage cannot save the sign-in record is now asked to sign in again once per page session, not on every restore.
- 7e62bc9: Native sign-in requests only the entries OpenKey's native client currently allows, so a new desktop or phone sign-in is no longer refused. Details: TC-2057
- cffdd3b: Home opens on the saved First screen choice straight away on a device that has already loaded it, even when the account setting is slow to load, and Settings no longer sits on "Loading your setting…" indefinitely: after eight seconds it shows Feed with the load-error note and lets you choose.

  Details: TC-2079

- 61db7ec: Connector keys read from the vault are cached in memory for the signed-in session, so repeat reads no longer make a network round trip. The cache is cleared on sign-out, account change and vault lock.

  Details: TC-2080

- f0f2d61: Stopping a recording automatically is now a setting, "Stop recordings automatically" (per device). It is off by default at the phone layout, where a recording runs until you stop it (with a silent eight-hour safety cap) and shows no countdown or warning, and on by default on desktop, where Exo asks "Keep recording?" five minutes before the limit and "Keep going" adds an hour. Recordings too long for private transcription are saved with their audio kept, and the note now says so.
- a9a2e94: A voice note that Private transcription is holding shows "Transcription is delayed, it will finish automatically." instead of an error, and keeps checking until it finishes. A note whose Private transcription stopped on a speech-to-text provider failure is re-submitted once, automatically, the next time the app loads and the recording is still on the device; if it fails again it waits for Retry.

  Details: TC-2085

- 44a1e4e: The one-time automatic re-submit of provider-failed voice notes now runs strictly one note at a time, and a note whose attempt is refused because the account already has an active transcription is not counted as used: it is tried again on the next load.

  Details: TC-2085

- f58cf76: An open tab that is idle or hidden makes far fewer background reads of the library: the transcriber library sync no longer runs on its timer while the tab is hidden, and a tab with nothing to retry checks every two minutes instead of every 30 seconds. A recording that failed to save still retries every 30 seconds, and coming back to the tab still starts a check at once.
- a8ccf05: Exo desktop development builds sign in again: the sign-in message is signed for `localhost` (the host the server accepts) instead of `localhost:5186`, and sign-in errors from the server are logged as short codes only. Published builds are unchanged.
- ae0fbc6: Hide the TinyCloud button by default; add a Settings toggle and an Open row.

  Update TinyCloud SDK to 3.8.0-beta.12 (panel delegation button, iPhone safe areas).

- a6db78c: Keep keyboard focus inside the Powerful consent dialog and let Escape close only the dialog.
- fde135c: Update the TinyCloud SDK family to the stable 3.3.0 line (web-sdk, node-sdk, sdk-core, sdk-services 3.3.0; node-sdk-wasm 1.7.8; web-sdk-wasm 1.7.7) and regenerate the node-sdk sign-in patch for 3.3.0.

  Details: TC-1152

- 11585e8: A transcript no longer tags every line that was recovered from the recording or came from a backup transcriber. When part of a transcript came from a backup transcriber, one short note above the text says so; lines recovered from the recording are not called out.
- 5c1d6d4: Turn the Conversation Canvas back on. It stays off for each user until they turn it on under Settings > Experimental.
- e85c6fa: Ask before sending an uploaded file to Powerful transcription. Powerful now says "Not private: Powerful sends your audio through Exo's server to an outside transcription service. Exo deletes the service's copy once the transcript is saved." in the recorder, the upload sheet and Settings.
- 3e173ce: Move the TinyCloud SDK family to the stable 3.3.0 set (web-sdk, node-sdk, sdk-core, sdk-services 3.3.0; `@tinycloud/replica` 0.3.0; web-sdk-wasm 1.7.7; node-sdk-wasm 1.7.8). Add an optional local read-through copy of transcript text for the web app behind a build-time flag that defaults OFF: nothing changes unless the app is built with `VITE_EXO_REPLICATION=true` (the per-browser runtime opt-in exists only outside production builds), and it refuses to turn on in Tauri, Capacitor, iOS browsers, Safari and Firefox. With the flag OFF, a local copy left by an earlier build is removed at the next load. Mirrors only audio-free transcript folders, within a 100 MB budget; reads that confirm a write use the network. Sign-out erases the local copy (a failed erase is shown and blocks reads), and Settings shows a read-only status line. A built-in kill switch forces replication off for every build and browser.
- 113c561: Local Whisper compares the audio it decoded with the saved recording's length. A transcript that covers less of the recording is shown as failed with the transcribed and recorded lengths, and Retry transcription runs it again.

## 0.10.0-beta.66

### Minor Changes

- 94d19ee: The recording view now shows ⚙︎ Capture settings, with a "Stop recording after" default for new recordings on the Mac app, and +15 min, +30 min and No limit next to "Stops at …" to move or cancel the stop time of the running recording. The chat header's microphone is no longer drawn while recording. Details: TC-2182

## 0.10.0-beta.65

### Patch Changes

- a43ddc8: Web sign-in is one click again, with no key grants, and connector credentials use the default key. Details: TC-1977

## 0.10.0-beta.64

### Minor Changes

- ec9f26e: Rename a chat from the Chats list or the chat header. The title is saved with the chat in your space, a renamed title is never replaced by the automatic title, and clearing it returns to the automatic title.

### Patch Changes

- 113c561: Local Whisper compares the audio it decoded with the saved recording's length. A transcript that covers less of the recording is shown as failed with the transcribed and recorded lengths, and Retry transcription runs it again.

## 0.10.0-beta.63

### Patch Changes

- 8c04781: A voice note whose audio is on this device plays from that file with seeking, and the Audio/Transcribe-on-device lines are gone. Transcription shows one status in Activity and on the note, with minutes done and time left and one working action. A transcribed note's title is no longer renamed with the transcription model.

## 0.10.0-beta.62

### Patch Changes

- 0cd762b: Send a notetaker accepts every Google Meet link shape: `/meet/<code>`, `/_meet/<code>`, `g.co/meet/<code>`, `tel.meet/<code>`, links wrapped in `accounts.google.com?continue=` or `meet.app.goo.gl?link=`, and a bare code with or without dashes. All become `https://meet.google.com/<code>` (lowercase, no trailing slash). A wrapper whose target is not a Meet link is refused. `meet.google.com/lookup/<nick>` is sent as pasted.

## 0.10.0-beta.61

### Patch Changes

- d401bb6: The minimized recorder bar's open button is a 44px touch target; the bar looks the same. Details: TC-2186

## 0.10.0-beta.60

### Patch Changes

- 8b6848e: Details: TC-1977 Store connector credentials in app named keys again. Web sign-in runs OpenKey's authorize review inside the embedded OpenKey frame, so it needs no popup or extra approval screen, and the web reads its manifest, with the named-key declaration, from its own /.well-known/openkey-manifest.json, the file OpenKey verifies. The backend's /api/manifest carries no key declaration.

## 0.10.0-beta.59

### Patch Changes

- 8a6c29e: Details: TC-1977 Serve TinyChat's key declaration at /.well-known/openkey-manifest.json so OpenKey can verify the app's named keys from the app's own origin.

## 0.10.0-beta.58

### Patch Changes

- d171ad6: Details: TC-1977 Revert storing connector credentials under app named keys: web sign-in with the named-key manifest could not complete in the OpenKey sign popup. It returns with a fix and a real-browser sign-in check.

## 0.10.0-beta.57

### Patch Changes

- b4c2b24: Home signs in with the permissions in its manifest, including the requested secret decrypt grant.

  Details: TC-2038

- b4c2b24: Details: TC-1977 Store connector credentials in app named keys and move existing credentials after a separate approval.

## 0.10.0-beta.56

### Patch Changes

- a6db78c: Keep keyboard focus inside the Powerful consent dialog and let Escape close only the dialog.

## 0.10.0-beta.55

### Patch Changes

- ae0fbc6: Hide the TinyCloud button by default; add a Settings toggle and an Open row.

  Update TinyCloud SDK to 3.8.0-beta.12 (panel delegation button, iPhone safe areas).

## 0.10.0-beta.54

### Patch Changes

- e85c6fa: Ask before sending an uploaded file to Powerful transcription. Powerful now says "Not private: Powerful sends your audio through Exo's server to an outside transcription service. Exo deletes the service's copy once the transcript is saved." in the recorder, the upload sheet and Settings.

## 0.10.0-beta.53

### Patch Changes

- 8b3b819: Hosted transcription refusals are now classified (rejected key, insufficient balance, rate limit) and reported to operators: one alert when AssemblyAI starts refusing, one when it recovers, one after three failed jobs in a row, a heartbeat every minute, and a read-only status for the monitoring probe. Nothing changes for users yet.

## 0.10.0-beta.52

### Patch Changes

- 0f22d69: Update the TinyCloud SDK packages to 3.8.0-beta.9 (replica 0.4.0-beta.3). The local copy now syncs entry names only and fetches a value when something reads it (`replication.contentFetch: "lazy"`), so signing in no longer downloads every transcript body. The sign-in key patch is regenerated for the new SDK version.

## 0.10.0-beta.51

### Patch Changes

- 11585e8: A transcript no longer tags every line that was recovered from the recording or came from a backup transcriber. When part of a transcript came from a backup transcriber, one short note above the text says so; lines recovered from the recording are not called out.

## 0.10.0-beta.50

### Patch Changes

- a8ccf05: Exo desktop development builds sign in again: the sign-in message is signed for `localhost` (the host the server accepts) instead of `localhost:5186`, and sign-in errors from the server are logged as short codes only. Published builds are unchanged.

## 0.10.0-beta.49

### Patch Changes

- 253d9d6: Hide Apps and Feed behind a device-local experimental setting, with Chat as the default web entry until enabled.
- 0e9f195: The "Keep recording?" prompt now offers "Stop now" and "Keep going". "Stop now" stops and saves the recording immediately; "Keep going" still adds an hour. Closing the prompt with Escape, or ignoring it, leaves the recording to stop at its limit.

## 0.10.0-beta.48

### Patch Changes

- f3fd701: Sign in once more after a grants change now shows its notice on the desktop recorder screen, with Sign in and the recorder still available, instead of a generic sign-in failure. A browser whose storage cannot save the sign-in record is now asked to sign in again once per page session, not on every restore.

## 0.10.0-beta.47

### Patch Changes

- cffdd3b: Home opens on the saved First screen choice straight away on a device that has already loaded it, even when the account setting is slow to load, and Settings no longer sits on "Loading your setting…" indefinitely: after eight seconds it shows Feed with the load-error note and lets you choose.

  Details: TC-2079

## 0.10.0-beta.46

### Patch Changes

- f0f2d61: Stopping a recording automatically is now a setting, "Stop recordings automatically" (per device). It is off by default at the phone layout, where a recording runs until you stop it (with a silent eight-hour safety cap) and shows no countdown or warning, and on by default on desktop, where Exo asks "Keep recording?" five minutes before the limit and "Keep going" adds an hour. Recordings too long for private transcription are saved with their audio kept, and the note now says so.

## 0.10.0-beta.45

### Patch Changes

- 44a1e4e: The one-time automatic re-submit of provider-failed voice notes now runs strictly one note at a time, and a note whose attempt is refused because the account already has an active transcription is not counted as used: it is tried again on the next load.

  Details: TC-2085

## 0.10.0-beta.44

### Patch Changes

- a9a2e94: A voice note that Private transcription is holding shows "Transcription is delayed, it will finish automatically." instead of an error, and keeps checking until it finishes. A note whose Private transcription stopped on a speech-to-text provider failure is re-submitted once, automatically, the next time the app loads and the recording is still on the device; if it fails again it waits for Retry.

  Details: TC-2085

## 0.10.0-beta.43

### Patch Changes

- f58cf76: An open tab that is idle or hidden makes far fewer background reads of the library: the transcriber library sync no longer runs on its timer while the tab is hidden, and a tab with nothing to retry checks every two minutes instead of every 30 seconds. A recording that failed to save still retries every 30 seconds, and coming back to the tab still starts a check at once.

## 0.10.0-beta.42

### Patch Changes

- 61db7ec: Connector keys read from the vault are cached in memory for the signed-in session, so repeat reads no longer make a network round trip. The cache is cleared on sign-out, account change and vault lock.

  Details: TC-2080

## 0.10.0-beta.41

### Patch Changes

- e228022: Local copy syncs every five minutes and serves a local read without syncing when the copy is under fifteen minutes old.

  Details: TC-2054

## 0.10.0-beta.40

### Patch Changes

- 9fa8a54: The minimized recorder is a smaller bar: timer, pause and stop, with no waveform or status line. It shows "Stops in" with a thin progress line toward the recording limit, and hovering it shows the exact time the recording stops.

## 0.10.0-beta.39

### Patch Changes

- 7e62bc9: Native sign-in requests only the entries OpenKey's native client currently allows, so a new desktop or phone sign-in is no longer refused. Details: TC-2057

## 0.10.0-beta.38

### Patch Changes

- 84819aa: Home signs in with the permissions in its manifest, including the requested secret decrypt grant.

  Details: TC-2038

## 0.10.0-beta.37

### Minor Changes

- 9affbdb: The local copy of transcripts on this device is now on by default in supported browsers. Turning it off in Settings is remembered per account and removes the local copy. Details: TC-2055
- bca5df5: TinyCloud Home sign-in manifest: adds the applications-space key-value grant and the two catalog databases (Health Log and Recipes), removes the unused migration record folder, renames the app to TinyCloud Home, and asks for one new sign-in per device. Details: TC-2043

### Patch Changes

- 4bbe96a: Update the TinyCloud SDK packages to 3.8.0-beta.1 (replica 0.3.5-beta.0) and request sign-in sync only on the declared replication prefixes (`replication.syncScope: "prefixes"`).

  Details: TC-2043

## 0.10.0-beta.36

### Minor Changes

- c69435b: Let users choose Feed or Apps as TinyCloud Home's first screen in Settings. The choice is saved with their account settings across devices; direct links retain their destinations. Details: TC-2040

## 0.10.0-beta.35

### Minor Changes

- 81211af: TinyCloud Home: the app opens on a feed of sample cards, with Recording, Chat, Apps and Feed in the navigation. Apps open in TinyCloud Share. Details: TC-2040

## 0.10.0-beta.34

### Minor Changes

- 69102c7: Add a sample Home Feed with five card layouts and visible-only refresh. Details: TC-2040

## 0.10.0-beta.33

### Patch Changes

- 1dcda46: Give the cached chat-list retry link a minimum 24 px hit area without changing its label.

## 0.10.0-beta.32

### Patch Changes

- 4cb941a: The local copy starts after the app's first load and brings its prefixes up two at a time, so sign-in and reload are not slowed by a burst of requests.

  The first-load gate listens for the thread store's completed list read, including a warm-cache background revalidation and failed loads, before starting the fill (or after its 45-second deadline).

## 0.10.0-beta.31

### Patch Changes

- 49e6c78: A failed or slow chat-list load is retried and, if it still fails, shown as an error with a retry instead of an empty list. Details: TC-2016

## 0.10.0-beta.30

### Patch Changes

- 90ab342: Adds the meeting databases, the migration record folder, the storage info read and the Exo mailbox folders to the sign-in manifest, and asks for one new sign-in per device when a saved session predates them.

## 0.10.0-beta.29

### Patch Changes

- 333a8f1: Show the notetaker stuck-joining state.

## 0.10.0-beta.28

### Patch Changes

- 5c1d6d4: Turn the Conversation Canvas back on. It stays off for each user until they turn it on under Settings > Experimental.

## 0.10.0-beta.27

### Patch Changes

- b083512: Update the web frontend to `@openkey/sdk` 0.12.1 for OpenKey embedded widget layout negotiation (TC-1183).

## 0.10.0-beta.26

### Patch Changes

- 05cac77: Library: a combined meeting replaces its source captures in the list; the combined page lists its sources, each opens its own page (TC-1152)

## 0.10.0-beta.25

### Patch Changes

- 549dcc1: Add an opt-in switch and a wipe button for local copies.

## 0.10.0-beta.24

### Patch Changes

- 1a839fb: Name new voice notes with the date, transcription model and participants.

## 0.10.0-beta.23

### Patch Changes

- abde4ac: Show which transcription model produced a transcript.

## 0.10.0-beta.22

### Patch Changes

- 2561378: Hide the Whisper Large Turbo model from the model picker. Models already selected or downloaded stay available.

## 0.10.0-beta.21

### Patch Changes

- 8feaa2d: Restores the previous sign-in permissions.

## 0.10.0-beta.20

### Patch Changes

- 084b0f4: Reading encrypted data now asks for decryption when needed, for about an hour.

## 0.10.0-beta.19

### Patch Changes

- 34720ec: A pasted transcript is shown as saved in the Library.

## 0.10.0-beta.18

### Patch Changes

- 6fd545d: Share chats as snapshots: a share holds one chat's title and messages at its own link. Owners can list and revoke their shares from the share dialog. Links created before this change still open.

## 0.10.0-beta.17

### Patch Changes

- 740150e: Pause chat sharing: the Share chat action is offered only for chats that already have a link, and creating a new chat share link is refused. Opening received share links and managing existing links are unchanged.

## 0.10.0-beta.16

### Patch Changes

- 57fb986: Send a notetaker accepts meeting links as people paste them. A link without `https://`, Google's `google.com/meet/<code>` form, a bare Meet code, a Gmail/Calendar or Outlook redirect, or a whole "Join with Google Meet" line now becomes the canonical meeting link before it goes to ptx. These used to fail with "That doesn't look like a meeting link" or "That meeting platform isn't supported yet". Any other link still goes upstream exactly as pasted, so capability links keep their query and fragment. The backend applies the same reading, so links from older clients work too.

## 0.10.0-beta.15

### Patch Changes

- 6312e16: Add an "Automatic meeting summaries" setting, on by default. When it is off, a combined meeting is saved without a summary and Generate starts one. `GET /api/billing/status` now reports the same usage the chat admission gate uses, and the client refreshes it after a summary run.

## 0.10.0-beta.14

### Patch Changes

- 3e173ce: Move the TinyCloud SDK family to the stable 3.3.0 set (web-sdk, node-sdk, sdk-core, sdk-services 3.3.0; `@tinycloud/replica` 0.3.0; web-sdk-wasm 1.7.7; node-sdk-wasm 1.7.8). Add an optional local read-through copy of transcript text for the web app behind a build-time flag that defaults OFF: nothing changes unless the app is built with `VITE_EXO_REPLICATION=true` (the per-browser runtime opt-in exists only outside production builds), and it refuses to turn on in Tauri, Capacitor, iOS browsers, Safari and Firefox. With the flag OFF, a local copy left by an earlier build is removed at the next load. Mirrors only audio-free transcript folders, within a 100 MB budget; reads that confirm a write use the network. Sign-out erases the local copy (a failed erase is shown and blocks reads), and Settings shows a read-only status line. A built-in kill switch forces replication off for every build and browser.

## 0.10.0-beta.13

### Patch Changes

- 0ccf29d: Combined-meeting summaries use z-ai/glm-5.2 with output caps of 2500 (whole meeting) and 1500 (per chunk), which leave room for the model's reasoning tokens. A reply with no content is reported as a failed summary and nothing is saved (TC-1686).

## 0.10.0-beta.12

### Patch Changes

- 6e64051: Combined-meeting summaries now use a faster model and a per-call output cap. The chat route accepts an optional `max_output_tokens` integer (1 to 4096), forwarded upstream as `max_tokens`. Details: TC-1686

## 0.10.0-beta.11

### Patch Changes

- fde135c: Update the TinyCloud SDK family to the stable 3.3.0 line (web-sdk, node-sdk, sdk-core, sdk-services 3.3.0; node-sdk-wasm 1.7.8; web-sdk-wasm 1.7.7) and regenerate the node-sdk sign-in patch for 3.3.0.

  Details: TC-1152

## 0.10.0-beta.10

### Patch Changes

- 1029746: Combined meetings get their own summary, made once per combine from the combined text (TC-1152).

## 0.10.0-beta.9

### Patch Changes

- 38b2c37: Combined meetings: in-app meeting chat and the agent retrieval pack (now 0.1.1-onboarding.24) search and cite the combined meeting as one meeting, and no longer return the captures it was combined from. A combined row whose record can't be read hides nothing and is itself left out.

## 0.10.0-beta.8

### Patch Changes

- 2e51461: Settings → Voice notes: Stop recording after is one compact select, the upload checkbox is aligned with its (i), and one help line follows the checkbox (TC-1618).

## 0.10.0-beta.7

### Patch Changes

- 287a93a: Google Meet in Meeting sources: Sync now and Full rescan return once the Meet records are saved and the Notes finish in the background (own time budget, checkpoints, progress on the row), so a slow storage node no longer hits the 60 s foreground limit and needs several presses. The status line follows the latest run: a finished run clears an earlier "Last sync failed", and "synced" shows when the run ended. The meeting count rises with every saved Note. A request for the Google access token that the network closes is sent once more before the row says it couldn't reach Google.

## 0.10.0-beta.6

### Patch Changes

- c0e2116: Register the `exo-merged` meeting source in the Library (source list, labels and kind).
- 311fe89: Add the meeting stitcher core (TC-1152 S1); nothing user-visible ships.
- 833e658: Add the combined-meeting data layer (TC-1152 S2b): write, delete, cascade and read-time sweep for `exo-merged` meetings. Purging a connector now also removes combined meetings that list it. Nothing user-visible ships.
- 984d884: Add "Combine with another capture…" to a meeting in the Library: pick an overlapping capture, see why the two look like the same meeting (or don't), and tap Combine to save one combined meeting. A combined meeting opens like any meeting, lists the captures it was made from, and can be deleted without touching them.

## 0.10.0-beta.5

### Patch Changes

- 1c140c0: Calendar autojoin now asks Google for Calendar events, openid and email only, and no longer asks for the Meet, Drive and Docs scopes or for previously granted scopes. Enabling it no longer saves a Google Meet token or runs a Meet sync; Google Meet stays a separate connect. Existing autojoin connections are not changed until the user reconnects.

## 0.10.0-beta.4

### Patch Changes

- 104c54e: Google Meet in Meeting sources: a Full rescan or Sync now that another Meet sync refuses (including the run its own vault unlock started) shows that sync's progress and starts by itself when it ends, instead of "Another Google Meet sync is already running". The meeting count is the live count of saved meetings, refreshed at every checkpoint and when a sync settles. The connect dialog says how many Meet recordings synced and how many meetings are saved. The sync log is saved when a run starts and at each checkpoint, so a run a reload cuts short leaves one, and "Copy sync log" is on the row. After a reload the row says "A Notes sync was interrupted at x/y. Sync now resumes it."

## 0.10.0-beta.3

### Patch Changes

- 54a136e: Google Meet Notes: one Note's storage write is retried twice with backoff, and a Note that still fails no longer fails the run: the rest are saved, the card reports "N of M Notes saved", and Sync now or Full rescan finishes the rest (a snapshot resumes only the unsaved Notes; an incremental run replays changes since its cursor). The row is recounted after every background run. The session-start sync now reconciles Notes in the background like the connect dialog, so Full rescan and Sync now show the running sync's live progress (including a Notes sync resumed from an earlier page load) and offer to wait instead of failing. "Copy sync log" is on the Connectors card, kept per account across reloads.

## 0.10.0-beta.2

### Minor Changes

- 723c72a: Add transcript paste as an Upload choice. Pasted text is committed as a transcript-only note and appears in the Library and meeting chat.

## 0.9.1-beta.1

### Patch Changes

- 0b3e6ac: Google Meet connect now finishes in seconds. The connection is saved as soon as the meetings are checked, and Notes by Gemini reconcile in the background: the Drive listing is limited to Google Docs, existing notes are matched in memory instead of one database scan per Doc, Docs are read up to five at a time with per-call timeouts, and progress is checkpointed so Retry resumes instead of restarting. The dialog shows real progress, per-phase counts and elapsed time, and a "Copy sync log" button (counts, timings and error kinds only). A background failure shows on the Google Meet card.

## 0.9.1-beta.0

### Patch Changes

- b52f4e4: Google Meet connect now keeps the connection when finishing the sync times out: the connection is saved as connected with a sync error, Drive Notes have their own time budget, and Retry finishes without reconnecting. If the connection itself can't be saved, the dialog says so and offers to connect again.

## 0.9.0

### Minor Changes

- 516ae0e: Settings → Voice notes has a "Stop recording after" choice (15 min to 2 h, default 1 h, or Off for the 3-hour limit); the recorder shows when it will stop, and the Mac app and browser can notify before and at an automatic stop.

### Patch Changes

- a4664bc: Exo desktop: Pause no longer shows "Paused" before it completes, and Stop settles instead of hanging while preserving the recorded audio. A Stop timeout does not confirm microphone release; the microphone may remain in use until Exo restarts (TC-1158).
- 67588ff: An on-device transcript from a single-channel recording saves its speaker as "Speaker 1", an anonymous name for that note only, instead of "You" or no name, and lists it as the note's participant. Each engine segment stays its own timed record. Two-channel desktop labels and private-cloud speaker labels are unchanged. Notes transcribed by AssemblyAI say that its speaker labels apply within that note only, and the retrieval pack (`0.1.1-onboarding.23`) documents the same for agents.
- 007062a: TinyCloud Transcriber sync shares each saved meeting it confirms with your other open tabs as it goes, so if the syncing tab closes partway through, the next one picks up where it stopped. A meeting whose saved copy can't be read is never treated as confirmed, and a meeting removed from your space is checked again if it comes back.
- 66fa0fe: Put less load on your space's meetings database. The Library list finds each voice note's older transcript in one pass instead of rescanning every row for every note. The TinyCloud Transcriber sync no longer reads every saved transcript to compare versions, checks only meetings it hasn't already confirmed this session, runs once per interval across all open tabs instead of once per tab (a tab whose sync makes no progress for a minute hands over to the others), and waits while the device is offline. After a database save times out, retries wait until the space has finished the abandoned request instead of queueing behind it.

## 0.9.0-beta.4

### Minor Changes

- 516ae0e: Settings → Voice notes has a "Stop recording after" choice (15 min to 2 h, default 1 h, or Off for the 3-hour limit); the recorder shows when it will stop, and the Mac app and browser can notify before and at an automatic stop.

## 0.8.2-beta.3

### Patch Changes

- 67588ff: An on-device transcript from a single-channel recording saves its speaker as "Speaker 1", an anonymous name for that note only, instead of "You" or no name, and lists it as the note's participant. Each engine segment stays its own timed record. Two-channel desktop labels and private-cloud speaker labels are unchanged. Notes transcribed by AssemblyAI say that its speaker labels apply within that note only, and the retrieval pack (`0.1.1-onboarding.23`) documents the same for agents.

## 0.8.2-beta.2

### Patch Changes

- 007062a: TinyCloud Transcriber sync shares each saved meeting it confirms with your other open tabs as it goes, so if the syncing tab closes partway through, the next one picks up where it stopped. A meeting whose saved copy can't be read is never treated as confirmed, and a meeting removed from your space is checked again if it comes back.

## 0.8.2-beta.1

### Patch Changes

- 66fa0fe: Put less load on your space's meetings database. The Library list finds each voice note's older transcript in one pass instead of rescanning every row for every note. The TinyCloud Transcriber sync no longer reads every saved transcript to compare versions, checks only meetings it hasn't already confirmed this session, runs once per interval across all open tabs instead of once per tab (a tab whose sync makes no progress for a minute hands over to the others), and waits while the device is offline. After a database save times out, retries wait until the space has finished the abandoned request instead of queueing behind it.

## 0.8.2-beta.0

### Patch Changes

- a4664bc: Exo desktop: Pause no longer shows "Paused" before it completes, and Stop settles instead of hanging while preserving the recorded audio. A Stop timeout does not confirm microphone release; the microphone may remain in use until Exo restarts (TC-1158).

## 0.8.1

### Patch Changes

- a31b425: Fixes the Google Meet sync dialog getting stuck after the last meeting; it doesn't speed up slow storage responses, so a slow sync may now end with an error and a Retry button instead of hanging.

  Web only; no desktop or mobile release.

## 0.8.1-beta.0

### Patch Changes

- a31b425: Show a bounded Finishing phase while Google Meet sync reconciles Notes and saves its final state. Surface finalization failures with in-dialog Retry, preserving saved meetings and preventing late completion from an abandoned attempt. Refresh the connector row once for both owned and joined syncs.

  This fixes the dialog getting stuck; it does not fix slow storage responses, so a slow sync may now end with an error and a Retry button instead of hanging.

## 0.8.0

### Minor Changes

- 111162e: Keep agent access status visible in chat and refresh it after connectivity changes.
- 27569de: Add an explicit, confirmed action to transcribe a committed voice note again while preserving and addressing its previous transcript revision.
- 8e2a931: Handle a full TinyCloud storage across voice notes. While storage is full, audio uploads pause: the audio stays on this device and shows as waiting for space. Each upload pass tries audio at most once while storage refuses it, so a full store is not probed once per note. The storage message is the same everywhere it appears. Plan detail appears only on the Settings banner and dialog, and Upgrade shows only when the plan is positively Free and the paywall is on. "Manage storage" opens the storage page in the external browser. Settings shows the storage state, and the upload and transcriber switches show "Paused: storage full".

  A transcript that storage refuses is handled by where it was transcribed:
  - On this device, the transcript is held on the device and marked as kept until space is available. A held transcript is retried on foreground, and after a successful write to storage. A transcript that is still refused stays held. A successful write that lands while a recovery pass is already running doesn't trigger another pass; the next write or a foreground event (focus, visibility, app active) does.
  - Private, a storage-full save fails the transcript with a non-retryable `storage_full` failure. It says the transcript wasn't saved and offers Manage storage, then Transcribe again. It says the recording is safe on this device only when the local audio is confirmed ready. Nothing retries it automatically.

  Private and hosted transcript retention (keeping a refused transcript for a later save) is not part of this change.

  A transcript save on this device that times out fails with its own "took too long" message and can be retried. It is a persisted failure, not a storage hold.

- 97cd667: Sync voice-note text independently of audio uploads and publish each local transcript revision once.

### Patch Changes

- 2b6fa8f: Keep held voice-note transcripts in a durable per-account web store.
- 187227d: Retry re-reads a missing committed transcript body.
- 898976d: Verify Private voice-note choices are stored before transcription starts.
- 58f12d7: Never evict local voice-note recordings during cache trim or Clear; clear downloaded playback copies instead.
- fa85621: Fix the Private transcription length boundary. Eligibility compares the unrounded note length with PTX's limit from `/capabilities`: `accepted_max_duration_seconds` (PTX's inclusive ceiling on measured duration) when present, otherwise `max_duration_seconds` plus the optional `duration_grace_seconds`. The client keeps a 0.25 s margin below the ceiling. Client-built WAVs are rechecked against the greater of the precise saved duration and exact decoded payload duration, and the latest byte cap is checked against the actual payload. Legacy integer durations use a conservative +0.5 s estimate. No Private limit is hard-coded; without a complete duration and byte advertisement Private is not offered. The backend relays the optional duration fields when PTX sends them; a client-only deploy is safe. Clock-style media durations floor fractional seconds consistently for the total and current position, and a refused Private start returns its refusal to the caller.
- f9ab032: Play voice notes from device audio whenever it exists and cache complete space downloads for later playback. Settings shows cache size and clears downloaded playback copies only; original recordings are never evicted in 0.8.0.
- 6f5605d: Show stored transcript timings in note detail with seek, playback follow, timestamped copy, and Markdown export.
- ec28052: Run recorder file operations and recovery encoding away from the macOS main thread, and stop native Whisper work when its deadline expires.
- 4d8481e: Keep stopped Mac audio sources durable before showing the save receipt, then prepare playable audio in a recoverable background job with reader gates and a quit prompt.
- 22eb64f: Keep iOS recorder Stop work off the main thread and limit Android local transcription progress updates.
- 272e402: Use a deterministic clock when checking the Private transcription retry timer.
- a436537: Hosted AssemblyAI transcription is not available in 0.8.0. This release includes dedupe and durable-spool groundwork only; it takes effect in a future, separately approved rollout.
- eb70350: Show current voice-note work in a shared Activity panel and note status line, with accurate destinations and retry actions.
- 7a024fb: Persist optional PTX quiet-mode VAD diagnostics with voice-note transcription outcomes.
- 7cd762c: Notify once for each voice-note track failure away from its note, with actionable deep links and a lazy Mac notification permission request. Dedupe retries by stable failure class and retain consumed failures across restarts without a 500-item limit.
- d4db840: Use the canonical storage-full wording: drop the "free up space or upgrade your plan" advice (deleting doesn't lower usage yet, and paid plans have nothing to upgrade to), and open Manage storage on the billing page's storage-full view.
- b341b89: Preserve short, timed transcript segments from local and hosted engines, including channel identity and honest coarse timing.

  The backend hosted transcript GET responses gain additive sentence word times and normalized channel fields. Until the backend is deployed, long Powerful sentences fall back to coarse word-boundary splits.

  A 0.7.1 same-revision write can still overwrite a richer transcript body. The next new-client commit repairs it on resync; this is repair, not prevention.

- f4a2184: TC-760: Preserve partial transcript gaps and provenance, and show missing and recovered speech in Library notes.
- ada6d55: Keep calendar autojoin enabled when reconnecting the same Google account and explain why it is off in connector settings and Meeting sources.
- 42fbd33: Keep a shared Google grant when another live calendar autojoin account still uses it, while removing the disconnecting account's local credentials. Explain that Google access can be revoked from another TinyChat account or Google settings.
- d337c7d: Clarify private transcription progress by labeling completed parts.
- 955addc: Publish retrieval records with engine, provider, and model provenance paired with the selected Exo voice-note transcript body.
- 710b410: Recover opted-in saved Private voice notes after availability returns, rate-limit automatic availability checks, bound readiness to each note's save progress, and keep pending notes actionable while Private cloud is unavailable.
- c745b4d: Keep completed Private transcription results until the shared transcript commit is verified; keep device-local save and admission failures out of shared failure metadata.
- bd43e90: Keep completed Private voice-note jobs available until transcript saves commit, and recover pending notes after admission drains or retryable failures.
- 9c9bba8: Prefetch the web sign-in manifest and single-use nonce while OpenKey connects, refreshing stale nonces before signing. Requires backend SIWE domain and URI validation (TC-1201) before preview or release; native sign-in is unchanged.
- a3a1e77: Use note-specific queue state for upload waiting copy.
- 7246c82: Update the Exo transcription-mode glyphs, Audio only card copy, and slider accessible name.
- 9abab0d: Keep Mac microphone and system audio in separate note channels, transcribe them as Me and Them, and play notes in mono.
- bfd8aae: Add a per-device audio upload setting that defaults off, keeps audio on the recording device while syncing the note and transcript, and offers an explicit upload action for individual notes. Remove the unused Mac auto-save setting.
- dfadb5b: Show separate mic and system-audio levels on Mac recordings, with the recorder ring following Me and a thin Them trace during system capture.

## 0.8.0-beta.4

### Minor Changes

- 111162e: Keep agent access status visible in chat and refresh it after connectivity changes.
- 27569de: Add an explicit, confirmed action to transcribe a committed voice note again while preserving and addressing its previous transcript revision.
- 8e2a931: Handle a full TinyCloud storage across voice notes. While storage is full, audio uploads pause: the audio stays on this device and shows as waiting for space. Each upload pass tries audio at most once while storage refuses it, so a full store is not probed once per note. The storage message is the same everywhere it appears. Plan detail appears only on the Settings banner and dialog, and Upgrade shows only when the plan is positively Free and the paywall is on. "Manage storage" opens the storage page in the external browser. Settings shows the storage state, and the upload and transcriber switches show "Paused: storage full".

  A transcript that storage refuses is handled by where it was transcribed:
  - On this device, the transcript is held on the device and marked as kept until space is available. A held transcript is retried on foreground, and after a successful write to storage. A transcript that is still refused stays held. A successful write that lands while a recovery pass is already running doesn't trigger another pass; the next write or a foreground event (focus, visibility, app active) does.
  - Private, a storage-full save fails the transcript with a non-retryable `storage_full` failure. It says the transcript wasn't saved and offers Manage storage, then Transcribe again. It says the recording is safe on this device only when the local audio is confirmed ready. Nothing retries it automatically.

  Private and hosted transcript retention (keeping a refused transcript for a later save) is not part of this change.

  A transcript save on this device that times out fails with its own "took too long" message and can be retried. It is a persisted failure, not a storage hold.

- 97cd667: Sync voice-note text independently of audio uploads and publish each local transcript revision once.

### Patch Changes

- 2b6fa8f: Keep held voice-note transcripts in a durable per-account web store.
- 187227d: Retry re-reads a missing committed transcript body.
- 898976d: Verify Private voice-note choices are stored before transcription starts.
- 58f12d7: Never evict local voice-note recordings during cache trim or Clear; clear downloaded playback copies instead.
- fa85621: Fix the Private transcription length boundary. Eligibility compares the unrounded note length with PTX's limit from `/capabilities`: `accepted_max_duration_seconds` (PTX's inclusive ceiling on measured duration) when present, otherwise `max_duration_seconds` plus the optional `duration_grace_seconds`. The client keeps a 0.25 s margin below the ceiling. Client-built WAVs are rechecked against the greater of the precise saved duration and exact decoded payload duration, and the latest byte cap is checked against the actual payload. Legacy integer durations use a conservative +0.5 s estimate. No Private limit is hard-coded; without a complete duration and byte advertisement Private is not offered. The backend relays the optional duration fields when PTX sends them; a client-only deploy is safe. Clock-style media durations floor fractional seconds consistently for the total and current position, and a refused Private start returns its refusal to the caller.
- f9ab032: Play voice notes from device audio whenever it exists and cache complete space downloads for later playback. Settings shows cache size and clears downloaded playback copies only; original recordings are never evicted in 0.8.0.
- 6f5605d: Show stored transcript timings in note detail with seek, playback follow, timestamped copy, and Markdown export.
- ec28052: Run recorder file operations and recovery encoding away from the macOS main thread, and stop native Whisper work when its deadline expires.
- 4d8481e: Keep stopped Mac audio sources durable before showing the save receipt, then prepare playable audio in a recoverable background job with reader gates and a quit prompt.
- 22eb64f: Keep iOS recorder Stop work off the main thread and limit Android local transcription progress updates.
- 272e402: Use a deterministic clock when checking the Private transcription retry timer.
- a436537: Hosted AssemblyAI transcription is not available in 0.8.0. This release includes dedupe and durable-spool groundwork only; it takes effect in a future, separately approved rollout.
- eb70350: Show current voice-note work in a shared Activity panel and note status line, with accurate destinations and retry actions.
- 7cd762c: Notify once for each voice-note track failure away from its note, with actionable deep links and a lazy Mac notification permission request. Dedupe retries by stable failure class and retain consumed failures across restarts without a 500-item limit.
- d4db840: Use the canonical storage-full wording: drop the "free up space or upgrade your plan" advice (deleting doesn't lower usage yet, and paid plans have nothing to upgrade to), and open Manage storage on the billing page's storage-full view.
- b341b89: Preserve short, timed transcript segments from local and hosted engines, including channel identity and honest coarse timing.

  The backend hosted transcript GET responses gain additive sentence word times and normalized channel fields. Until the backend is deployed, long Powerful sentences fall back to coarse word-boundary splits.

  A 0.7.1 same-revision write can still overwrite a richer transcript body. The next new-client commit repairs it on resync; this is repair, not prevention.

- d337c7d: Clarify private transcription progress by labeling completed parts.
- 955addc: Publish retrieval records with engine, provider, and model provenance paired with the selected Exo voice-note transcript body.
- 710b410: Recover opted-in saved Private voice notes after availability returns, rate-limit automatic availability checks, bound readiness to each note's save progress, and keep pending notes actionable while Private cloud is unavailable.
- c745b4d: Keep completed Private transcription results until the shared transcript commit is verified; keep device-local save and admission failures out of shared failure metadata.
- bd43e90: Keep completed Private voice-note jobs available until transcript saves commit, and recover pending notes after admission drains or retryable failures.
- 9c9bba8: Prefetch the web sign-in manifest and single-use nonce while OpenKey connects, refreshing stale nonces before signing. Requires backend SIWE domain and URI validation (TC-1201) before preview or release; native sign-in is unchanged.
- a3a1e77: Use note-specific queue state for upload waiting copy.
- 7246c82: Update the Exo transcription-mode glyphs, Audio only card copy, and slider accessible name.
- 9abab0d: Keep Mac microphone and system audio in separate note channels, transcribe them as Me and Them, and play notes in mono.
- bfd8aae: Add a per-device audio upload setting that defaults off, keeps audio on the recording device while syncing the note and transcript, and offers an explicit upload action for individual notes. Remove the unused Mac auto-save setting.
- dfadb5b: Show separate mic and system-audio levels on Mac recordings, with the recorder ring following Me and a thin Them trace during system capture.

## 0.7.4

### Patch Changes

- 7a024fb: Persist optional PTX quiet-mode VAD diagnostics with voice-note transcription outcomes.
- ada6d55: Keep calendar autojoin enabled when reconnecting the same Google account and explain why it is off in connector settings and Meeting sources.
- 42fbd33: Keep a shared Google grant when another live calendar autojoin account still uses it, while removing the disconnecting account's local credentials. Explain that Google access can be revoked from another TinyChat account or Google settings.
- c745b4d: Keep completed Private transcription results until the shared transcript commit is verified; keep device-local save and admission failures out of shared failure metadata.

## 0.7.4-beta.4

### Patch Changes

- c745b4d: Keep completed Private transcription results until the shared transcript commit is verified; keep device-local save and admission failures out of shared failure metadata.

## 0.7.4-beta.3

### Patch Changes

- 42fbd33: Keep a shared Google grant when another live calendar autojoin account still uses it, while removing the disconnecting account's local credentials. Explain that Google access can be revoked from another TinyChat account or Google settings.

## 0.7.4-beta.2

### Patch Changes

- ada6d55: Keep calendar autojoin enabled when reconnecting the same Google account and explain why it is off in connector settings and Meeting sources.

## 0.7.4-beta.1

### Patch Changes

- f4a2184: TC-760: Preserve partial transcript gaps and provenance, and show missing and recovered speech in Library notes.

## 0.7.4-beta.0

### Patch Changes

- 7a024fb: Persist optional PTX quiet-mode VAD diagnostics with voice-note transcription outcomes.

## 0.7.3

### Patch Changes

- ec28052: Run recorder file operations and recovery encoding away from the macOS main thread, and stop native Whisper work when its deadline expires.
- 5b5ca03: Use PTX VAD-drop stats for incomplete-transcript retries and track missing stats.
- b5a4d09: Use specific private-cloud failure copy for persisted voice-note transcription failures.
- 438d85b: Accept transcript sentence spans up to the shared 60-second turn limit for timestamped playback and copying.
- 60e745c: Reduce PTX and hosted transcription status polling after the initial fast phase, honor rate-limit retry deadlines, expose limiter headers to browser clients, and keep throttling separate from failure budgets.

## 0.7.3-beta.4

### Patch Changes

- 438d85b: Accept transcript sentence spans up to the shared 60-second turn limit for timestamped playback and copying.

## 0.7.3-beta.3

### Patch Changes

- 60e745c: Reduce PTX and hosted transcription status polling after the initial fast phase, honor rate-limit retry deadlines, expose limiter headers to browser clients, and keep throttling separate from failure budgets.

## 0.7.3-beta.2

### Patch Changes

- 5b5ca03: Use PTX VAD-drop stats for incomplete-transcript retries and track missing stats.

## 0.7.3-beta.1

### Patch Changes

- b5a4d09: Use specific private-cloud failure copy for persisted voice-note transcription failures.

## 0.7.3-beta.0

### Patch Changes

- ec28052: Run recorder file operations and recovery encoding away from the macOS main thread, and stop native Whisper work when its deadline expires.

## 0.7.2

### Patch Changes

- 6f5605d: Show stored transcript timings in note detail with seek, playback follow, timestamped copy, and Markdown export.
- b1b58a1: Open Google consent in the system browser on Exo Mac, receive the authorization code through a validated one-shot loopback listener, and exchange it using a Google Desktop OAuth client. Offer a same-tab return when a web popup is blocked.
- 1834edf: TC-1016: reuse notetaker send idempotency keys across retries and coalesce active or concurrent sends for the same meeting URL.
- f7a1fa8: Route explicit Private transcription requests through the committed-mode override.
- e844f56: Normalize PTX MIME types and surface durable transcription outcomes in the Library.
- c88319e: Preserve Fireflies' last successful sync time on failed runs, surface 24-hour staleness, and run a bounded browser catch-up when a stale connector is available on mount or unlock.
- 5eb65ed: (TC-983) Keep the transcriber heartbeat at 50 minutes; with successful passes of ≤ 60 seconds and timely 30-second timer execution, `checked_at` lag is ≤ H + 2D + I = 50 min + 2×60 s + 30 s = 52 min 30 s < 1h30s.

## 0.7.2-beta.6

### Patch Changes

- 6f5605d: Show stored transcript timings in note detail with seek, playback follow, timestamped copy, and Markdown export.

## 0.7.2-beta.5

### Patch Changes

- b1b58a1: Open Google consent in the system browser on Exo Mac, receive the authorization code through a validated one-shot loopback listener, and exchange it using a Google Desktop OAuth client. Offer a same-tab return when a web popup is blocked.

## 0.7.2-beta.4

### Patch Changes

- c88319e: Preserve Fireflies' last successful sync time on failed runs, surface 24-hour staleness, and run a bounded browser catch-up when a stale connector is available on mount or unlock.

## 0.7.2-beta.3

### Patch Changes

- e844f56: Normalize PTX MIME types and surface durable transcription outcomes in the Library.

## 0.7.2-beta.2

### Patch Changes

- f7a1fa8: Route explicit Private transcription requests through the committed-mode override.

## 0.7.2-beta.1

### Patch Changes

- 5eb65ed: (TC-983) Keep the transcriber heartbeat at 50 minutes; with successful passes of ≤ 60 seconds and timely 30-second timer execution, `checked_at` lag is ≤ H + 2D + I = 50 min + 2×60 s + 30 s = 52 min 30 s < 1h30s.

## 0.7.2-beta.0

### Patch Changes

- 1834edf: TC-1016: reuse notetaker send idempotency keys across retries and coalesce active or concurrent sends for the same meeting URL.

## 0.7.1

### Patch Changes

- 79a072f: Voice notes now persist transcription outcomes and keep unsent or failed notes retryable in the Library.
- 1c5e68b: Publish TinyChat retrieval pack 0.1.1-onboarding.21 with metadata-only backend-pending coverage.
- 1d60115: Update the TinyCloud SDK family to 3.2.1 for the sign-in wait and repeat-login re-bootstrap fixes (TC-998, TC-999).

## 0.7.1-beta.2

### Patch Changes

- 1c5e68b: Publish TinyChat retrieval pack 0.1.1-onboarding.21 with metadata-only backend-pending coverage.

## 0.7.1-beta.1

### Patch Changes

- 1d60115: Update the TinyCloud SDK family to 3.2.1 for the sign-in wait and repeat-login re-bootstrap fixes (TC-998, TC-999).

## 0.7.1-beta.0

### Patch Changes

- 79a072f: Voice notes now persist transcription outcomes and keep unsent or failed notes retryable in the Library.

## 0.7.0

### Minor Changes

- 8ec1482: Existing browser sync passes persist a metadata-only snapshot of backend-ingested and completed transcriber meetings that are still unreconciled or unsaved. `changed_at` records projection changes; `checked_at` is the observation time of the last persisted source check. Backend-ingest updates on existing mount/unlock passes only. Transcriber unchanged projections refresh at most hourly on its existing 30-second active/unlocked pass, so its consumer freshness threshold must exceed 1 hour plus 30 seconds. The snapshot uses the retrieval pack's existing connector read grant. Pack consumption is intentionally deferred until TC-977 merges.
- 20faa03: Refresh saved transcriber transcripts when ptx publishes a newer version, keeping previous copies in an immutable archive and preserving edited meeting titles and start times (TC-989).

### Patch Changes

- ddbadf9: fix(exo desktop): allow the system-audio consent commands so Mac recording can start
- 5918a34: feat(exo): agent-readable logging in dev builds (desktop log file, iOS container log and os_log, Android logcat ExoDev), with secret redaction; release builds stay quiet
- b32bc87: fix(exo): show local transcripts before upload, mark them saved only after a verified write, and show transcription and upload progress side by side on the Mac
- 244d7a6: Update TinyCloud web, node, core, and services SDKs to 3.2.0 and OpenKey SDK and Capacitor plugin to their stable releases, retaining the session-key patch for the TinyCloud node SDK.
- 3b92372: Handle Exo transcript omissions and channel speakers, honor voice-note commit and legacy-winner semantics from TC-978, and publish retrieval pack 0.1.1-onboarding.19.
- 8946533: Keep retrieval latest queries compatible with sqlparser-rs using nested LTRIM/RTRIM.
- 37ef2fa: Treat the private transcriber's literal 'Unknown' speaker as unattributed (null) and keep it out of participants (TC-981).
- 2ac09a6: Widen Calendar autojoin's late-join window, preserve truthful RSVP outcomes without hiding dispatch failures, skip unchanged RSVP writes, and record discovery and dispatch lag (TC-988).

## 0.7.0-beta.9

### Patch Changes

- 8946533: Keep retrieval latest queries compatible with sqlparser-rs using nested LTRIM/RTRIM.

## 0.7.0-beta.8

### Patch Changes

- 5918a34: feat(exo): agent-readable logging in dev builds (desktop log file, iOS container log and os_log, Android logcat ExoDev), with secret redaction; release builds stay quiet

## 0.7.0-beta.7

### Patch Changes

- b32bc87: fix(exo): show local transcripts before upload, mark them saved only after a verified write, and show transcription and upload progress side by side on the Mac

## 0.7.0-beta.6

### Minor Changes

- 8ec1482: Existing browser sync passes persist a metadata-only snapshot of backend-ingested and completed transcriber meetings that are still unreconciled or unsaved. `changed_at` records projection changes; `checked_at` is the observation time of the last persisted source check. Backend-ingest updates on existing mount/unlock passes only. Transcriber unchanged projections refresh at most hourly on its existing 30-second active/unlocked pass, so its consumer freshness threshold must exceed 1 hour plus 30 seconds. The snapshot uses the retrieval pack's existing connector read grant. Pack consumption is intentionally deferred until TC-977 merges.

## 0.7.0-beta.5

### Patch Changes

- 2ac09a6: Widen Calendar autojoin's late-join window, preserve truthful RSVP outcomes without hiding dispatch failures, skip unchanged RSVP writes, and record discovery and dispatch lag (TC-988).

## 0.7.0-beta.4

### Patch Changes

- 3b92372: Handle Exo transcript omissions and channel speakers, honor voice-note commit and legacy-winner semantics from TC-978, and publish retrieval pack 0.1.1-onboarding.19.

## 0.7.0-beta.3

### Patch Changes

- ddbadf9: fix(exo desktop): allow the system-audio consent commands so Mac recording can start

## 0.7.0-beta.2

### Minor Changes

- 20faa03: Refresh saved transcriber transcripts when ptx publishes a newer version, keeping previous copies in an immutable archive and preserving edited meeting titles and start times (TC-989).

## 0.6.1-beta.1

### Patch Changes

- 244d7a6: Update TinyCloud web, node, core, and services SDKs to 3.2.0 and OpenKey SDK and Capacitor plugin to their stable releases, retaining the session-key patch for the TinyCloud node SDK.

## 0.6.1-beta.0

### Patch Changes

- 37ef2fa: Treat the private transcriber's literal 'Unknown' speaker as unattributed (null) and keep it out of participants (TC-981).

## 0.6.0

### Minor Changes

- acea78c: Capture shows what's in progress and your recent notes. The Library has filters and durations, and each note shows how it got into your space.
- c05aa4e: Discard a recording you didn't mean to make: "Discard" in the recorder's header asks "Discard?" in place, with Keep and Discard. A discarded recording is stopped and deleted from the phone, never saved to your space, even if the app closes before the delete finishes.
- 4dae5f8: Shorter screens: hints in tooltips and a How it works page
- c81e6bc: Exo's new look: navy Night and paper Day themes (following your system), Literata display type, motion tokens.
- f5f20ac: Record from Capture or the chat header. A focused recorder shows where your audio goes, minimises to a live island that follows you, and shows a receipt when your note lands in your space.
- ef2f000: Capture, Chat and Connectors are the three destinations: a tab bar on phones, a rail on landscape phones and tablets, a sidebar on desktop. The phone app opens on Capture. Android Back closes sheets first.
- aa2e1f9: Upload audio and send a notetaker from Capture: each opens its own sheet (a dialog on wider screens) that shows where the audio goes, with a receipt when the transcript lands. Interrupted uploads resume on launch, and wait as "Upload paused · Continue" when your own AssemblyAI key is locked. The desktop app records on this Mac from a card at the top of Capture that keeps recording while you navigate.
- d5e1894: Add the Android native capture engine, durable voice-note recovery, app shortcut and recording notification controls.
- 671f28c: Add on-device transcription for Exo voice notes: an "On this phone" transcriber choice in the recorder and Settings, a downloadable Parakeet/sherpa-onnx model with Wi-Fi-only download and sha256 verification, and native decode-and-transcribe after Stop that works signed out and offline.
- 3661337: Native OpenKey sign-in (TC-775) is now the only sign-in path on iOS and Android — the `VITE_EXO_NATIVE_OPENKEY` build flag is gone, and so is the embedded-widget fallback on those two platforms. A widget session persisted on a device from before this change is cleared once on the next launch; the user signs in again through the native flow. Web and the Tauri desktop app are unchanged and keep the embedded widget. The registered native OpenKey client id is now committed config (`frontend/.env.production`), not something a build flag gated.
- a376332: Add native iOS voice-note capture with durable segments, recovery, account-aware sidecars, and a home-screen recording shortcut.
- da282d4: Show native voice recordings in a full-page view with pause, a waveform, and immediate local playback after Stop. Keep committed audio on the phone after upload.
- 3973e7f: Add iOS recording interruption recovery, stale notification protection, and audio input routing.
- c79b024: Add Android recording interruption recovery, paused resume notifications, and microphone input selection.
- 1cabcd5: Keep existing data readable when storage is full and show clear write failures.
- c65d24f: Add feature-gated server delivery of Private Transcription transcripts into a user's connector SQL and KV space using a verified, narrow session-key delegation. Preserve the browser importer as a ten-minute fallback and keep production rollout blocked on the node SQL-scope fix (TC-825).
- b6ffb9b: Native OpenKey sign-in for the Exo app (TC-775 E1). Inside the iOS/Android app only, sign-in runs the OpenKey delegation flow (PAR + PKCE in the system browser) and restores a TinyCloudWeb session whose key lives in the device secure store — the web and Tauri desktop keep the embedded widget. The backend's `/api/auth/nonce` now accepts a request without `address` and issues an unbound, single-use, 5-minute nonce that `/verify` binds to the recovered signer. Secrets-dependent surfaces (connector connect/sync/disconnect, queued sync, the background drains, own AssemblyAI key) are gated on native sessions, which have no vault capability; voice notes are unaffected.
- fb6cce4: Restore native OpenKey sessions across app and backend JWT restarts, renew delegations before expiry, and swap the live TinyCloud session while preserving voice-note pending-save recovery. Bound native backend authentication fetches with a timeout.
- 99f170a: Keep one native recorder available above sign-in, show local notes while signed out, and durably hand off capture ownership before clearing credentials. Claim signed-out notes at the next ready session and save them through the account-aware pipeline.

### Patch Changes

- 6d9a101: Keep the native renewal test's voice-note save fixture from leaking into later Bun test files.
- 177ddc9: Expose recorded elapsed time and native mic state reasons
- 15f5c94: Persist Android capture account state, remote cleanup receipts, and recovery actions.
- d0f143f: Make the Android compensation debug hook fail both the sign-out and compensation writes so the account remains transitioning.
- 73cc903: Show Android Private upload status errors with a retry without delaying the app's first paint, and classify missing desktop audio by its IO error kind.
- ed379a7: Map microphone RMS to the recorder's perceptual level once across native, desktop, and web capture.
- 108e63e: Add a flag-gated desktop Meeting sources entry and shared modal on Connectors.
- 99e4f56: Voice-note save failures now retain their cause and upload state across retries and recovery.
- b32e046: Fix Android STT benchmark VAD framing by feeding Silero one decision window at a time.
- 01dab09: Show the target, version, build number and commit at the foot of the boot screen, the desktop sidebar and the bottom of Settings; a tap copies the line.
- 108e63e: Fix the Capture settings e2e: expose one fake service on the harness page and target the Capture heading exactly.
- 8bb9f4e: Sign-in no longer shows raw errors: Android WebViews without Ed25519 now sign in (or point to the WebView update), closing OpenKey is a quiet cancel, sign-out waits for your OpenKey confirmation, and the app is called Exo on the boot screen and in OpenKey.
- 9099a86: Signing out no longer says OpenKey sign-out "could not be verified". When OpenKey can't confirm it signed out, Exo shows one calm line: "Signed out of Exo. To use a different account, also sign out at openkey.so."
- bf477cb: Add pure view models and Soft-skin foundations for the final recorder.
- 108e63e: Capture settings: the local-model picker is a standard radio group of downloaded models, with the rest as plain rows with Get, and focus follows a download from Get to progress to the new radio.
- 108e63e: Add the desktop Capture settings popover and the DesktopCaptureExtras seam it reads, behind the final recorder flag.
- b16eca5: Stop local transcript sync before it writes across account changes.
- 5dea60d: Keep Android microphone-state reasons within the native contract, carry diagnostic detail separately, and publish read failures only after entering interrupted state.
- 972778c: Skip queued transcriber completeness reads after the account pass is cancelled.
- 108e63e: The desktop Capture home's Recent row now says so when a partial-audio notice could not be dismissed: the same inline alert as the phone sheet, on that row, with the notice kept and focus left on Dismiss.
- 108e63e: Connect the Tauri recorder to the shared voice-note contract and store its audio in Rust-owned files.
- 108e63e: Default the new desktop recorder to capturing system audio and keep corrupt recorder settings from blocking app launch. Remove the classic desktop capture engine and its native private-cloud uploader; retain transcript saving for meetings and uploads.
- 108e63e: Start existing desktop beta users with system audio on in the new recorder, while preserving choices they make afterward. Remove the unused classic cloud bridge and local-stt model download permissions.
- 108e63e: Transcribe stopped desktop recorder notes locally with the selected Whisper model, and resume unfinished transcription after a WebView reload.
- 108e63e: Store recording Markdown and moments with voice notes
- 108e63e: Add the recorder engine seam: one selector installs the native, web or desktop engine at boot (web and desktop only with the final recorder on), and native-only calls are gated on the engine's capabilities.
- f07bac3: Make unavailable recorder modes actionable, quiet the mic-denied ring, and reserve rail space for the minimized Ribbon.
- 5ce67a5: On iOS, Local transcription uses Apple's built-in on-device speech instead of downloading a 640 MB model. iOS now requires 26.
- 85aa07b: Keep iOS recording account state and remote cleanup receipts durable, recover parked pauses, and expose recovery actions.
- 3eea2fc: The phone recorder fits landscape, 320 px phones and large text: the ring is sized from its stage, the controls stay reachable by scrolling, and Done and Discard stay when the microphone drops. Desktop toasts no longer cover the status and timer.
- 477b730: Recover voice-note saves after a fresh sign-in and show the recorder for cold iOS quick actions.
- 3e3571a: Fix Android recorder Back handling, Gboard moment submission, automatic-stop copy, new-recording state, status-bar colors, and Recent note opening.
- ee207ba: Hold each recorder halo atlas bitmap for one frame before closing it. The two smallest rings were seen blank intermittently on WebKit; the WebGL draw itself is correct, and the suspected cause is closing the bitmap straight after `drawImage`. This is a hardening change: the blank was not reproduced on demand, so the fix is unproven until checked on an iPhone.
- 83cd123: Route voice notes by their committed transcriber choice and expose one recorder choice API
- 003fe5b: Keep recordings on the phone when sign-out suspends an upload, and move the app to the signed-out screen after a shared 401 session clear.
- 47cc4f7: Never say Exo will finish a recording automatically when it couldn't recover or save it, and add Try again and Delete (with a confirmation) to the couldn't-recover sheet, including recordings the phone quarantined
- 94b694c: The Done receipt is honest about a Local note: the source reads "This phone" until a transcript exists, "Saved on this phone" is said once, the gap above the receipt is gone, and a note waiting on the model shows a static "Needs the on-device model" with "Get model" and "Use Private instead" (no spinner), kept open for 10 seconds while there is something to press. A saved note's transcript block is one sentence ("Transcribe on this phone — needs a 640 MB download") with a full-width button, and offers "Transcribe with Private instead" when Private is available. Switching to Private waits until the phone's own record says the on-device job has ended (a note whose Local result already exists is never cancelled or switched, and Android no longer marks a finished note "cancelled"; iOS gets that from #263), a Private choice survives a restart, including after a retryable failure before the cloud job exists, the receipt says "Transcribing" only while a private job is really running (Audio only says nothing; finished and failed Private notes say so), and a receipt with Open stays 10 seconds. On the saved-note sheet the "Get model" and "Transcribe with Private instead" buttons are visible outline buttons in the dark theme too (they use the sheet's own fill and ring, as "Add a note" does).
- 12ec582: Keep recorder harnesses rendering with a real string space ID, validate capture issue scope after mount, and reconcile status before the best-effort sidecar scan.
- 5252d10: Choosing Local, or recording on Local, now starts the on-device model download by itself and never blocks recording. The note is saved normally and is transcribed on the phone once the model is ready, including after the app is relaunched mid-download. Progress shows quietly ("Downloading on-device model · 42%"), a failure says so with "Try again", and the Wi-Fi-only rule shows "Waiting for Wi-Fi" instead of a dead end. A Local choice is never silently switched to another transcriber.
- 0b32ebe: Play a saved note that is still on the phone through the audio element's direct file URL (resolved on Play) instead of fetching it, which iOS answers with status 0.
- 12957c2: Show Mac recording inputs in Via and Capture settings, persist the selected microphone, and report disconnected devices while recording from the current default.
- 297ca1a: Restore Mac Private transcription uploads from the local recording and report service failures as retryable.
- Merges main into the Exo iOS dogfood branch: the Library refreshes after transcript saves together with the account-checked on-device transcript sync, and Notetaker meetings save through the shared core writer.
- b60d99a: Brings the Exo dogfood fixes onto main's TinyCloud SDK 3.1 and shared-recording changes; shared recordings keep their "Shared recording" label next to the save state.
- d9c24a7: Show the full-page microphone recovery screen after an Android recording shortcut is denied, with a direct link to app settings.
- d780bde: Stream private voice-note uploads from native recording files instead of sending base64 audio through the WebView.
- 3d2d3a2: On iPhone and Android, signing in starts on Exo's own screen: an email field, Continue with Google and Use a passkey. The OpenKey sheet then opens straight on that step, and Android's browser bar is dark.
- 3177a1b: Route recorder private-cloud choices into native capture
- fb7e2d9: Add the note pipeline selector, stepper and row halo glyph (not wired into any screen yet).
- 49fba98: A voice note you just recorded now shows in Recent and the Library right away, marked "Saving…" or "On this phone", and opens from its local copy before the upload finishes. List rows are easier to tell apart: the title is the first moment or a transcript snippet (or "Voice note"), and the subtitle is the time and length.
- 23eebf2: One name for each transcription mode (Audio only, Local, Private, Powerful) in Settings, Upload, the route diagrams and saved notes, with Settings offering Private only when the recorder does. A voice note names a transcript maker only when it was transcribed. How it works says notes run up to 3 hours. Capture's In progress rows match the voice card, and the Connectors tab and Capture share one Meeting sources view whose row actions sit under the text on phones.
- e36018b: Update the OpenKey Capacitor SDK and use the shared Kotlin version for Android builds.
- 9e129f1: Native OpenKey error logs (sign-in, boot restore, renew) now include the HTTP status and OAuth error code, e.g. `boot restore: INVALID_GRANT (HTTP 400 invalid_grant)`, so a forced sign-out can be traced. Messages and tokens are still never logged.
- 54d9510: Show audio upload and transcript progress as independent tracks, including transcripts saved before their audio upload finishes.
- d47d9f9: Hide Conversation Canvas while its experimental rollout is paused, without deleting saved Canvas data.
- 108e63e: A pending-note save that fails after you switch accounts no longer shows its error on the new account's pending notes.
- 336bfcb: The recorder checks Private transcription again when the account is ready and when the app returns to the foreground, and shows "Checking…" or a failed check with "Check again". Local's "Get the on-device model" now starts the download with visible progress, size and errors, and a saved note waiting on the model says so (with a way to get it, retry, or the reason it failed) instead of "No transcript."
- d682e75: Hide other accounts' pending voice notes from signed-in capture, preserve a note's save error while newer notes upload, and log automatic save starts for device diagnosis.
- 9aa2dcc: Handle the private transcription service's 429 `capacity_exhausted` (TC-907). Calendar auto-join counts each create attempt once, so its backoff no longer doubles per attempt. An occurrence the service keeps refusing for capacity now ends after its joining window with the outcome "All TinyCloud notetakers were busy when this meeting started." Before, it was polled every 15 minutes indefinitely and never cleaned up. A manual send that hits the cap now shows the service's "All N meeting notetakers are busy…" message instead of the generic "temporarily unavailable" text, and the backend relays `Retry-After` and `retry_after_seconds` on any upstream 429.
- 02ba07e: Show automatic voice-note saving and explain when recordings belong to another account. Avoid repeating the space-wide archive sweep for each note.
- 8665739: Android Back now blurs only text-entry fields, and a failed moment mark clears the recorder's focus state.
- 69c83e2: The final phone recorder reads and changes the transcriber through the recorder provider, and names the mode that is unavailable.
- 108e63e: Add a flag-gated desktop recorder note view and a saved voice-note page and sheet with edit, copy and play-from-moment.
- 688dd3d: Keep voice-note save failures actionable and keep Recent in sync with the retry state.
- cfc7daf: Pin the OpenKey SDK WebView popup fix and explain when remote OpenKey sign-out is unavailable while completing local sign-out.
- e604971: Show a quiet "Saved — part of this recording couldn't be written" line on Recent and Library rows and on the saved receipt when a recording is missing some audio, with a details sheet (how much is missing, when known) and a Dismiss button
- 65cb50f: Add the final phone recorder screen behind VITE_EXO_RECORDER_FINAL (off by default).
- d6c97cd: Disclose Private transcription and Mac system audio capture before use, and require existing Private consents to be confirmed again.
- de2d034: Add the minimized final recorder behind the flag: a Ribbon above the tab bar, floating on the rail, and a dock in the sidebar.
- f044877: Improve theme-aware recorder contrast, visible halo discs, readable notetaker errors, and Chat banner placement.
- b8f8803: Keep a saved note's pipeline from reporting a false connection error while its space read waits behind uploads, and read again once they finish.
- be61865: Notes saved after the fact (relaunch, the sign-in claim of signed-out notes, Save now) are now handed to Private transcription once, with their own choice. Off stays off and Local is never sent to the cloud.
- 108e63e: Phone recorder: note moments with ＋ while recording, and a notes sheet with a Markdown writer and a lazily loaded Markdown preview (TC-881). The preview's WASM is no longer part of the service worker's install; it is cached after its first use.
- f23b956: Restore recorder controls when Android microphone access is granted while the app is away.
- 14aca2c: A mode changed mid-recording now stays on screen until the note is saved instead of snapping back to the default at Done. A signed-in phone that never chose a mode no longer defaults to Local while the on-device model is missing: it starts in Private (or Audio only) and says the model is needed; an explicit Local choice is kept and shows the same note.
- 7b17239: Refresh the Library when the new recorder lands a voice note through Stop, Save now, or sign-in recovery, and when on-device or private-cloud transcription (including recovery), a notetaker browser import or newly observed server delivery, or an audio upload commits a transcript. Revalidate only the saved note while preserving its audio and prior reads on failure, and retry failed reads on Try again or reopening. Ignore late saves from a previous account.
- c8c1e9b: Exo uses its original neutral palette again (zinc greys, light and dark, following the system theme). Recording is shown in red and warnings in amber.
- 58717da: Voice notes waiting on your phone now upload after a relaunch: a restored session keeps its space, and a saved session with no space shows a clear error instead of dropping you at sign-in.
- 108e63e: CI: split the frontend workflow so the Exo UI screens run one viewport per job and the browser harnesses run beside the unit tests; add the recorder follow-ups' interaction suites.
- 108e63e: Desktop Capture home (wide layout) behind the final-recorder flag: the Capture header with Library and the ⚙︎ settings, the idle start button and Back to recording, Upload, Meeting and Connect existing meetings, the "on this Mac" card on the app, and Recent with All / Notes / Meetings filters and capture-issue rows (including a partial-audio row with Dismiss). The Capture nav dot also shows on the rail.
- 108e63e: Bind the desktop capture settings to the Tauri recorder's model, system-audio and auto-save commands, and drop the Mac recorder card from Capture when the shared recorder is on.
- 108e63e: On the Mac app, the recorder's Local choice is Whisper: available (signed in or out) once a Whisper model is selected, named in its caption, and live as models download; saved notes and Recent rows show the after-stop Whisper progress and failure with Retry.
- 108e63e: Recorder phone UI fixes from the E1 pass: rounded focus rings on the moment field and the ＋ button, the saved note sheet keeps its formatting bar in view in Edit mode, and a failed Open Settings shows a generic line instead of the raw plugin error.
- 108e63e: Unsaved voice notes keep their Save now row on the web at rail widths ("in this browser"), and native tablets say "on this device" instead of "this Mac". The microphone recovery views show stable lines instead of native error text. Library filter chips are at least 44 px wide.
- 108e63e: The new recorder is the only recorder: `VITE_EXO_RECORDER_FINAL` is gone and the previous recorder screens, the live-edge indicator and the on-page local transcriber panel are removed. After Done, a receipt-only view shows the saved note.
- 108e63e: Recorder in a browser: the tab title follows the recording, the screen stays awake, leaving the page asks first, a keep-open notice shows once, a denied microphone gets site-permission guidance with Try again, the microphone list comes from the browser, and Local transcription stays closed on the web.
- ca5ccda: Fit the final recorder and Capture home on a 320 px phone: the Ribbon's trace stays clear of Pause (whose Day edge now shows), the modes card's labels wrap beside their dots, the paused pill keeps its distance from the minimise button, and the Capture actions fit.
- 58891dd: Soft-skin phone Capture home and Recent rows, with the capture-issue row states, behind the recorder-final flag (TC-871).
- b23d76c: Align recorder announcements with the final recorder UI and restore the dock spectrum gain and halo pixel checks.
- 233219e: Show accurate voice-note progress in lists and restore Save now when an online note is idle.
- 70a7956: Keep recorder, chat, connector, settings, and Capture controls readable and inside their layouts at 200% text size.
- c99ac25: Expose native capture recovery and write failures
- 108e63e: Expose recording note sync status and retry note loads with backoff
- e7f978f: Announce when microphone access is off in the recorder
- be3e182: Internal: split App.tsx into chat and shell modules.
- 108e63e: Test infrastructure: the Meeting sources e2e waits for Radix to move focus instead of reading it the instant the sheet unmounts, and the exo-ui harness readiness cap runs on `performance.now()` so `?freeze=1` can no longer hang a never-ready screen.
- e315bed: Voice notes now track on-device transcript syncing and queue position, and a stuck transcript read no longer blocks later retries.
- 5edd171: The note audio player shows how long the recording is as soon as it opens, with a loading state and a calm error, instead of 00:00 / 00:00. The receipt, the saved note, the Library detail and the on-phone note now share one player (play or pause, elapsed over total, scrubber).
- 08f2cdf: Show each voice note's pipeline (on this phone, in your space, transcript, notes) on the saved-note sheet and the recorder receipt, with its one next action.
- 598bd04: Show a calm recovery screen with a Reload action instead of a blank screen when the app hits an unexpected error, and recover the iOS and Android web views to the screen the user was on if the system ends their process while Exo is in the background.
- 9c6a376: On-device transcription no longer freezes the app: the iOS queue answers status and cancel while a note decodes, installed models are verified in the background (reported as "checking"), and cancel, retry and model-load races leave a note in one consistent final state.
- 108e63e: Show a one-time, dismissible notice in the desktop Capture settings that system audio is now included in Mac recordings.
- b425f3f: Save voice notes to their owner’s space with deterministic row identities and durable transcript commits.
- 799d72f: Calendar auto-join sends one bot when two connected accounts auto-join the same Meet (TC-581). The second account sends no bot while the other bot is in the call, and sends its own if that bot leaves within its joining window. It sees a neutral "Already being recorded by another TinyCloud account" state instead of a failure. With `CALENDAR_AUTOJOIN_SHARING` off (the default), that state never promises a transcript. With it on, the second account gets the transcript only if both checks pass: the other account is on its own invite, and its verified Google email accepted the bot owner's own invite. If the other account is not on its own invite, the collision shows as unverified ("an account we couldn't match to your invite") and is never shared. Shared recordings show as "Shared recording" and can be removed from your list, but not ended or deleted. Auto-join now also asks for the `email` scope; existing connections must reconnect before they can be matched or receive a share.
- 0913742: CI: split the frontend workflow so the Exo UI screens run one viewport per job and the browser harnesses run beside the unit tests.
- d8881bc: Make the iOS compensation failure probe keep account state transitioning after a failed sign-out handoff.
- d37cc52: Raise the Exo iOS minimum to iOS 18 and support a separate device test bundle identifier.
- adbbaa4: Move to TinyCloud js-sdk 3.1.0 (from 2.11.0). Sessions and grants keep their 30-day lifetimes; existing web and desktop sessions are not re-signed.
- d0c51c3: Open the app's iOS Settings page from the voice recorder's microphone access screen.
- ec1eac7: Report current iOS microphone permission in voice recorder status so access can refresh after Settings.
- 85ad869: Add the Halo Ticks recorder ring and level bar visualisers for the final recorder.
- 108e63e: Hide the legacy screen-edge glow when the final recorder is enabled.
- 25eb3df: Name local recording finalization and the saved receipt by device, and name the TinyCloud space and Private transcription in audio transfer progress.
- 14daf66: Honor the saved Local transcription mode and enable speaker identification for Private voice notes.
- 8249402: Stop note playback whenever capture starts or its controls become unavailable, and avoid opening a Mac output stream for mic-only capture.
- c3ad09b: Skip unchanged connector meeting row updates and log why saved transcriber meetings are incomplete.
- c173a11: Keep native renewal stopped when terminal sign-out cannot complete its capture handoff, while preserving renewal after a failed manual sign-out.
- 77bb2dd: Keep the empty chat welcome visible above the composer, compact the agent prompt during a minimized recording, and follow iOS Dynamic Type for rem-based text.
- 6f1e7cb: Keep transcriber API reads off the shared TinyCloud space write lane and yield between saved-recording completeness checks.
- 9c7a923: Voice-note saves now time out visibly while keeping retries safe on slow connections.
- a3cade0: Read retained voice-note audio locally before the space copy, use safe transcription error copy, and remove the private transcription ten-minute cap.
- db0a16d: Keep the Settings memory actions within narrow phone viewports.
- 7e4e880: Restore the recorder's neutral halo disc, visible dark-mode edges, and grey paused ring ticks.
- ecdc66f: A note with no transcript now has a Transcribe button with a small provider chip (Local by default, Private when offered), and a failed transcript's "Try again" lets you pick the provider.
- 45e43de: Anchor recorded elapsed time to the native checkpoint receipt
- 108e63e: Turn on the browser voice-notes engine behind the recorder flag: lazy registration, boot recovery, a fetch upload transport for private-cloud transcription, and mime-derived saved file extensions.
- 108e63e: Add a browser voice-notes engine (IndexedDB store, MediaRecorder capture, level meter) implementing the full VoiceNotesPlugin contract. Not wired in yet.
- 92f97f6: Keep partial-audio notices after a recording commits
- 108e63e: Add the desktop recorder ring view (rail and desktop layouts, in the main region), its discard confirmation and toasts, the overlay mount by layout, and shell × layout capabilities.
- 382193b: The recorder's ring ticks are neutral zinc instead of blue-violet, the timer no longer jitters (and the ＋ button no longer moves) as the digits change, and Capture and the recorder use the same fonts as Chat and Connectors.

## 0.6.0-beta.44

### Patch Changes

- c3ad09b: Skip unchanged connector meeting row updates and log why saved transcriber meetings are incomplete.

## 0.6.0-beta.43

### Patch Changes

- 73cc903: Show Android Private upload status errors with a retry without delaying the app's first paint, and classify missing desktop audio by its IO error kind.
- d6c97cd: Disclose Private transcription and Mac system audio capture before use, and require existing Private consents to be confirmed again.
- 25eb3df: Name local recording finalization and the saved receipt by device, and name the TinyCloud space and Private transcription in audio transfer progress.
- 14daf66: Honor the saved Local transcription mode and enable speaker identification for Private voice notes.

## 0.6.0-beta.42

### Patch Changes

- 297ca1a: Restore Mac Private transcription uploads from the local recording and report service failures as retryable.

## 0.6.0-beta.41

### Patch Changes

- 8249402: Stop note playback whenever capture starts or its controls become unavailable, and avoid opening a Mac output stream for mic-only capture.

## 0.6.0-beta.40

### Patch Changes

- d47d9f9: Hide Conversation Canvas while its experimental rollout is paused, without deleting saved Canvas data.

## 0.6.0-beta.39

### Patch Changes

- 54d9510: Show audio upload and transcript progress as independent tracks, including transcripts saved before their audio upload finishes.

## 0.6.0-beta.38

### Patch Changes

- 12957c2: Show Mac recording inputs in Via and Capture settings, persist the selected microphone, and report disconnected devices while recording from the current default.

## 0.6.0-beta.37

### Patch Changes

- ecdc66f: A note with no transcript now has a Transcribe button with a small provider chip (Local by default, Private when offered), and a failed transcript's "Try again" lets you pick the provider.

## 0.6.0-beta.36

### Patch Changes

- 3d2d3a2: On iPhone and Android, signing in starts on Exo's own screen: an email field, Continue with Google and Use a passkey. The OpenKey sheet then opens straight on that step, and Android's browser bar is dark.

## 0.6.0-beta.35

### Patch Changes

- d780bde: Stream private voice-note uploads from native recording files instead of sending base64 audio through the WebView.
- a3cade0: Read retained voice-note audio locally before the space copy, use safe transcription error copy, and remove the private transcription ten-minute cap.

## 0.6.0-beta.34

### Patch Changes

- 5edd171: The note audio player shows how long the recording is as soon as it opens, with a loading state and a calm error, instead of 00:00 / 00:00. The receipt, the saved note, the Library detail and the on-phone note now share one player (play or pause, elapsed over total, scrubber).
- db0a16d: Keep the Settings memory actions within narrow phone viewports.

## 0.6.0-beta.33

### Patch Changes

- 9e129f1: Native OpenKey error logs (sign-in, boot restore, renew) now include the HTTP status and OAuth error code, e.g. `boot restore: INVALID_GRANT (HTTP 400 invalid_grant)`, so a forced sign-out can be traced. Messages and tokens are still never logged.

## 0.6.0-beta.32

### Minor Changes

- 3661337: Native OpenKey sign-in (TC-775) is now the only sign-in path on iOS and Android — the `VITE_EXO_NATIVE_OPENKEY` build flag is gone, and so is the embedded-widget fallback on those two platforms. A widget session persisted on a device from before this change is cleared once on the next launch; the user signs in again through the native flow. Web and the Tauri desktop app are unchanged and keep the embedded widget. The registered native OpenKey client id is now committed config (`frontend/.env.production`), not something a build flag gated.

### Patch Changes

- ed379a7: Map microphone RMS to the recorder's perceptual level once across native, desktop, and web capture.
- 99e4f56: Voice-note save failures now retain their cause and upload state across retries and recovery.
- 8bb9f4e: Sign-in no longer shows raw errors: Android WebViews without Ed25519 now sign in (or point to the WebView update), closing OpenKey is a quiet cancel, sign-out waits for your OpenKey confirmation, and the app is called Exo on the boot screen and in OpenKey.
- 9099a86: Signing out no longer says OpenKey sign-out "could not be verified". When OpenKey can't confirm it signed out, Exo shows one calm line: "Signed out of Exo. To use a different account, also sign out at openkey.so."
- b16eca5: Stop local transcript sync before it writes across account changes.
- 972778c: Skip queued transcriber completeness reads after the account pass is cancelled.
- f07bac3: Make unavailable recorder modes actionable, quiet the mic-denied ring, and reserve rail space for the minimized Ribbon.
- 5ce67a5: On iOS, Local transcription uses Apple's built-in on-device speech instead of downloading a 640 MB model. iOS now requires 26.
- 3eea2fc: The phone recorder fits landscape, 320 px phones and large text: the ring is sized from its stage, the controls stay reachable by scrolling, and Done and Discard stay when the microphone drops. Desktop toasts no longer cover the status and timer.
- 3e3571a: Fix Android recorder Back handling, Gboard moment submission, automatic-stop copy, new-recording state, status-bar colors, and Recent note opening.
- 94b694c: The Done receipt is honest about a Local note: the source reads "This phone" until a transcript exists, "Saved on this phone" is said once, the gap above the receipt is gone, and a note waiting on the model shows a static "Needs the on-device model" with "Get model" and "Use Private instead" (no spinner), kept open for 10 seconds while there is something to press. A saved note's transcript block is one sentence ("Transcribe on this phone — needs a 640 MB download") with a full-width button, and offers "Transcribe with Private instead" when Private is available. Switching to Private waits until the phone's own record says the on-device job has ended (a note whose Local result already exists is never cancelled or switched, and Android no longer marks a finished note "cancelled"; iOS gets that from #263), a Private choice survives a restart, including after a retryable failure before the cloud job exists, the receipt says "Transcribing" only while a private job is really running (Audio only says nothing; finished and failed Private notes say so), and a receipt with Open stays 10 seconds. On the saved-note sheet the "Get model" and "Transcribe with Private instead" buttons are visible outline buttons in the dark theme too (they use the sheet's own fill and ring, as "Add a note" does).
- 5252d10: Choosing Local, or recording on Local, now starts the on-device model download by itself and never blocks recording. The note is saved normally and is transcribed on the phone once the model is ready, including after the app is relaunched mid-download. Progress shows quietly ("Downloading on-device model · 42%"), a failure says so with "Try again", and the Wi-Fi-only rule shows "Waiting for Wi-Fi" instead of a dead end. A Local choice is never silently switched to another transcriber.
- 0b32ebe: Play a saved note that is still on the phone through the audio element's direct file URL (resolved on Play) instead of fetching it, which iOS answers with status 0.
- Merges main into the Exo iOS dogfood branch: the Library refreshes after transcript saves together with the account-checked on-device transcript sync, and Notetaker meetings save through the shared core writer.
- b60d99a: Brings the Exo dogfood fixes onto main's TinyCloud SDK 3.1 and shared-recording changes; shared recordings keep their "Shared recording" label next to the save state.
- fb7e2d9: Add the note pipeline selector, stepper and row halo glyph (not wired into any screen yet).
- 49fba98: A voice note you just recorded now shows in Recent and the Library right away, marked "Saving…" or "On this phone", and opens from its local copy before the upload finishes. List rows are easier to tell apart: the title is the first moment or a transcript snippet (or "Voice note"), and the subtitle is the time and length.
- 23eebf2: One name for each transcription mode (Audio only, Local, Private, Powerful) in Settings, Upload, the route diagrams and saved notes, with Settings offering Private only when the recorder does. A voice note names a transcript maker only when it was transcribed. How it works says notes run up to 3 hours. Capture's In progress rows match the voice card, and the Connectors tab and Capture share one Meeting sources view whose row actions sit under the text on phones.
- 336bfcb: The recorder checks Private transcription again when the account is ready and when the app returns to the foreground, and shows "Checking…" or a failed check with "Check again". Local's "Get the on-device model" now starts the download with visible progress, size and errors, and a saved note waiting on the model says so (with a way to get it, retry, or the reason it failed) instead of "No transcript."
- 8665739: Android Back now blurs only text-entry fields, and a failed moment mark clears the recorder's focus state.
- 688dd3d: Keep voice-note save failures actionable and keep Recent in sync with the retry state.
- f044877: Improve theme-aware recorder contrast, visible halo discs, readable notetaker errors, and Chat banner placement.
- b8f8803: Keep a saved note's pipeline from reporting a false connection error while its space read waits behind uploads, and read again once they finish.
- be61865: Notes saved after the fact (relaunch, the sign-in claim of signed-out notes, Save now) are now handed to Private transcription once, with their own choice. Off stays off and Local is never sent to the cloud.
- 14aca2c: A mode changed mid-recording now stays on screen until the note is saved instead of snapping back to the default at Done. A signed-in phone that never chose a mode no longer defaults to Local while the on-device model is missing: it starts in Private (or Audio only) and says the model is needed; an explicit Local choice is kept and shows the same note.
- 58717da: Voice notes waiting on your phone now upload after a relaunch: a restored session keeps its space, and a saved session with no space shows a clear error instead of dropping you at sign-in.
- 233219e: Show accurate voice-note progress in lists and restore Save now when an online note is idle.
- 70a7956: Keep recorder, chat, connector, settings, and Capture controls readable and inside their layouts at 200% text size.
- e315bed: Voice notes now track on-device transcript syncing and queue position, and a stuck transcript read no longer blocks later retries.
- 08f2cdf: Show each voice note's pipeline (on this phone, in your space, transcript, notes) on the saved-note sheet and the recorder receipt, with its one next action.
- 598bd04: Show a calm recovery screen with a Reload action instead of a blank screen when the app hits an unexpected error, and recover the iOS and Android web views to the screen the user was on if the system ends their process while Exo is in the background.
- 9c6a376: On-device transcription no longer freezes the app: the iOS queue answers status and cancel while a note decodes, installed models are verified in the background (reported as "checking"), and cancel, retry and model-load races leave a note in one consistent final state.
- 77bb2dd: Keep the empty chat welcome visible above the composer, compact the agent prompt during a minimized recording, and follow iOS Dynamic Type for rem-based text.
- 6f1e7cb: Keep transcriber API reads off the shared TinyCloud space write lane and yield between saved-recording completeness checks.
- 9c7a923: Voice-note saves now time out visibly while keeping retries safe on slow connections.
- 7e4e880: Restore the recorder's neutral halo disc, visible dark-mode edges, and grey paused ring ticks.
- 382193b: The recorder's ring ticks are neutral zinc instead of blue-violet, the timer no longer jitters (and the ＋ button no longer moves) as the digits change, and Capture and the recorder use the same fonts as Chat and Connectors.

## 0.6.0-beta.31

### Patch Changes

- 7b17239: Refresh the Library when the new recorder lands a voice note through Stop, Save now, or sign-in recovery, and when on-device or private-cloud transcription (including recovery), a notetaker browser import or newly observed server delivery, or an audio upload commits a transcript. Revalidate only the saved note while preserving its audio and prior reads on failure, and retry failed reads on Try again or reopening. Ignore late saves from a previous account.

## 0.6.0-beta.30

No changes in this release.

## 0.6.0-beta.29

### Minor Changes

- c65d24f: Add feature-gated server delivery of Private Transcription transcripts into a user's connector SQL and KV space using a verified, narrow session-key delegation. Preserve the browser importer as a ten-minute fallback and keep production rollout blocked on the node SQL-scope fix (TC-825).

## 0.6.0-beta.28

### Patch Changes

- 9aa2dcc: Handle the private transcription service's 429 `capacity_exhausted` (TC-907). Calendar auto-join counts each create attempt once, so its backoff no longer doubles per attempt. An occurrence the service keeps refusing for capacity now ends after its joining window with the outcome "All TinyCloud notetakers were busy when this meeting started." Before, it was polled every 15 minutes indefinitely and never cleaned up. A manual send that hits the cap now shows the service's "All N meeting notetakers are busy…" message instead of the generic "temporarily unavailable" text, and the backend relays `Retry-After` and `retry_after_seconds` on any upstream 429.

## 0.6.0-beta.27

### Patch Changes

- 799d72f: Calendar auto-join sends one bot when two connected accounts auto-join the same Meet (TC-581). The second account sends no bot while the other bot is in the call, and sends its own if that bot leaves within its joining window. It sees a neutral "Already being recorded by another TinyCloud account" state instead of a failure. With `CALENDAR_AUTOJOIN_SHARING` off (the default), that state never promises a transcript. With it on, the second account gets the transcript only if both checks pass: the other account is on its own invite, and its verified Google email accepted the bot owner's own invite. If the other account is not on its own invite, the collision shows as unverified ("an account we couldn't match to your invite") and is never shared. Shared recordings show as "Shared recording" and can be removed from your list, but not ended or deleted. Auto-join now also asks for the `email` scope; existing connections must reconnect before they can be matched or receive a share.

## 0.6.0-beta.26

### Patch Changes

- adbbaa4: Move to TinyCloud js-sdk 3.1.0 (from 2.11.0). Sessions and grants keep their 30-day lifetimes; existing web and desktop sessions are not re-signed.

## 0.6.0-beta.25

### Patch Changes

- 108e63e: Add a flag-gated desktop Meeting sources entry and shared modal on Connectors.
- 108e63e: Fix the Capture settings e2e: expose one fake service on the harness page and target the Capture heading exactly.
- 108e63e: Capture settings: the local-model picker is a standard radio group of downloaded models, with the rest as plain rows with Get, and focus follows a download from Get to progress to the new radio.
- 108e63e: Add the desktop Capture settings popover and the DesktopCaptureExtras seam it reads, behind the final recorder flag.
- 108e63e: The desktop Capture home's Recent row now says so when a partial-audio notice could not be dismissed: the same inline alert as the phone sheet, on that row, with the notice kept and focus left on Dismiss.
- 108e63e: Connect the Tauri recorder to the shared voice-note contract and store its audio in Rust-owned files.
- 108e63e: Default the new desktop recorder to capturing system audio and keep corrupt recorder settings from blocking app launch. Remove the classic desktop capture engine and its native private-cloud uploader; retain transcript saving for meetings and uploads.
- 108e63e: Start existing desktop beta users with system audio on in the new recorder, while preserving choices they make afterward. Remove the unused classic cloud bridge and local-stt model download permissions.
- 108e63e: Transcribe stopped desktop recorder notes locally with the selected Whisper model, and resume unfinished transcription after a WebView reload.
- 108e63e: Store recording Markdown and moments with voice notes
- 108e63e: Add the recorder engine seam: one selector installs the native, web or desktop engine at boot (web and desktop only with the final recorder on), and native-only calls are gated on the engine's capabilities.
- 108e63e: A pending-note save that fails after you switch accounts no longer shows its error on the new account's pending notes.
- 108e63e: Add a flag-gated desktop recorder note view and a saved voice-note page and sheet with edit, copy and play-from-moment.
- 108e63e: Phone recorder: note moments with ＋ while recording, and a notes sheet with a Markdown writer and a lazily loaded Markdown preview (TC-881). The preview's WASM is no longer part of the service worker's install; it is cached after its first use.
- 108e63e: CI: split the frontend workflow so the Exo UI screens run one viewport per job and the browser harnesses run beside the unit tests; add the recorder follow-ups' interaction suites.
- 108e63e: Desktop Capture home (wide layout) behind the final-recorder flag: the Capture header with Library and the ⚙︎ settings, the idle start button and Back to recording, Upload, Meeting and Connect existing meetings, the "on this Mac" card on the app, and Recent with All / Notes / Meetings filters and capture-issue rows (including a partial-audio row with Dismiss). The Capture nav dot also shows on the rail.
- 108e63e: Bind the desktop capture settings to the Tauri recorder's model, system-audio and auto-save commands, and drop the Mac recorder card from Capture when the shared recorder is on.
- 108e63e: On the Mac app, the recorder's Local choice is Whisper: available (signed in or out) once a Whisper model is selected, named in its caption, and live as models download; saved notes and Recent rows show the after-stop Whisper progress and failure with Retry.
- 108e63e: Recorder phone UI fixes from the E1 pass: rounded focus rings on the moment field and the ＋ button, the saved note sheet keeps its formatting bar in view in Edit mode, and a failed Open Settings shows a generic line instead of the raw plugin error.
- 108e63e: Unsaved voice notes keep their Save now row on the web at rail widths ("in this browser"), and native tablets say "on this device" instead of "this Mac". The microphone recovery views show stable lines instead of native error text. Library filter chips are at least 44 px wide.
- 108e63e: The new recorder is the only recorder: `VITE_EXO_RECORDER_FINAL` is gone and the previous recorder screens, the live-edge indicator and the on-page local transcriber panel are removed. After Done, a receipt-only view shows the saved note.
- 108e63e: Recorder in a browser: the tab title follows the recording, the screen stays awake, leaving the page asks first, a keep-open notice shows once, a denied microphone gets site-permission guidance with Try again, the microphone list comes from the browser, and Local transcription stays closed on the web.
- 108e63e: Expose recording note sync status and retry note loads with backoff
- 108e63e: Test infrastructure: the Meeting sources e2e waits for Radix to move focus instead of reading it the instant the sheet unmounts, and the exo-ui harness readiness cap runs on `performance.now()` so `?freeze=1` can no longer hang a never-ready screen.
- 108e63e: Show a one-time, dismissible notice in the desktop Capture settings that system audio is now included in Mac recordings.
- 108e63e: Hide the legacy screen-edge glow when the final recorder is enabled.
- 108e63e: Turn on the browser voice-notes engine behind the recorder flag: lazy registration, boot recovery, a fetch upload transport for private-cloud transcription, and mime-derived saved file extensions.
- 108e63e: Add a browser voice-notes engine (IndexedDB store, MediaRecorder capture, level meter) implementing the full VoiceNotesPlugin contract. Not wired in yet.
- 108e63e: Add the desktop recorder ring view (rail and desktop layouts, in the main region), its discard confirmation and toasts, the overlay mount by layout, and shell × layout capabilities.

## 0.6.0-beta.24

### Patch Changes

- d682e75: Hide other accounts' pending voice notes from signed-in capture, preserve a note's save error while newer notes upload, and log automatic save starts for device diagnosis.

## 0.6.0-beta.23

### Patch Changes

- 02ba07e: Show automatic voice-note saving and explain when recordings belong to another account. Avoid repeating the space-wide archive sweep for each note.

## 0.6.0-beta.22

### Patch Changes

- f23b956: Restore recorder controls when Android microphone access is granted while the app is away.

## 0.6.0-beta.21

### Patch Changes

- 477b730: Recover voice-note saves after a fresh sign-in and show the recorder for cold iOS quick actions.

## 0.6.0-beta.20

### Patch Changes

- ec1eac7: Report current iOS microphone permission in voice recorder status so access can refresh after Settings.

## 0.6.0-beta.19

### Patch Changes

- d0c51c3: Open the app's iOS Settings page from the voice recorder's microphone access screen.

## 0.6.0-beta.18

### Patch Changes

- ee207ba: Hold each recorder halo atlas bitmap for one frame before closing it. The two smallest rings were seen blank intermittently on WebKit; the WebGL draw itself is correct, and the suspected cause is closing the bitmap straight after `drawImage`. This is a hardening change: the blank was not reproduced on demand, so the fix is unproven until checked on an iPhone.

## 0.6.0-beta.17

### Minor Changes

- d5e1894: Add the Android native capture engine, durable voice-note recovery, app shortcut and recording notification controls.
- 671f28c: Add on-device transcription for Exo voice notes: an "On this phone" transcriber choice in the recorder and Settings, a downloadable Parakeet/sherpa-onnx model with Wi-Fi-only download and sha256 verification, and native decode-and-transcribe after Stop that works signed out and offline.
- a376332: Add native iOS voice-note capture with durable segments, recovery, account-aware sidecars, and a home-screen recording shortcut.
- da282d4: Show native voice recordings in a full-page view with pause, a waveform, and immediate local playback after Stop. Keep committed audio on the phone after upload.
- 3973e7f: Add iOS recording interruption recovery, stale notification protection, and audio input routing.
- c79b024: Add Android recording interruption recovery, paused resume notifications, and microphone input selection.
- 99f170a: Keep one native recorder available above sign-in, show local notes while signed out, and durably hand off capture ownership before clearing credentials. Claim signed-out notes at the next ready session and save them through the account-aware pipeline.

### Patch Changes

- 6d9a101: Keep the native renewal test's voice-note save fixture from leaking into later Bun test files.
- 177ddc9: Expose recorded elapsed time and native mic state reasons
- 15f5c94: Persist Android capture account state, remote cleanup receipts, and recovery actions.
- d0f143f: Make the Android compensation debug hook fail both the sign-out and compensation writes so the account remains transitioning.
- b32e046: Fix Android STT benchmark VAD framing by feeding Silero one decision window at a time.
- 01dab09: Show the target, version, build number and commit at the foot of the boot screen, the desktop sidebar and the bottom of Settings; a tap copies the line.
- bf477cb: Add pure view models and Soft-skin foundations for the final recorder.
- 5dea60d: Keep Android microphone-state reasons within the native contract, carry diagnostic detail separately, and publish read failures only after entering interrupted state.
- 85aa07b: Keep iOS recording account state and remote cleanup receipts durable, recover parked pauses, and expose recovery actions.
- 83cd123: Route voice notes by their committed transcriber choice and expose one recorder choice API
- 003fe5b: Keep recordings on the phone when sign-out suspends an upload, and move the app to the signed-out screen after a shared 401 session clear.
- 47cc4f7: Never say Exo will finish a recording automatically when it couldn't recover or save it, and add Try again and Delete (with a confirmation) to the couldn't-recover sheet, including recordings the phone quarantined
- 12ec582: Keep recorder harnesses rendering with a real string space ID, validate capture issue scope after mount, and reconcile status before the best-effort sidecar scan.
- d9c24a7: Show the full-page microphone recovery screen after an Android recording shortcut is denied, with a direct link to app settings.
- 3177a1b: Route recorder private-cloud choices into native capture
- e36018b: Update the OpenKey Capacitor SDK and use the shared Kotlin version for Android builds.
- 69c83e2: The final phone recorder reads and changes the transcriber through the recorder provider, and names the mode that is unavailable.
- cfc7daf: Pin the OpenKey SDK WebView popup fix and explain when remote OpenKey sign-out is unavailable while completing local sign-out.
- e604971: Show a quiet "Saved — part of this recording couldn't be written" line on Recent and Library rows and on the saved receipt when a recording is missing some audio, with a details sheet (how much is missing, when known) and a Dismiss button
- 65cb50f: Add the final phone recorder screen behind VITE_EXO_RECORDER_FINAL (off by default).
- de2d034: Add the minimized final recorder behind the flag: a Ribbon above the tab bar, floating on the rail, and a dock in the sidebar.
- ca5ccda: Fit the final recorder and Capture home on a 320 px phone: the Ribbon's trace stays clear of Pause (whose Day edge now shows), the modes card's labels wrap beside their dots, the paused pill keeps its distance from the minimise button, and the Capture actions fit.
- 58891dd: Soft-skin phone Capture home and Recent rows, with the capture-issue row states, behind the recorder-final flag (TC-871).
- b23d76c: Align recorder announcements with the final recorder UI and restore the dock spectrum gain and halo pixel checks.
- c99ac25: Expose native capture recovery and write failures
- e7f978f: Announce when microphone access is off in the recorder
- b425f3f: Save voice notes to their owner’s space with deterministic row identities and durable transcript commits.
- 0913742: CI: split the frontend workflow so the Exo UI screens run one viewport per job and the browser harnesses run beside the unit tests.
- d8881bc: Make the iOS compensation failure probe keep account state transitioning after a failed sign-out handoff.
- d37cc52: Raise the Exo iOS minimum to iOS 18 and support a separate device test bundle identifier.
- 85ad869: Add the Halo Ticks recorder ring and level bar visualisers for the final recorder.
- c173a11: Keep native renewal stopped when terminal sign-out cannot complete its capture handoff, while preserving renewal after a failed manual sign-out.
- 45e43de: Anchor recorded elapsed time to the native checkpoint receipt
- 92f97f6: Keep partial-audio notices after a recording commits

## 0.6.0-beta.16

### Patch Changes

- 6d9a101: Keep the native renewal test's voice-note save fixture from leaking into later Bun test files.

## 0.6.0-beta.15

### Minor Changes

- fb6cce4: Restore native OpenKey sessions across app and backend JWT restarts, renew delegations before expiry, and swap the live TinyCloud session while preserving voice-note pending-save recovery. Bound native backend authentication fetches with a timeout.

## 0.6.0-beta.14

### Minor Changes

- b6ffb9b: Native OpenKey sign-in for the Exo app (TC-775 E1, behind `VITE_EXO_NATIVE_OPENKEY`). Inside the iOS/Android app only, sign-in runs the OpenKey delegation flow (PAR + PKCE in the system browser) and restores a TinyCloudWeb session whose key lives in the device secure store — the web and Tauri desktop keep the embedded widget. The backend's `/api/auth/nonce` now accepts a request without `address` and issues an unbound, single-use, 5-minute nonce that `/verify` binds to the recovered signer. Secrets-dependent surfaces (connector connect/sync/disconnect, queued sync, the background drains, own AssemblyAI key) are gated on native sessions, which have no vault capability; voice notes are unaffected. The flag stays off in every build until the OpenKey server side and the registered native client ship.

## 0.6.0-beta.13

No changes in this release.

## 0.6.0-beta.12

### Minor Changes

- 1cabcd5: Keep existing data readable when storage is full and show clear write failures.

## 0.6.0-beta.11

No changes in this release.

## 0.6.0-beta.10

No changes in this release.

## 0.6.0-beta.9

### Minor Changes

- acea78c: Capture shows what's in progress and your recent notes. The Library has filters and durations, and each note shows how it got into your space.

## 0.6.0-beta.8

### Minor Changes

- c05aa4e: Discard a recording you didn't mean to make: "Discard" in the recorder's header asks "Discard?" in place, with Keep and Discard. A discarded recording is stopped and deleted from the phone, never saved to your space, even if the app closes before the delete finishes.

## 0.6.0-beta.7

### Minor Changes

- f5f20ac: Record from Capture or the chat header. A focused recorder shows where your audio goes, minimises to a live island that follows you, and shows a receipt when your note lands in your space.

## 0.6.0-beta.6

### Minor Changes

- aa2e1f9: Upload audio and send a notetaker from Capture: each opens its own sheet (a dialog on wider screens) that shows where the audio goes, with a receipt when the transcript lands. Interrupted uploads resume on launch, and wait as "Upload paused · Continue" when your own AssemblyAI key is locked. The desktop app records on this Mac from a card at the top of Capture that keeps recording while you navigate.

## 0.6.0-beta.5

No changes in this release.

## 0.6.0-beta.4

### Minor Changes

- 4dae5f8: Shorter screens: hints in tooltips and a How it works page

## 0.6.0-beta.3

### Minor Changes

- ef2f000: Capture, Chat and Connectors are the three destinations: a tab bar on phones, a rail on landscape phones and tablets, a sidebar on desktop. The phone app opens on Capture. Android Back closes sheets first.

## 0.6.0-beta.2

### Patch Changes

- c8c1e9b: Exo uses its original neutral palette again (zinc greys, light and dark, following the system theme). Recording is shown in red and warnings in amber.

## 0.6.0-beta.1

### Patch Changes

- be3e182: Internal: split App.tsx into chat and shell modules.

## 0.6.0-beta.0

### Minor Changes

- c81e6bc: Exo's new look: navy Night and paper Day themes (following your system), Literata display type, motion tokens.

## 0.5.1

### Patch Changes

- 57a7198: Connectors and Settings scroll inside their own pane again. The header and sidebar stay fixed to the window, the blank band below the content is gone, and switching Transcriber tabs no longer jumps the page.
- e5ea1ca: Exo desktop no longer offers passkeys in the OpenKey sign-in modal. WebAuthn does not work in the ad-hoc-signed Tauri webview, so the desktop shell opens OpenKey with `passkeysSupported: false` (sign-in, sign-out and Connect agent), and OpenKey offers only email and Google. The Connect agent banner on desktop now says you'll sign in with OpenKey instead of promising a passkey. Web and mobile are unchanged. Requires `@openkey/sdk` 0.11.0.

## 0.5.1-beta.1

### Patch Changes

- 57a7198: Connectors and Settings scroll inside their own pane again. The header and sidebar stay fixed to the window, the blank band below the content is gone, and switching Transcriber tabs no longer jumps the page.

## 0.5.1-beta.0

### Patch Changes

- e5ea1ca: Exo desktop no longer offers passkeys in the OpenKey sign-in modal. WebAuthn does not work in the ad-hoc-signed Tauri webview, so the desktop shell opens OpenKey with `passkeysSupported: false` (sign-in, sign-out and Connect agent), and OpenKey offers only email and Google. The Connect agent banner on desktop now says you'll sign in with OpenKey instead of promising a passkey. Web and mobile are unchanged. Requires `@openkey/sdk` 0.11.0.

## 0.5.0

### Minor Changes

- d451a1a: Store the original audio of uploaded meetings in your TinyCloud space and play it back from the meeting in Library.
- 874ad74: Upload audio: transcribe an audio file on web, desktop and mobile with Private transcription (default) or AssemblyAI, under TinyCloud's AssemblyAI account by default or your own API key, with optional speaker identification; the transcript and the original file are saved to your TinyCloud space as an Uploaded audio meeting. Settings gains a Transcription card for the default engine and which AssemblyAI account to use (with the optional own key).

### Patch Changes

- 304587d: Exo: turn on the Private cloud transcription engine. The desktop now compiles in the production ptx-batch upload origin, so Local recording offers Private cloud (the default until an on-device model is downloaded) for accounts the backend enables.
- 874ad74: Delete unclaimed hosted AssemblyAI transcripts after 24 hours and retain bounded expiry tombstones. Resolve expired upload cleanup after reload and bound missing-outcome retries with persistent timestamps and a retention notice (TC-592).
- 874ad74: Keep hosted AssemblyAI submission outcomes visible while deleting temporary audio, retain unresolved Discard cleanup across reloads, and preserve Retry for recoverable hosted uploads without the original file.

## 0.5.0-beta.2

### Patch Changes

- 304587d: Exo: turn on the Private cloud transcription engine. The desktop now compiles in the production ptx-batch upload origin, so Local recording offers Private cloud (the default until an on-device model is downloaded) for accounts the backend enables.

## 0.5.0-beta.1

### Minor Changes

- 874ad74: Upload audio: transcribe an audio file on web, desktop and mobile with Private transcription (default) or AssemblyAI, under TinyCloud's AssemblyAI account by default or your own API key, with optional speaker identification; the transcript and the original file are saved to your TinyCloud space as an Uploaded audio meeting. Settings gains a Transcription card for the default engine and which AssemblyAI account to use (with the optional own key).

### Patch Changes

- 874ad74: Delete unclaimed hosted AssemblyAI transcripts after 24 hours and retain bounded expiry tombstones. Resolve expired upload cleanup after reload and bound missing-outcome retries with persistent timestamps and a retention notice (TC-592).
- 874ad74: Keep hosted AssemblyAI submission outcomes visible while deleting temporary audio, retain unresolved Discard cleanup across reloads, and preserve Retry for recoverable hosted uploads without the original file.

## 0.5.0-beta.0

### Minor Changes

- d451a1a: Store the original audio of uploaded meetings in your TinyCloud space and play it back from the meeting in Library.

## 0.4.1

### Patch Changes

- 0a273d3: Connect agent now refuses an OpenKey key that is not the one you are signed in with. An OpenKey account can hold several keys, and each key owns separate TinyCloud spaces. If you picked another key in the Connect agent prompt, the agent was granted access to that key's data instead of your signed-in account's. TinyChat now compares the connected address with the signed-in session address (ignoring checksum casing) and stops before any grant is minted or sent. It shows both shortened addresses and asks you to choose the signed-in key.

## 0.4.1-beta.0

### Patch Changes

- 0a273d3: Connect agent now refuses an OpenKey key that is not the one you are signed in with. An OpenKey account can hold several keys, and each key owns separate TinyCloud spaces. If you picked another key in the Connect agent prompt, the agent was granted access to that key's data instead of your signed-in account's. TinyChat now compares the connected address with the signed-in session address (ignoring checksum casing) and stops before any grant is minted or sent. It shows both shortened addresses and asks you to choose the signed-in key.

## 0.4.0

### Minor Changes

- 8ae3f67: Exo on the web is now an installable app (PWA).
  - **Install Exo.** Chrome, Edge and Android offer to install tinycloud.chat as "Exo", with its own window and the same icon as the mobile app. On Chromium the page shows an "Install Exo as an app." prompt (hidden once installed, and for 30 days after "Not now"). On iOS, use Share > Add to Home Screen.
  - **Opens offline.** The installed app opens without a connection: you get the app and the "You're offline…" screen (with the offline voice recorder), not the browser's error page. Only the app itself is stored on the device. Chats, API calls and sign-in always go to the network and are never cached.
  - **Updates.** When a new version is out, Exo shows "New version of Exo available." with Reload. You can ignore it, and the new version loads the next time you open Exo after closing all its tabs.
  - The desktop and mobile apps are unchanged. They never use the web app's offline cache.

### Patch Changes

- 96007c1: Lost private agent access is no longer hidden. When an agent turn runs without private access (no session, an expired or stale grant, or a failed status check), the backend still answers from public tools, but first sends a `delegation_error` frame (`delegation_required`, `delegation_expired` or the new `delegation_unverified`). It also tells the model to send the user to Settings > Agent access to reconnect, not to pick another model. This applies to both the Eliza task path and the legacy loop. The browser shows the Reconnect banner without aborting the public answer, and a failed check reads "Couldn't verify" rather than "expired". The session status read before each turn now times out after 3s; POST and DELETE stay unbounded. Agent grants are minted for 29 days so a fast browser clock cannot trip the 30-day courier ceiling, and Connect errors name the server's code. The meeting tool contract accepts the `exo-local` source.
- 1f682a0: Chat replies start streaming without waiting for the user message to be saved to TinyCloud SQL; the save runs alongside the stream and still lands before the reply, and a new chat's first message no longer reads a compaction checkpoint it cannot have. Every thread-store SQL call is now bounded (15s), so a dropped response fails as a retryable error instead of hanging that chat's saves for the rest of the session.

## 0.4.0-beta.1

### Patch Changes

- 96007c1: Lost private agent access is no longer hidden. When an agent turn runs without private access (no session, an expired or stale grant, or a failed status check), the backend still answers from public tools, but first sends a `delegation_error` frame (`delegation_required`, `delegation_expired` or the new `delegation_unverified`). It also tells the model to send the user to Settings > Agent access to reconnect, not to pick another model. This applies to both the Eliza task path and the legacy loop. The browser shows the Reconnect banner without aborting the public answer, and a failed check reads "Couldn't verify" rather than "expired". The session status read before each turn now times out after 3s; POST and DELETE stay unbounded. Agent grants are minted for 29 days so a fast browser clock cannot trip the 30-day courier ceiling, and Connect errors name the server's code. The meeting tool contract accepts the `exo-local` source.
- 1f682a0: Chat replies start streaming without waiting for the user message to be saved to TinyCloud SQL; the save runs alongside the stream and still lands before the reply, and a new chat's first message no longer reads a compaction checkpoint it cannot have. Every thread-store SQL call is now bounded (15s), so a dropped response fails as a retryable error instead of hanging that chat's saves for the rest of the session.

## 0.4.0-beta.0

### Minor Changes

- 8ae3f67: Exo on the web is now an installable app (PWA).
  - **Install Exo.** Chrome, Edge and Android offer to install tinycloud.chat as "Exo", with its own window and the same icon as the mobile app. On Chromium the page shows an "Install Exo as an app." prompt (hidden once installed, and for 30 days after "Not now"). On iOS, use Share > Add to Home Screen.
  - **Opens offline.** The installed app opens without a connection: you get the app and the "You're offline…" screen (with the offline voice recorder), not the browser's error page. Only the app itself is stored on the device. Chats, API calls and sign-in always go to the network and are never cached.
  - **Updates.** When a new version is out, Exo shows "New version of Exo available." with Reload. You can ignore it, and the new version loads the next time you open Exo after closing all its tabs.
  - The desktop and mobile apps are unchanged. They never use the web app's offline cache.

## 0.3.0

### Minor Changes

- 69c76b3: Experimental Conversation Canvas, off by default. Settings → Experimental Features → Conversation Canvas adds a Chat/Canvas switch to each chat. Canvas visualizes branches, lets you continue from an earlier message, and pins versioned Markdown documents into the next request.
  - **Explicit opt-in per chat.** Each chat is switched to Canvas only after you confirm, with a warning about what changes.
  - **One chat history.** The chat history stays the single source every reader uses, including share links, other devices and older app versions. Picking a branch rewrites the chat to that branch, and messages sent elsewhere are folded into Canvas.
  - **Safe concurrent edits.** Edits from other tabs and devices are never overwritten.
  - **No cost when off.** Accounts and chats that never use Canvas never touch Canvas storage.
  - **Permission on enable.** Turning Canvas on asks for its storage permission when the session doesn't have it yet.
  - **Backend manifest.** The backend's app manifest adds the `canvas` SQL permission.

- fcbdc49: Google Meet and Calendar autojoin can be connected from the Exo mobile app. Google refuses sign-in inside the app's web view, so on mobile "Continue with Google" opens the system browser (Custom Tabs on Android, Safari on iOS) and returns to Exo when you finish. The web app's popup flow is unchanged. The in-app flow ships switched off (build flag `VITE_EXO_NATIVE_GOOGLE_OAUTH`) until it can return through a verified https link; until then the app says that Google can be connected from the web.
- ecc9346: Exo mobile: record voice notes when Exo can't connect, and they are saved once it reconnects.
  - **Record from the offline screen.** If Exo launches without a connection but your session is still held ("You're offline…" or "Can't reach Exo right now. You're still signed in."), that screen now has a voice recorder. It shows the elapsed time, the level and the same microphone warnings as the Voice notes card. Stop keeps the note on the phone, and the screen counts what is waiting: "2 notes will be saved when you're back online." The recorder stays on screen through "Try again". It is not offered when you are signed out, because there is no account to save to.
  - **Saved when the session is back.** Once Exo is signed in again, notes still on the phone (recorded offline, or from a save that failed) are saved to your TinyCloud space right away, without opening Connectors. When private-cloud transcription is on, they are queued for it just like notes saved from the card. This uses the card's own retry, so a note is never uploaded twice.
  - **A recording that is still running carries over.** If Exo reconnects while you are recording, the chat screen's voice note bar shows that recording and its Stop. The recording is never restarted.

- e7a02a2: Exo mobile: record a voice note from the chat screen, and the Google connect dialog stops offering what the app can't do yet.
  - **One-tap voice note.** Inside the native app, the header has a "Voice note" button. One tap starts recording and opens a bar under the header with the elapsed time, the level meter, the same microphone-state warnings as the Voice notes card (the system blocking the mic, no sound arriving) and Stop. The chat stays usable underneath. Stop saves the note to your TinyCloud space, after which the bar offers Open Library. If the save fails, the bar says so and the note stays on the phone. The bar uses the Voice notes card's own recorder, so saved notes appear in Connectors → Sources and Library as before. The button is not shown on Connectors, where the card has its own Record and takes over a recording that is still running. The web and desktop apps are unchanged.
  - **Google connect in the app.** While a build keeps Google sign-in off inside the app, the Google Meet and Calendar autojoin dialogs show the "isn't available in the Exo app yet" explanation and a Close button instead of "Continue with Google". When a build turns it on, the consent text says you sign in "in your browser" instead of "in a popup window". The web and desktop dialogs are unchanged.

- 4e22e2e: Exo mobile voice notes are capped at 60 minutes and stored in parts, so long notes save and play back.
  - **60-minute limit.** The phone's recorder (Android and iOS) stops a note by itself at 60 minutes, the same way Stop does, and the note is saved like any other. The card shows the limit in the last five minutes ("Recording 55:00 of 60:00") and says "Stopped at the 60-minute limit." afterwards. A recording left running can no longer grow to hundreds of megabytes (6 hours was 188 MB).
  - **Stored in 1 MiB parts.** Audio is stored in the user's space as raw parts of at most 1 MiB plus a manifest written last, read from the phone one part at a time. The production node's ingress refuses request bodies over 1 MiB, so the old single base64 value failed for notes longer than about a minute and a half. A save that fails partway leaves the note on the phone, and "Save now" resumes after the parts already stored without writing anything twice.
  - **Playback and transcription read the parts.** The player loads a note part by part (with progress) into an object URL. Notes saved before this change, stored as one value, still play and transcribe.

- f69c62a: Exo mobile voice notes can be transcribed with private cloud transcription (TinyCloud Private Transcription → Tinfoil), the same path as the desktop's Exo Local engine. It is offered only when the build has a PTX upload origin, the device can upload (iOS, or Android 8.0 and later), and the backend admits the account. The user confirms "Use private cloud" once, and the choice is kept per account. New notes are transcribed after they are saved, and older ones have a Transcribe action. The card shows progress, failures with Retry, and the transcript. "Turn off" stops anything not yet sent.

  Transcribed voice notes appear in Library and in meeting chat. A voice note that is not transcribed is not a meeting, so it never wins "my latest meeting". Exo desktop's private cloud recovery no longer adopts a phone's voice-note job: it recovers only jobs it made itself.

### Patch Changes

- d9ba752: Exo mobile: the app opens on chat instead of the marketing page, stays clear of the status bar, notch and gesture bar, and reads properly on phone-width screens.
  - **Opens in the app.** Inside the native app, `/` goes straight to `/chat`, where a signed-out user gets the sign-in screen. The web and desktop apps still open on the landing page.
  - **Safe areas.** The app shell now pads the left and right safe-area insets (landscape notch, side navigation bar) as well as the top one. The agent access prompt and its "Agent tools active." toast sit above the home indicator. Desktop browsers and the desktop app report zero insets, so their layout is unchanged.
  - **Agent access prompt on phones.** Below the `sm` breakpoint the "Connect private agent access" prompt spans the screen with its button under the text. It used to be squeezed into half the width. From `sm` up it is the same centred row as before.
  - **Library titles on phones.** Below `sm`, a meeting or voice-note title gets its own line, with the source chip and date under it, so "Voice note · Sep 29, 1:40 PM" is no longer cut to "Voice note · Sep 29, 1…". From `sm` up the row is unchanged.

## 0.3.0-beta.6

### Minor Changes

- ecc9346: Exo mobile: record voice notes when Exo can't connect, and they are saved once it reconnects.
  - **Record from the offline screen.** If Exo launches without a connection but your session is still held ("You're offline…" or "Can't reach Exo right now. You're still signed in."), that screen now has a voice recorder. It shows the elapsed time, the level and the same microphone warnings as the Voice notes card. Stop keeps the note on the phone, and the screen counts what is waiting: "2 notes will be saved when you're back online." The recorder stays on screen through "Try again". It is not offered when you are signed out, because there is no account to save to.
  - **Saved when the session is back.** Once Exo is signed in again, notes still on the phone (recorded offline, or from a save that failed) are saved to your TinyCloud space right away, without opening Connectors. When private-cloud transcription is on, they are queued for it just like notes saved from the card. This uses the card's own retry, so a note is never uploaded twice.
  - **A recording that is still running carries over.** If Exo reconnects while you are recording, the chat screen's voice note bar shows that recording and its Stop. The recording is never restarted.

## 0.3.0-beta.5

### Minor Changes

- e7a02a2: Exo mobile: record a voice note from the chat screen, and the Google connect dialog stops offering what the app can't do yet.
  - **One-tap voice note.** Inside the native app, the header has a "Voice note" button. One tap starts recording and opens a bar under the header with the elapsed time, the level meter, the same microphone-state warnings as the Voice notes card (the system blocking the mic, no sound arriving) and Stop. The chat stays usable underneath. Stop saves the note to your TinyCloud space, after which the bar offers Open Library. If the save fails, the bar says so and the note stays on the phone. The bar uses the Voice notes card's own recorder, so saved notes appear in Connectors → Sources and Library as before. The button is not shown on Connectors, where the card has its own Record and takes over a recording that is still running. The web and desktop apps are unchanged.
  - **Google connect in the app.** While a build keeps Google sign-in off inside the app, the Google Meet and Calendar autojoin dialogs show the "isn't available in the Exo app yet" explanation and a Close button instead of "Continue with Google". When a build turns it on, the consent text says you sign in "in your browser" instead of "in a popup window". The web and desktop dialogs are unchanged.

## 0.3.0-beta.4

### Minor Changes

- 4e22e2e: Exo mobile voice notes are capped at 60 minutes and stored in parts, so long notes save and play back.
  - **60-minute limit.** The phone's recorder (Android and iOS) stops a note by itself at 60 minutes, the same way Stop does, and the note is saved like any other. The card shows the limit in the last five minutes ("Recording 55:00 of 60:00") and says "Stopped at the 60-minute limit." afterwards. A recording left running can no longer grow to hundreds of megabytes (6 hours was 188 MB).
  - **Stored in 1 MiB parts.** Audio is stored in the user's space as raw parts of at most 1 MiB plus a manifest written last, read from the phone one part at a time. The production node's ingress refuses request bodies over 1 MiB, so the old single base64 value failed for notes longer than about a minute and a half. A save that fails partway leaves the note on the phone, and "Save now" resumes after the parts already stored without writing anything twice.
  - **Playback and transcription read the parts.** The player loads a note part by part (with progress) into an object URL. Notes saved before this change, stored as one value, still play and transcribe.

## 0.3.0-beta.3

### Patch Changes

- d9ba752: Exo mobile: the app opens on chat instead of the marketing page, stays clear of the status bar, notch and gesture bar, and reads properly on phone-width screens.
  - **Opens in the app.** Inside the native app, `/` goes straight to `/chat`, where a signed-out user gets the sign-in screen. The web and desktop apps still open on the landing page.
  - **Safe areas.** The app shell now pads the left and right safe-area insets (landscape notch, side navigation bar) as well as the top one. The agent access prompt and its "Agent tools active." toast sit above the home indicator. Desktop browsers and the desktop app report zero insets, so their layout is unchanged.
  - **Agent access prompt on phones.** Below the `sm` breakpoint the "Connect private agent access" prompt spans the screen with its button under the text. It used to be squeezed into half the width. From `sm` up it is the same centred row as before.
  - **Library titles on phones.** Below `sm`, a meeting or voice-note title gets its own line, with the source chip and date under it, so "Voice note · Sep 29, 1:40 PM" is no longer cut to "Voice note · Sep 29, 1…". From `sm` up the row is unchanged.

## 0.3.0-beta.2

### Minor Changes

- f69c62a: Exo mobile voice notes can be transcribed with private cloud transcription (TinyCloud Private Transcription → Tinfoil), the same path as the desktop's Exo Local engine. It is offered only when the build has a PTX upload origin, the device can upload (iOS, or Android 8.0 and later), and the backend admits the account. The user confirms "Use private cloud" once, and the choice is kept per account. New notes are transcribed after they are saved, and older ones have a Transcribe action. The card shows progress, failures with Retry, and the transcript. "Turn off" stops anything not yet sent.

  Transcribed voice notes appear in Library and in meeting chat. A voice note that is not transcribed is not a meeting, so it never wins "my latest meeting". Exo desktop's private cloud recovery no longer adopts a phone's voice-note job: it recovers only jobs it made itself.

## 0.3.0-beta.1

### Minor Changes

- fcbdc49: Google Meet and Calendar autojoin can be connected from the Exo mobile app. Google refuses sign-in inside the app's web view, so on mobile "Continue with Google" opens the system browser (Custom Tabs on Android, Safari on iOS) and returns to Exo when you finish. The web app's popup flow is unchanged. The in-app flow ships switched off (build flag `VITE_EXO_NATIVE_GOOGLE_OAUTH`) until it can return through a verified https link; until then the app says that Google can be connected from the web.

## 0.3.0-beta.0

### Minor Changes

- 69c76b3: Experimental Conversation Canvas, off by default. Settings → Experimental Features → Conversation Canvas adds a Chat/Canvas switch to each chat. Canvas visualizes branches, lets you continue from an earlier message, and pins versioned Markdown documents into the next request.
  - **Explicit opt-in per chat.** Each chat is switched to Canvas only after you confirm, with a warning about what changes.
  - **One chat history.** The chat history stays the single source every reader uses, including share links, other devices and older app versions. Picking a branch rewrites the chat to that branch, and messages sent elsewhere are folded into Canvas.
  - **Safe concurrent edits.** Edits from other tabs and devices are never overwritten.
  - **No cost when off.** Accounts and chats that never use Canvas never touch Canvas storage.
  - **Permission on enable.** Turning Canvas on asks for its storage permission when the session doesn't have it yet.
  - **Backend manifest.** The backend's app manifest adds the `canvas` SQL permission.

## 0.2.0

### Minor Changes

- 5c16fb5: Voice notes for the Exo mobile app: a Voice notes card in Connectors → Sources (shown only inside the native app) records on the phone, saves to your TinyCloud space, plays back, keeps unsaved notes on the device and retries them, and shows when the system blocks the microphone. Voice notes appear in Library.
- e76fcaa: Exo desktop: add the "Private cloud" transcription engine for Local recording (upload a stopped recording to TinyCloud Private Transcription via a native capture handle, poll, and save it as the same Exo Local meeting). The engine is hidden: this build compiles in no private transcription origin.

### Patch Changes

- fb522f4: Exo Local transcripts read naturally: consecutive same-speaker segments merge into turns (max 60 s), speakers are labelled You (mic) and Others (system audio), mic chunks that are wholly an echo of the call audio are dropped, and meeting chat can answer "what did I / what did they say".
- 4542521: Keep the sign-in when Exo launches offline. A session restore that fails because the network or backend is unreachable now keeps the saved session and shows "You're offline. Exo will reconnect when you're back online." instead of signing out; "Try again" (and coming back online) re-runs the restore rather than a full OpenKey sign-in. Expired or invalid sessions still sign out as before.

## 0.2.0-beta.3

### Minor Changes

- 5c16fb5: Voice notes for the Exo mobile app: a Voice notes card in Connectors → Sources (shown only inside the native app) records on the phone, saves to your TinyCloud space, plays back, keeps unsaved notes on the device and retries them, and shows when the system blocks the microphone. Voice notes appear in Library.

### Patch Changes

- 4542521: Keep the sign-in when Exo launches offline. A session restore that fails because the network or backend is unreachable now keeps the saved session and shows "You're offline. Exo will reconnect when you're back online." instead of signing out; "Try again" (and coming back online) re-runs the restore rather than a full OpenKey sign-in. Expired or invalid sessions still sign out as before.

## 0.2.0-beta.2

### Minor Changes

- e76fcaa: Exo desktop: add the "Private cloud" transcription engine for Local recording (upload a stopped recording to TinyCloud Private Transcription via a native capture handle, poll, and save it as the same Exo Local meeting). The engine is hidden: this build compiles in no private transcription origin.

## 0.1.1-beta.1

No changes in this release.

## 0.1.1-beta.0

### Patch Changes

- fb522f4: Exo Local transcripts read naturally: consecutive same-speaker segments merge into turns (max 60 s), speakers are labelled You (mic) and Others (system audio), mic chunks that are wholly an echo of the call audio are dropped, and meeting chat can answer "what did I / what did they say".
