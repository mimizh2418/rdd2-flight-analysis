"""Supervise native export work so crashes cannot leave unpublished output behind."""

from __future__ import annotations

from argparse import Namespace
import multiprocessing
import os
from pathlib import Path
import signal
import sys
import tempfile

from .bundle import export_bundle, output_directory, validate_inputs
from .output import ExportTransaction


class ExportCancelled(RuntimeError):
    """Interrupt a worker wait without being swallowed as a retryable InterruptedError by multiprocessing."""


def export_in_worker(args) -> None:
    """Build a completed export in a private destination, reporting Python failures on stderr.

    Args:
        args: Parsed arguments whose output directory belongs to the supervising process.
    Notes:
        Native faults terminate this process; the parent owns and cleans the containing workspace.
    """
    # Terminal Ctrl-C belongs to the supervisor. Interrupting native code inside this worker can be delayed
    # until it returns to Python, so the parent stops the entire worker process instead.
    signal.signal(signal.SIGINT, signal.SIG_IGN)

    # Scenario-loading helpers also use tempfile; keep their work inside the parent's cleanup boundary.
    tempfile.tempdir = str(args.out.parent)
    os.environ["TMPDIR"] = tempfile.tempdir
    if os.name == "posix":
        import resource

        # A native fault must not leave an OS-generated core file in the user's working directory.
        _, hard_limit = resource.getrlimit(resource.RLIMIT_CORE)
        resource.setrlimit(resource.RLIMIT_CORE, (0, hard_limit))
    try:
        export_bundle(args)
    except BaseException as error:
        operation = "Simulation" if args.command == "run" else "CSV conversion"
        print(f"{operation} failed: {error}", file=sys.stderr, flush=True)
        raise SystemExit(130 if isinstance(error, KeyboardInterrupt) else 1) from None


def interrupt_export(signum, frame) -> None:
    """Cancel on SIGINT or SIGTERM and let shutdown finish despite repeated interrupts.

    Args:
        signum: Signal delivered to the supervising process.
        frame: Interrupted Python frame, supplied by the signal module.
    Raises:
        ExportCancelled: Always; unlike InterruptedError, multiprocessing will not retry this exception.
    """
    for cancellation_signal in (signal.SIGINT, signal.SIGTERM):
        signal.signal(cancellation_signal, signal.SIG_IGN)

    raise ExportCancelled("Export cancelled")


def stop_worker(process: multiprocessing.Process) -> None:
    """Stop and reap an export worker, allowing at most one second for graceful termination.

    Args:
        process: Worker owned by the supervisor; it may already have exited or failed to start.
    Notes:
        Native code can install its own SIGTERM handler. Escalate to a forced stop rather than waiting for
        that handler indefinitely. Reaping the child before deleting its workspace prevents further writes.
    """
    if process.is_alive():
        process.terminate()
        process.join(timeout=1.0)

        if process.is_alive():
            process.kill()
            process.join()

    process.close()


def supervise_export(args) -> Path:
    """Run native work in a child process and publish only after it exits successfully.

    Args:
        args: Parsed simulation or CSV-conversion arguments.
    Returns:
        Final output directory; also prints that directory on stdout after publication.
    Raises:
        RuntimeError: The worker exits unsuccessfully, including a native segmentation fault.
        ExportCancelled: The parent receives SIGINT or SIGTERM and cancels the worker.
    Notes:
        Failed runs remove their private workspace and newly created empty parents. Publication errors restore
        previous artifacts. SIGINT/SIGTERM cleanup waits for the child before removing its workspace.
    """
    # Explicitly enable Ctrl-C even when a launcher passed down an ignored SIGINT disposition.
    previous_handlers = {signum: signal.signal(signum, interrupt_export) for signum in (signal.SIGINT, signal.SIGTERM)}

    try:
        validate_inputs(args)
        out = output_directory(args)

        with ExportTransaction(out) as transaction:
            worker_out = transaction.staging / "result"
            worker_args = Namespace(**{**vars(args), "out": worker_out, "display_out": out})
            process = multiprocessing.get_context("spawn").Process(target=export_in_worker, args=(worker_args,))
            try:
                process.start()
                process.join()
                exitcode = process.exitcode
            finally:
                stop_worker(process)

            if exitcode != 0:
                detail = signal.Signals(-exitcode).name if exitcode < 0 else f"status {exitcode}"
                raise RuntimeError(f"Export worker terminated with {detail}")

            names = ("trace.csv", "manifest.json") if args.format == "csv" else ("trace.arrow",)
            transaction.publish([worker_out / name for name in names])
            print(out, flush=True)
            return out
    finally:
        for signum, previous_handler in previous_handlers.items():
            signal.signal(signum, previous_handler)
