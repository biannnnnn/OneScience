import json
import socket
import subprocess
import sys
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from ranker_service.model import empirical_percentiles, prompt_for_paper


ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def request_json(url, method="GET", body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(
        url,
        method=method,
        data=data,
        headers={"Content-Type": "application/json"} if data else {},
    )
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode("utf-8"))


class RankerModelTest(unittest.TestCase):
    def test_prompt_matches_official_pointwise_evaluation(self):
        self.assertEqual(
            prompt_for_paper({"title": "  A  paper ", "abstract": "A\n result"}),
            "Given a certain paper, Title: A paper\n"
            "Abstract: A result\n"
            "Evaluate the quality of this paper:",
        )

    def test_empirical_percentile_preserves_rank_order(self):
        self.assertEqual(empirical_percentiles([-2.0, 0.0, 3.0], [-2.0, 0.0, 3.0]), [0.0, 50.0, 100.0])


class RankerHttpTest(unittest.TestCase):
    def test_mock_service_scores_a_batch_and_rejects_empty_abstract(self):
        port = free_port()
        child = subprocess.Popen(
            [
                sys.executable,
                "-m", "ranker_service.app",
                "--config", "config/ranker-service.mock.json",
                "--backend", "mock",
                "--port", str(port),
            ],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            deadline = time.time() + 10
            while time.time() < deadline:
                line = child.stdout.readline()
                if line and json.loads(line).get("event") == "ready":
                    break
            else:
                self.fail("Ranker mock service did not become ready")

            status, health = request_json("http://127.0.0.1:{}/health".format(port))
            self.assertEqual(status, 200)
            self.assertIn("paper_score_batch", health["capabilities"])

            status, result = request_json(
                "http://127.0.0.1:{}/v1/paper-scores".format(port),
                method="POST",
                body={
                    "request_id": "ranker-test",
                    "papers": [
                        {"paper_id": "a", "title": "Paper A", "abstract": "A complete abstract for the first paper."},
                        {"paper_id": "b", "title": "Paper B", "abstract": "A different complete abstract for another paper."},
                    ],
                },
            )
            self.assertEqual(status, 200)
            self.assertEqual(len(result["scores"]), 2)
            self.assertTrue(all(0 <= item["score"] <= 100 for item in result["scores"]))
            self.assertEqual(result["scores"][0]["score_method"], "request_empirical_cdf")

            status, invalid = request_json(
                "http://127.0.0.1:{}/v1/paper-scores".format(port),
                method="POST",
                body={"papers": [{"paper_id": "x", "title": "No abstract", "abstract": ""}]},
            )
            self.assertEqual(status, 422)
            self.assertEqual(invalid["error"]["code"], "RANKER_REQUEST_INVALID")
        finally:
            child.terminate()
            child.wait(timeout=5)
            child.stdout.close()
            child.stderr.close()


if __name__ == "__main__":
    unittest.main()
