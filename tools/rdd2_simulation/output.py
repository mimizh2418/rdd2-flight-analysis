"""Manage private export workspaces and reversible artifact publication."""

from __future__ import annotations

from pathlib import Path
import shutil
import tempfile


ARTIFACT_NAMES = ("trace.arrow", "trace.csv", "manifest.json")


def validate_artifact_destinations(out: Path) -> None:
    """Reject directories occupying generated artifact names without changing the filesystem.

    Args:
        out: Destination directory, which may contain existing logs and unrelated files.
    Raises:
        ValueError: A generated artifact name is occupied by a directory.
    """
    for name in ARTIFACT_NAMES:
        destination = out / name
        if destination.is_dir():
            raise ValueError(f"Artifact path is a directory: {destination}")


class ExportTransaction:
    """Stage output beside its destination and restore previous artifacts if publication fails.

    Args:
        out: Resolved destination directory.
    Notes:
        Only generated artifacts and directories created by this transaction are managed. Unrelated files and
        preexisting directories are preserved. Native crashes must be supervised by a separate process.
    """

    def __init__(self, out: Path):
        """Record the destination and initialize the rollback journal without creating files."""
        self.out = out
        self.staging: Path | None = None
        self.created_directories: list[Path] = []
        self.backups: dict[Path, Path] = {}
        self.installed: list[Path] = []

    def mkdir(self, directory: Path) -> None:
        """Create missing parents and record only directories actually created by this transaction."""
        missing = []
        candidate = directory
        while not candidate.exists():
            missing.append(candidate)
            candidate = candidate.parent

        for candidate in reversed(missing):
            try:
                candidate.mkdir()
            except FileExistsError:
                if not candidate.is_dir():
                    raise
            else:
                self.created_directories.append(candidate)

    def __enter__(self) -> ExportTransaction:
        """Create a private workspace on the output filesystem; undo partial setup if it fails."""
        try:
            validate_artifact_destinations(self.out)
            self.mkdir(self.out.parent)
            self.staging = Path(tempfile.mkdtemp(prefix=f".{self.out.name}-export-", dir=self.out.parent))
            return self
        except BaseException:
            self.cleanup()
            raise

    def publish(self, artifacts: list[Path]) -> None:
        """Back up existing generated files and move a completed export into place.

        Args:
            artifacts: Completed files on the same filesystem, named trace.arrow or trace.csv and manifest.json.
        Raises:
            OSError: A backup or installation fails; context exit restores the previous export.
            ValueError: A generated artifact path is occupied by a directory.
        Notes:
            Obsolete format files stay in the backup until context exit confirms success. Recording operations
            before each rename also makes interruption immediately after a rename reversible.
        """
        validate_artifact_destinations(self.out)
        self.mkdir(self.out)
        backup_directory = self.staging / "previous"
        backup_directory.mkdir()

        for name in ARTIFACT_NAMES:
            destination = self.out / name
            if destination.exists() or destination.is_symlink():
                backup = backup_directory / name
                self.backups[destination] = backup
                destination.replace(backup)

        for artifact in artifacts:
            destination = self.out / artifact.name
            self.installed.append(destination)
            artifact.replace(destination)

    def rollback(self) -> None:
        """Remove installed files and restore all successfully backed-up artifacts, including obsolete formats."""
        for destination in reversed(self.installed):
            destination.unlink(missing_ok=True)

        for destination, backup in self.backups.items():
            if backup.exists() or backup.is_symlink():
                backup.replace(destination)

    def cleanup(self) -> None:
        """Remove private staging and newly created empty directories, preserving unrelated contents."""
        if self.staging is not None:
            shutil.rmtree(self.staging)

        for directory in reversed(self.created_directories):
            try:
                directory.rmdir()
            except OSError:
                # Existing or concurrently added contents belong to someone else; never recursively remove them.
                if directory.is_dir() and not any(directory.iterdir()):
                    raise

    def __exit__(self, exception_type, exception, traceback) -> None:
        """Roll back on any Python exception, including interrupts and native-library panic exceptions."""
        if exception_type is not None:
            # Keep the backup workspace for recovery if restoring an artifact itself fails.
            self.rollback()
        self.cleanup()
