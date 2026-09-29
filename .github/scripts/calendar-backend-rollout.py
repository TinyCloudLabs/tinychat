"""One-time, reviewed backend replacement; secrets stay in runner temp or encrypted recovery."""
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

import yaml

UUID = "7bf0a49d-b12b-46f2-b684-bebc5407e64a"
APP = "2faaa9242e190fe9cbbff7bc8667b5c4e52c3acf"
OLD = "ghcr.io/tinycloudlabs/tinychat-backend:add998813ea473b3396320cfbcadd30bf62e6d57"
NEW = "ghcr.io/tinycloudlabs/tinychat-backend:calendar-autojoin-76e800725200594382f6715e80e33eea7fba3251@sha256:de34c711fe0e872d8b91fc70fce8e99bd0e15f3b1bcc0033103a4eca6aab3dc1"
MASTER_SHA256 = "32f7011c098b15837c6dbcaf43f0b41b135cdaf06151516f0c9f4b5b0df608c8"
RECOVERY_CERTIFICATE = Path(__file__).resolve().parent.parent / "calendar-recovery.crt.pem"
FAILURE_EVIDENCE_DIR = None


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def command(args, timeout=60):
    try:
        result = subprocess.run(args, cwd="/tmp", capture_output=True, timeout=timeout)
    except (subprocess.TimeoutExpired, OSError) as error:
        capture_command_failure(args, None, getattr(error, "stdout", None), getattr(error, "stderr", None))
        raise
    if result.returncode:
        capture_command_failure(args, result.returncode, result.stdout, result.stderr)
    check(result.returncode == 0, "Command failed; raw output withheld to protect configuration")
    return result.stdout


