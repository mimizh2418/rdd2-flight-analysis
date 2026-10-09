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
        scenario: Absolute, home-relative, working-directory-relative, or library-relative scenario path.
        root: Resolved model source directory.
    Returns:
        Resolved absolute path. Existing paths are used directly, including files outside either repository.
        Otherwise, relative paths are resolved against the model library. The caller checks that the file exists.
    """
    scenario = scenario.expanduser()
    if scenario.is_absolute() or scenario.exists():
        return scenario.resolve()

    return (root / scenario).resolve()


def model_source_root(model: Path) -> Path:
    """Find the outermost package directory needed to load an external Modelica file.

    Args:
        model: Resolved model file whose enclosing package directories contain package.mo files.
    Returns:
        The outermost enclosing package directory, or the model's directory for a standalone model.
    Notes:
        A nested package directory cannot be registered as a top-level root without changing its namespace.
    """
    source = model.parent
    while source.parent != source and (source.parent / "package.mo").is_file():
        source = source.parent
    return source
