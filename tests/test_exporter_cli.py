"""Exercise user-facing exporter status without requiring Rumoca."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from exporter_support import SIMULATOR_PATH


class CliTests(unittest.TestCase):
    def test_commands_reject_options_from_the_other_operation(self):
        """Reject conversion receipts for simulations and simulation time overrides for CSV conversion."""
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output"
            cases = [
                ["run", "scenario.toml", "--receipt", "receipt.json"],
                ["convert-csv", "input.csv", "--stop-time", "1"],
            ]

            for arguments in cases:
                with self.subTest(command=arguments[0]):
                    result = subprocess.run(
                        [sys.executable, str(SIMULATOR_PATH), *arguments, "--out", str(output)],
                        text=True,
                        capture_output=True,
                    )

                    self.assertEqual(result.returncode, 2)
                    self.assertEqual(result.stdout, "")
                    self.assertIn("unrecognized arguments", result.stderr)
                    self.assertFalse(output.exists())

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

    def test_scenario_load_failure_includes_python_diagnostics(self):
        """Surface Python compiler diagnostics on stderr and leave no published output after failure."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scenario = root / "scenario.toml"
            scenario.write_text("[sim]\nt_end = 1\n")
            # A local package keeps this CLI regression independent of installed simulation dependencies.
            (root / "rumoca.py").write_text(
                "from types import SimpleNamespace\n"
                "_native = SimpleNamespace(__file__=__file__)\n"
                "def version():\n"
                "    return '0.10.2'\n"
                "class Session:\n"
                "    @classmethod\n"
                "    def from_scenario(cls, path):\n"
                "        raise RuntimeError('Invalid scenario: missing model name')\n"
            )
            distribution = root / "rumoca-0.10.2.dist-info"
            distribution.mkdir()
            (distribution / "METADATA").write_text("Name: rumoca\nVersion: 0.10.2\n")
            output = root / "bundle"
            result = subprocess.run(
                [
                    sys.executable,
                    str(SIMULATOR_PATH),
                    "run",
                    str(scenario),
                    "--modelica-root",
                    str(root),
                    "--out",
                    str(output),
                ],
                text=True,
                capture_output=True,
                env={**os.environ, "PYTHONPATH": str(root)},
            )

            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, "")
            self.assertIn("Invalid scenario: missing model name", result.stderr)
            self.assertEqual(list(output.iterdir()), [])

    def test_missing_simulation_dependencies_explain_uv_setup(self):
        """Point users to the simulation extra when running a scenario without site-packages."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scenario = root / "scenario.toml"
            scenario.write_text('[model]\nname = "RDD2"\n')
            output = root / "bundle"
            result = subprocess.run(
                [
                    sys.executable,
                    "-S",
                    str(SIMULATOR_PATH),
                    "run",
                    str(scenario),
                    "--format",
                    "csv",
                    "--modelica-root",
                    str(root),
                    "--out",
                    str(output),
                    "--quiet",
                ],
                text=True,
                capture_output=True,
            )

            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, "")
            self.assertIn("uv run --locked --extra simulation tools/rdd2_simulate.py run", result.stderr)
            self.assertEqual(list(output.iterdir()), [])

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
                    str(SIMULATOR_PATH),
                    "convert-csv",
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
            self.assertIn("CSV conversion failed: Receipt SHA-256 does not match input CSV", result.stderr)
            self.assertEqual(list(output.iterdir()), [])
