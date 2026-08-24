"""Dependency-free logistic model with held-out Platt calibration."""

import hashlib
import json
import math
import pathlib
from datetime import datetime, timezone

from .features import FEATURE_NAMES, explanation_factors, extract_feature_dict, vectorize
from .score_features import SCORE_FEATURE_NAMES, extract_score_feature_dict, score_factors, vectorize_score


class ModelError(RuntimeError):
    pass


def sigmoid(value):
    if value >= 0:
        inverse = math.exp(-min(value, 700))
        return 1 / (1 + inverse)
    exp_value = math.exp(max(value, -700))
    return exp_value / (1 + exp_value)


def _dot(left, right):
    return sum(a * b for a, b in zip(left, right))


def _fit_logistic(vectors, labels, learning_rate=0.05, epochs=1600, l2=0.02, initial_bias=None):
    if not vectors or len(vectors) != len(labels):
        raise ModelError("训练向量与标签为空或数量不一致。")
    if len(set(labels)) < 2:
        raise ModelError("训练数据必须同时包含 accept 和 reject。")
    width = len(vectors[0])
    weights = [0.0] * width
    prevalence = sum(labels) / len(labels)
    bias = (
        math.log(prevalence / (1 - prevalence))
        if initial_bias is None and 0 < prevalence < 1
        else float(initial_bias or 0.0)
    )
    count = float(len(labels))
    for epoch in range(int(epochs)):
        weight_gradients = [0.0] * width
        bias_gradient = 0.0
        for vector, label in zip(vectors, labels):
            error = sigmoid(_dot(weights, vector) + bias) - label
            bias_gradient += error
            for index, value in enumerate(vector):
                weight_gradients[index] += error * value
        rate = learning_rate / math.sqrt(1 + epoch / 200)
        for index in range(width):
            gradient = weight_gradients[index] / count + l2 * weights[index]
            weights[index] -= rate * gradient
        bias -= rate * bias_gradient / count
    return weights, bias


def _means_scales(vectors):
    width = len(vectors[0])
    means = [sum(row[index] for row in vectors) / len(vectors) for index in range(width)]
    scales = []
    for index, mean in enumerate(means):
        variance = sum((row[index] - mean) ** 2 for row in vectors) / len(vectors)
        scales.append(math.sqrt(variance) if variance > 1e-12 else 1.0)
    return means, scales


def _standardize(vector, means, scales):
    return [(value - mean) / scale for value, mean, scale in zip(vector, means, scales)]


def _fit_platt(logits, labels, epochs=1000):
    if len(logits) < 10 or len(set(labels)) < 2:
        return {"method": "identity", "slope": 1.0, "intercept": 0.0, "sample_count": len(logits)}
    vectors = [[value] for value in logits]
    weights, bias = _fit_logistic(
        vectors,
        labels,
        learning_rate=0.02,
        epochs=epochs,
        l2=0.005,
        initial_bias=0.0,
    )
    return {"method": "platt", "slope": weights[0], "intercept": bias, "sample_count": len(logits)}


def _rank_auc(probabilities, labels):
    positives = sum(labels)
    negatives = len(labels) - positives
    if not positives or not negatives:
        return None
    ranked = sorted(zip(probabilities, labels), key=lambda item: item[0])
    rank_sum = 0.0
    index = 0
    while index < len(ranked):
        end = index + 1
        while end < len(ranked) and ranked[end][0] == ranked[index][0]:
            end += 1
        average_rank = (index + 1 + end) / 2
        rank_sum += average_rank * sum(label for _, label in ranked[index:end])
        index = end
    return (rank_sum - positives * (positives + 1) / 2) / (positives * negatives)


def _average_precision(probabilities, labels):
    positives = sum(labels)
    if not positives:
        return None
    ordered = sorted(zip(probabilities, labels), key=lambda item: item[0], reverse=True)
    true_positives = 0
    predicted_positives = 0
    previous_recall = 0.0
    average_precision = 0.0
    index = 0
    while index < len(ordered):
        end = index + 1
        while end < len(ordered) and ordered[end][0] == ordered[index][0]:
            end += 1
        group = ordered[index:end]
        true_positives += sum(label for _, label in group)
        predicted_positives += len(group)
        recall = true_positives / positives
        precision = true_positives / predicted_positives
        average_precision += (recall - previous_recall) * precision
        previous_recall = recall
        index = end
    return average_precision


