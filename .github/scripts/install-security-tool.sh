#!/usr/bin/env bash
# Installs a pinned, sha256-verified security scanner into $RUNNER_TEMP/<tool> and puts it on PATH.
# Fails closed: a download, checksum or version mismatch fails the step.
#   .github/scripts/install-security-tool.sh gitleaks|trivy
# To bump a tool, change version and sha256 together (sha256 from the release's checksums file).
set -euo pipefail

tool=${1:?usage: install-security-tool.sh gitleaks|trivy}
case "$tool" in
  gitleaks)
    version=8.30.1
    url="https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_linux_x64.tar.gz"
    sha256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
    ;;
  trivy)
    version=0.76.2
    url="https://github.com/aquasecurity/trivy/releases/download/v${version}/trivy_${version}_Linux-64bit.tar.gz"
    sha256=bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf
    ;;
  *)
    echo "::error::unknown tool '$tool'" >&2
    exit 1
    ;;
esac

dir="${RUNNER_TEMP:?}/$tool"
mkdir -p "$dir"
curl --fail --location --silent --show-error --retry 3 "$url" --output "$dir/$tool.tar.gz"
echo "$sha256  $dir/$tool.tar.gz" | sha256sum --check -
tar -xzf "$dir/$tool.tar.gz" -C "$dir" "$tool"
rm "$dir/$tool.tar.gz"
"$dir/$tool" --version | grep -F "$version"
echo "$dir" >> "${GITHUB_PATH:?}"
