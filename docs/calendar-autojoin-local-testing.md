# Calendar autojoin: obtain the changes and test locally

Calendar autojoin spans two repositories. Use both feature branches:

```bash
gh repo clone TinyCloudLabs/tinychat tinychat-calendar-autojoin -- --branch feat/calendar-autojoin
gh repo clone TinyCloudLabs/tinycloud-private-transcription transcription-calendar-autojoin -- --branch feat/calendar-autojoin-lookup
```

Use new destination directories; preserve any existing local changes. With an existing checkout,
fetch the relevant branch and create a separate worktree instead. GitHub access to the transcription
repository is required. The implementation, tests, and operational documentation are in these
branches. Runtime credentials, environment files, databases, and recordings are not in Git.

Read [the implementation report](calendar-autojoin-implementation.md) for previous validation and
known baseline failures, and [the operations guide](calendar-autojoin-operations.md) for the storage,
OAuth, single-writer, and live-test requirements. Real Google authorization and Meet admission remain
unverified until the live smoke is completed.

## Use an existing development server from a local browser

If the implementation's development services are already running on a remote machine, a local
browser needs both frontend and backend ports forwarded. For frontend port 5186 and backend port
3014, replace `YOUR_DEV_SERVER` with the authorized SSH host:

```bash
ssh -fN -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -L 127.0.0.1:5186:127.0.0.1:5186 \
  -L 127.0.0.1:3014:127.0.0.1:3014 \
  YOUR_DEV_SERVER
curl -fsS http://localhost:3014/health
open -a "Google Chrome" http://localhost:5186/chat
```

Check for an existing tunnel or port conflict first. Keep the browser origin `http://localhost:5186`
and the registered OAuth callback `http://localhost:3014/api/connectors/google/oauth/callback`
consistent. The backend reaches transcription on the server; the browser needs no transcription
tunnel. The session handoff contains the existing server's private runtime locations and restart
instructions. Do not publish that configuration or regenerate its keys.

## Run the code on the local machine

Install the repository's supported Bun version and dependencies in each checkout. In Tinychat:

```bash
bun install
bun run build:packages
```

Configure ignored `backend/.env` and `frontend/.env.local` using the repository's examples and
operations guide. The frontend and backend origins must agree. For the ports above, use
`PORT=3014`, `FRONTEND_URL=http://localhost:5186`, and
`VITE_BACKEND_URL=http://localhost:3014`. Configure the real TinyCloud/OpenKey hosts used by your
test environment and a persistent backend identity and credential encryption key.

Supply a Google Web application client with the exact callback above, enable Calendar API and the
documented scopes, and enable `GOOGLE_MEET_OAUTH_ENABLED`. Point `TRANSCRIPTION_API_URL` and
`TRANSCRIPTION_API_KEY` at an isolated project running the transcription feature branch with
`google_meet` enabled and a real capture provider. The transcription repository documents its
PostgreSQL, Redis, API, worker, and provider dependencies. A mock provider cannot establish a real
Meet result.

Do not enable `TINYCHAT_LOCAL_VALIDATION` or `VITE_LOCAL_VALIDATION`; those modes disable the
connectors/transcriber paths needed for this test. Do not run a second backend against an existing
backend identity/space. Stop and drain the previous writer before moving that identity to another
machine, or use a separate development identity and state.

Start the backend from `backend/` with `bun src/index.ts` and the frontend from `frontend/` with
`bun run dev --host 127.0.0.1 --port 5186 --strictPort`. Use normal Chrome sign-in and storage unlock.

## Required live evidence

1. Explicitly enable autojoin through the Google connector and observe On plus a successful primary
   calendar scan. Ordinary Google connection alone must leave autojoin Off.
2. Create a controlled confirmed timed primary-calendar event with a real Meet, scheduled several
   minutes ahead. The account must organize or accept it. Avoid unrelated eligible meetings in the
   test account: autojoin applies to all eligible primary-calendar events, including private ones.
3. Close Tinychat tabs while keeping the host's Meet and runtime running. Observe bot admission
   within the dispatch window, speak a synthetic phrase, and finish/stop the recording.
4. Reopen Tinychat and unlock storage. Verify one completed owned recording imports into the library
   with Calendar metadata and a persisted transcript containing that phrase. Navigation/reload must
   not duplicate the recording or overwrite an edited title.
5. Verify Disable stops active autojoined bots, prevents new sends, and preserves recordings and
   browser importer access. Exercise cancellation/rescheduling, restart recovery, reconnect, and
   Disconnect as described in the operations guide.

Record pass/fail/not-run separately for live and automated checks. Disable autojoin and stop test
bots when finished. Preserve durable sent markers and unresolved recovery state.

Transcription integration tests truncate their configured database. Run them only against a new
throwaway test database, never the live smoke database or another useful database. The test harness
uses mock Vexa and is not proof of real Meet capture. If testing native Vexa with attributed
transcription disabled, state that scope explicitly; it does not validate the attributed pipeline.
