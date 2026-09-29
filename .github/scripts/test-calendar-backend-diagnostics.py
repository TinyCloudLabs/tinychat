"""Offline fixtures for encrypted backend command diagnostics; no production access."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("backend_rollout", Path(__file__).with_name("calendar-backend-rollout.py"))
rollout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rollout)


class DiagnosticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = tempfile.TemporaryDirectory(prefix="backend-diagnostic-test-")
        cls.root = Path(cls.fixture.name)
        cls.key = cls.root / "test.key.pem"
        cls.cert = cls.root / "test.crt.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                        "-subj", "/CN=Synthetic diagnostic test", "-days", "1",
                        "-keyout", str(cls.key), "-out", str(cls.cert)],
                       capture_output=True, check=True)

    @classmethod
    def tearDownClass(cls):
        cls.fixture.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=self.root)
        self.evidence = Path(self.temp.name)
        rollout.FAILURE_EVIDENCE_DIR = self.evidence
        rollout.RECOVERY_CERTIFICATE = self.cert

    def tearDown(self):
        self.temp.cleanup()

    def diagnostic(self):
        artifacts = list(self.evidence.iterdir())
        self.assertEqual(len(artifacts), 1)
        self.assertEqual(artifacts[0].suffix, ".cms")
        self.assertNotIn(b"synthetic-sensitive", artifacts[0].read_bytes())
        decrypted = subprocess.run(["openssl", "cms", "-decrypt", "-binary", "-inform", "DER",
                                    "-in", str(artifacts[0]), "-recip", str(self.cert),
                                    "-inkey", str(self.key)], capture_output=True, check=True)
        return json.loads(decrypted.stdout)

    def test_nonzero_exit_has_recoverable_encrypted_output_only(self):
        with self.assertRaisesRegex(RuntimeError, "^Command failed; raw output withheld"):
            rollout.command([sys.executable, "-c", "import sys; print('synthetic-sensitive-out'); print('synthetic-sensitive-err', file=sys.stderr); sys.exit(9)"])
        diagnostic = self.diagnostic()
        self.assertEqual(diagnostic["returncode"], 9)
        self.assertEqual(diagnostic["stdout"], "synthetic-sensitive-out\n")
        self.assertEqual(diagnostic["stderr"], "synthetic-sensitive-err\n")

    def test_timeout_keeps_original_failure_and_encrypted_partial_output(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            rollout.command([sys.executable, "-c", "import time; print('synthetic-sensitive-partial', flush=True); time.sleep(5)"], timeout=0.3)
        diagnostic = self.diagnostic()
        self.assertIsNone(diagnostic["returncode"])
        self.assertEqual(diagnostic["stdout"], "synthetic-sensitive-partial\n")

    def test_success_has_no_diagnostic(self):
        self.assertEqual(rollout.command([sys.executable, "-c", "print('ok')"]), b"ok\n")
        self.assertEqual(list(self.evidence.iterdir()), [])

    def test_launch_failure_keeps_original_failure_and_records_no_output(self):
        with self.assertRaises(FileNotFoundError):
            rollout.command([str(self.root / "absent-command")])
        diagnostic = self.diagnostic()
        self.assertIsNone(diagnostic["returncode"])
        self.assertIsNone(diagnostic["stdout"])
        self.assertIsNone(diagnostic["stderr"])

    def test_encryption_failure_does_not_expose_output_or_replace_original_failure(self):
        rollout.RECOVERY_CERTIFICATE = self.root / "absent.crt.pem"
        log = io.StringIO()
        with contextlib.redirect_stdout(log):
            with self.assertRaises(subprocess.TimeoutExpired):
                rollout.command([sys.executable, "-c", "import time; print('synthetic-sensitive-partial', flush=True); time.sleep(5)"], timeout=0.3)
        self.assertIn("diagnostics unavailable", log.getvalue())
        self.assertNotIn("synthetic-sensitive", log.getvalue())


if __name__ == "__main__":
    unittest.main()
