"""Content fingerprints and Modelica checkout identity."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import subprocess


def sha256(path: Path) -> str:
    """Hash a file in bounded chunks without retaining the whole trace in memory.

    Args:
        path: Readable file to hash in one-megabyte chunks.
    Returns:
        Lowercase SHA-256 hexadecimal digest.
    Raises:
        OSError: The file cannot be opened or read.
    """

    digest = hashlib.sha256()

    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)

    return digest.hexdigest()


def source_identity(root: Path) -> dict:
    """Hash model inputs and record the checkout revision and working-tree status.

    Args:
        root: Modelica checkout whose model/config/resource inputs are inspected.
    Returns:
        Source SHA-256, optional Git/Nix revision, and optional dirty-tree status.
    Notes:
        Includes relative filenames and file digests; excludes generated artifacts and dependencies. Git identity is
        None when unavailable. A matching Nix model root supplies its explicit pinned revision without a .git folder.
    """

    digest = hashlib.sha256()
    paths = []
    excluded = {".git", "artifacts", "node_modules"}

    # Prune ignored directory trees before traversal, rather than visiting every generated artifact first.
    for directory, children, filenames in os.walk(root):
        children[:] = [name for name in children if name not in excluded]

        for filename in filenames:
            path = Path(directory) / filename
            relative = path.relative_to(root)

            if filename not in excluded and path.is_file():
                if path.suffix in (".mo", ".toml") or filename == "package.order" or "Resources" in relative.parts:
                    paths.append(path)

    for path in sorted(paths):
        # Include relative names as well as file hashes so renamed inputs change the source identity.
        digest.update(str(path.relative_to(root)).encode())
        digest.update(b"\0")
        digest.update(bytes.fromhex(sha256(path)))

    revision = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], text=True, capture_output=True)
    dirty = subprocess.run(["git", "-C", str(root), "status", "--porcelain"], text=True, capture_output=True)

    pinned_root = os.environ.get("RDD2_MODELICA_ROOT")
    pinned_revision = os.environ.get("RDD2_MODELICA_REVISION")
    from_nix = (
        revision.returncode != 0
        and bool(pinned_root and pinned_revision)
        and root.resolve() == Path(pinned_root).resolve()
    )

    return {
        "model_revision": (
            revision.stdout.strip() if revision.returncode == 0 else pinned_revision if from_nix else None
        ),
        "source_sha256": digest.hexdigest(),
        "working_tree_dirty": bool(dirty.stdout) if dirty.returncode == 0 else None,
    }


def simulation_source_identity(root: Path, scenario: Path) -> dict:
    """Fingerprint the selected library and any project scenario sources outside it.

    Args:
        root: Resolved Modelica library directory.
        scenario: Resolved scenario actually compiled.
    Returns:
        Library identity with a combined source digest and separate scenario_sources identity when needed.
    Notes:
        Project scenarios used with a developer checkout live in a separate repository. Include their models,
        TOML, and package files so before/after checks detect edits to either set of simulation inputs.
    """
    identity = source_identity(root)
    if scenario.is_relative_to(root):
        return identity

    scenario_identity = source_identity(scenario.parent)
    combined = hashlib.sha256()
    combined.update(bytes.fromhex(identity["source_sha256"]))
    combined.update(bytes.fromhex(scenario_identity["source_sha256"]))

    return {
        **identity,
        "source_sha256": combined.hexdigest(),
        "scenario_sources": {"path": str(scenario.parent), **scenario_identity},
    }
