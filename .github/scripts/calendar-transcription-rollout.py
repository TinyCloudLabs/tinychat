#!/usr/bin/env python3
"""Bounded, compose-only update of the existing transcription CVM."""

import copy
import argparse
from datetime import datetime, timezone
import hashlib
import http.server
import json
import os
import subprocess
import tempfile
import time
import threading
import unittest
import urllib.error
import urllib.request
import uuid
from unittest import mock
from pathlib import Path

import yaml

CVM_ID = "9a79a27e-8243-4fd7-b17d-fc9300333784"
APP_ID = "7fd569fb6ac2cae943cea1d1aff247cd8ea61fdc"
OLD_IMAGE = "ghcr.io/tinycloudlabs/tinycloud-private-transcription/api:0c5b5ae12a1ea417d39e55e2291963393480222b@sha256:574e7106f93cb1bf730a816ada12a2e3d2fa545b149a8dce2308b09ddb303005"
NEW_IMAGE = "ghcr.io/tinycloudlabs/tinycloud-private-transcription/api:calendar-autojoin-666c3111d4d47547050d06b637ac0eef74229e89@sha256:df9d4425eb5def3bcffff9b162934e4dc104784816f3531e66b0c3d0cf10eec3"
VOLUMES = {
    "ptx-postgres", "ptx-redis", "vexa-postgres", "vexa-redis", "minio-data",
    "whisper-cache", "vexa-provision", "signal-profile", "signal-profile-2",
    "signal-profile-3", "signal-runtime", "signal-health", "signal-health-2",
    "signal-health-3", "signal-control-1", "signal-control-2", "signal-control-3",
}
FAILURE_EVIDENCE_DIR = None


class RolloutError(Exception):
    """Only fixed, nonsecret error codes may be exposed."""


class UniqueLoader(yaml.SafeLoader):
    def construct_mapping(self, node, deep=False):
        # Flatten Compose merge keys before checking for ambiguous mappings.
        self.flatten_mapping(node)
        keys = [self.construct_object(key, deep=deep) for key, _ in node.value]
        if len(keys) != len(set(keys)):
            raise RolloutError("duplicate_yaml_keys")
        return super().construct_mapping(node, deep=deep)


def parse_compose(raw):
    try:
        result = yaml.load(raw, Loader=UniqueLoader)
        if not isinstance(result, dict):
            raise RolloutError("invalid_compose")
        return result
    except (yaml.YAMLError, TypeError, ValueError):
        raise RolloutError("invalid_compose") from None


def plan_update(compose):
    raw = compose.get("docker_compose_file")
    if not isinstance(raw, str) or raw.count(OLD_IMAGE) != 2:
        raise RolloutError("unexpected_image_references")
    before = parse_compose(raw)
    if set(before.get("volumes", {})) != VOLUMES:
        raise RolloutError("unexpected_volume_inventory")
    expected = copy.deepcopy(before)
    for service in ("api", "worker"):
        if before.get("services", {}).get(service, {}).get("image") != OLD_IMAGE:
            raise RolloutError("unexpected_service_image")
        expected["services"][service]["image"] = NEW_IMAGE
    replaced = raw.replace(OLD_IMAGE, NEW_IMAGE)
    if parse_compose(replaced) != expected:
        raise RolloutError("unexpected_compose_change")
    return {**compose, "docker_compose_file": replaced}


def check_target(info, require_running=True):
    if info.get("vm_uuid") != CVM_ID or info.get("app_id") != APP_ID:
        raise RolloutError("target_identity_mismatch")
    if require_running and (info.get("status") != "running" or info.get("in_progress") is not False):
        raise RolloutError("target_not_idle_running")


