# Changesets

Every PR adds a changeset here. It names the release units the PR ships
(`@tinychat/frontend` and `exo-desktop` share one version; `@tinychat/backend`
stays `0.x`, minor/patch only) and the bump:

```sh
bunx changeset                                            # interactive
bunx changeset --patch @tinychat/backend -m "Fix X"       # non-interactive
bunx changeset add --empty                                # nothing ships
```

`main` is in pre mode (`pre.json`, tag `beta`); `pre/` holds changesets that a
beta already released. Nothing here is ever published to npm. See "Releases"
in the root [README](../README.md#releases).
