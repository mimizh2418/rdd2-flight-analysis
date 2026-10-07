#!/usr/bin/env python3
"""Optional loopback-only Rumoca job service; Python 3.11+, standard library only."""

from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import uuid


class Jobs:
    """Serialize simulations while allowing HTTP threads to inspect and cancel jobs safely."""

    def __init__(self, root: Path, artifacts: Path, rumoca: str):
        """Discover allowed scenarios and initialize a queue that runs one simulation at a time.

        Args:
            root: Modelica checkout containing Vehicles/Rdd2/Test scenario files.
            artifacts: Directory for per-job bundles and exporter logs.
            rumoca: CLI executable name/path forwarded to the exporter.
        Notes:
            Discovers allowed scenarios once, resolves directory paths, and creates a single-worker executor. The
            service owner must shut down the executor.
        """

        self.root, self.artifacts, self.rumoca = root.resolve(), artifacts.resolve(), rumoca
        self.scenarios = {
            str(p.relative_to(self.root)): p
            for p in sorted((self.root / "Vehicles/Rdd2/Test").glob("rumoca-scenario.*.toml"))
        }
        self.items: dict[str, dict] = {}
        self.lock = threading.RLock()
        self.executor = ThreadPoolExecutor(max_workers=1)

    def submit(self, scenario: str):
        """Queue a known scenario and return its generated job identifier.

        Args:
            scenario: Relative scenario path from the discovered allowlist.
        Returns:
            Generated hexadecimal job ID after recording queued state and scheduling work.
        Raises:
            ValueError: The scenario is not allowlisted.
        """

        if scenario not in self.scenarios:
            raise ValueError("Unknown RDD2 scenario")

        ident = uuid.uuid4().hex

        with self.lock:
            self.items[ident] = {"id": ident, "scenario": scenario, "state": "queued"}

        self.executor.submit(self.run, ident)

        return ident

    def run(self, ident):
        """Launch an isolated exporter process and publish completion or failure under the job lock.

        Args:
            ident: Existing queued job ID, normally supplied by the executor.
        Returns:
            None; publishes running then complete/failed state, unless the job was cancelled. Failure details retain
            the final 6,000 log characters.
        Notes:
            Runs the exporter in a new process session. Waits outside the queue lock so HTTP polling/cancellation
            remain responsive. Launch/I/O errors propagate to the executor future.
        """

        with self.lock:
            job = self.items[ident]

            if job["state"] == "cancelled":
                return

            output = self.artifacts / ident
            cmd = [
                sys.executable,
                str(Path(__file__).with_name("export_rdd2_viewer.py")),
                "--modelica-root",
                str(self.root),
                "--scenario",
                str(self.scenarios[job["scenario"]]),
                "--out",
                str(output),
                "--rumoca",
                self.rumoca,
            ]

            self.artifacts.mkdir(parents=True, exist_ok=True)

            log = (self.artifacts / f"{ident}.log").open("w+")
            process = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)

            job.update(state="running", process=process)

        # Waiting outside the lock keeps polling and cancellation available while Rumoca runs.
        code = process.wait()

        with self.lock:
            if job["state"] != "cancelled":
                job["state"] = "complete" if code == 0 else "failed"

                if code:
                    log.seek(0)

                    job["error"] = log.read()[-6000:]

            job.pop("process", None)

        log.close()

    def cancel(self, ident):
        """Cancel queued work or terminate the process group of a running simulation.

        Args:
            ident: Existing job ID.
        Returns:
            None; marks pending work cancelled and sends SIGTERM to a running exporter process group. Terminal jobs
            are unchanged.
        Raises:
            KeyError: The job does not exist.
        Notes:
            Does not synchronously wait for process exit; the executor observes completion later.
        """

        with self.lock:
            job = self.items[ident]

            if job["state"] in ("complete", "failed", "cancelled"):
                return

            job["state"] = "cancelled"
            process = job.get("process")

            if process:
                try:
                    # The exporter starts a separate session, so cancellation also reaches child processes.
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass

    def public(self):
        """Return serializable job snapshots without exposing subprocess objects.

        Returns:
            Fresh shallow job dictionaries safe for JSON encoding, excluding internal subprocess handles. Snapshot
            creation occurs while holding the queue lock.
        """

        with self.lock:
            return [{k: v for k, v in job.items() if k != "process"} for job in self.items.values()]


