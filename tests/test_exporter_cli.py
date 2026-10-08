"""Exercise user-facing exporter status without requiring Rumoca."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from exporter_support import EXPORTER_PATH


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
                        str(EXPORTER_PATH),
                        "--csv",
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
                    self.assertIn("uv run --locked tools/export_rdd2_viewer.py", result.stderr)

    def test_scenario_check_failure_includes_rumoca_diagnostics(self):
        """Surface captured compiler errors even when CLI-check output is no longer sent to stdout."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scenario = root / "scenario.toml"
            scenario.write_text("[sim]\nt_end = 1\n")
            compiler = root / "rumoca"
            compiler.write_text(
                f"#!{sys.executable}\n"
                "import sys\n"
                "if '--version' in sys.argv:\n"
                "    print('rumoca 0.10.0')\n"
                "else:\n"
                "    print('Invalid scenario: missing model name', file=sys.stderr)\n"
                "    sys.exit(2)\n"
            )
            compiler.chmod(0o755)
            output = root / "bundle"
            result = subprocess.run(
                [
                    sys.executable,
                    str(EXPORTER_PATH),
                    "--scenario",
                    str(scenario),
                    "--modelica-root",
                    str(root),
                    "--rumoca",
                    str(compiler),
                    "--out",
                    str(output),
                ],
                text=True,
                capture_output=True,
            )

            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, "")
            self.assertIn("Invalid scenario: missing model name", result.stderr)
            self.assertEqual(list(output.iterdir()), [])

    def test_cli_success_returns_bundle_path_in_both_output_modes(self):
        """Return a usable bundle path on stdout with normal or quiet output."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "input.csv"
            source.write_text("time,x\n0,1\n1,2\n")

            for quiet in (False, True):
                output = root / f"bundle-{quiet}"
                command = [sys.executable, str(EXPORTER_PATH), "--csv", str(source), "--out", str(output)]

                if quiet:
                    command.append("--quiet")

                with self.subTest(quiet=quiet):
                    result = subprocess.run(command, check=True, text=True, capture_output=True)
                    self.assertEqual(result.stdout, f"{output}\n")
                    self.assertTrue((output / "trace.arrow").is_file())
                    self.assertFalse((output / "manifest.json").exists())

                    if quiet:
                        self.assertEqual(result.stderr, "")

    def test_cli_failure_reports_error_and_preserves_existing_output(self):
        """Retain receipt-mismatch diagnostics and leave the unpublished bundle empty."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "input.csv"
            source.write_text("time,x\n0,1\n")
            receipt = root / "receipt.json"
            receipt.write_text(json.dumps({"csv_sha256": "wrong"}))
            output = root / "bundle"
            result = subprocess.run(
                [
                    sys.executable,
                    str(EXPORTER_PATH),
                    "--csv",
                    str(source),
                    "--receipt",
                    str(receipt),
                    "--out",
                    str(output),
                ],
                text=True,
                capture_output=True,
            )

            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, "")
            self.assertIn("Export failed: Receipt SHA-256 does not match input CSV", result.stderr)
            self.assertEqual(list(output.iterdir()), [])
