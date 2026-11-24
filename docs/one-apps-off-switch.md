# Turning One Apps off

One Apps is the Apps grid in TinyCloud One that opens separately hosted apps inside One. This page says how to turn it off on the web, what turning it off does, and what it cannot do for a phone that already has the app installed.

## What the switch is

One build variable, `VITE_ONE_APPS`. One Apps is on only when it is exactly `"true"`. Anything else, including unset, gives the Apps page One had before One Apps (`frontend/src/App.tsx`, `frontend/src/shell/navPins.ts`).

`VITE_ONE_NAV` (the pill, the grid and the app bar) and `VITE_ONE_ADD_APP` do nothing unless `VITE_ONE_APPS` is `"true"`.

Vite bakes `VITE_*` values into the build, so the switch only takes effect when a new build is deployed. Nothing flips it at run time.

Where it is set today:

| File | Value |
|---|---|
| `wrangler.toml`, `[vars]` and `[env.production.vars]` | `"true"` |
| `frontend/.env.production` | `true` (phone builds read this file too) |
| `.github/workflows/mobile.yml` (the framed-apps check) | `"true"` |

The Pages project may also hold its own copy in the Cloudflare dashboard. `wrangler.toml` says it is the source of truth for Pages Git builds, while `docs/deployment.md` says the dashboard build variables are. This page does not settle that. Whoever runs the deploy checks the dashboard value before relying on either file.

## What turning it off does

- The Apps tab shows the old Apps page. The framed apps (Secrets, Credentials, Explorer, Account, Courier and the rest of the grid) are not opened from One.
- Nothing is deleted and nothing is revoked. Permissions a person already gave to an app stay as they are until they expire or the person revokes them.
- Recording, Connectors and the rest of One keep working. They do not depend on the switch.

## Turn it off on the web

1. Open a pull request that sets `VITE_ONE_APPS` to `"false"` in `wrangler.toml` (both blocks) and in `frontend/.env.production`. Add a changeset. Keep `VITE_ONE_NAV` as it is.
2. Merge it. A merge to `main` only builds a preview. It does not change `tinycloud.one`.
3. Deploy with the Deploy production workflow (`.github/workflows/deploy-production.yml`), which moves the `production` branch to the released commit. The Release workflow starts it for a stable frontend release. It can also be started by hand with the release tag.
4. Check `https://tinycloud.one/version.json`. It names the deployed commit, and it has to be the commit from step 1. Open the Apps tab and confirm the old Apps page.

## Turn it back on

Revert the same pull request and deploy the same way.

## Roll back a deploy

Start Deploy production with the previous release tag (`--ref main -f tag=@tinychat/frontend@<version> -f backend=false`), or use the rollback in the Pages dashboard. Note the current deployment before any change, so there is something to return to.

A Pages rollback to a deployment built before One Apps was turned on (2026-11-19) also drops everything shipped since. Prefer a new deploy with the switch off.

## Phones

A phone build carries its own copy of the switch. There is no way to turn One Apps off on a phone that already has the build. Off on a phone means a new build with the switch off, a new store release, and the person updating.

Each framed app is a separately hosted site, so taking one site down stops that app on every build that still opens it. This page does not describe that, and it does not turn One Apps off.

## Who runs it

A merge needs the repository's usual approval. The production deploy and the Cloudflare side are run by whoever owns deploys, one change at a time. A switch that works without a new build is separate work and is not described here.
