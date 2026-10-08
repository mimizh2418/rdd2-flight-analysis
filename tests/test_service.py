import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer

SPEC = importlib.util.spec_from_file_location("service", Path(__file__).parents[1] / "tools/simulation_service.py")
service = importlib.util.module_from_spec(SPEC)

SPEC.loader.exec_module(service)


class ServiceTests(unittest.TestCase):
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
        """Start an isolated loopback service with a temporary invalid scenario.

        Returns:
            None; stores a temporary fixture, job queue, ephemeral-port HTTP server, and background server thread on
            this test case.
        """

        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        scenario = self.root / "Vehicles/Rdd2/Test/rumoca-scenario.smoke.toml"

        scenario.parent.mkdir(parents=True)
        scenario.write_text("[sim]\nt_end = 0.02\n")

        self.scenario = str(scenario.relative_to(self.root))
        self.jobs = service.Jobs(self.root, self.root / "jobs")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), service.handler(self.jobs, {"http://127.0.0.1:5173"}))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

        self.thread.start()

    def tearDown(self):
        """Stop the server and executor before removing temporary test files.

        Returns:
            None; shuts down the server and executor before deleting the temporary fixture. Runs after each test.
        """

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

    def test_scenario_listing_and_cors(self):
        """Check discovery, empty job listing, and permitted-origin response headers.

        Returns:
            None; creates isolated fixtures and asserts the documented behavior with unittest. Assertion failures
            fail the test.
        """

        status, headers, data = self.request("GET", "/api/scenarios", headers={"Origin": "http://127.0.0.1:5173"})

        self.assertEqual(status, 200)
        self.assertEqual(data["scenarios"], [self.scenario])
        self.assertEqual(headers["Access-Control-Allow-Origin"], "http://127.0.0.1:5173")

        status, _, data = self.request("GET", "/api/jobs")

        self.assertEqual((status, data), (200, {"jobs": []}))

    def test_unlisted_origin_and_host_are_rejected(self):
        """Reject unrelated hosts/origins and support allowed browser preflight.

        Returns:
            None; creates isolated fixtures and asserts the documented behavior with unittest. Assertion failures
            fail the test.
        """

        for headers in ({"Origin": "https://example.com"}, {"Host": "example.com"}):
            self.assertEqual(self.request("GET", "/api/scenarios", headers=headers)[0], 403)

        self.assertEqual(self.request("OPTIONS", "/api/jobs", headers={"Origin": "http://127.0.0.1:5173"})[0], 204)

    def test_invalid_job_and_result_requests(self):
        """Check malformed submissions and references to nonexistent jobs.

        Returns:
            None; creates isolated fixtures and asserts the documented behavior with unittest. Assertion failures
            fail the test.
        """

        self.assertEqual(
            self.request(
                "POST", "/api/jobs", json.dumps({"scenario": "../unknown.toml"}), {"Content-Type": "application/json"}
            )[0],
            400,
        )
        self.assertEqual(self.request("POST", "/api/jobs", "{", {"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.request("DELETE", "/api/jobs/unknown")[0], 404)
        self.assertEqual(self.request("GET", "/api/jobs/unknown/trace.csv")[0], 404)

    def test_failed_process_reports_error_and_no_result(self):
        """Confirm failed exporters report errors and cannot expose a result bundle.

        Returns:
            None; creates isolated fixtures and asserts the documented behavior with unittest. Assertion failures
            fail the test.
        """

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
