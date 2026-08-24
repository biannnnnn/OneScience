import json
import pathlib
import unittest

from jsonschema import Draft202012Validator

from acceptance_prediction import AcceptancePredictor, ModelError, train_model
from acceptance_prediction.score_features import (
    SCORE_FEATURE_NAMES,
    extract_score_feature_dict,
    score_factors,
    vectorize_score,
)


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[1]


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


def review_rows(count=180):
    venue = {"id": "ICLR.cc/2025/Conference", "name": "ICLR 2025"}
    rows = []
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


def score_object(overall=70, confidence=0.6):
    return {
        "originality": overall,
        "rigor": overall,
        "evidence": overall,
        "clarity": overall,
        "reproducibility": overall,
        "venue_fit": overall,
        "overall": overall,
        "confidence": confidence,
        "rationale": "该论文方法清晰，实验充分。",
        "strengths": ["方法新颖", "实验充分"],
        "risks": ["样本规模有限"],
        "limitations": ["摘要输入无法证明完整方法细节"],
    }


def trace():
    return {
        "model": "qwen/Qwen3-8B",
        "model_version": "v1",
        "adapter_version": "schema-lora-v1",
        "prompt_version": "venue-score-1.0.0",
    }


def score_rows(count=180):
    venue = {"id": "ICLR.cc/2025/Conference", "name": "ICLR 2025"}
    rows = []
    for index in range(count):
        label = 1 if index % 3 == 0 else 0
        rows.append({
            "case_id": str(index),
            "split": "train" if index < 120 else ("validation" if index < 150 else "test"),
            "decision_label": label,
            "target_venue": venue,
            "manuscript": manuscript(),
            "score": score_object(80 if label else 45),
            "model_trace": trace(),
        })
    return rows


class ScoreFeatureTests(unittest.TestCase):
    def test_score_features_are_normalized_into_unit_interval(self):
        features = extract_score_feature_dict(score_object(overall=85, confidence=0.7))
        self.assertEqual(features["overall"], 0.85)
        self.assertEqual(features["confidence"], 0.7)
        self.assertEqual(set(features.keys()), set(SCORE_FEATURE_NAMES))
        vector = vectorize_score(features)
        self.assertEqual(len(vector), len(SCORE_FEATURE_NAMES))
        self.assertTrue(all(0.0 <= value <= 1.0 for value in vector))

    def test_score_factors_extract_positive_and_risk_text(self):
        positive, risks = score_factors(score_object())
        self.assertEqual(positive, ["方法新颖", "实验充分"])
        self.assertEqual(risks, ["样本规模有限"])

    def test_score_mode_training_produces_score_contract(self):
        model = train_model(score_rows(), epochs=350, feature_mode="score")
        self.assertEqual(model["feature_contract_version"], "2.0.0")
        self.assertEqual(model["feature_names"], list(SCORE_FEATURE_NAMES))
        self.assertEqual(model["calibrator"]["method"], "platt")
        self.assertEqual(model["sample_counts"], {"train": 120, "validation": 30, "test": 30})
        predictor = AcceptancePredictor(model)
        self.assertEqual(predictor.feature_contract, "score")

    def test_predict_from_score_matches_output_schema(self):
        model = train_model(score_rows(), epochs=350, feature_mode="score")
        predictor = AcceptancePredictor(model)
        row = score_rows(1)[0]
        result = predictor.predict_from_score(
            row["manuscript"], row["target_venue"], row["score"], row["model_trace"]
        )
        with (PROJECT_ROOT / "schemas" / "acceptance-prediction.json").open("r", encoding="utf-8") as handle:
            schema = json.load(handle)
        errors = list(Draft202012Validator(schema).iter_errors(result))
        self.assertEqual(errors, [])
        self.assertIn(result["prediction"], {"accept", "borderline", "reject"})
        self.assertGreaterEqual(result["acceptance_probability"], 0)
        self.assertLessEqual(result["acceptance_probability"], 1)

    def test_score_signature_mismatch_is_rejected(self):
        model = train_model(score_rows(), epochs=350, feature_mode="score")
        predictor = AcceptancePredictor(model)
        row = score_rows(1)[0]
        with self.assertRaisesRegex(ModelError, "版本不一致"):
            predictor.predict_from_score(
                row["manuscript"],
                row["target_venue"],
                row["score"],
                dict(trace(), adapter_version="other-adapter"),
            )

    def test_score_training_rejects_mixed_model_traces(self):
        rows = score_rows()
        rows[-1]["model_trace"] = dict(trace(), model_version="v2")
        with self.assertRaisesRegex(ModelError, "多个审稿模型版本"):
            train_model(rows, epochs=10, feature_mode="score")

    def test_review_predictor_rejects_score_prediction(self):
        review_model = train_model(review_rows(), epochs=350, feature_mode="review")
        predictor = AcceptancePredictor(review_model)
        self.assertEqual(predictor.feature_contract, "review")
        row = score_rows(1)[0]
        with self.assertRaisesRegex(ModelError, "不是 score 特征契约"):
            predictor.predict_from_score(
                row["manuscript"], row["target_venue"], row["score"], row["model_trace"]
            )


if __name__ == "__main__":
    unittest.main()
