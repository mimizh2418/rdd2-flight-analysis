"""Exercise user-facing exporter status without requiring Rumoca."""

from pathlib import Path
import errno
import os
import subprocess
import sys
import tempfile
import unittest

from exporter_support import SIMULATOR_PATH


class CliTests(unittest.TestCase):

    def test_csv_remains_usable_without_arrow_dependencies(self):
        """Run with site-packages disabled; CSV works and Arrow fails with actionable stderr only."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "input.csv"
            source.write_text("time,x\n0,1\n1,2\n")
            for encoding in ("csv", "arrow"):
                output = root / encoding
                result = subprocess.run(
                    [
                        sys.executable,
                        "-S",
                        str(SIMULATOR_PATH),
                        "convert-csv",
                        str(source),
                        "--format",
                        encoding,
                        "--out",
                        str(output),
                        "--quiet",
                    ],
                    text=True,
                    capture_output=True,
                )
                if encoding == "csv":
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stdout, f"{output}\n")
                    self.assertTrue((output / "trace.csv").is_file())
                else:
                    self.assertEqual(result.returncode, 1)
                    self.assertEqual(result.stdout, "")
                    self.assertIn("uv sync --locked", result.stderr)
                    self.assertIn("uv run --locked tools/rdd2_simulate.py", result.stderr)

    def test_cli_success_returns_bundle_path_in_both_output_modes(self):
        """Return a usable bundle path on stdout with normal or quiet output."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "input.csv"
            source.write_text("time,x\n0,1\n1,2\n")

            for quiet in (False, True):
                output = root / f"bundle-{quiet}"
                command = [sys.executable, str(SIMULATOR_PATH), "convert-csv", str(source), "--out", str(output)]

                if quiet:
                    command.append("--quiet")

                with self.subTest(quiet=quiet):
                    result = subprocess.run(command, check=True, text=True, capture_output=True)
                    self.assertEqual(result.stdout, f"{output}\n")
                    self.assertTrue((output / "trace.arrow").is_file())
                    self.assertFalse((output / "manifest.json").exists())

                    if quiet:
                        self.assertEqual(result.stderr, "")
                    else:
                        self.assertIn("RDD2 Flight Tools | CSV conversion", result.stderr)
                        self.assertIn("Log ready", result.stderr)
                        self.assertIn("2 rows / 1 signal", result.stderr)
                        self.assertNotIn("\033", result.stderr)
                        self.assertNotIn("\r", result.stderr)

    @unittest.skipUnless(os.name == "posix", "Pseudo-terminal integration requires POSIX")
    def test_terminal_progress_preserves_stdout_path(self):
        """Exercise stderr TTY detection through the spawned worker using only a CSV conversion."""
        import pty

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "input.csv"
            source.write_text("time,x\n0,1\n1,2\n")
            output = root / "bundle"
            master, slave = pty.openpty()
            try:
                environment = {**os.environ, "TERM": "xterm-256color"}
                environment.pop("NO_COLOR", None)
                with subprocess.Popen(
                    [sys.executable, str(SIMULATOR_PATH), "convert-csv", str(source), "--out", str(output)],
                    stdout=subprocess.PIPE,
                    stderr=slave,
                    env=environment,
                ) as process:
                    os.close(slave)
                    slave = None
                    chunks = []
                    while True:
                        try:
                            chunk = os.read(master, 4096)
                        except OSError as error:
                            if error.errno != errno.EIO:
                                raise
                            break
                        if not chunk:
                            break
                        chunks.append(chunk)
                    stdout, _ = process.communicate(timeout=10)
                    stderr = b"".join(chunks).decode()
                    self.assertEqual(process.returncode, 0, stderr)
                    self.assertEqual(stdout.decode(), f"{output}\n")
                    self.assertIn("\r\033[2K", stderr)
                    self.assertIn("\033[1;36m", stderr)
                    self.assertIn("Log ready", stderr)
                    self.assertTrue((output / "trace.arrow").is_file())
            finally:
                if slave is not None:
                    os.close(slave)
                os.close(master)
