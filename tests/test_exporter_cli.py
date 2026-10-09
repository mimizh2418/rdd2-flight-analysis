"""Exercise user-facing exporter status without requiring Rumoca."""

from pathlib import Path
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
