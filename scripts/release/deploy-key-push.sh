#!/usr/bin/env bash
# Push to this repository over SSH with the release-push deploy key. The release rulesets let only deploy keys create,
# move or delete release tags and update the `production` branch (docs/deployment.md), so every such push goes
# through here. The key comes from RELEASE_PUSH_SSH_KEY (secret of the `release-push` environment, main only); it is
# written to a private temp file for this push and removed afterwards. GitHub's SSH host keys are read from the
# authenticated API (GH_TOKEN), never trusted on first use.
# Usage: deploy-key-push.sh <git push arguments>   pushes to git@github.com:$GITHUB_REPOSITORY.git
set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
if [ -z "${RELEASE_PUSH_SSH_KEY:-}" ]; then
  echo "::error::RELEASE_PUSH_SSH_KEY is not set: add the release-push deploy key to the release-push environment (docs/deployment.md)"
  exit 1
fi

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
(umask 077 && printf '%s\n' "$RELEASE_PUSH_SSH_KEY" > "$dir/key")
gh api meta --jq '.ssh_keys[] | "github.com " + .' > "$dir/known_hosts"
if [ ! -s "$dir/known_hosts" ]; then
  echo "::error::Could not read GitHub's SSH host keys from the API"
  exit 1
fi

export GIT_SSH_COMMAND="ssh -i '$dir/key' -o IdentitiesOnly=yes -o UserKnownHostsFile='$dir/known_hosts' -o StrictHostKeyChecking=yes"
git push "git@github.com:${GITHUB_REPOSITORY}.git" "$@"
