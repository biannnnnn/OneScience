import copy
import importlib.util
import json
import pathlib
import unittest

from jsonschema import Draft202012Validator

from acceptance_prediction import AcceptancePredictor, ModelError, train_model
from reviewer_service.app import ReviewerService
from reviewer_service.core import normalize_review_evidence


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[1]


def load_prepare_module():
    path = PROJECT_ROOT / "scripts" / "acceptance-prediction" / "prepare_proreview.py"
    spec = importlib.util.spec_from_file_location("acceptance_prepare", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_run_reviews_module():
    path = PROJECT_ROOT / "scripts" / "acceptance-prediction" / "run_reviews.py"
    spec = importlib.util.spec_from_file_location("acceptance_run_reviews", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def base_review():
    with (PROJECT_ROOT / "docs" / "reviewer" / "review-example.json").open("r", encoding="utf-8") as handle:
        review = json.load(handle)
    review["review_type"] = "venue_conditioned"
    review["target_venue"] = {"id": "ICLR.cc/2025/Conference", "name": "ICLR 2025"}
    review["model_trace"].update({
        "model": "frozen-reviewer",
        "model_version": "v1",
        "adapter_version": "adapter-v1",
        "prompt_version": "prompt-v1",
    })
    return review


def manuscript():
    return {
        "paper_id": "paper-test",
        "title": "A test manuscript",
        "language": "en",
        "fingerprint": None,
        "paragraphs": [
            {
                "section": "Abstract",
                "paragraph_id": "abstract-p01",
                "text": "This paper introduces and evaluates a test method on a public benchmark.",
            }
        ],
    }


def training_rows(count=180):
    rows = []
    venue = {"id": "ICLR.cc/2025/Conference", "name": "ICLR 2025"}
    for index in range(count):
        label = 1 if index % 3 == 0 else 0
        review = base_review()
        if label:
            review["recommendation"]["verdict"] = "ready_for_submission"
            review["major_concerns"] = []
            review["minor_concerns"] = []
            review["revision_tasks"] = []
        rows.append({
            "case_id": str(index),
            "split": "train" if index < 120 else ("validation" if index < 150 else "test"),
            "decision_label": label,
            "target_venue": venue,
            "manuscript": manuscript(),
            "review": review,
        })
    return rows


class DecisionPreparationTests(unittest.TestCase):
    def test_decision_normalization_excludes_ambiguous_values(self):
        module = load_prepare_module()
        self.assertEqual(module.normalize_decision("Accept (Poster)"), 1)
        self.assertEqual(module.normalize_decision("Conditional Accept (Poster)"), 1)
        self.assertEqual(module.normalize_decision("Reject"), 0)
        self.assertEqual(module.normalize_decision("Desk Reject"), 0)
        self.assertIsNone(module.normalize_decision("Withdrawn Submission"))
        self.assertIsNone(module.normalize_decision(""))
        self.assertIsNone(module.normalize_decision("Invite revision"))

    def test_case_target_venue_never_contains_the_outcome(self):
        module = load_prepare_module()
        row = {
            "paper_id": "rejected-paper",
            "title": "A paper",
            "decision": {"decision": "Reject"},
            "metadata": {
                "venueid": "ICLR.cc/2025/Conference/Rejected_Submission",
                "venue": "Submitted to ICLR 2025",
            },
            "markdown": {
                "content": "# Abstract\n\n" + "This is a sufficiently long abstract. " * 5
            },
        }
        case, _ = module.make_case(row, "train", 2025, 24000, 80)
        self.assertEqual(case["target_venue"], {
            "id": "ICLR.cc/2025/Conference",
            "name": "ICLR 2025",
        })
        self.assertIn("Rejected_Submission", case["source"]["venue_id"])

    def test_review_extraction_rejects_outcome_bearing_target_venue(self):
        module = load_run_reviews_module()
        with self.assertRaisesRegex(SystemExit, "拒绝生成审稿特征"):
            module.validate_target_venues([{
                "case_id": "leaked",
                "target_venue": {
                    "id": "ICLR.cc/2025/Conference/Rejected_Submission",
                    "name": "ICLR 2025",
                },
            }])


class AcceptanceModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model = train_model(training_rows(), epochs=350)
        cls.predictor = AcceptancePredictor(cls.model)

    def test_model_is_calibrated_on_validation_and_time_split_is_reported(self):
        self.assertEqual(self.model["calibrator"]["method"], "platt")
        self.assertEqual(self.model["sample_counts"], {"train": 120, "validation": 30, "test": 30})
        self.assertEqual(self.model["metrics"]["test"]["auroc"], 1.0)
        self.assertIn("test", self.model["historical_rate_baseline_metrics"])
        self.assertIn("decision_text", self.model["forbidden_features"])
        self.assertNotIn("venue_prior_logit", self.model["feature_names"])
        self.assertNotIn("venue_priors", self.model)

    def test_outcome_bearing_target_venue_is_rejected(self):
        rows = training_rows()
        rows[0]["target_venue"] = {
            "id": "ICLR.cc/2025/Conference/Rejected_Submission",
            "name": "ICLR 2025",
        }
        with self.assertRaisesRegex(ModelError, "标签泄漏"):
            train_model(rows, epochs=10)

    def test_prediction_matches_output_schema(self):
        row = training_rows(1)[0]
        result = self.predictor.predict(row["manuscript"], row["target_venue"], row["review"])
        with (PROJECT_ROOT / "schemas" / "acceptance-prediction.json").open("r", encoding="utf-8") as handle:
            schema = json.load(handle)
        errors = list(Draft202012Validator(schema).iter_errors(result))
        self.assertEqual(errors, [])
        self.assertGreaterEqual(result["acceptance_probability"], 0)
        self.assertLessEqual(result["acceptance_probability"], 1)
        self.assertIn(result["confidence_level"], {"high", "medium", "low"})

    def test_mixed_reviewer_versions_are_rejected(self):
        rows = training_rows()
        rows[-1]["review"]["model_trace"]["adapter_version"] = "different-adapter"
        with self.assertRaisesRegex(ModelError, "多个审稿模型版本"):
            train_model(rows, epochs=10)

    def test_single_location_cross_section_is_downgraded_without_text_changes(self):
        review = base_review()
        review["strengths"][0]["evidence"] = [{
            "type": "cross_section",
            "description": "Only one location was emitted",
            "locations": [{
                "section": "Abstract",
                "paragraph_id": "abstract-p01",
                "excerpt": "verbatim evidence",
            }],
            "confidence": 0.9,
        }]
        normalized = normalize_review_evidence(review)
        self.assertEqual(normalized["strengths"][0]["evidence"], [{
            "type": "direct_quote",
            "section": "Abstract",
            "paragraph_id": "abstract-p01",
            "excerpt": "verbatim evidence",
        }])

    def test_short_absence_description_reuses_the_owner_problem(self):
        review = base_review()
        owner = review["major_concerns"][0]
        owner["evidence"] = [{
            "type": "absence",
            "description": "缺少什么",
            "searched_sections": ["Experiments", "Experiments"],
            "confidence": 0.9,
        }]
        normalized = normalize_review_evidence(review)
        self.assertEqual(owner["evidence"][0], {
            "type": "absence",
            "description": owner["problem"],
            "searched_sections": ["Experiments"],
        })

    def test_service_prediction_endpoint_contract(self):
        with (PROJECT_ROOT / "config" / "reviewer-service.m1.json").open("r", encoding="utf-8") as handle:
            config = json.load(handle)
        service = ReviewerService(config, "mock")
        service.acceptance_predictor = self.predictor
        row = training_rows(1)[0]
        response = service.predict_acceptance({
            "request_id": "acceptance-unit-test",
            "manuscript": row["manuscript"],
            "target_venue": row["target_venue"],
            "review": row["review"],
        })
        self.assertEqual(response["status"], "completed")
        self.assertEqual(response["prediction"]["prediction_schema_version"], "1.0.0")
        self.assertEqual(service.prediction_count, 1)


if __name__ == "__main__":
    unittest.main()
