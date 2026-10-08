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
        Source SHA-256, optional Git revision, and optional dirty-tree status.
    Notes:
        Includes relative filenames and file digests; excludes generated artifacts and dependencies. Git identity is
        None when unavailable rather than invented.
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

    return {
        "model_revision": revision.stdout.strip() if revision.returncode == 0 else None,
        "source_sha256": digest.hexdigest(),
        "working_tree_dirty": bool(dirty.stdout) if dirty.returncode == 0 else None,
    }
