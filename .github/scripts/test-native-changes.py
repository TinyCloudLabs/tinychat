"""Exercise the workflow's detector against real PR merge-base diffs (stdlib only)."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest

WORKFLOW = Path(__file__).resolve().parents[1] / "workflows/native-changes.yml"


class NativeInputsTest(unittest.TestCase):
    def test_build_input_diffs(self):
        # The detector is the last literal run block in this reusable workflow.
        # Execute that shell, rather than duplicating its path-selection rules.
        script = textwrap.dedent(WORKFLOW.read_text().split("        run: |\n", 1)[1])
        selected = [
            "agent-skills/tinychat-retrieval/pack.json",
            "agent-skills/tinychat-retrieval/lib/setup.mjs",
            "agent-skills/tinychat-retrieval/references/setup.md",
            "agent-setup/index.html", "agent-setup/setup.md",
            "backend/package.json", "backend/bunfig.toml",
            "new-workspace/package.json", "new-workspace/bun.lock",
            "new-workspace/bun.lockb", "new-workspace/package-lock.json",
            "new-workspace/npm-shrinkwrap.json", "new-workspace/pnpm-lock.yaml",
            "new-workspace/yarn.lock", "new-workspace/.npmrc",
            "package.json", "bun.lock", "bun.lockb", "bunfig.toml",
            "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml",
            "pnpm-workspace.yaml", "yarn.lock", "turbo.json", "tsconfig.base.json",
            "future-build.config.js", "README.md",
            "frontend/vite.config.ts", "frontend/tsconfig.json",
            "frontend/tailwind.config.js", "frontend/postcss.config.js",
            "frontend/public/agents/tinychat-retrieval/1.0.0/release.json",
            "frontend/src/lib/agent-setup.json", "frontend/src/lib/agent-setup-prompt.mjs",
            "packages/client/scripts/fix-web-wasm-init.mjs",
            "packages/server/scripts/fix-wasm-esm.mjs",
            "scripts/build-agent-skills.mjs", "scripts/build-agent-setup.mjs",
            "scripts/build-agent-surface.mjs", "patches/sdk.patch",
            "scripts/release/desktop-signing.sh",
            "scripts/release/desktop-bundle-config.mjs",
            "scripts/release/verify-desktop-signing.sh",
            ".github/workflows/native-changes.yml", "test/package.json",
        ]
        cases = [(path, "true", "true") for path in selected] + [
            ("mobile/ios/App/Package.resolved", "true", "false"),
            ("desktop/src-tauri/Cargo.lock", "true", "false"),
            ("docs/deployment.md", "false", "false"),
            ("backend/src/health.ts", "false", "false"),
        ]
        with tempfile.TemporaryDirectory(prefix="native-input-fixtures-") as directory:
            cwd = Path(directory)
            subprocess.run(["git", "init", "-q", directory], check=True)
            stream = bytearray(b"commit refs/heads/base\nmark :1\ncommitter CI <ci@example.invalid> 1 +0000\ndata 4\nbase\n\n")
            for index, (path, _, _) in enumerate(cases, 2):
                stream.extend(f"commit refs/heads/case{index}\ncommitter CI <ci@example.invalid> 2 +0000\ndata 4\ncase\nfrom :1\nM 100644 inline {json.dumps(path)}\ndata 1\nx\n\n".encode())
            subprocess.run(["git", "fast-import", "--quiet"], cwd=cwd, input=stream, check=True)
            for index, (path, native, frontend) in enumerate(cases, 2):
                with self.subTest(path=path):
                    output = cwd / "output"
                    output.write_text("")
                    result = subprocess.run(["bash", "-e", "-o", "pipefail", "-c", script], cwd=cwd, env={
                        **os.environ, "EVENT": "pull_request", "BASE": "base", "HEAD": f"case{index}",
                        "RUNNER_TEMP": directory, "GITHUB_OUTPUT": str(output), "GITHUB_STEP_SUMMARY": str(cwd / "summary"),
                    }, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(output.read_text(), f"native={native}\nfrontend={frontend}\n")


if __name__ == "__main__":
    unittest.main()
