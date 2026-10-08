"""Legacy CSV validation, snapshot copying, and row serialization."""

from __future__ import annotations

import csv
import hashlib
import math
from pathlib import Path

from .progress import Progress
from .trace import CsvStatistics, TraceSummary


class HashingWriter:
    """Adapt csv.writer's text output to a binary stream while hashing its exact UTF-8 bytes."""

    def __init__(self, stream):
        """Attach a writable binary stream and start a fresh SHA-256 digest."""
        self.stream = stream
        self.digest = hashlib.sha256()

    def write(self, text: str) -> int:
        """Write and hash one text fragment, returning its character count like a text stream."""
        payload = text.encode("utf-8")
        self.stream.write(payload)
        self.digest.update(payload)

        return len(text)


def scan_csv(path: Path, progress: Progress | None = None) -> tuple[list[str], dict]:
    """Validate numeric CSV rows and report timing, event cadence, and missing-value counts.

    Args:
        path: UTF-8 numeric CSV with one supported time column and consistent row widths.
        progress: Optional reporter for throttled row-count updates.
    Returns:
        (headers, observed), where observed includes raw row/event counts, start/end seconds, distinct sample-period
        bounds in seconds, and the non-finite-cell count.
    Raises:
        ValueError: Headers, field counts, numeric values, or the finite/nondecreasing time axis are invalid.
    Notes:
        Empty cells remain NaN. Near-equal event timestamps do not count toward minimum solver cadence.
    """

    with path.open(newline="", encoding="utf-8-sig") as stream:
        reader = csv.reader(stream)
        headers = next(reader, [])

        statistics = CsvStatistics(headers)

        for row in reader:
            if not row:
                continue

            if len(row) != statistics.columns:
                raise ValueError(f"Row {statistics.rows + 2}: invalid field count")

            values = [float(v) if v.strip() else math.nan for v in row]
            statistics.add(values)

            if progress is not None and statistics.rows % 5000 == 0:
                progress.update(f"Validated {statistics.rows:,} rows through t={statistics.previous:.6g} s")

    return headers, statistics.finish()


def copy_and_hash(source: Path, destination: Path, progress: Progress) -> str:
    """Copy an input CSV once and hash those same bytes, including its BOM and original line endings.

    Args:
        source: Original log; never modified.
        destination: Private staging file, not a published bundle file.
        progress: Reporter for byte-based copy progress.
    Returns:
        SHA-256 of the exact copied snapshot; receipt verification must use this digest.
    Raises:
        OSError: Reading or writing fails.
    """
    size = source.stat().st_size
    copied = 0
    digest = hashlib.sha256()

    with source.open("rb") as incoming, destination.open("wb") as outgoing:
        for chunk in iter(lambda: incoming.read(1024 * 1024), b""):
            outgoing.write(chunk)
            digest.update(chunk)
            copied += len(chunk)
            progress.update(f"Copying CSV: {min(100, copied / max(1, size) * 100):.0f}% ({copied / 1024**2:.1f} MiB)")

    return digest.hexdigest()


def write_trace(output: Path, names: list[str], times, arrays, progress: Progress) -> TraceSummary:
    """Write, validate, summarize, and hash generated numeric columns in one pass.

    Args:
        output: Private staging CSV; discarded by the caller on failure.
        names: Selected telemetry names, excluding the time column.
        times: Original simulation timestamps, including event rows.
        arrays: Numeric columns aligned with times, in names order.
        progress: Reporter for row-based write progress.
    Returns:
        Validated metadata and the digest of the emitted UTF-8 CSV bytes.
    Raises:
        ValueError: Columns have inconsistent lengths, headers are invalid, or timestamps are invalid.
    """
    headers = ["time", *names]
    statistics = CsvStatistics(headers)
    rows = len(times)

    if len(arrays) != len(names) or any(len(column) != rows for column in arrays):
        raise ValueError("Simulation columns must have the same length as time")

    with output.open("wb") as stream:
        hashing = HashingWriter(stream)
        writer = csv.writer(hashing)
        writer.writerow(headers)

        for index, timestamp in enumerate(times):
            values = [float(timestamp), *(float(column[index]) for column in arrays)]
            statistics.add(values)
            writer.writerow(values)

            if (index + 1) % 1000 == 0:
                progress.update(f"Writing CSV: {(index + 1) / rows * 100:.0f}% ({index + 1:,}/{rows:,} rows)")

    return TraceSummary(headers, statistics.finish(), hashing.digest.hexdigest())
