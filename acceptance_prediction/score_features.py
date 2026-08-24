"""Deterministic features for the venue-score acceptance prediction layer.

This is the 7-dimension score contract (feature_contract_version 2.0.0). It
consumes a single venue-conditioned score object from the Reviewer Service
(``/v1/venue-scores``), not a full structured review. Human scores, meta-reviews
and final decisions must never be passed into this module as inference features.
"""


SCORE_DIMENSIONS = (
    "originality",
    "rigor",
    "evidence",
    "clarity",
    "reproducibility",
    "venue_fit",
    "overall",
)

SCORE_FEATURE_NAMES = tuple(list(SCORE_DIMENSIONS) + ["confidence"])


def _clamp(value, lower=0.0, upper=1.0):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return lower
    return min(upper, max(lower, number))


def extract_score_feature_dict(score):
    """Return the flat score feature vector from a single venue-score object.

    Only the seven venue-conditioned dimensions (scaled into [0, 1]) and the
    model's own confidence are used. The manuscript body and target-venue
    metadata are intentionally excluded so that training and inference consume
    the exact same representation.
    """
    features = {}
    for dimension in SCORE_DIMENSIONS:
        features[dimension] = _clamp(score.get(dimension), 0.0, 100.0) / 100.0
    features["confidence"] = _clamp(score.get("confidence"))
    return features


def vectorize_score(features, names=SCORE_FEATURE_NAMES):
    return [float(features.get(name, 0.0)) for name in names]


def score_factors(score):
    """Produce deterministic, score-grounded factors without inventing causality."""
    positive = []
    risks = []
    for item in (score.get("strengths") or [])[:3]:
        point = str(item or "").strip()
        if point:
            positive.append(point)
    for item in (score.get("risks") or [])[:4]:
        risk = str(item or "").strip()
        if risk:
            risks.append(risk)
    return positive, risks
