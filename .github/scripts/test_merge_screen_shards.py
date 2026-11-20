import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest

spec = importlib.util.spec_from_file_location("merge", Path(__file__).with_name("merge_screen_shards.py"))
merge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(merge)


class ShardCoverageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.expected_file = "test/exo-ui-screens.e2e.test.ts"
        self.expected = [f"home__phone__{theme}.png" for theme in ("light", "dark")]
        for theme, filename in zip(("light", "dark"), self.expected):
            folder = self.root / theme
            folder.mkdir()
            (folder / filename).write_bytes(b"screenshot")
            (folder / "report.json").write_text(json.dumps({
                "engine": "chromium", "motion": "reduce", "themes": [theme],
                "expected": self.expected,
                "captures": [{"screen": "home", "viewport": "phone", "theme": theme, "file": filename, "findings": []}],
                "readinessCapHits": [],
            }))
            (folder / "junit.xml").write_text(f'<testsuites><testsuite><testcase file="/runner/work/tinychat/tinychat/{self.expected_file}" name="capture" /></testsuite></testsuites>')

    def run_merge(self):
        return merge.merge_reports(self.root, self.root / "merged", {self.expected_file})

    def change_report(self, theme, change):
        path = self.root / theme / "report.json"
        report = json.loads(path.read_text())
        change(report)
        path.write_text(json.dumps(report))

    def test_merges_all_captures_and_junit(self):
        self.run_merge()
        result = json.loads((self.root / "merged/report.json").read_text())
        self.assertEqual({c["file"] for c in result["captures"]}, set(self.expected))
        self.assertTrue((self.root / "merged" / self.expected[0]).is_file())
        self.assertIn(self.expected[1], (self.root / "merged/index.html").read_text())
        self.assertEqual(len(merge.ET.parse(self.root / "merged/junit.xml").findall(".//testcase")), 2)

    def test_rejects_missing_capture_even_when_test_file_ran(self):
        self.change_report("dark", lambda r: r.update(captures=[]))
        with self.assertRaisesRegex(ValueError, "capture coverage"):
            self.run_merge()

    def test_rejects_unexecuted_test_file(self):
        with self.assertRaisesRegex(ValueError, "test file coverage"):
            merge.merge_reports(self.root, self.root / "merged", {self.expected_file, "test/exo-ui-screens-new.e2e.test.ts"})

    def test_rejects_missing_shard(self):
        (self.root / "dark/report.json").unlink()
        with self.assertRaisesRegex(ValueError, "two theme shards"):
            self.run_merge()

    def test_rejects_duplicate_capture(self):
        self.change_report("dark", lambda r: r["captures"].append(r["captures"][0]))
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.run_merge()

    def test_rejects_different_discovery_between_shards(self):
        self.change_report("dark", lambda r: r["expected"].append("new__phone__light.png"))
        with self.assertRaisesRegex(ValueError, "discovery"):
            self.run_merge()

    def test_rejects_skipped_test(self):
        (self.root / "dark/junit.xml").write_text(f'<testsuites><testsuite><testcase file="{self.expected_file}"><skipped /></testcase></testsuite></testsuites>')
        with self.assertRaisesRegex(ValueError, "failed or skipped"):
            self.run_merge()


class ScreenAggregateTests(unittest.TestCase):
    def test_dependency_outcomes(self):
        workflow = Path(__file__).resolve().parents[1] / "workflows/frontend.yml"
        job = workflow.read_text().split("\n  screens:\n", 1)[1].split("\n  halo-webkit:\n", 1)[0]
        script = textwrap.dedent(job.split("        run: |\n", 1)[1])
        cases = [
            ("selected full success", "success", "true", "success", "success", "pull_request", True),
            ("cancelled shard", "success", "true", "cancelled", "success", "pull_request", False),
            ("cancelled coverage", "success", "true", "success", "cancelled", "pull_request", False),
            ("cancelled detector", "cancelled", "", "skipped", "skipped", "pull_request", False),
            ("missing shard", "success", "true", "skipped", "success", "pull_request", False),
            ("failed coverage", "success", "true", "success", "failure", "pull_request", False),
            ("skipped coverage", "success", "true", "success", "skipped", "pull_request", False),
            ("backend-only skip", "success", "false", "skipped", "skipped", "pull_request", True),
            ("main-event skip", "success", "true", "skipped", "skipped", "push", True),
            ("unexpected execution", "success", "false", "success", "success", "pull_request", False),
        ]
        for name, changes, frontend, shards, coverage, event, expected in cases:
            with self.subTest(name=name):
                result = subprocess.run(["bash", "-e", "-c", script], env={
                    **os.environ, "CHANGES_RESULT": changes, "FRONTEND_CHANGED": frontend,
                    "SHARDS_RESULT": shards, "COVERAGE_RESULT": coverage, "EVENT_NAME": event,
                }, capture_output=True, text=True)
                self.assertEqual(result.returncode == 0, expected, result.stderr)


if __name__ == "__main__":
    unittest.main()
