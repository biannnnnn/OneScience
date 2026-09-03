#!/usr/bin/env python3
"""Build a leakage-controlled full-text evidence dataset from ProReview parquet.

The generated model input deliberately excludes authors, affiliations, venue names,
citations, reviews, meta-reviews, and decisions. Venue/year and decisions are kept
only as grouping/evaluation columns and are never placed in the evidence text.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from collections import Counter
from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd


FIELD_LABELS = (
    "[ABSTRACT]",
    "[RESEARCH QUESTION AND MAIN CONTRIBUTIONS]",
    "[EXPERIMENTAL SETUP AND DATASETS]",
    "[KEY FINDINGS AND CONCLUSION]",
)
EXCLUDED_MODEL_FIELDS = (
    "authors",
    "affiliations",
    "venue",
    "venueid",
    "citations",
    "references",
    "reviews",
    "meta_review",
    "decision",
)
SKIP_HEADINGS = re.compile(
    r"\b(reference|bibliograph|acknowledg|appendix|supplement|broader impact|"
    r"reproducibility|checklist|author contribution)\b",
    re.I,
)
CITATION_RE = re.compile(
    r"\[(?:\d{1,3}(?:\s*[,;\-]\s*\d{1,3})*)\]|"
    r"\((?:[A-Z][A-Za-z'`-]+(?:\s+et\s+al\.)?(?:,?\s+\d{4}[a-z]?)"
    r"(?:\s*;\s*)?)+\)"
)
AUTHOR_YEAR_RE = re.compile(
    r"\b(?:[A-Z][A-Za-z'`-]+\s+et\s+al\.|"
    r"[A-Z][A-Za-z'`-]+(?:\s+(?:and|&)\s+[A-Z][A-Za-z'`-]+)?)"
    r"\s*\((?:19|20)\d{2}[a-z]?\)",
)
URL_RE = re.compile(r"https?://\S+|www\.\S+", re.I)
LATEX_RE = re.compile(r"\$+[^$]{1,500}\$+|\\(?:cite|ref|label)\{[^}]*\}")
SENTENCE_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9])|\n+")

RQ_KEYWORDS = (
    "we propose", "we present", "we introduce", "we develop", "we study",
    "we investigate", "our contribution", "our method", "this paper",
    "research question", "challenge", "aim", "objective", "problem",
)
EXPERIMENT_KEYWORDS = (
    "experiment", "evaluation", "dataset", "benchmark", "baseline", "training",
    "implementation", "hyperparameter", "metric", "split", "ablation", "sample",
)
FINDING_KEYWORDS = (
    "result", "outperform", "improve", "achieve", "demonstrate", "show that",
    "find that", "conclude", "conclusion", "significant", "limitation",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train-parquet", required=True)
    parser.add_argument("--test-parquet", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--abstract-chars", type=int, default=850)
    parser.add_argument("--question-chars", type=int, default=800)
    parser.add_argument("--experiment-chars", type=int, default=1100)
    parser.add_argument("--finding-chars", type=int, default=650)
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def as_mapping(value: object) -> dict:
    if isinstance(value, dict):
        return value
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return {}
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    try:
        return dict(value)  # pyarrow struct-like values
    except (TypeError, ValueError):
        return {}


def normalize_space(value: object) -> str:
    text = str(value or "").replace("\u00ad", "").replace("\u00a0", " ")
    return re.sub(r"\s+", " ", text).strip()


def clean_evidence(value: object) -> str:
    text = str(value or "")
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = re.sub(r"!\[[^]]*\]\([^)]*\)", " ", text)
    text = re.sub(r"\[([^]]+)\]\([^)]*\)", r"\1", text)
    text = URL_RE.sub(" ", text)
    text = LATEX_RE.sub(" ", text)
    text = CITATION_RE.sub(" ", text)
    text = AUTHOR_YEAR_RE.sub(" ", text)
    text = re.sub(r"\|[-: |]+\|", " ", text)
    text = re.sub(r"[*_~`]", "", text)
    return normalize_space(text)


def parse_sections(markdown: str) -> list[tuple[str, str]]:
    """Parse Markdown headings and ignore all front matter before the first heading."""
    matches = list(re.finditer(r"(?m)^\s{0,3}#{1,6}\s+(.+?)\s*$", markdown))
    sections: list[tuple[str, str]] = []
    for index, match in enumerate(matches):
        heading = clean_evidence(match.group(1))
        end = matches[index + 1].start() if index + 1 < len(matches) else len(markdown)
        if heading and not SKIP_HEADINGS.search(heading):
            body = clean_evidence(markdown[match.end():end])
            if body:
                sections.append((heading, body))
    return sections


def section_text(sections: list[tuple[str, str]], heading_pattern: str) -> str:
    pattern = re.compile(heading_pattern, re.I)
    return " ".join(body for heading, body in sections if pattern.search(heading))


def sentences(text: str) -> list[str]:
    return [clean_evidence(item) for item in SENTENCE_RE.split(text) if len(clean_evidence(item)) >= 20]


def select_sentences(text: str, keywords: Iterable[str], char_budget: int) -> str:
    candidates = sentences(text)
    if not candidates:
        return clean_evidence(text)[:char_budget].rstrip()
    lowered_keywords = tuple(keyword.lower() for keyword in keywords)
    scored: list[tuple[int, int, str]] = []
    for index, sentence in enumerate(candidates):
        lower = sentence.lower()
        score = sum(2 if " " in keyword else 1 for keyword in lowered_keywords if keyword in lower)
        if index < 3:
            score += 1
        scored.append((score, index, sentence))
    selected: list[tuple[int, str]] = []
    used = 0
    for score, index, sentence in sorted(scored, key=lambda item: (-item[0], item[1])):
        if score <= 0 and selected:
            continue
        remaining = char_budget - used
        if remaining <= 0:
            break
        snippet = sentence if len(sentence) <= remaining else sentence[:remaining].rsplit(" ", 1)[0]
        if snippet:
            selected.append((index, snippet))
            used += len(snippet) + 1
    return " ".join(sentence for _, sentence in sorted(selected))[:char_budget].rstrip()


def first_nonempty(*values: str) -> str:
    return next((value for value in values if normalize_space(value)), "")


def extract_fields(markdown_value: object, budgets: dict[str, int]) -> dict[str, str]:
    markdown = as_mapping(markdown_value)
    content = str(markdown.get("content") or "")
    sections = parse_sections(content)
    abstract_source = section_text(sections, r"\babstract\b")
    intro = section_text(sections, r"\b(introduction|motivation|overview)\b")
    experiments = section_text(
        sections,
        r"\b(experiment|evaluation|empirical|dataset|data|benchmark|implementation|methodology)\b",
    )
    findings = section_text(sections, r"\b(result|discussion|conclusion|finding|limitation)\b")
    all_allowed = " ".join(body for _, body in sections)
    abstract = select_sentences(first_nonempty(abstract_source, intro, all_allowed), (), budgets["abstract"])
    question = select_sentences(first_nonempty(intro, abstract_source, all_allowed), RQ_KEYWORDS, budgets["question"])
    experiment = select_sentences(first_nonempty(experiments, all_allowed), EXPERIMENT_KEYWORDS, budgets["experiment"])
    finding = select_sentences(first_nonempty(findings, experiments, abstract_source), FINDING_KEYWORDS, budgets["finding"])
    return {
        "abstract_only": abstract,
        "research_question_contributions": question,
        "experimental_setup_datasets": experiment,
        "key_findings_conclusion": finding,
    }


def parse_numbers(value: object) -> list[float]:
    if isinstance(value, (list, tuple, np.ndarray)):
        raw = value
    else:
        raw = re.split(r"[;,|\s]+", str(value or "").strip())
    numbers = []
    for item in raw:
        try:
            number = float(item)
            if math.isfinite(number):
                numbers.append(number)
        except (TypeError, ValueError):
            continue
    return numbers


def confidence_weighted_rating(scores_value: object) -> tuple[float | None, list[float], list[float]]:
    scores = as_mapping(scores_value)
    ratings = parse_numbers(scores.get("rating"))
    confidences = parse_numbers(scores.get("confidence"))
    if ratings and len(confidences) == len(ratings) and sum(confidences) > 0:
        return float(np.average(ratings, weights=confidences)), ratings, confidences
    if ratings:
        return float(np.mean(ratings)), ratings, confidences
    try:
        fallback = float(scores.get("rating_avg"))
        return (fallback, [], []) if math.isfinite(fallback) else (None, [], [])
    except (TypeError, ValueError):
        return None, [], []


def normalize_identity(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", "", normalize_space(value).lower())


def decision_label(value: object) -> int:
    decision = normalize_space(as_mapping(value).get("decision")).lower()
    if not decision:
        return -1
    if "reject" in decision or "withdraw" in decision:
        return 0
    if "accept" in decision:
        return 1
    return -1


def prepare_frame(frame: pd.DataFrame, budgets: dict[str, int]) -> tuple[pd.DataFrame, Counter]:
    records = []
    dropped = Counter()
    for source_index, source in frame.iterrows():
        title = clean_evidence(source.get("title"))
        rating, ratings, confidences = confidence_weighted_rating(source.get("scores"))
        fields = extract_fields(source.get("markdown"), budgets)
        if not title or rating is None:
            dropped["missing_title_or_rating"] += 1
            continue
        if any(not fields[key] for key in fields):
            dropped["incomplete_evidence"] += 1
            continue
        metadata = as_mapping(source.get("metadata"))
        venue_id = normalize_space(metadata.get("venueid")) or "unknown-group"
        # OpenReview sometimes appends outcome-like paths such as
        # /Rejected_Submission. Strip them so pair construction cannot depend on
        # the decision, even indirectly.
        venue_group = re.sub(r"(/Conference)(?:/.*)?$", r"\1", venue_id, flags=re.I)
        year_match = re.search(r"(?:19|20)\d{2}", venue_group)
        year = int(year_match.group()) if year_match else 0
        paper_id = normalize_space(source.get("paper_id")) or f"row-{source_index}"
        arxiv_id = normalize_space(source.get("arxiv_id"))
        evidence = "\n".join(
            (
                FIELD_LABELS[0], fields["abstract_only"],
                FIELD_LABELS[1], fields["research_question_contributions"],
                FIELD_LABELS[2], fields["experimental_setup_datasets"],
                FIELD_LABELS[3], fields["key_findings_conclusion"],
            )
        )
        records.append({
            "source_paper_id": paper_id,
            "arxiv_id": arxiv_id,
            "title": title,
            "abstract": evidence,
            **fields,
            "RTS": round(rating, 6),
            "accept": decision_label(source.get("decision")),
            "pub_year": year,
            "cluster_cat": venue_group,
            "scores": ";".join(f"{item:g}" for item in ratings),
            "confs": ";".join(f"{item:g}" for item in confidences),
        })
    result = pd.DataFrame(records)
    if result.empty:
        raise ValueError("No usable papers were produced")
    result.insert(0, "id", np.arange(len(result), dtype=int))
    return result, dropped


def frame_stats(frame: pd.DataFrame) -> dict:
    text_columns = [
        "abstract_only", "research_question_contributions",
        "experimental_setup_datasets", "key_findings_conclusion", "abstract",
    ]
    known_accept = frame["accept"].isin([0, 1])
    return {
        "rows": int(len(frame)),
        "rating": {
            "min": float(frame["RTS"].min()),
            "median": float(frame["RTS"].median()),
            "mean": float(frame["RTS"].mean()),
            "max": float(frame["RTS"].max()),
        },
        "accept_known": int(known_accept.sum()),
        "accept_rate": float(frame.loc[known_accept, "accept"].mean()) if known_accept.any() else None,
        "groups": int(frame[["pub_year", "cluster_cat"]].drop_duplicates().shape[0]),
        "text_chars": {
            column: {
                "median": int(frame[column].str.len().median()),
                "p95": int(frame[column].str.len().quantile(0.95)),
                "max": int(frame[column].str.len().max()),
            }
            for column in text_columns
        },
    }


def main() -> None:
    args = parse_args()
    train_path = Path(args.train_parquet).resolve()
    test_path = Path(args.test_parquet).resolve()
    output_dir = Path(args.output_dir).resolve()
    budgets = {
        "abstract": args.abstract_chars,
        "question": args.question_chars,
        "experiment": args.experiment_chars,
        "finding": args.finding_chars,
    }
    train, train_dropped = prepare_frame(pd.read_parquet(train_path), budgets)
    test, test_dropped = prepare_frame(pd.read_parquet(test_path), budgets)

    test_titles = {normalize_identity(value) for value in test["title"]}
    test_arxiv = {normalize_identity(value) for value in test["arxiv_id"] if normalize_identity(value)}
    overlap_mask = train.apply(
        lambda row: normalize_identity(row["title"]) in test_titles
        or bool(normalize_identity(row["arxiv_id"]) and normalize_identity(row["arxiv_id"]) in test_arxiv),
        axis=1,
    )
    overlap_removed = int(overlap_mask.sum())
    train = train.loc[~overlap_mask].reset_index(drop=True)
    train["id"] = np.arange(len(train), dtype=int)
    test = test.reset_index(drop=True)
    test["id"] = np.arange(len(test), dtype=int)

    output_dir.mkdir(parents=True, exist_ok=True)
    train_csv = output_dir / "proreview-train.csv"
    test_csv = output_dir / "proreview-test.csv"
    train.to_csv(train_csv, index=False)
    test.to_csv(test_csv, index=False)
    audit_columns = [
        "source_paper_id", "title", "abstract_only", "research_question_contributions",
        "experimental_setup_datasets", "key_findings_conclusion", "RTS",
    ]
    test[audit_columns].head(20).to_json(
        output_dir / "audit-sample.jsonl", orient="records", lines=True, force_ascii=False,
    )
    manifest = {
        "schema_version": "1.0.0",
        "dataset": "ProReview full-text evidence Ranker",
        "seed": args.seed,
        "target": "confidence-weighted reviewer overall rating; unweighted mean fallback",
        "model_input_columns": ["title", "abstract"],
        "evidence_fields": list(FIELD_LABELS),
        "excluded_model_fields": list(EXCLUDED_MODEL_FIELDS),
        "grouping_only_columns": ["pub_year", "cluster_cat"],
        "evaluation_only_columns": ["accept"],
        "budgets_chars": budgets,
        "overlap_removed_from_train": overlap_removed,
        "train_dropped": dict(train_dropped),
        "test_dropped": dict(test_dropped),
        "train": frame_stats(train),
        "test": frame_stats(test),
        "source_hashes": {
            "train_parquet": sha256_file(train_path),
            "test_parquet": sha256_file(test_path),
        },
        "output_hashes": {
            "proreview-train.csv": sha256_file(train_csv),
            "proreview-test.csv": sha256_file(test_csv),
        },
        "interpretation": (
            "Scores measure agreement with held-out reviewer ratings and decisions. "
            "They are not objective paper quality or acceptance probabilities."
        ),
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