def check_health(status, body):
    checks = body.get("checks", {})
    attributed = checks.get("attributed_transcription", {})
    signal = checks.get("signal", {})
    if not all(checks.get(key) is True for key in ("postgres", "redis", "vexa")):
        raise RolloutError("core_health_not_ready")
    if attributed.get("enabled") is not True or attributed.get("ready") is not True:
        raise RolloutError("attributed_health_not_ready")
    if checks.get("transcription_provider") != "vexa":
        raise RolloutError("unexpected_transcription_provider")
    if checks.get("bot_capacity", {}).get("running") != 0:
        raise RolloutError("active_bot_or_unknown_capacity")
    capacity = signal.get("capacity")
    if isinstance(capacity, dict) and capacity.get("running") != 0:
        raise RolloutError("active_signal_or_unknown_capacity")
    known_signal = signal == {"enabled": True, "ready": False,
                             "reason": "seat 2 is not ready; seat 3 is not ready", "capacity": None}
    if not ((status == 200 and body.get("status") == "ok" and signal.get("ready") is True)
            or (status == 503 and body.get("status") == "degraded" and known_signal)):
        raise RolloutError("unexpected_health_degradation")
    return {"healthStatus": status, "postgres": True, "redis": True, "vexa": True,
            "attributedReady": True, "runningBots": 0, "signalReady": signal.get("ready") is True,
            "knownSignalDegradation": known_signal}


def runtime_matches(composition, image):
    containers = composition.get("containers", [])
    for service in ("api", "worker"):
        matches = [c for c in containers if f"/dstack-{service}-1" in c.get("names", [])]
        if len(matches) != 1 or matches[0].get("state") != "running" or matches[0].get("image") != image:
            return False
    return True


