"""Load the exporter once for Python regression tests."""

import importlib.util
from pathlib import Path
import sys

EXPORTER_PATH = Path(__file__).parents[1] / "tools/export_rdd2_viewer.py"
sys.path.insert(0, str(EXPORTER_PATH.parent))

from rdd2_exporter import bundle, progress, provenance, simulation

SPEC = importlib.util.spec_from_file_location("rdd2_test_exporter", EXPORTER_PATH)
exporter = importlib.util.module_from_spec(SPEC)

# Register the module before execution, as a normal import would (required by dataclasses).
sys.modules[SPEC.name] = exporter
SPEC.loader.exec_module(exporter)
