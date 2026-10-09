"""Status reporting and stage timing for simulation and export."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import os
import shutil
import sys
import threading
import time
from typing import TextIO
import unicodedata


@dataclass
class _Stage:
    label: str
    started: float
    detail: str = ""


def format_bytes(size: int) -> str:
    """Choose a readable size unit, including for small logs."""
    value = float(size)
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if value < 1024 or unit == "TiB":
            return f"{size:,} B" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024


def _width(text: str) -> int:
    return sum(0 if unicodedata.combining(c) else 2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in text)


class Progress:
    """Show one live terminal task, permanent stage outcomes, and wall-time measurements.

    Redirected output contains plain stage outcomes without animation. All output goes to stderr by default;
    stdout remains the completed bundle-path channel. Elapsed times are not solver completion percentages.
    """

    def __init__(self, quiet: bool = False, *, color: str = "auto", stream: TextIO | None = None):
        self.quiet = quiet
        self.stream = stream if stream is not None else sys.stderr
        self.interactive = self.stream.isatty() and os.environ.get("TERM") != "dumb"
        self.color = color == "always" or (color == "auto" and self.interactive and "NO_COLOR" not in os.environ)
        self.started = time.perf_counter()
        self.timings: dict[str, float] = {}
        self.last_update = self.started
        self._lock = threading.RLock()
        self._active: _Stage | None = None
        self._visible = False
        self._frame = 0
        try:
            "⠋✓✗…".encode(self.stream.encoding or "utf-8")
            self._unicode = True
        except (UnicodeEncodeError, LookupError):
            self._unicode = False

    def _style(self, text: str, code: str) -> str:
        return f"\033[{code}m{text}\033[0m" if self.color else text

    def _clear(self, *, force: bool = False) -> None:
        if self.interactive and (self._visible or force):
            self.stream.write("\r\033[2K")
            self._visible = False

    def _clip(self, text: str, columns: int) -> str:
        text = " ".join(text.split())
        if _width(text) <= columns:
            return text
        suffix = "…" if self._unicode else "..."
        if columns < len(suffix):
            return ""
        result = ""
        for character in text:
            if _width(result + character) > columns - len(suffix):
                break
            result += character
        return result + suffix

    def _render(self) -> None:
        if self.quiet or not self.interactive or self._active is None:
            return
        frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏" if self._unicode else "|/-\\"
        spinner = frames[self._frame % len(frames)]
        self._frame += 1
        elapsed = f"  {time.perf_counter() - self._active.started:.1f}s"
        text = self._active.label
        if self._active.detail:
            text += f" | {self._active.detail}"
        columns = shutil.get_terminal_size(fallback=(100, 24)).columns - 1
        text = self._clip(text, max(0, columns - 4 - len(elapsed)))
        self.stream.write(f"\r\033[2K  {self._style(spinner, '36')} {text}{self._style(elapsed, '2')}")
        self.stream.flush()
        self._visible = True

    def _line(self, text: str) -> None:
        if self.quiet:
            return
        with self._lock:
            self._clear()
            self.stream.write(text + "\n")
            self.stream.flush()
            self._render()

    def heading(self, operation: str) -> None:
        self._line(self._style(f"RDD2 Flight Tools | {operation}", "1;36"))

    def detail(self, label: str, value: object) -> None:
        self._line(f"  {self._style(f'{label:<12}', '2')} {value}")

    def message(self, text: str) -> None:
        self._line(f"  {text}")

    def warning(self, text: str) -> None:
        self._line(f"  {self._style('! ' + text, '33')}")

    def summary(self, title: str, details: dict[str, object]) -> None:
        self._line("")
        marker = "✓" if self._unicode else "OK"
        self._line(self._style(f"{marker} {title}", "1;32"))
        for label, value in details.items():
            self.detail(label, value)

    def update(self, text: str, *, force: bool = False) -> None:
        """Retain current row/byte progress; refresh immediately when forced or once per second."""
        with self._lock:
            now = time.perf_counter()
            if self._active is not None:
                self._active.detail = text
                if force or now - self.last_update >= 1:
                    self._render()
                    self.last_update = now
            elif force or now - self.last_update >= 1:
                self.message(text)
                self.last_update = now

    @contextmanager
    def stage(self, key: str, label: str):
        """Animate blocking work, record its duration, and stop animation on success or failure.

        Every interactive stage animates. Plain logs contain one outcome per stage, including its last
        row/byte update, without periodic heartbeat lines.
        """
        stage = _Stage(label, time.perf_counter())
        with self._lock:
            previous = self._active
            self._active = stage
            self.last_update = stage.started
            self._render()
        stopped = threading.Event()
        worker = None

        def animate():
            while not stopped.wait(0.1):
                with self._lock:
                    if self._active is stage:
                        self._render()

        if self.interactive and not self.quiet:
            worker = threading.Thread(target=animate, name="rdd2-progress", daemon=True)
            worker.start()
        succeeded = False
        try:
            yield
            succeeded = True
        finally:
            elapsed = time.perf_counter() - stage.started
            stopped.set()
            if worker is not None:
                worker.join()
            with self._lock:
                self.timings[key] = elapsed
                self._clear()
                self._active = previous
                marker = ("✓" if succeeded else "✗") if self._unicode else ("OK" if succeeded else "FAIL")
                outcome = self._style(marker, "32" if succeeded else "31")
                detail = f" | {stage.detail}" if stage.detail and not self.interactive else ""
                self._line(f"  {outcome} {label}{self._style(f'  {elapsed:.2f}s', '2')}{detail}")


def report_error(text: str, *, color: str = "auto", cancelled: bool = False) -> None:
    """Clear a worker's interrupted task line; keep redirected error messages machine compatible."""
    reporter = Progress(color=color)
    reporter._clear(force=True)
    if reporter.interactive:
        marker = "!" if cancelled else ("✗" if reporter._unicode else "FAIL")
        text = f"{marker} {text}"
    reporter._line(reporter._style(text, "33" if cancelled else "31"))
