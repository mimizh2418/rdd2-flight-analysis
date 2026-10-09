"""Check compiler failures, native crashes, and cancellation without simulating a vehicle."""

import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

from exporter_support import SIMULATOR_PATH


class WorkerTests(unittest.TestCase):
    def setUp(self):
        """Create a tiny compiler stub whose load step can terminate or wait for cancellation."""
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.scenario = self.root / "scenario.toml"
        self.scenario.write_text("[sim]\nt_end = 1\n")
        (self.root / "rumoca.py").write_text(
            "import os, signal, time\n"
            "from pathlib import Path\n"
            "from types import SimpleNamespace\n"
            "_native = SimpleNamespace(__file__=__file__)\n"
            "def version():\n"
            "    return '0.10.2'\n"
            "class Session:\n"
            "    @classmethod\n"
            "    def from_scenario(cls, path):\n"
            "        if os.environ['WORKER_MODE'] == 'ignore-term':\n"
            "            signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
            "        Path(os.environ['WORKER_READY']).write_text(str(os.getpid()))\n"
            "        if os.environ['WORKER_MODE'] == 'crash':\n"
            "            os.kill(os.getpid(), signal.SIGSEGV)\n"
            "        elif os.environ['WORKER_MODE'] == 'error':\n"
            "            raise RuntimeError('Invalid scenario: missing model name')\n"
            "        else:\n"
            "            time.sleep(30)\n"
        )
        distribution = self.root / "rumoca-0.10.2.dist-info"
        distribution.mkdir()
        (distribution / "METADATA").write_text("Name: rumoca\nVersion: 0.10.2\n")

    def command(self, output):
        """Build a CSV-mode CLI command that loads only the tiny local compiler stub."""
        return [
            sys.executable,
            str(SIMULATOR_PATH),
            "run",
            str(self.scenario),
            "--modelica-root",
            str(self.root),
            "--format",
            "csv",
            "--out",
            str(output),
            "--quiet",
        ]

    def environment(self, mode):
        """Expose the stub and a readiness marker without altering the current process environment."""
        return {
            **os.environ,
            "PYTHONPATH": str(self.root),
            "WORKER_MODE": mode,
            "WORKER_READY": str(self.root / "ready"),
        }

    def test_compiler_failure_reports_diagnostics_without_creating_output(self):
        """Report the compiler's error and leave no incomplete destination or staging directory."""
        output = self.root / "exports" / "nested" / "flight"
        result = subprocess.run(
            self.command(output), env=self.environment("error"), capture_output=True, text=True, timeout=20
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertIn("Invalid scenario: missing model name", result.stderr)
        self.assertFalse((self.root / "exports").exists())

    @unittest.skipUnless(os.name == "posix", "Native signal termination is checked on POSIX")
    def test_native_crash_preserves_existing_artifacts_and_removes_staging(self):
        """Handle a real SIGSEGV in the tiny worker stub without running a vehicle simulation."""
        output = self.root / "flight"
        output.mkdir()
        original = {"trace.csv": b"previous log", "manifest.json": b"previous metadata", "notes": b"keep"}
        for name, content in original.items():
            (output / name).write_bytes(content)

        result = subprocess.run(
            self.command(output), env=self.environment("crash"), capture_output=True, text=True, timeout=20
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SIGSEGV", result.stderr)
        self.assertEqual({path.name: path.read_bytes() for path in output.iterdir()}, original)
        self.assertEqual(list(self.root.glob(".flight-export-*")), [])

    def cancel_export(self, signum, *, stubborn=False):
        """Interrupt a blocked CLI and check its exit status, diagnostics, child lifetime, and output.

        Args:
            signum: Cancellation signal sent after the worker is ready.
            stubborn: Ignore SIGINT in the launcher and SIGTERM in the worker, then interrupt twice.
        """
        output = self.root / "exports" / "flight"
        command = self.command(output)
        if stubborn:
            command = [
                sys.executable,
                "-c",
                "import os, signal, sys; signal.signal(signal.SIGINT, signal.SIG_IGN); "
                "os.execv(sys.argv[1], sys.argv[1:])",
                *command,
            ]

        process = subprocess.Popen(
            command,
            env=self.environment("ignore-term" if stubborn else "wait"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        try:
            deadline = time.monotonic() + 10
            while not (self.root / "ready").exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue((self.root / "ready").exists(), "Worker did not start")
            worker_pid = int((self.root / "ready").read_text())

            # Both terminals and the HTTP service signal the full foreground process group.
            os.killpg(process.pid, signum)

            if stubborn:
                time.sleep(0.05)
                os.killpg(process.pid, signum)

            stdout, stderr = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 130, stderr)
            self.assertEqual(stdout, "")
            self.assertEqual(stderr, "Export cancelled\n")
            self.assertFalse((self.root / "exports").exists())
            with self.assertRaises(ProcessLookupError):
                os.kill(worker_pid, 0)
        finally:
            if process.poll() is None:
                # Kill the test's isolated process group on failure so blocked stub workers never leak.
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()

    @unittest.skipUnless(os.name == "posix", "Service cancellation uses POSIX SIGTERM")
    def test_service_cancellation_stops_worker(self):
        """Cancel a blocked worker through the supervisor's SIGTERM handler."""
        self.cancel_export(signal.SIGTERM)

    @unittest.skipUnless(os.name == "posix", "Terminal cancellation uses POSIX signals")
    def test_ctrl_c_stops_a_stubborn_worker_without_a_traceback(self):
        """Honor inherited and repeated Ctrl-C signals even when native work ignores graceful termination."""
        self.cancel_export(signal.SIGINT, stubborn=True)