def capture_command_failure(args, returncode, stdout, stderr):
    if FAILURE_EVIDENCE_DIR is None:
        return
    destination = FAILURE_EVIDENCE_DIR / f"command-failure-{uuid.uuid4()}.cms"
    try:
        diagnostic = {"command": args, "returncode": returncode,
                      "stdout": stdout.decode(errors="replace") if isinstance(stdout, bytes) else stdout,
                      "stderr": stderr.decode(errors="replace") if isinstance(stderr, bytes) else stderr}
        with tempfile.TemporaryDirectory(prefix="calendar-backend-diagnostic-") as tmp:
            source = Path(tmp) / "diagnostic.json"
            descriptor = os.open(source, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w") as stream:
                json.dump(diagnostic, stream)
            # Run encryption directly: its own failure must not recurse or retry
            # the original operation. Plaintext never enters the artifact directory.
            encrypted = subprocess.run([
                "openssl", "cms", "-encrypt", "-binary", "-aes256", "-in", str(source),
                "-out", str(destination), "-outform", "DER", str(RECOVERY_CERTIFICATE),
            ], cwd="/tmp", capture_output=True, timeout=30)
            check(encrypted.returncode == 0 and destination.is_file() and destination.stat().st_size > 0,
                  "Diagnostic encryption failed")
    except Exception:
        try:
            destination.unlink(missing_ok=True)
        except OSError:
            pass
        print("Encrypted command-failure diagnostics unavailable; raw output withheld", flush=True)


def api(suffix="", method="GET"):
    raw = command(["phala", "api", "/cvms/" + UUID + suffix, "-X", method])
    try:
        return json.loads(raw)
    except ValueError:
        raise RuntimeError("Phala returned a non-JSON response") from None


def parse_compose(text):
    try:
        parsed = yaml.safe_load(text)
    except yaml.YAMLError:
        raise RuntimeError("Invalid compose YAML; source withheld") from None
    check(isinstance(parsed, dict), "Invalid compose structure")
    return parsed


def identity(info):
    check(info.get("app_id") == APP and info.get("vm_uuid") == UUID, "Unexpected production identity")


def running_backends(composition):
    return [row for row in composition.get("containers", [])
            if row.get("state") == "running" and "/dstack-tinychat-backend-1" in row.get("names", [])]


def main(mode):
    global FAILURE_EVIDENCE_DIR
    os.umask(0o077)
    temp = Path(os.environ["RUNNER_TEMP"])
    evidence = temp / "calendar-backend-evidence"
    evidence.mkdir(mode=0o700, exist_ok=True)
    FAILURE_EVIDENCE_DIR = evidence
    certificate = RECOVERY_CERTIFICATE
    receipt = {"vmUuid": UUID, "appId": APP, "image": NEW, "phase": "preflight"}

    def record():
        (evidence / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps(receipt), flush=True)

    def encrypt(source, filename):
        command(["openssl", "cms", "-encrypt", "-binary", "-aes256", "-in", str(source),
                 "-out", str(evidence / filename), "-outform", "DER", str(certificate)])

    record()
    env_file = temp / "phala-prod.env"
    rows = env_file.read_text().splitlines()
    check(all("=" in line for line in rows), "Invalid complete environment file")
    env = dict(line.split("=", 1) for line in rows)
    check(len(env) == len(rows), "Duplicate environment names")
    for name in ("BACKEND_PRIVATE_KEY", "CONNECTOR_CREDENTIAL_MASTER", "GOOGLE_OAUTH_CLIENT_ID",
                 "GOOGLE_OAUTH_CLIENT_SECRET", "TRANSCRIPTION_API_KEY"):
        check(bool(env.get(name)), "Required production input absent: " + name)
    master = env["CONNECTOR_CREDENTIAL_MASTER"]
    check(hashlib.sha256(master.encode()).hexdigest() == MASTER_SHA256, "Custody recovery mismatch")
    check(len(base64.b64decode(master, validate=True)) == 32, "Invalid custody key size")
    check(env.get("GOOGLE_MEET_OAUTH_ENABLED") == "true", "Google OAuth must remain enabled")
    check(env.get("TINYCHAT_BACKEND_IMAGE") == NEW, "Unexpected deployment image")
    transcription = "https://7fd569fb6ac2cae943cea1d1aff247cd8ea61fdc-8080.dstack-pha-prod5.phala.network"
    check(env.get("TRANSCRIPTION_API_URL", "").rstrip("/") == transcription, "Unexpected transcription target")
    request = urllib.request.Request(transcription + "/v1/meetings/by-idempotency-key",
                                     headers={"Authorization": "Bearer " + env["TRANSCRIPTION_API_KEY"]})
    class NoRedirects(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    try:
        response = urllib.request.build_opener(NoRedirects).open(request, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        check(response.code == 400, "Deploy transcription lookup before replacing backend")
        lookup = json.load(response)
    check(lookup.get("error", {}).get("code") == "invalid_request", "Transcription lookup canary failed")

    info = api()
    identity(info)
    check(info.get("status") == "running" and info.get("in_progress") is False, "Target is not idle/running")
    before = api("/compose_file")
    allowed = set(before.get("allowed_envs", []))
    check(allowed == set(env), "Complete environment names differ from existing allowed names")
    compose = parse_compose(before["docker_compose_file"])
    backend = compose["services"]["tinychat-backend"]
    check(backend["image"] == OLD, "Production image changed since review")
    initial = running_backends(api("/composition"))
    check(len(initial) == 1 and initial[0].get("image") == OLD, "Expected one old backend writer")
    old_id = initial[0]["id"]
    updated = copy.deepcopy(compose)
    updated["services"]["tinychat-backend"]["image"] = NEW
    updated["services"]["tinychat-backend"]["stop_grace_period"] = "130s"
    compose_file = temp / "calendar-backend-compose.yml"
    compose_file.write_text(yaml.safe_dump(updated, sort_keys=False))
    before_file = temp / "calendar-backend-before.json"
    plan_file = temp / "calendar-backend-plan.json"
    plan = {"before": before, "oldContainerId": old_id,
            "environmentSha256": hashlib.sha256(env_file.read_bytes()).hexdigest()}
    if mode == "--prepare-only":
        before_file.write_text(json.dumps(before))
        plan_file.write_text(json.dumps(plan))
        encrypt(before_file, "backend-before.cms")
        encrypt(compose_file, "backend-release-compose.cms")
        encrypt(env_file, "backend-release-env.cms")
    else:
        check(plan_file.exists() and json.loads(plan_file.read_text()) == plan,
              "Prepared target or environment changed after recovery upload")
    receipt.update(phase="backup_saved", environmentNames=len(env), oldContainerId=old_id,
                   beforeComposeHash=info.get("compose_hash"), encryptedRecovery=True)
    record()
    if mode == "--prepare-only":
        return

    # Graceful request, never cvms stop/force-stop. Do not submit replacement until stopped.
    api("/shutdown", "POST")
    receipt.update(phase="shutdown_requested", shutdownRequestedAt=time.time())
    record()
    for _ in range(60):
        state = api()
        identity(state)
        if state.get("status") == "stopped" and state.get("in_progress") is False:
            break
        check(state.get("status") not in ("failed", "error", "exited"), "Shutdown ended unexpectedly")
        time.sleep(5)
    else:
        raise RuntimeError("Old VM did not reach stopped state; no replacement submitted")
    receipt.update(phase="old_writer_stopped", stoppedObservedAt=time.time())
    record()
    check(state.get("compose_hash") == info.get("compose_hash"), "Production configuration changed during shutdown")
    check(api("/compose_file") == before, "Production compose changed during shutdown")

    command(["phala", "deploy", "--cvm-id", UUID, "-c", str(compose_file), "-e", str(env_file)], timeout=300)
    receipt.update(phase="update_submitted", updateSubmittedAt=time.time())
    record()
    start_sent = False
    for _ in range(100):
        state = api()
        identity(state)
        check(state.get("status") not in ("failed", "error", "exited"), "Replacement failed to start")
        current = api("/compose_file")
        installed = parse_compose(current["docker_compose_file"]) == updated
        check(current.get("pre_launch_script") == before.get("pre_launch_script"), "Pre-launch script changed")
        check(set(current.get("allowed_envs", [])) == allowed, "Allowed environment names changed")
        if installed and state.get("in_progress") is False:
            if state.get("status") == "stopped" and not start_sent:
                api("/start", "POST")
                start_sent = True
            elif state.get("status") == "running":
                rows = running_backends(api("/composition"))
                if len(rows) == 1 and rows[0].get("image") == NEW and rows[0].get("id") != old_id:
                    receipt.update(phase="replacement_running", runningObservedAt=time.time(),
                                   newContainerId=rows[0]["id"], composeHash=state.get("compose_hash"),
                                   preLaunchPreserved=True, allowedNamesPreserved=True,
                                   unchangedServicesAndVolumes=True, singleWriterReplacement=True)
                    record()
                    return
        time.sleep(6)
    raise RuntimeError("Replacement verification timed out; inspect safe receipt before any retry")


if __name__ == "__main__":
    try:
        check(len(sys.argv) == 2 and sys.argv[1] in ("--prepare-only", "--execute"), "Explicit rollout phase required")
        main(sys.argv[1])
    except Exception as error:
        # Never serialize provider errors, raw compose, environment values or tracebacks.
        print("Backend rollout failed: " + (str(error) if isinstance(error, RuntimeError) else type(error).__name__), flush=True)
        raise SystemExit(1)
