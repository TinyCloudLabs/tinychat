# Changesets

Every PR adds a changeset here. It names the release units the PR ships
(`exo-desktop`, `@tinychat/frontend`, `@tinychat/backend`) and the bump:

```sh
bunx changeset                                          # interactive
bunx changeset --patch @tinychat/backend -m "Fix X"     # non-interactive
bunx changeset add --empty                              # nothing ships
```

Nothing here is ever published to npm. See "Releases" in the root
[README](../README.md#releases) for how versions, tags and deploys work.