def metrics(probabilities, labels, bins=10):
    if not probabilities:
        return {"count": 0}
    epsilon = 1e-12
    brier = sum((probability - label) ** 2 for probability, label in zip(probabilities, labels)) / len(labels)
    log_loss = -sum(
        label * math.log(max(epsilon, probability))
        + (1 - label) * math.log(max(epsilon, 1 - probability))
        for probability, label in zip(probabilities, labels)
    ) / len(labels)
    accuracy = sum((probability >= 0.5) == bool(label) for probability, label in zip(probabilities, labels)) / len(labels)
    ece = 0.0
    calibration_bins = []
    for bin_index in range(bins):
        lower = bin_index / bins
        upper = (bin_index + 1) / bins
        selected = [
            (probability, label)
            for probability, label in zip(probabilities, labels)
            if lower <= probability < upper or (bin_index == bins - 1 and probability == 1)
        ]
        if not selected:
            continue
        mean_probability = sum(item[0] for item in selected) / len(selected)
        observed_rate = sum(item[1] for item in selected) / len(selected)
        ece += len(selected) / len(labels) * abs(mean_probability - observed_rate)
        calibration_bins.append({
            "lower": lower,
            "upper": upper,
            "count": len(selected),
            "mean_probability": mean_probability,
            "observed_rate": observed_rate,
        })
    return {
        "count": len(labels),
        "acceptance_rate": sum(labels) / len(labels),
        "accuracy_at_0_5": accuracy,
        "auroc": _rank_auc(probabilities, labels),
        "average_precision": _average_precision(probabilities, labels),
        "brier_score": brier,
        "log_loss": log_loss,
        "ece_10_bin": ece,
        "calibration_bins": calibration_bins,
    }


def _trace_signature(trace):
    trace = trace or {}
    return "|".join(str(trace.get(key) or "") for key in (
        "model", "model_version", "adapter_version", "prompt_version"
    ))


def _review_signature(review):
    return _trace_signature((review or {}).get("model_trace"))


def _venue_key(target_venue):
    venue = target_venue or {}
    return str(venue.get("id") or venue.get("name") or "unknown").strip().lower()


def _assert_no_target_venue_leakage(rows):
    forbidden = (
        "reject",
        "withdraw",
        "poster",
        "spotlight",
        "oral",
        "acceptance decision",
    )
    for row in rows:
        venue = row.get("target_venue") or {}
        value = "{} {}".format(venue.get("id") or "", venue.get("name") or "").lower()
        matched = next((token for token in forbidden if token in value), None)
        if matched:
            raise ModelError(
                "target_venue 包含疑似结果字段 {!r}（case_id={}），拒绝训练以防标签泄漏。".format(
                    matched, row.get("case_id")
                )
            )


