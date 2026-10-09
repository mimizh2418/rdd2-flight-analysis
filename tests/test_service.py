import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer

from exporter_support import SIMULATOR_PATH

SPEC = importlib.util.spec_from_file_location("service", SIMULATOR_PATH.with_name("simulation_service.py"))
service = importlib.util.module_from_spec(SPEC)

SPEC.loader.exec_module(service)


class ServiceTests(unittest.TestCase):
    def test_project_scenarios_are_discovered_without_allowing_external_symlinks(self):
        """Discover local missions beside upstream scenarios and reject symlinks escaping either source tree."""
        with tempfile.TemporaryDirectory() as outside:
            directory = self.project_scenarios
            scenario = directory / "rumoca-scenario.circles-mocap.toml"
            scenario.write_text("[sim]\nt_end = 110.0\n")
            external = Path(outside) / "outside.toml"
            external.write_text("[sim]\nt_end = 1.0\n")
            (directory / "rumoca-scenario.escape.toml").symlink_to(external)
            upstream = self.root / "Vehicles/Rdd2/Test"
            (upstream / "rumoca-scenario.escape.toml").symlink_to(external)
            # An upstream alias into the separate project tree must also be rejected.
            (upstream / "rumoca-scenario.project-alias.toml").symlink_to(scenario)
            jobs = service.Jobs(self.root, self.root / "project-jobs")

            try:
                local_name = f"scenarios/{scenario.name}"
                self.assertEqual(set(jobs.scenarios), {self.scenario, local_name})
                self.assertEqual(jobs.scenarios[local_name], scenario.resolve())
            finally:
                jobs.executor.shutdown(wait=True)

    def test_completed_arrow_artifact_streams_without_a_manifest(self):
        """Serve binary bytes with the Arrow MIME type, and report an absent CSV sidecar as 404."""
        ident = "arrow-result"
        self.jobs.items[ident] = {"id": ident, "state": "complete"}
        directory = self.jobs.artifacts / ident
        directory.mkdir(parents=True)
        payload = (Path(__file__).parent / "fixtures/python-flight.arrow").read_bytes()
        (directory / "trace.arrow").write_bytes(payload)
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        connection.request("GET", f"/api/jobs/{ident}/trace.arrow")
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("Content-Type"), "application/vnd.apache.arrow.file")
        self.assertEqual(response.read(), payload)
        connection.close()
        self.assertEqual(self.request("GET", f"/api/jobs/{ident}/manifest.json")[0], 404)

    def setUp(self):
        """Start a loopback service on an ephemeral port with temporary model and scenario directories."""

        self.temporary = tempfile.TemporaryDirectory()
        workspace = Path(self.temporary.name)
        self.root = workspace / "models"
        self.project_scenarios = workspace / "scenarios"
        self.project_scenarios.mkdir()
        project_patch = patch.object(service, "PROJECT_SCENARIOS", self.project_scenarios)
        project_patch.start()
        self.addCleanup(project_patch.stop)
        scenario = self.root / "Vehicles/Rdd2/Test/rumoca-scenario.smoke.toml"

        scenario.parent.mkdir(parents=True)
        scenario.write_text("[sim]\nt_end = 0.02\n")

        self.scenario = str(scenario.relative_to(self.root))
        self.jobs = service.Jobs(self.root, self.root / "jobs")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), service.handler(self.jobs, {"http://127.0.0.1:5173"}))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

        self.thread.start()

    def tearDown(self):
        """Stop the server and executor before removing temporary test files."""

        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.jobs.executor.shutdown(wait=True)
        self.temporary.cleanup()

    def request(self, method, path, body=None, headers=None):
        """Return the status, headers, and decoded JSON from an HTTP request.

        Args:
            method: HTTP method to issue to this test's loopback server.
            path: Request route.
            body: Optional request payload accepted by HTTPConnection.
            headers: Optional request headers.
        Returns:
            (status, response_headers, JSON_body), with None for an empty body. Closes the connection after reading.
        """

        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)

        connection.request(method, path, body, headers or {})

        response = connection.getresponse()
        status, metadata, data = response.status, dict(response.getheaders()), response.read()

        connection.close()

        return status, metadata, json.loads(data) if data else None

    def test_origin_and_host_access_controls(self):
        """Allow the configured browser origin, including preflight, while rejecting unrelated origins and hosts."""
        status, headers, data = self.request("GET", "/api/scenarios", headers={"Origin": "http://127.0.0.1:5173"})

        self.assertEqual(status, 200)
        self.assertEqual(data["scenarios"], [self.scenario])
        self.assertEqual(headers["Access-Control-Allow-Origin"], "http://127.0.0.1:5173")

        for headers in ({"Origin": "https://example.com"}, {"Host": "example.com"}):
            self.assertEqual(self.request("GET", "/api/scenarios", headers=headers)[0], 403)

        self.assertEqual(self.request("OPTIONS", "/api/jobs", headers={"Origin": "http://127.0.0.1:5173"})[0], 204)

    def test_invalid_job_submissions_are_rejected(self):
        """Reject malformed JSON and scenario paths outside the service's discovered models."""

        self.assertEqual(
            self.request(
                "POST", "/api/jobs", json.dumps({"scenario": "../unknown.toml"}), {"Content-Type": "application/json"}
            )[0],
            400,
        )
        self.assertEqual(self.request("POST", "/api/jobs", "{", {"Content-Type": "application/json"})[0], 400)

    def test_failed_process_reports_error_and_no_result(self):
        """Confirm failed exporters report errors and cannot expose a result bundle."""

        status, _, data = self.request(
            "POST", "/api/jobs", json.dumps({"scenario": self.scenario}), {"Content-Type": "application/json"}
        )

        self.assertEqual(status, 202)

        ident = data["id"]
        deadline = time.monotonic() + 5

        while time.monotonic() < deadline:
            job = self.jobs.public()[0]

            if job["state"] == "failed":
                break

            time.sleep(0.01)

        self.assertEqual(job["state"], "failed")
        self.assertIn("Simulation failed", job["error"])
        self.assertNotIn("process", job)
        self.assertEqual(self.request("GET", f"/api/jobs/{ident}/trace.csv")[0], 409)
