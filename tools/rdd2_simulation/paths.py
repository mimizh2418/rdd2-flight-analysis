"""Locate the pinned model library or an explicitly selected developer checkout."""

import os
from pathlib import Path


PROJECT_SCENARIOS = Path(__file__).resolve().parents[2] / "scenarios"


def default_modelica_root() -> Path:
    """Return Nix's model source directory, falling back to the conventional sibling checkout.

    Returns:
        RDD2_MODELICA_ROOT when set, otherwise ../modelica_models. Explicit CLI arguments override this default.
    """
    return Path(os.environ.get("RDD2_MODELICA_ROOT") or "../modelica_models")


def resolve_scenario(scenario: Path, root: Path) -> Path:
    """Resolve a scenario from the working directory or relative to the selected model library.

    Args:
        scenario: Absolute path, project scenarios/ path, or library-relative scenario path.
        root: Resolved model source directory.
    Returns:
        Resolved absolute path. Existing working-tree paths are used directly, including project scenarios.
        Otherwise, paths are resolved relative to the model library. The caller validates source containment.
    """
    if scenario.is_absolute() or scenario.exists():
        return scenario.resolve()

    return (root / scenario).resolve()
