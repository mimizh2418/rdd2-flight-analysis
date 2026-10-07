"""Load the exporter once for dependency-free Python regression tests."""

import importlib.util
from pathlib import Path
import sys

EXPORTER_PATH = Path(__file__).parents[1] / "tools/export_rdd2_viewer.py"
SPEC = importlib.util.spec_from_file_location("rdd2_test_exporter", EXPORTER_PATH)
exporter = importlib.util.module_from_spec(SPEC)

# Register the module before execution, as a normal import would (required by dataclasses).
sys.modules[SPEC.name] = exporter
SPEC.loader.exec_module(exporter)