def train_model(rows, learning_rate=0.05, epochs=1600, l2=0.02, low_threshold=0.35, high_threshold=0.65, feature_mode="review"):
    if feature_mode not in ("review", "score"):
        raise ModelError("未知特征模式：{}。".format(feature_mode))
    source_key = "review" if feature_mode == "review" else "score"
    usable = [row for row in rows if row.get(source_key) and row.get("decision_label") in (0, 1)]
    by_split = {
        split: [row for row in usable if row.get("split") == split]
        for split in ("train", "validation", "test")
    }
    if not by_split["train"]:
        raise ModelError("没有可用的 train 样本。")
    if len(set(int(row["decision_label"]) for row in by_split["train"])) < 2:
        raise ModelError("train 样本必须同时包含 accept 和 reject。")
    _assert_no_target_venue_leakage(usable)
    if feature_mode == "review":
        signatures = {_review_signature(row["review"]) for row in usable}
    else:
        signatures = {_trace_signature(row.get("model_trace")) for row in usable}
    if len(signatures) != 1:
        raise ModelError("检测到多个审稿模型版本；请使用同一冻结审稿模型重新生成特征。")

    global_prior = sum(int(row["decision_label"]) for row in by_split["train"]) / len(
        by_split["train"]
    )
    venue_support = {}
    for row in by_split["train"]:
        key = _venue_key(row.get("target_venue"))
        venue_support[key] = venue_support.get(key, 0) + 1

    if feature_mode == "score":
        feature_names = list(SCORE_FEATURE_NAMES)
        feature_contract_version = "2.0.0"

        def raw_vector(row):
            return vectorize_score(extract_score_feature_dict(row["score"]))
    else:
        feature_names = list(FEATURE_NAMES)
        feature_contract_version = "1.1.0"

        def raw_vector(row):
            values = extract_feature_dict(row["manuscript"], row["target_venue"], row["review"])
            return vectorize(values)

    train_vectors = [raw_vector(row) for row in by_split["train"]]
    train_labels = [int(row["decision_label"]) for row in by_split["train"]]
    means, scales = _means_scales(train_vectors)
    standardized = [_standardize(vector, means, scales) for vector in train_vectors]
    weights, bias = _fit_logistic(
        standardized, train_labels, learning_rate=learning_rate, epochs=epochs, l2=l2
    )

    def logits(split_rows):
        return [
            _dot(weights, _standardize(raw_vector(row), means, scales)) + bias
            for row in split_rows
        ]

    validation_logits = logits(by_split["validation"])
    validation_labels = [int(row["decision_label"]) for row in by_split["validation"]]
    calibrator = _fit_platt(validation_logits, validation_labels)

    def probabilities(split_rows):
        return [
            sigmoid(calibrator["slope"] * value + calibrator["intercept"])
            for value in logits(split_rows)
        ]

    split_metrics = {}
    baseline_metrics = {}
    for split, split_rows in by_split.items():
        split_labels = [int(row["decision_label"]) for row in split_rows]
        split_metrics[split] = metrics(
            probabilities(split_rows),
            split_labels,
        )
        baseline_metrics[split] = metrics(
            [global_prior] * len(split_rows),
            split_labels,
        )
    created_at = datetime.now(timezone.utc).isoformat()
    payload = {
        "model_schema_version": "1.1.0",
        "model_type": "standardized_logistic_regression_with_platt_calibration",
        "created_at": created_at,
        "training_objective": "P(accept | initial manuscript, target venue, frozen reviewer output)",
        "forbidden_features": ["human_review_score", "meta_review", "decision_text", "author_identity"],
        "feature_contract_version": feature_contract_version,
        "feature_names": feature_names,
        "means": means,
        "scales": scales,
        "weights": weights,
        "bias": bias,
        "calibrator": calibrator,
        "thresholds": {"reject_max": low_threshold, "accept_min": high_threshold},
        "global_prior": global_prior,
        "venue_support": venue_support,
        "reviewer_signature": next(iter(signatures)),
        "metrics": split_metrics,
        "historical_rate_baseline_metrics": baseline_metrics,
        "sample_counts": {key: len(value) for key, value in by_split.items()},
    }
    stable = json.dumps(payload, sort_keys=True, ensure_ascii=True).encode("utf-8")
    payload["model_id"] = "acceptance-logistic-" + hashlib.sha256(stable).hexdigest()[:12]
    return payload