def handler(jobs: Jobs, origins: set[str]):
    """Create an HTTP handler bound to the job queue and allowed browser origins.

    Args:
        jobs: Shared allowlisted job queue.
        origins: Exact browser Origin strings permitted to call the service.
    Returns:
        BaseHTTPRequestHandler subclass capturing the queue and origin policy for use with ThreadingHTTPServer.
    """

    class Handler(BaseHTTPRequestHandler):
        """Expose the small loopback API without retaining trace contents in server memory."""

        def allowed(self):
            """Accept only loopback Host headers and absent or explicitly allowed Origin headers.

            Returns:
                True only for localhost/127.0.0.1 Host headers and absent or explicitly allowlisted Origin headers.
                Does not write a response.
            """

            origin = self.headers.get("Origin")
            host = self.headers.get("Host", "").split(":")[0]

            return host in ("127.0.0.1", "localhost") and (not origin or origin in origins)

        def send(self, code, data, content_type="application/json"):
            """Send JSON or bytes with content length, cache policy, and applicable CORS headers.

            Args:
                code: HTTP status code.
                data: Raw bytes or a JSON-serializable payload.
                content_type: Response MIME type, defaulting to application/json.
            Returns:
                None; writes response headers and body with no-store caching and applicable CORS origin.
            Notes:
                Serialization and disconnected-client write errors propagate to the HTTP server.
            """

            body = data if isinstance(data, bytes) else json.dumps(data).encode()

            self.send_response(code)
            self.send_header("Content-Type", content_type)

            origin = self.headers.get("Origin")

            if origin in origins:
                self.send_header("Access-Control-Allow-Origin", origin)

            self.send_header("Vary", "Origin")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            """Answer a permitted browser preflight for the supported service methods.

            Returns:
                None; sends 204 with supported methods/headers for an allowed request, otherwise 403. Called by the
                HTTP server for CORS preflight.
            """

            if not self.allowed():
                return self.send(403, {"error": "Origin not allowed"})

            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", ""))
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def do_GET(self):
            """List scenarios/jobs or stream a completed job's trace and manifest.

            Returns:
                None; serves scenario/job lists or streams a completed job's trace.csv/manifest.json. Uses 403 for
                rejected origin/host, 409 for unfinished results, and 404 for unknown routes.
            Notes:
                Large artifacts stream in one-megabyte blocks; their complete contents are not retained in memory.
            """

            if not self.allowed():
                return self.send(403, {"error": "Origin not allowed"})

            if self.path == "/api/scenarios":
                return self.send(200, {"scenarios": list(jobs.scenarios)})

            if self.path == "/api/jobs":
                return self.send(200, {"jobs": jobs.public()})

            parts = self.path.split("/")

            if (
                len(parts) == 5
                and parts[1:3] == ["api", "jobs"]
                and parts[3] in jobs.items
                and parts[4] in ("trace.csv", "manifest.json")
            ):
                if jobs.items[parts[3]]["state"] != "complete":
                    return self.send(409, {"error": "Result not complete"})

                path = jobs.artifacts / parts[3] / parts[4]

                self.send_response(200)
                self.send_header("Content-Type", "text/csv" if path.suffix == ".csv" else "application/json")

                origin = self.headers.get("Origin")

                if origin in origins:
                    self.send_header("Access-Control-Allow-Origin", origin)

                self.send_header("Content-Length", str(path.stat().st_size))
                self.end_headers()

                # Stream potentially large CSVs in bounded blocks instead of building one response body.
                with path.open("rb") as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b""):
                        self.wfile.write(block)

                return

            self.send(404, {"error": "Not found"})

        def do_POST(self):
            """Validate a bounded JSON request and queue its known scenario.

            Returns:
                None; POST /api/jobs accepts at most 8,192 bytes of application/json containing an allowlisted
                scenario and replies 202 with its ID. Rejected requests return 403/404/400 as applicable.
            """

            if not self.allowed():
                return self.send(403, {"error": "Origin not allowed"})

            if self.path != "/api/jobs":
                return self.send(404, {"error": "Not found"})

            try:
                if self.headers.get("Content-Type") != "application/json":
                    raise ValueError("Expected application/json")

                length = int(self.headers.get("Content-Length", "0"))

                if not 0 < length <= 8192:
                    raise ValueError("Invalid request size")

                body = json.loads(self.rfile.read(length))
                ident = jobs.submit(body["scenario"])

                self.send(202, {"id": ident})
            except (ValueError, KeyError, TypeError) as error:
                self.send(400, {"error": str(error)})

        def do_DELETE(self):
            """Cancel the job identified by the request path.

            Returns:
                None; DELETE /api/jobs/<id> cancels an existing job and returns its state. Unknown jobs return 404;
                rejected host/origin returns 403.
            """

            if not self.allowed():
                return self.send(403, {"error": "Origin not allowed"})

            ident = self.path.removeprefix("/api/jobs/")

            if not self.path.startswith("/api/jobs/") or ident not in jobs.items:
                return self.send(404, {"error": "Unknown job"})

            jobs.cancel(ident)
            self.send(200, {"state": jobs.items[ident]["state"]})

    return Handler


def main():
    """Serve the local API until interrupted, then cancel pending work and shut down the executor.

    Returns:
        None after serving until interruption and cleaning up queued/running jobs, the HTTP server, and the
        executor.
    Notes:
        Parses process arguments and binds only 127.0.0.1; argument, bind, and setup errors propagate.
    """

    p = argparse.ArgumentParser(description=__doc__)

    p.add_argument("--modelica-root", type=Path, default=Path("../modelica_models"))
    p.add_argument("--artifacts", type=Path, default=Path("artifacts/jobs"))
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--rumoca", default=os.environ.get("MODELICA_MODELS_RUMOCA", "rumoca"))
    p.add_argument(
        "--origin",
        action="append",
        default=["http://127.0.0.1:5173", "http://localhost:5173", "http://127.0.0.1:4173", "http://localhost:4173"],
    )

    args = p.parse_args()
    jobs = Jobs(args.modelica_root, args.artifacts, args.rumoca)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler(jobs, set(args.origin)))

    print(f"RDD2 simulation service: http://127.0.0.1:{args.port}", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for ident in jobs.items:
            jobs.cancel(ident)

        server.server_close()
        jobs.executor.shutdown(wait=True)


if __name__ == "__main__":
    main()
