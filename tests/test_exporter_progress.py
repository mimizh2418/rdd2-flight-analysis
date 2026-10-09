"""Verify terminal redraws, plain logs, and animation cleanup without running a simulation."""

import io
import os
import re
import threading
import unittest
from unittest.mock import patch

from exporter_support import progress


class Terminal(io.StringIO):
    encoding = "utf-8"

    def __init__(self):
        super().__init__()
        self.refreshes = 0
        self.animated = threading.Event()

    def isatty(self):
        return True

    def write(self, text):
        if text.startswith("\r"):
            self.refreshes += 1
            if self.refreshes >= 3:
                self.animated.set()
        return super().write(text)


class ProgressTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {"TERM": "xterm-256color", "COLUMNS": "80"})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        os.environ.pop("NO_COLOR", None)

    def test_blocking_stage_animates_one_line_and_stops_after_completion(self):
        stream = Terminal()
        reporter = progress.Progress(stream=stream)
        with reporter.stage("compile", "Compile model"):
            self.assertTrue(stream.animated.wait(2), "Blocking work should still refresh the status line")
            reporter.update("50%", force=True)
            self.assertNotIn("\n", stream.getvalue())
            self.assertIn("50%", stream.getvalue())
            self.assertIn("\033[36m", stream.getvalue())
        self.assertEqual(stream.getvalue().count("\n"), 1)
        self.assertIn("✓ Compile model", re.sub(r"\033\[[0-9;]*m", "", stream.getvalue()))
        self.assertGreater(reporter.timings["compile"], 0)
        self.assertFalse(any(thread.name == "rdd2-progress" for thread in threading.enumerate()))

    def test_redirected_output_keeps_only_latest_stage_progress(self):
        stream = io.StringIO()
        reporter = progress.Progress(stream=stream)
        with reporter.stage("write", "Write Arrow"):
            for percent in range(100):
                reporter.update(f"{percent}%", force=True)
            self.assertEqual(stream.getvalue(), "")
        self.assertEqual(stream.getvalue().count("\n"), 1)
        self.assertIn("99%", stream.getvalue())
        self.assertNotIn("\033", stream.getvalue())
        self.assertNotIn("\r", stream.getvalue())

    def test_color_modes_and_no_color_do_not_disable_terminal_redraws(self):
        for color, no_color, expected in (("auto", False, True), ("auto", True, False), ("never", False, False)):
            with self.subTest(color=color, no_color=no_color), patch.dict(os.environ):
                if no_color:
                    os.environ["NO_COLOR"] = ""
                stream = Terminal()
                reporter = progress.Progress(color=color, stream=stream)
                with reporter.stage("task", "Task"):
                    pass
                self.assertIn("\r\033[2K", stream.getvalue())
                self.assertEqual(bool(re.search(r"\033\[[0-9;]*m", stream.getvalue())), expected)
        stream = io.StringIO()
        progress.Progress(color="always", stream=stream).heading("CSV conversion")
        self.assertIn("\033[1;36m", stream.getvalue())
        self.assertNotIn("\r", stream.getvalue())

    def test_dumb_terminal_and_ascii_stream_use_readable_fallbacks(self):
        with patch.dict(os.environ, {"TERM": "dumb"}):
            stream = Terminal()
            reporter = progress.Progress(stream=stream)
            with reporter.stage("task", "Task"):
                pass
            self.assertNotIn("\033", stream.getvalue())
        stream = Terminal()
        stream.encoding = "ascii"
        reporter = progress.Progress(stream=stream, color="never")
        with reporter.stage("task", "Task"):
            pass
        self.assertIn("OK Task", stream.getvalue())
        stream.getvalue().encode("ascii")

    def test_long_status_fits_terminal_and_messages_preserve_current_task(self):
        stream = Terminal()
        reporter = progress.Progress(stream=stream, color="never")
        with patch.dict(os.environ, {"COLUMNS": "40"}), reporter.stage("task", "Compile " + "界" * 60):
            reporter.update("extra\nprogress", force=True)
            visible = stream.getvalue().split("\r\033[2K")[-1]
            self.assertLessEqual(progress._width(visible), 39)
            self.assertNotIn("\n", visible)
            reporter.warning("Example warning")
            self.assertEqual(stream.getvalue().count("\n"), 1)
            self.assertIn("Compile", stream.getvalue().split("\r\033[2K")[-1])

    def test_stage_failure_cleans_up_animation_and_preserves_exception(self):
        stream = Terminal()
        reporter = progress.Progress(stream=stream)
        with self.assertRaisesRegex(ValueError, "bad input"), reporter.stage("task", "Validate input"):
            raise ValueError("bad input")
        self.assertIn("✗", stream.getvalue())
        self.assertEqual(stream.getvalue().count("\n"), 1)
        self.assertIn("task", reporter.timings)
        self.assertFalse(any(thread.name == "rdd2-progress" for thread in threading.enumerate()))

    def test_quiet_suppresses_all_status_but_collects_timings(self):
        stream = Terminal()
        reporter = progress.Progress(quiet=True, stream=stream)
        reporter.heading("Simulation")
        reporter.detail("Output", "exports/test")
        with reporter.stage("task", "Task"):
            reporter.update("100%", force=True)
            reporter.warning("Warning")
        reporter.summary("Log ready", {"Rows": 10})
        self.assertEqual(stream.getvalue(), "")
        self.assertIn("task", reporter.timings)


if __name__ == "__main__":
    unittest.main()