class AcceptancePredictor:
    def __init__(self, model):
        self.model = model
        if model.get("model_schema_version") != "1.1.0":
            raise ModelError("不支持的录用预测模型版本。")
        contract = model.get("feature_contract_version")
        if contract == "2.0.0":
            self.feature_contract = "score"
            if tuple(model.get("feature_names") or []) != SCORE_FEATURE_NAMES:
                raise ModelError("录用预测模型的特征协议与当前 score 契约不一致。")
        elif contract in (None, "1.1.0"):
            self.feature_contract = "review"
            if tuple(model.get("feature_names") or []) != FEATURE_NAMES:
                raise ModelError("录用预测模型的特征协议与当前代码不一致。")
        else:
            raise ModelError("不支持的录用预测特征契约版本：{}。".format(contract))

    @classmethod
    def load(cls, path):
        with pathlib.Path(path).open("r", encoding="utf-8") as handle:
            return cls(json.load(handle))

    def info(self):
        return {
            "model_id": self.model["model_id"],
            "model_type": self.model["model_type"],
            "feature_contract_version": self.model["feature_contract_version"],
            "reviewer_signature": self.model["reviewer_signature"],
            "calibration_method": self.model["calibrator"]["method"],
        }

    def _confidence(self, venue_support):
        validation = self.model.get("metrics", {}).get("validation", {})
        ece = validation.get("ece_10_bin")
        validation_count = int(validation.get("count") or 0)
        if venue_support >= 100 and validation_count >= 200 and ece is not None and ece <= 0.05:
            return "high"
        if venue_support >= 30 and validation_count >= 50 and ece is not None and ece <= 0.12:
            return "medium"
        return "low"

    def _predict_common(self, target_venue, raw, positive, risks):
        key = _venue_key(target_venue)
        venue_support = int(self.model["venue_support"].get(key, 0))
        standardized = _standardize(raw, self.model["means"], self.model["scales"])
        raw_logit = _dot(self.model["weights"], standardized) + self.model["bias"]
        calibrator = self.model["calibrator"]
        probability = sigmoid(calibrator["slope"] * raw_logit + calibrator["intercept"])
        thresholds = self.model["thresholds"]
        if probability >= thresholds["accept_min"]:
            prediction = "accept"
        elif probability <= thresholds["reject_max"]:
            prediction = "reject"
        else:
            prediction = "borderline"
        warnings = []
        if not venue_support:
            warnings.append("目标期刊未出现在训练集中，属于分布外目标期刊。")
        if venue_support < 30:
            warnings.append("该期刊的训练样本较少，概率仅供低置信度参考。")
        return {
            "prediction_schema_version": "1.0.0",
            "prediction": prediction,
            "acceptance_probability": round(probability, 6),
            "confidence_level": self._confidence(venue_support),
            "target_venue": {
                "id": target_venue.get("id"),
                "name": target_venue["name"],
            },
            "main_positive_factors": positive,
            "main_risk_factors": risks,
            "uncertainty_reasons": warnings,
            "calibration": {
                "method": calibrator["method"],
                "validation_sample_count": self.model.get("metrics", {}).get("validation", {}).get("count", 0),
                "validation_brier_score": self.model.get("metrics", {}).get("validation", {}).get("brier_score"),
                "validation_ece": self.model.get("metrics", {}).get("validation", {}).get("ece_10_bin"),
                "venue_training_sample_count": venue_support,
                "out_of_distribution_venue": not bool(venue_support),
            },
            "model_trace": self.info(),
            "disclaimer": "该结果是基于历史数据的校准估计，不是目标期刊的真实编辑决定。",
        }

    def predict(self, manuscript, target_venue, review):
        signature = _review_signature(review)
        if signature != self.model["reviewer_signature"]:
            raise ModelError("审稿输出模型版本与录用预测模型训练版本不一致。")
        raw = vectorize(extract_feature_dict(manuscript, target_venue, review))
        positive, risks = explanation_factors(review)
        return self._predict_common(target_venue, raw, positive, risks)

    def predict_from_score(self, manuscript, target_venue, score, model_trace):
        if self.feature_contract != "score":
            raise ModelError("录用预测模型不是 score 特征契约。")
        # The score contract derives features from the score object only; the
        # manuscript body is kept in the signature for venue-conditioned
        # semantics and any future length-aware feature.
        signature = _trace_signature(model_trace)
        if signature != self.model["reviewer_signature"]:
            raise ModelError("评分输出模型版本与录用预测模型训练版本不一致。")
        raw = vectorize_score(extract_score_feature_dict(score))
        positive, risks = score_factors(score)
        return self._predict_common(target_venue, raw, positive, risks)
