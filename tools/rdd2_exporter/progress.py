"""Status reporting and stage timing for simulation and export."""

from __future__ import annotations

from contextlib import contextmanager
import sys
import threading
import time


class Progress:
    """Report flushed status on stderr and record completed stage wall times.

    Args:
        quiet: Suppress status messages while still collecting timings.
    Notes:
        Heartbeats report elapsed wall time, not solver progress or an estimated completion percentage.
    """

    def __init__(self, quiet: bool = False):
        """Initialize a reporter with an independent clock and timing registry."""
        self.quiet = quiet
        self.started = time.perf_counter()
        self.timings: dict[str, float] = {}
        self.last_update = self.started

    def message(self, text: str) -> None:
        """Flush one status line to stderr; stdout remains the bundle-path channel."""
        if not self.quiet:
            print(f"[rdd2-export] {text}", file=sys.stderr, flush=True)

    def update(self, text: str, *, force: bool = False) -> None:
        """Emit row/byte progress at most once a second, or immediately when forced."""
        now = time.perf_counter()

        if force or now - self.last_update >= 1:
            self.message(text)
            self.last_update = now

    @contextmanager
    def stage(self, key: str, label: str, *, heartbeat: bool = False):
        """Time a stage and report its outcome, optionally emitting five-second heartbeats.

        Args:
            key: Stable key used in manifest timings.
            label: User-facing description of the work.
            heartbeat: Report activity during blocking model loading or simulation.
        Yields:
            None; the caller performs the stage's work inside the context.
        Raises:
            Any exception from the stage, after reporting failure and stopping its heartbeat.
        """
        started = time.perf_counter()
        self.last_update = started
        self.message(f"{label}...")
        stopped = threading.Event()
        worker = None

        def report_activity():
            """Report elapsed time until the enclosing stage finishes or fails."""
            while not stopped.wait(5):
                self.message(f"{label}: still running ({time.perf_counter() - started:.1f} s elapsed)")

        if heartbeat and not self.quiet:
            worker = threading.Thread(target=report_activity, daemon=True)
            worker.start()

        succeeded = False

        try:
            yield
            succeeded = True
        finally:
            elapsed = time.perf_counter() - started
            stopped.set()

            if worker is not None:
                worker.join()

            self.timings[key] = elapsed
            outcome = "completed" if succeeded else "failed"
            self.message(f"{label}: {outcome} in {elapsed:.2f} s")
