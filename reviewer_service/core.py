"""Shared prompt and review assembly helpers for Reviewer Service backends."""

import copy
import importlib.util
import pathlib
import uuid


PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent
BASELINE_RUNNER = PROJECT_ROOT / "scripts" / "reviewer-baseline" / "run_mlx.py"


def _load_baseline_core():
    spec = importlib.util.spec_from_file_location("onescience_reviewer_baseline_core", BASELINE_RUNNER)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载共享审稿 Prompt。")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_BASELINE = _load_baseline_core()


def build_request_context(request, model_config):
    """Convert a service request to the frozen baseline prompt contract."""
    case_id = request.get("request_id") or request["manuscript"].get("paper_id") or str(uuid.uuid4())
    case = {
        "case_id": case_id,
        "manuscript": request["manuscript"],
    }
    effective_config = copy.deepcopy(model_config)
    effective_config["review_language"] = request["review_language"]
    messages, coverage = _BASELINE.build_messages(case, effective_config)
    venue = request.get("target_venue")
    if request["review_type"] == "venue_conditioned" and venue:
        venue_lines = ["目标期刊：{}".format(venue["name"])]
        if venue.get("scope"):
            venue_lines.append("期刊范围：{}".format(venue["scope"]))
        requirements = venue.get("requirements") or []
        if requirements:
            venue_lines.append("投稿要求：{}".format("；".join(requirements)))
        messages[1]["content"] += "\n\n" + "\n".join(venue_lines)
    return case, effective_config, messages, coverage


def parse_json_output(text):
    return _BASELINE.parse_json_output(text)


def _normalized_location(value):
    if not isinstance(value, dict):
        return None
    location = {
        key: value.get(key)
        for key in ("section", "paragraph_id", "excerpt")
    }
    if not all(isinstance(item, str) and item for item in location.values()):
        return None
    return location


def normalize_review_evidence(review):
    """Apply narrow, deterministic repairs to evidence representation only.

    A model occasionally emits a one-location ``cross_section`` item. Its
    semantics are a direct quote, so downgrade it without changing any text.
    Unknown or empty evidence remains untouched and will still fail Schema
    validation instead of being silently invented.
    """
    for key in ("central_contribution", "strengths", "major_concerns", "minor_concerns"):
        values = review.get(key)
        owners = values if isinstance(values, list) else ([values] if isinstance(values, dict) else [])
        for owner in owners:
            evidence_list = owner.get("evidence")
            if not isinstance(evidence_list, list):
                continue
            owner_description = str(
                owner.get("problem") or owner.get("point") or owner.get("claim") or ""
            ).strip()
            normalized = []
            for evidence in evidence_list:
                if not isinstance(evidence, dict):
                    normalized.append(evidence)
                    continue
                evidence_type = evidence.get("type")
                if evidence_type == "direct_quote":
                    normalized.append({
                        key: evidence.get(key)
                        for key in ("type", "section", "paragraph_id", "excerpt")
                    })
                elif evidence_type == "absence":
                    description = str(evidence.get("description") or "").strip()
                    if len(description) < 5 and len(owner_description) >= 5:
                        description = owner_description[:1000]
                    searched_sections = list(dict.fromkeys(
                        item for item in evidence.get("searched_sections") or []
                        if isinstance(item, str) and item
                    ))[:20]
                    normalized.append({
                        "type": "absence",
                        "description": description,
                        "searched_sections": searched_sections,
                    })
                elif evidence_type == "cross_section":
                    locations = [
                        location
                        for location in (
                            _normalized_location(item) for item in evidence.get("locations") or []
                        )
                        if location is not None
                    ]
                    if len(locations) == 1:
                        normalized.append({"type": "direct_quote", **locations[0]})
                    elif len(locations) >= 2:
                        description = str(evidence.get("description") or "").strip()
                        if len(description) < 5 and len(owner_description) >= 5:
                            description = owner_description[:1000]
                        normalized.append({
                            "type": "cross_section",
                            "description": description,
                            "locations": locations[:5],
                        })
                    else:
                        normalized.append(evidence)
                else:
                    normalized.append(evidence)
            owner["evidence"] = normalized
    return review


def render_prompt(tokenizer, messages):
    return _BASELINE.render_prompt(tokenizer, messages)


def assemble_review(request, case, parsed, coverage, model_config, latency_ms, trace):
    review = _BASELINE.make_review(case, parsed, coverage, model_config, latency_ms)
    if review is None:
        return None
    manuscript = request["manuscript"]
    venue = request.get("target_venue")
    review["review_id"] = "review-{}".format(uuid.uuid4())
    review["review_type"] = request["review_type"]
    review["review_language"] = request["review_language"]
    review["manuscript"]["paper_id"] = manuscript.get("paper_id")
    review["manuscript"]["fingerprint"] = manuscript.get("fingerprint")
    review["target_venue"] = None if venue is None else {
        key: venue.get(key) for key in ("id", "name", "scope_source", "scope_checked_at")
        if key in venue
    }
    review["model_trace"].update(trace)
    return normalize_review_evidence(review)