def phala(endpoint, yaml_body=None):
    command = ["phala", "api", f"/cvms/{CVM_ID}{endpoint}", "-X", "PATCH" if yaml_body is not None else "GET"]
    # Capture all output: compose metadata and CLI errors can contain credentials.
    try:
        with tempfile.TemporaryDirectory(prefix="calendar-transcription-request-") as tmp:
            if yaml_body is not None:
                # phala 1.1.22 parses --input twice. A pipe is consumed by the first
                # parse and sends an empty PATCH; a private file is safely reread.
                source = Path(tmp) / "compose.yaml"
                descriptor = os.open(source, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(descriptor, "w") as stream:
                    stream.write(yaml_body)
                command += ["-H", "Content-Type: text/yaml", "--input", str(source), "--include"]
            result = subprocess.run(command, text=True, capture_output=True,
                                    timeout=120, cwd="/tmp", check=False)
    except (subprocess.TimeoutExpired, OSError) as error:
        capture_phala_failure(endpoint, None, getattr(error, "stdout", None), getattr(error, "stderr", None))
        raise RolloutError("phala_request_failed") from None
    output = result.stdout
    http_status = None
    if output.startswith("HTTP/"):
        first_line = output.splitlines()[0].split()
        if len(first_line) > 1 and first_line[1].isdigit():
            http_status = int(first_line[1])
        output = output.partition("\n\n")[2]
    if result.returncode:
        capture_phala_failure(endpoint, result.returncode, result.stdout, result.stderr)
        code = f"phala_http_{http_status}" if http_status and 100 <= http_status <= 599 else "phala_request_failed"
        raise RolloutError(code)
    try:
        body = json.loads(output)
        if not isinstance(body, dict):
            raise ValueError()
        return body
    except ValueError:
        capture_phala_failure(endpoint, result.returncode, result.stdout, result.stderr)
        raise RolloutError("phala_response_invalid") from None


def capture_phala_failure(endpoint, returncode, stdout, stderr):
    if FAILURE_EVIDENCE_DIR is not None:
        diagnostic = {"endpoint": endpoint, "returncode": returncode,
                      "stdout": stdout.decode(errors="replace") if isinstance(stdout, bytes) else stdout,
                      "stderr": stderr.decode(errors="replace") if isinstance(stderr, bytes) else stderr}
        encrypt_backup(diagnostic, FAILURE_EVIDENCE_DIR / f"phala-failure-{uuid.uuid4()}.cms")


def prepare(report, evidence):
    check_target(phala(""))
    before = phala("/compose_file")
    after = plan_update(before)
    if not runtime_matches(phala("/composition"), OLD_IMAGE):
        raise RolloutError("unexpected_initial_runtime_images")
    report["beforeHealth"] = check_health(*public_get("/health"))
    encrypt_backup(before, evidence / "transcription-before.cms")
    encrypt_backup(after, evidence / "transcription-after.cms")
    report["beforeComposeSha256"] = hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest()
    report["afterComposeSha256"] = hashlib.sha256(json.dumps(after, sort_keys=True).encode()).hexdigest()
    report["volumeCount"] = len(VOLUMES)
    report["encryptedComposeBackupsCreated"] = True
    return {"before": before, "after": after}


def execute(report, evidence, plan):
    before, after = plan["before"], plan["after"]
    if plan_update(before) != after:
        raise RolloutError("invalid_saved_plan")
    # Optimistic race check; no server compare-and-swap API is documented here.
    if phala("/compose_file") != before:
        raise RolloutError("concurrent_compose_change")
    check_target(phala(""))
    if not runtime_matches(phala("/composition"), OLD_IMAGE):
        raise RolloutError("unexpected_initial_runtime_images")
    report["immediateBeforeHealth"] = check_health(*public_get("/health"))
    report["mutationAttempts"] = 1
    # An ambiguous timeout/error is never automatically retried or rolled back.
    report["mutationOutcomeUncertain"] = True
    result = phala("/docker-compose", after["docker_compose_file"])
    if result.get("status") != "in_progress":
        raise RolloutError("unexpected_patch_response")
    report["patchAccepted"] = True
    deadline = time.monotonic() + 900
    while time.monotonic() < deadline:
        try:
            info = phala("")
            check_target(info, require_running=False)
            if info.get("status") == "running" and info.get("in_progress") is False:
                if phala("/compose_file") != after:
                    raise RolloutError("post_update_metadata_mismatch")
                if runtime_matches(phala("/composition"), NEW_IMAGE):
                    live_status, live = public_get("/health/live")
                    if live_status != 200 or any(live.get("checks", {}).get(key) is not True for key in ("postgres", "redis")):
                        raise RolloutError("liveness_not_ready")
                    report["afterHealth"] = check_health(*public_get("/health"))
                    report["liveStatus"] = 200
                    break
        except RolloutError as error:
            if str(error) in ("target_identity_mismatch", "post_update_metadata_mismatch"):
                raise
            report["lastPollError"] = str(error)
        time.sleep(10)
    else:
        raise RolloutError("post_update_verification_timeout")
    headers = {"Authorization": "Bearer " + os.environ["TRANSCRIPTION_API_KEY"]}
    status, body = public_get("/v1/meetings/by-idempotency-key", headers)
    if status != 400 or body.get("error", {}).get("code") != "invalid_request":
        raise RolloutError("lookup_missing_header_failed")
    headers = {**headers, "Idempotency-Key": "calendar-release-check-" + str(uuid.uuid4())}
    status, body = public_get("/v1/meetings/by-idempotency-key", headers)
    if status != 404 or body.get("error", {}).get("code") != "meeting_not_found":
        raise RolloutError("lookup_unknown_key_failed")
    report.update(verified=True, metadataPreserved=True, runtimeImage=NEW_IMAGE,
                  lookupMissingHeaderStatus=400, lookupUnknownKeyStatus=404,
                  mutationOutcomeUncertain=False)
    report.pop("lastPollError", None)


def public_get(path, headers=None):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    origin = f"https://{APP_ID}-8080.dstack-pha-prod5.phala.network"
    request = urllib.request.Request(origin + path, headers=headers or {}, method="GET")
    try:
        try:
            response = urllib.request.build_opener(NoRedirect).open(request, timeout=20)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            status = response.code
            body = json.loads(response.read(65536))
        if not isinstance(body, dict):
            raise ValueError()
        return status, body
    except (ValueError, OSError, urllib.error.URLError):
        raise RolloutError("public_probe_failed") from None


def encrypt_backup(compose, destination):
    # Full compose metadata can include embedded secrets. Plaintext exists only in
    # a 0700 temporary directory; never place it under the artifact directory.
    with tempfile.TemporaryDirectory(prefix="calendar-transcription-private-") as tmp:
        source = Path(tmp) / "compose.json"
        descriptor = os.open(source, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as stream:
            json.dump(compose, stream, sort_keys=True)
        result = subprocess.run([
            "openssl", "cms", "-encrypt", "-binary", "-aes256", "-in", str(source),
            "-out", str(destination), "-outform", "DER", ".github/calendar-recovery.crt.pem",
        ], capture_output=True, timeout=30, check=False)
        if result.returncode or not destination.is_file() or not destination.stat().st_size:
            raise RolloutError("compose_backup_encryption_failed")


class PlanTests(unittest.TestCase):
    def fixture(self):
        return {"name": "ptx-dev", "allowed_envs": ["EXISTING_SECRET"],
                "pre_launch_script": "preserve exactly",
                "docker_compose_file": yaml.safe_dump({
                    "services": {
                        "api": {"image": OLD_IMAGE, "volumes": ["signal-runtime:/key:ro"]},
                        "worker": {"image": OLD_IMAGE},
                        "postgres": {"image": "unchanged@sha256:abc"}},
                    "volumes": {name: None for name in sorted(VOLUMES)},
                }, sort_keys=False)}

    def test_only_two_images_change_and_input_is_untouched(self):
        before = self.fixture()
        original = copy.deepcopy(before)
        after = plan_update(before)
        self.assertEqual(before, original)
        self.assertEqual(after, {**before, "docker_compose_file":
                                before["docker_compose_file"].replace(OLD_IMAGE, NEW_IMAGE)})
        self.assertNotEqual(after, before)

    def test_rejects_either_unexpected_image(self):
        for service in ("api", "worker"):
            value = self.fixture()
            doc = yaml.safe_load(value["docker_compose_file"])
            doc["services"][service]["image"] = NEW_IMAGE
            value["docker_compose_file"] = yaml.safe_dump(doc)
            with self.assertRaises(RolloutError):
                plan_update(value)

    def test_rejects_extra_reference_to_the_old_image(self):
        value = self.fixture()
        value["docker_compose_file"] += "\n# " + OLD_IMAGE + "\n"
        with self.assertRaises(RolloutError):
            plan_update(value)

    def test_rejects_changed_volume_inventory(self):
        value = self.fixture()
        doc = yaml.safe_load(value["docker_compose_file"])
        del doc["volumes"]["minio-data"]
        value["docker_compose_file"] = yaml.safe_dump(doc)
        with self.assertRaises(RolloutError):
            plan_update(value)

    def test_rejects_duplicate_yaml_keys(self):
        value = self.fixture()
        value["docker_compose_file"] += "\nservices: {}\n"
        with self.assertRaises(RolloutError):
            plan_update(value)


class SafetyTests(unittest.TestCase):
    def health(self):
        return {"status": "degraded", "checks": {
            "postgres": True, "redis": True, "vexa": True,
            "transcription_provider": "vexa", "bot_capacity": {"running": 0},
            "attributed_transcription": {"enabled": True, "ready": True},
            "signal": {"enabled": True, "ready": False,
                       "reason": "seat 2 is not ready; seat 3 is not ready", "capacity": None}}}

    def test_rejects_wrong_or_busy_target(self):
        good = {"vm_uuid": CVM_ID, "app_id": APP_ID, "status": "running", "in_progress": False}
        check_target(good)
        for update in ({"app_id": "wrong"}, {"vm_uuid": "wrong"},
                       {"in_progress": True}, {"status": "stopped"}):
            with self.assertRaises(RolloutError):
                check_target({**good, **update})

    def test_accepts_only_known_signal_degradation_with_core_ready(self):
        body = self.health()
        self.assertEqual(check_health(503, body).get("healthStatus"), 503)
        for key in ("postgres", "redis", "vexa"):
            broken = copy.deepcopy(body)
            broken["checks"][key] = False
            with self.assertRaises(RolloutError):
                check_health(503, broken)
        body["checks"]["attributed_transcription"]["ready"] = False
        with self.assertRaises(RolloutError):
            check_health(503, body)

    def test_rejects_new_signal_failure_or_live_bot(self):
        body = self.health()
        body["checks"]["signal"]["reason"] = "seat 1 readiness is stale"
        with self.assertRaises(RolloutError):
            check_health(503, body)
        body = self.health()
        body["checks"]["bot_capacity"]["running"] = 1
        with self.assertRaises(RolloutError):
            check_health(503, body)

    def test_runtime_requires_both_running_new_images(self):
        composition = {"is_online": True, "containers": [
            {"names": ["/dstack-api-1"], "state": "running", "image": NEW_IMAGE},
            {"names": ["/dstack-worker-1"], "state": "running", "image": NEW_IMAGE}]}
        self.assertTrue(runtime_matches(composition, NEW_IMAGE))
        composition["containers"][1]["image"] = OLD_IMAGE
        self.assertFalse(runtime_matches(composition, NEW_IMAGE))

    @mock.patch("subprocess.run")
    def test_patch_uses_private_file_and_never_retries_or_exposes_failure(self, run):
        run.return_value = mock.Mock(returncode=1, stdout="secret response", stderr="secret error")
        paths = []
        def inspect_request(command, **kwargs):
            path = Path(command[command.index("--input") + 1])
            self.assertNotEqual(str(path), "-")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.read_text(), "sensitive compose")
            paths.append(path)
            return run.return_value
        run.side_effect = inspect_request
        with self.assertRaisesRegex(RolloutError, "^phala_request_failed$"):
            phala("/docker-compose", "sensitive compose")
        self.assertEqual(run.call_count, 1)
        args, kwargs = run.call_args
        self.assertNotIn("sensitive compose", args[0])
        self.assertNotIn("input", kwargs)
        self.assertFalse(paths[0].exists())


class ExecutionTests(unittest.TestCase):
    def info(self):
        return {"vm_uuid": CVM_ID, "app_id": APP_ID, "status": "running", "in_progress": False}

    def composition(self, image):
        return {"containers": [{"names": [f"/dstack-{service}-1"], "state": "running", "image": image}
                               for service in ("api", "worker")]}

    @mock.patch.dict(os.environ, {"TRANSCRIPTION_API_KEY": "test-only"})
    @mock.patch("__main__.encrypt_backup")
    @mock.patch("__main__.public_get")
    @mock.patch("__main__.phala")
    def test_backups_precede_single_patch_then_verify_same_vm_metadata_and_lookup(self, api, http, encrypt):
        before = PlanTests().fixture()
        after = {**before, "docker_compose_file": before["docker_compose_file"].replace(OLD_IMAGE, NEW_IMAGE)}
        mutated = False
        events = []
        def remote(endpoint, yaml_body=None):
            nonlocal mutated
            if yaml_body is not None:
                events.append("patch")
                self.assertEqual(yaml_body, after["docker_compose_file"])
                mutated = True
                return {"status": "in_progress"}
            return {"": self.info(), "/compose_file": after if mutated else before,
                    "/composition": self.composition(NEW_IMAGE if mutated else OLD_IMAGE)}[endpoint]
        api.side_effect = remote
        encrypt.side_effect = lambda *args: events.append("backup")
        http.side_effect = [(503, SafetyTests().health()),
                            (503, SafetyTests().health()),
                            (200, {"checks": {"postgres": True, "redis": True}}),
                            (503, SafetyTests().health()),
                            (400, {"error": {"code": "invalid_request"}}),
                            (404, {"error": {"code": "meeting_not_found"}})]
        report = {}
        with tempfile.TemporaryDirectory() as tmp:
            plan = prepare(report, Path(tmp))
            execute(report, Path(tmp), plan)
        self.assertEqual(events, ["backup", "backup", "patch"])
        self.assertTrue(report.get("verified"))
        self.assertTrue(report.get("metadataPreserved"))
        self.assertEqual(report.get("mutationAttempts"), 1)
        lookup_headers = http.call_args_list[-1].args[1]
        self.assertTrue(lookup_headers["Idempotency-Key"].startswith("calendar-release-check-"))

    @mock.patch("__main__.encrypt_backup")
    @mock.patch("__main__.public_get")
    @mock.patch("__main__.phala")
    def test_race_rejects_before_patch(self, api, http, encrypt):
        before = PlanTests().fixture()
        api.side_effect = [{**before, "pre_launch_script": "another operator changed this"}]
        http.return_value = (503, SafetyTests().health())
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(RolloutError, "^concurrent_compose_change$"):
                execute({}, Path(tmp), {"before": before, "after": plan_update(before)})
        self.assertTrue(all(len(call.args) == 1 for call in api.call_args_list))

    def test_encrypted_backup_contains_no_plaintext(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "backup.cms"
            encrypt_backup({"sentinel": "synthetic confidential fixture"}, output)
            self.assertTrue(output.exists())
            self.assertNotIn(b"synthetic confidential fixture", output.read_bytes())


class CliTransportTests(unittest.TestCase):
    def test_real_cli_patch_sends_complete_non_json_yaml(self):
        seen = []
        payload = "services:\n  api:\n    image: example.invalid/synthetic\n"
        class Receiver(http.server.BaseHTTPRequestHandler):
            def do_PATCH(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                seen.append((body, self.headers.get("Content-Type")))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"status":"in_progress"}')
            def log_message(self, *args):
                pass
        server = http.server.HTTPServer(("127.0.0.1", 0), Receiver)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with mock.patch.dict(os.environ, {
                "PHALA_CLOUD_API_KEY": "synthetic-loopback-only",
                "PHALA_CLOUD_API_PREFIX": f"http://127.0.0.1:{server.server_port}/api/v1",
            }):
                self.assertEqual(phala("/docker-compose", payload), {"status": "in_progress"})
            self.assertEqual(seen, [(payload.encode(), "text/yaml")])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


def main():
    global FAILURE_EVIDENCE_DIR
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--self-test", action="store_true")
    mode.add_argument("--prepare-only", action="store_true")
    mode.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        unittest.main(argv=[__file__])
        return
    os.umask(0o077)
    root = Path(os.environ["RUNNER_TEMP"])
    evidence = root / "calendar-transcription-evidence"
    private = root / "calendar-transcription-private"
    evidence.mkdir(mode=0o700, exist_ok=True)
    FAILURE_EVIDENCE_DIR = evidence
    private.mkdir(mode=0o700, exist_ok=True)
    report_path = evidence / "report.json"
    plan_path = private / "plan.json"
    report = {"cvmId": CVM_ID, "appId": APP_ID, "client": "phala@1.1.22",
              "mutationAttempts": 0, "verified": False,
              "persistentVolumeSnapshotTaken": False,
              "operatorMaintenanceAssurance": True}
    try:
        if not os.environ.get("PHALA_CLOUD_API_KEY") or not os.environ.get("TRANSCRIPTION_API_KEY"):
            raise RolloutError("missing_required_credential")
        version = subprocess.run(["phala", "--version"], capture_output=True, text=True,
                                 timeout=30, check=False)
        if version.returncode or version.stdout.strip().removeprefix("v").split("+", 1)[0] != "1.1.22":
            raise RolloutError("unexpected_phala_cli_version")
        if args.prepare_only:
            if plan_path.exists():
                raise RolloutError("saved_plan_already_exists")
            plan = prepare(report, evidence)
            descriptor = os.open(plan_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w") as stream:
                json.dump(plan, stream)
            report["prepared"] = True
        else:
            report = json.loads(report_path.read_text())
            if report.get("mutationAttempts") != 0 or report.get("prepared") is not True or report.get("executionStarted"):
                raise RolloutError("saved_plan_not_ready")
            plan = json.loads(plan_path.read_text())
            # Prevent replay after any interrupted execution, including an ambiguous PATCH.
            report["executionStarted"] = True
            report_path.write_text(json.dumps(report, indent=2) + "\n")
            execute(report, evidence, plan)
        report["outcome"] = "prepared" if args.prepare_only else "verified"
        exit_code = 0
    except RolloutError as error:
        report["outcome"] = "failed"
        report["errorCode"] = str(error)
        exit_code = 1
    except Exception:
        # Never interpolate raw exceptions, tracebacks, API responses or env values.
        report["outcome"] = "failed"
        report["errorCode"] = "unexpected_runner_error"
        exit_code = 1
    finally:
        report["observedAt"] = datetime.now(timezone.utc).isoformat()
        report_path.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, sort_keys=True))
        if args.execute:
            plan_path.unlink(missing_ok=True)
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
