"""Shared trace validation and observed sample statistics."""

from __future__ import annotations

from dataclasses import dataclass
import math
import sys


class CsvStatistics:
    """Validate one numeric trace and accumulate observations without storing its rows.

    Args:
        headers: Original CSV column names, including exactly one supported time column.
    Raises:
        ValueError: Headers are empty, duplicated, or have an ambiguous/missing time column.
    """

    def __init__(self, headers: list[str]):
        """Validate headers and initialize an event-aware time/statistics accumulator."""
        if not headers or len(set(headers)) != len(headers) or any(not header for header in headers):
            raise ValueError("Missing or duplicate column names")

        candidates = [header for header in headers if header in ("time", "time_s")]

        if not candidates:
            candidates = [header for header in headers if header.endswith(".time_s")]

        if len(candidates) != 1:
            raise ValueError("CSV needs one unambiguous time column")

        self.columns = len(headers)
        self.time_index = headers.index(candidates[0])
        self.rows = self.events = self.nonfinite = 0
        self.first = self.previous = None
        self.min_dt, self.max_dt = math.inf, 0.0

    def add(self, values: list[float]) -> None:
        """Validate one row and count gaps/events, preserving every original timestamp.

        Args:
            values: Numeric cells in header order; non-finite non-time cells remain gaps.
        Raises:
            ValueError: Row width differs, time is non-finite, or time moves backwards.
        """
        if len(values) != self.columns:
            raise ValueError(f"Row {self.rows + 2}: invalid field count")

        timestamp = values[self.time_index]

        if not math.isfinite(timestamp) or self.previous is not None and timestamp < self.previous:
            raise ValueError(f"Row {self.rows + 2}: non-finite or backwards time")

        if self.previous is not None:
            interval = timestamp - self.previous

            # Near-coincident event rows are retained, but do not distort the reported solver cadence.
            if interval <= 8 * sys.float_info.epsilon * max(1, abs(timestamp), abs(self.previous)):
                self.events += 1
            else:
                self.min_dt = min(self.min_dt, interval)
                self.max_dt = max(self.max_dt, interval)

        if self.first is None:
            self.first = timestamp

        self.previous = timestamp
        self.rows += 1
        self.nonfinite += sum(not math.isfinite(value) for value in values)

    def finish(self) -> dict:
        """Return observed row, time, cadence, and gap counts; reject an empty trace."""
        if not self.rows:
            raise ValueError("No samples")

        return {
            "rows": self.rows,
            "start_time_s": self.first,
            "end_time_s": self.previous,
            "event_rows": self.events,
            "min_distinct_dt_s": self.min_dt if math.isfinite(self.min_dt) else None,
            "max_distinct_dt_s": self.max_dt,
            "nonfinite_values": self.nonfinite,
        }


@dataclass(frozen=True)
class TraceSummary:
    """Validated trace observations with either a CSV digest or an Arrow table awaiting publication."""

    names: list[str]
    observed: dict
    csv_sha256: str
    # Arrow retains column buffers until provenance is complete and the single file can be written.
    table: object | None = None
