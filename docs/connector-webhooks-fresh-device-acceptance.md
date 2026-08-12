# Fresh-device goal acceptance (W12) — the test that defines done

**Status: SPEC + SCAFFOLD. Never run. Arming it is an OPERATOR action.**

Scaffold: `test/connectors/fresh-device-goal-acceptance.e2e.test.ts`
Runbook for enabling a cohort at all:
`docs/specs/tinychat-webhooks-backend-ingest-cohort-enable-checklist.md` (dev repo)

---

## 1. The criterion

Backend-ingest plan §12.1, verbatim:

> **Goal acceptance (W12), the test that defines done:** on a **fresh device/browser profile that
> has never held the Fireflies key and never opened the app before** — sign in, open meetings:
> cohort meetings are visible via the read API. No vault unlock, no key entry. (Sign-in is still
> required; "always there" means no prior device setup, not anonymous access.)

Every other test in this repository proves a component. This one proves the *goal*. A green backend
suite with a red lane here is a backend that stores meetings nobody can see from a new device — the
feature did not happen.

### What "fresh device" means, exactly

A browser profile directory that has never been used before. Not "logged out", not "cleared site
data" — **new**. The three things that must never have existed in it:

1. a Fireflies API key (the Option-C vault secret),
2. an unlocked secrets vault or a cached vault signature (IndexedDB),
3. any prior visit to the app.

The premise under test is that *none of that is needed*. Reusing a warm profile does not weaken the
test; it voids it — the meetings might be visible because yesterday's device set them up. The
scaffold therefore refuses a non-empty profile directory and offers **no reuse override**.

### What "always there" does NOT mean

Sign-in is still required, and the lane asserts it before it opens a browser: an unauthenticated
`GET /api/connectors/meetings` must be rejected. The same bound is pinned in the cohort consent copy
(`frontend/src/lib/connectors/consentCopy.ts`, checked by
`backend/src/__tests__/consent-scope.test.ts`: *"signing in is still required"*). If this lane is
ever edited so a signed-out browser can see meetings, it has stopped describing the product.

---

## 2. Preconditions

The lane cannot manufacture any of these. It asserts the outcome; the operator creates the
conditions.

| # | Precondition | Where it comes from |
|---|---|---|
| 1 | A deployment with `CONNECTOR_BACKEND_INGEST_ENABLED=true` | operator flag flip — cohort-enable checklist |
| 2 | The signing address is in `webhooks/ingest/cohort` on that deployment | operator allowlist edit — cohort-enable checklist |
| 3 | That address has a backend-held Fireflies credential, seeded through the obtain flow | `POST /api/connectors/credentials/fireflies/oauth/start` → `…/callback` |
| 4 | At least one meeting has been webhook-delivered, fetched and stored for that address | the provider; `[connector-obs]` reports `fetched` |
| 5 | The operator is physically present to complete the passkey + SIWE ceremony | by design — sign-in is the one kept ceremony |
| 6 | The account being touched is the operator's own (D5: operator-only dark cohort) | `DECISIONS` `D5-cohort` |

Precondition 3 is the one that surprises people: **the Option-C vault key is not migrated.** A user
who connected Fireflies in the browser has a key in their own vault, and the backend still cannot
read it. The backend's credential is a *separate*, newly obtained one. See the checklist's
seeding step.

---

## 3. Arming the lane

Disarmed unless `FRESH_DEVICE_LANE` is the **exact string `1`** — the same discipline
`backendIngestEnabled()` applies to the dark flag, for the same reason: a value that merely *looks*
on must not half-start something that touches a live full-account credential.

Armed with an incomplete target, the resolver **throws**. It does not skip. A goal-acceptance test
that reports "nothing to run" because an env var was typo'd is the failure mode this rule exists
for.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `FRESH_DEVICE_LANE` | yes | *(unset — disarmed)* | exactly `1` arms the lane |
| `FRESH_DEVICE_APP_URL` | yes when armed | — | the app route (e.g. `https://tinycloud.chat/chat`), not the landing page |
| `FRESH_DEVICE_BACKEND_URL` | yes when armed | — | backend origin serving `/api/connectors/meetings` |
| `FRESH_DEVICE_PROFILE_DIR` | no | `test/.auth/fresh-device/<timestamp>` | must be absent or empty |
| `FRESH_DEVICE_SOURCE` | no | `fireflies` | connector under test |
| `FRESH_DEVICE_SIGNIN_TIMEOUT_MS` | no | `600000` | the operator's window to complete the passkey |
| `FRESH_DEVICE_MIN_MEETINGS` | no | `1` | rows that must be visible for the goal to be met |
| `FRESH_DEVICE_KEEP_OPEN` | no | — | `1` leaves the browser open for inspection |

```
FRESH_DEVICE_LANE=1 \
FRESH_DEVICE_APP_URL=https://tinycloud.chat/chat \
FRESH_DEVICE_BACKEND_URL=https://api.tinycloud.chat \
bun test test/connectors/fresh-device-goal-acceptance.e2e.test.ts
```

Unarmed, the file still runs: it asserts the arming rules, the fresh-profile guard, and the
criterion itself, so the definition of done stays pinned on machines that can never reach a cohort
target.

---

## 4. The steps, and what each one would catch

| Step | Assertion | A failure means |
|---|---|---|
| `fresh-profile-guard` | the profile directory is absent or empty before launch | the run would have proven nothing — a warm profile can see meetings for the wrong reason |
| `signin-required` | unauthenticated `GET /api/connectors/meetings` is rejected (401/403/404) | the read API leaks a tenant's archive to an anonymous caller — stop everything |
| `signin` | a human completes passkey + SIWE in the fresh profile | the app cannot be entered at all |
| `read-api` | a `GET /api/connectors/meetings` answered `200` | dark flag, address not enrolled (404), or an unreadable store (503) |
| `meetings-visible` | ≥ `FRESH_DEVICE_MIN_MEETINGS` rows render, none badged "On this device" | nothing was ingested for this address, or the profile was not fresh after all |
| `content` | `GET /:source/:sourceId` answered `200` after opening a row | metadata without content — the store has an index and no bodies |
| `no-vault-unlock` | no unlock control, no extra ceremony window, `secrets.isUnlocked === false` where observable | the surface secretly depends on the vault, and the goal is not met |
| `no-key-entry` | no API-key field rendered; no connector-secret traffic | the device was asked for the key the goal says it never needs |

### An honest limit in the evidence

`window.__tcw` is exposed only under `import.meta.env.DEV` (`frontend/src/App.tsx`). Against a
production bundle the seam is **absent**, so the vault claim rests on observable proof — no unlock
control, no additional signing ceremony, no secrets traffic. The lane prints which of the two it
used. It does not imply a stronger check than it made.

Related, and deliberately not asserted: W6's browser reconcile (`BackendReconciler.tsx`) writes the
user's own space **only when a vault is already unlocked** — it reads that state, never prompts for
it. On a fresh device it is a no-op, which is why "no vault unlock" and "the reconcile exists" are
both true at once.

---

## 5. Why this never runs in CI

The only target that can answer the criterion is a cohort-enabled deployment: shared infra, a live
full-account Fireflies credential, a real account's meetings. There is no mock that would make the
result mean anything — a fake backend proving a fake device can see fake meetings is a tautology.

It also needs a human at the keyboard for the sign-in, which is not a limitation to engineer around.
Sign-in is the ceremony the goal keeps.

Consequently: **this lane has never been run.** Nothing in this repository has demonstrated the
goal end to end, and nothing may report that it has until an operator arms it against an enabled
cohort and pastes the result.
