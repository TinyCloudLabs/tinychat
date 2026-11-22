"""Merge Bun screen-harness reports; fail closed on missing files or captures."""
import html
import json
from pathlib import Path
import shutil
import sys
import xml.etree.ElementTree as ET


def merge_reports(source, destination, expected_test_files):
    paths = sorted(source.glob("**/report.json"))
    reports = [json.loads(path.read_text()) for path in paths]
    if len(reports) != 2 or sorted(r["themes"] for r in reports) != [["dark"], ["light"]]:
        raise ValueError("expected exactly two theme shards: light and dark")
    expected = set(reports[0]["expected"])
    if not expected or any(set(r["expected"]) != expected for r in reports):
        raise ValueError("full capture discovery differs between shards or is empty")
    captures = [capture for report in reports for capture in report["captures"]]
    executed = [capture["file"] for capture in captures]
    if len(executed) != len(set(executed)):
        raise ValueError("duplicate captures across shards")
    if set(executed) != expected:
        raise ValueError(f"capture coverage mismatch: missing={sorted(expected - set(executed))}, unexpected={sorted(set(executed) - expected)}")
    if any(capture["findings"] for capture in captures):
        raise ValueError("screen findings in shard report")

    junit_paths = sorted(source.glob("**/junit.xml"))
    if len(junit_paths) != 2:
        raise ValueError("expected JUnit execution evidence from both shards")
    combined_junit = ET.Element("testsuites")
    for path in junit_paths:
        root = ET.parse(path).getroot()
        cases = root.findall(".//testcase")
        if not cases or any(case.find(tag) is not None for case in cases for tag in ("failure", "error", "skipped")):
            raise ValueError("failed or skipped tests in shard JUnit")
        executed_files = set()
        for case in cases:
            file = case.attrib.get("file", "")
            matches = {expected for expected in expected_test_files if file == expected or file.endswith("/" + expected) or "test/" + file == expected}
            if not matches:
                raise ValueError(f"unexpected test file coverage: {file}")
            executed_files.update(matches)
        if executed_files != expected_test_files:
            raise ValueError(f"test file coverage mismatch: missing={sorted(expected_test_files - executed_files)}")
        combined_junit.extend(root.findall("testsuite"))

    destination.mkdir(parents=True, exist_ok=True)
    for path, report in zip(paths, reports):
        for capture in report["captures"]:
            shutil.copyfile(path.parent / capture["file"], destination / capture["file"])
    merged = {
        "engine": "chromium", "motion": "reduce", "themes": ["light", "dark"],
        "expected": sorted(expected), "captures": captures,
        "readinessCapHits": [hit for report in reports for hit in report["readinessCapHits"]],
        "executedTestFiles": sorted(expected_test_files),
    }
    (destination / "report.json").write_text(json.dumps(merged, indent=2))
    ET.ElementTree(combined_junit).write(destination / "junit.xml", encoding="utf-8", xml_declaration=True)
    figures = "".join(f'<figure><a href="{html.escape(c["file"], quote=True)}"><img width="240" src="{html.escape(c["file"], quote=True)}"></a><figcaption>{html.escape(c["file"])}</figcaption></figure>' for c in captures)
    (destination / "index.html").write_text(f'<!doctype html><meta charset="utf-8"><title>Exo UI Chromium screens</title><h1>{len(captures)} captures; both theme shards</h1>{figures}')
    print(f"Shard coverage: {len(expected_test_files)} test files and {len(captures)} captures; no missing or duplicate captures")


if __name__ == "__main__":
    # The screens job's discovered test-file list, independently of its JUnit evidence.
    expected_files = {path.as_posix() for path in Path("test").glob("exo-ui-screens*.e2e.test.ts")}
    if not expected_files:
        raise ValueError("no screen test files discovered")
    merge_reports(Path(sys.argv[1]), Path(sys.argv[2]), expected_files)
