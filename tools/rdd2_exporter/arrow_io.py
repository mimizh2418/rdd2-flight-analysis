"""Binary Arrow serialization and bulk numeric validation."""

from __future__ import annotations

import json
from pathlib import Path

from .progress import Progress
from .trace import CsvStatistics, TraceSummary


def arrow_modules():
    """Load optional binary-export dependencies, with an actionable error for CSV-only environments."""
    try:
        import numpy as np
        import pyarrow as pa
    except ImportError as error:
        raise RuntimeError(
            "Arrow export requires the project dependencies: uv sync --locked; "
            "run with uv run --locked tools/export_rdd2_viewer.py, or use --format csv"
        ) from error
    return np, pa


def prepare_arrow(names, columns) -> TraceSummary:
    """Validate numeric columns in bulk and retain them for IPC publication.

    Args:
        names: Original headers, including one time column.
        columns: Equally sized one-dimensional arrays, preserving raw event order.
    Returns:
        Observations and a Float64 Arrow table; no intermediate CSV is created.
    Raises:
        ValueError: Invalid headers, shapes, empty data, or non-finite/backwards time.
    """
    np, pa = arrow_modules()
    validator = CsvStatistics(names)
    arrays = [np.asarray(column, dtype=np.float64) for column in columns]
    if len(arrays) != len(names) or any(array.ndim != 1 for array in arrays):
        raise ValueError("Expected one numeric array per column")
    times = arrays[validator.time_index]
    if not len(times) or any(len(array) != len(times) for array in arrays):
        raise ValueError("No samples or inconsistent column lengths")
    delta = np.diff(times)
    if not np.isfinite(times).all() or (delta < 0).any():
        raise ValueError("Non-finite or backwards time")

    tolerance = 8 * np.finfo(np.float64).eps * np.maximum(1, np.maximum(np.abs(times[1:]), np.abs(times[:-1])))
    distinct = delta[delta > tolerance]
    observed = {
        "rows": len(times),
        "start_time_s": float(times[0]),
        "end_time_s": float(times[-1]),
        "event_rows": int(np.count_nonzero(delta <= tolerance)),
        "min_distinct_dt_s": float(distinct.min()) if len(distinct) else None,
        "max_distinct_dt_s": float(distinct.max()) if len(distinct) else 0.0,
        "nonfinite_values": sum(int(np.count_nonzero(~np.isfinite(array))) for array in arrays),
    }
    table = pa.Table.from_arrays(
        [pa.array(array, type=pa.float64(), from_pandas=False) for array in arrays], names=names
    )
    return TraceSummary(names, observed, "", table)


def write_arrow(output: Path, table, manifest: dict, progress: Progress) -> None:
    """Write a self-contained uncompressed IPC file with bounded record batches.

    Args:
        output: Private staging path; caller publishes only after successful completion.
        table: Validated Float64 channels in original row order.
        manifest: Viewer metadata and provenance, without CSV payload identifiers.
        progress: Reporter receiving batch-level progress.
    """
    _, pa = arrow_modules()
    schema = pa.schema(
        [
            pa.field(
                field.name,
                pa.float64(),
                nullable=False,
                metadata={
                    b"rdd2:signal": json.dumps(manifest["signals"].get(field.name, {})).encode(),
                },
            )
            for field in table.schema
        ],
        metadata={
            b"rdd2:format": b"rdd2-arrow-v1",
            b"rdd2:manifest": json.dumps(manifest, default=str).encode(),
        },
    )
    written = 0
    with pa.OSFile(str(output), "wb") as stream, pa.ipc.new_file(stream, schema) as writer:
        for batch in table.to_batches(max_chunksize=65536):
            writer.write_batch(pa.RecordBatch.from_arrays(batch.columns, schema=schema))
            written += batch.num_rows
            progress.update(
                f"Writing Arrow: {written / table.num_rows * 100:.0f}% ({written:,}/{table.num_rows:,} rows)"
            )


def csv_to_arrow(path: Path, names: list[str]):
    """Read a validated CSV snapshot as Float64 columns, converting blank cells to NaN.

    Args:
        path: Private snapshot already checked by scan_csv.
        names: Validated original headers, in file order.
    Returns:
        Arrow table ready for embedded-metadata publication.
    """
    _, pa = arrow_modules()
    import pyarrow.csv as arrow_csv

    table = arrow_csv.read_csv(
        path,
        convert_options=arrow_csv.ConvertOptions(
            column_types={name: pa.float64() for name in names},
            null_values=[""],
        ),
    )
    return pa.Table.from_arrays([column.fill_null(float("nan")) for column in table.columns], names=names)
