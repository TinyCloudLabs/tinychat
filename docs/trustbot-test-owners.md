# TrustBot test owner list

TrustBot (the Home Main bot) answers only owners on `BOTS_TEST_ACCOUNTS`. The list lives in two GitHub environment
variables that must hold the same entries:

- `production-api` → read by `.github/workflows/deploy-backend-phala.yml` (`vars.BOTS_TEST_ACCOUNTS`), enforced by
  `botsFromEnv` → `accountAllowed` in `backend/src/routes/bots.ts`.
- `production-bots` → read by `.github/workflows/deploy-bots-phala.yml` (`vars.BOTS_TEST_ACCOUNTS`), enforced by
  `bots/src/config.ts` and `ownerAllowed` (`bots/src/owner.ts`, called from `bots/src/server.ts`).

A change takes effect only when the backend and bots are next deployed. Pages previews use the production backend
(`wrangler.toml` `VITE_BACKEND_URL`), so these lists gate previews too.

This file records each owner added or removed through the procedure below. Entries that were on the lists before this
file existed are not described here and are not changed by it.

## Log

| Address | Label | Credential held by | Purpose | Added | Remove after | Removed |
|---|---|---|---|---|---|---|
| `0x9744721B75a608Da8A819755fcB767B1DaD2900F` | `trustbot-acje-20261124-67921660` | QA (fresh sign-up, created 2026-11-24 12:38Z; never used TrustBot) | TrustBot reads check on production and the fresh-owner chat-history permission check | on the deploy after this PR merges | both checks pass or are abandoned; 2026-12-24 at the latest | |

Each owner holds no funds, data or other grants, and is used for nothing else.

## Procedure

Run by the deployer after the PR that edits the log has merged. Values never go in chat or logs; the saved copy
stays in a private scratch file.

Apply:

1. Read both variables and save them:
   `gh variable get BOTS_TEST_ACCOUNTS --env production-api --repo TinyCloudLabs/tinychat > "$S/api.old"` and the
   same for `production-bots` into `"$S/bots.old"` (`S` is a `mktemp -d` directory, mode 700). Stop if the two lists
   differ as sets.
2. Set each to its saved value plus the logged address, appended with a comma. Nothing else changes:
   `gh variable set BOTS_TEST_ACCOUNTS --env production-api --repo TinyCloudLabs/tinychat --body "$(cat "$S/api.old"),ADDRESS"`
   and the same for `production-bots` from `"$S/bots.old"`.
3. Read both back. Each must equal its old set plus the address, with no entry lost.
4. Deploy the backend and bots the normal way at the approved main SHA.
5. Check: the logged owner gets `enabled: true` from the bots status route; an existing test owner still does.

Roll back: set both variables back to `"$S/api.old"` and `"$S/bots.old"`, read them back, and deploy the backend and
bots again.

Remove: once QA is done, a PR fills in the Removed column; after it merges, run the apply steps with the address
taken out instead of appended, then deploy.
