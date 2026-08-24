"""Deterministic features for the acceptance prediction layer.

Only manuscript text, target-venue metadata and output from a frozen reviewer are
accepted here. Human scores, meta-reviews and final decisions must never be
passed into this module as inference features.
"""

import math


VERDICTS = (
    "ready_for_submission",
    "minor_revision",
    "major_revision",
    "fundamental_revision",
    "insufficient_evidence",
)
CATEGORIES = (
    "research_question",
    "contribution_novelty",
    "scope_relevance",
    "related_work",
    "methodology",
    "experimental_design",
    "data_quality",
    "statistical_analysis",
    "results_interpretation",
    "conclusion_support",
    "reproducibility",
    "ethics_compliance",
    "limitations",
    "writing_clarity",
    "structure",
    "figures_tables",
    "references",
    "other",
)
PRIORITIES = ("critical", "high", "medium", "low")


BASE_FEATURE_NAMES = (
    "manuscript_log_characters",
    "manuscript_log_paragraphs",
    "manuscript_log_sections",
    "recommendation_confidence",
    "central_contribution_present",
    "central_contribution_confidence",
    "strength_count",
    "strength_confidence_mean",
    "major_concern_count",
    "minor_concern_count",
    "concern_confidence_mean",
    "question_count",
    "revision_task_count",
    "evidence_grounded_ratio",
    "evidence_direct_quote_ratio",
)
FEATURE_NAMES = tuple(
    list(BASE_FEATURE_NAMES)
    + ["verdict_{}".format(item) for item in VERDICTS]
    + ["major_category_{}".format(item) for item in CATEGORIES]
    + ["minor_category_{}".format(item) for item in CATEGORIES]
    + ["task_priority_{}".format(item) for item in PRIORITIES]
)


def clamp(value, lower=0.0, upper=1.0):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return lower
    return min(upper, max(lower, number))


def _locations(evidence):
    if not isinstance(evidence, dict):
        return []
    if evidence.get("type") == "direct_quote":
        return [evidence]
    if evidence.get("type") == "cross_section":
        values = evidence.get("locations")
        return values if isinstance(values, list) else []
    return []


def _all_evidence(review):
    result = []
    central = review.get("central_contribution") or {}
    result.extend(central.get("evidence") or [])
    for key in ("strengths", "major_concerns", "minor_concerns"):
        for item in review.get(key) or []:
            result.extend(item.get("evidence") or [])
    return result


def evidence_metrics(review, manuscript):
    paragraphs = {
        item.get("paragraph_id"): item
        for item in manuscript.get("paragraphs") or []
        if item.get("paragraph_id")
    }
    sections = {item.get("section") for item in paragraphs.values()}
    checked = 0
    grounded = 0
    direct = 0
    evidence_items = _all_evidence(review)
    for evidence in evidence_items:
        if evidence.get("type") == "absence":
            checked += 1
            searched = evidence.get("searched_sections") or []
            if searched and all(section in sections for section in searched):
                grounded += 1
            continue
        locations = _locations(evidence)
        if not locations:
            checked += 1
            continue
        for location in locations:
            checked += 1
            if evidence.get("type") == "direct_quote":
                direct += 1
            paragraph = paragraphs.get(location.get("paragraph_id"))
            excerpt = location.get("excerpt")
            if (
                paragraph
                and paragraph.get("section") == location.get("section")
                and isinstance(excerpt, str)
                and excerpt
                and excerpt in paragraph.get("text", "")
            ):
                grounded += 1
    return {
        "checked": checked,
        "grounded_ratio": grounded / checked if checked else 0.0,
        "direct_quote_ratio": direct / checked if checked else 0.0,
    }


def _mean(values):
    numeric = [clamp(value) for value in values if value is not None]
    return sum(numeric) / len(numeric) if numeric else 0.0


def extract_feature_dict(manuscript, target_venue, review, venue_prior=None):
    """Return the frozen, versioned feature contract as a flat dictionary."""
    paragraphs = manuscript.get("paragraphs") or []
    characters = sum(len(str(item.get("text") or "")) for item in paragraphs)
    sections = {str(item.get("section") or "") for item in paragraphs}
    strengths = review.get("strengths") or []
    major = review.get("major_concerns") or []
    minor = review.get("minor_concerns") or []
    concerns = major + minor
    tasks = review.get("revision_tasks") or []
    central = review.get("central_contribution") or {}
    evidence = evidence_metrics(review, manuscript)
    recommendation = review.get("recommendation") or {}

    features = {
        "manuscript_log_characters": math.log1p(characters),
        "manuscript_log_paragraphs": math.log1p(len(paragraphs)),
        "manuscript_log_sections": math.log1p(len(sections)),
        "recommendation_confidence": clamp(recommendation.get("confidence")),
        "central_contribution_present": 1.0 if central else 0.0,
        "central_contribution_confidence": clamp(central.get("confidence")),
        "strength_count": float(len(strengths)),
        "strength_confidence_mean": _mean(item.get("confidence") for item in strengths),
        "major_concern_count": float(len(major)),
        "minor_concern_count": float(len(minor)),
        "concern_confidence_mean": _mean(item.get("confidence") for item in concerns),
        "question_count": float(len(review.get("questions") or [])),
        "revision_task_count": float(len(tasks)),
        "evidence_grounded_ratio": evidence["grounded_ratio"],
        "evidence_direct_quote_ratio": evidence["direct_quote_ratio"],
    }
    verdict = recommendation.get("verdict")
    for item in VERDICTS:
        features["verdict_{}".format(item)] = 1.0 if verdict == item else 0.0
    for category in CATEGORIES:
        features["major_category_{}".format(category)] = float(
            sum(1 for item in major if item.get("category") == category)
        )
        features["minor_category_{}".format(category)] = float(
            sum(1 for item in minor if item.get("category") == category)
        )
    for priority in PRIORITIES:
        features["task_priority_{}".format(priority)] = float(
            sum(1 for item in tasks if item.get("priority") == priority)
        )
    return features


def vectorize(features, names=FEATURE_NAMES):
    return [float(features.get(name, 0.0)) for name in names]


def explanation_factors(review):
    """Produce deterministic, review-grounded factors without inventing causality."""
    positive = []
    risks = []
    strengths = review.get("strengths") or []
    for item in sorted(strengths, key=lambda value: clamp(value.get("confidence")), reverse=True)[:3]:
        point = str(item.get("point") or "").strip()
        if point:
            positive.append(point)
    concerns = [
        ("major", item) for item in review.get("major_concerns") or []
    ] + [
        ("minor", item) for item in review.get("minor_concerns") or []
    ]
    concerns.sort(
        key=lambda pair: (pair[0] != "major", -clamp(pair[1].get("confidence")))
    )
    for _, item in concerns[:4]:
        problem = str(item.get("problem") or "").strip()
        if problem:
            risks.append(problem)
    return positive, risks
