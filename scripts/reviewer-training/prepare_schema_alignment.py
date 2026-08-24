#!/usr/bin/env python3
"""Build high-precision weakly supervised review-schema alignment examples."""

import argparse
import collections
import json
import math
import pathlib
import re

import pyarrow.parquet as parquet

from prepare_proreview import redact, split_review_items, stable_validation


SCHEMA_ALIGNMENT_PROMPT = """You are a rigorous pre-submission reviewer. Return only one JSON object with exactly these top-level keys: recommendation, summary, central_contribution, strengths, major_concerns, minor_concerns, questions, revision_tasks, limitations. Arrays must always be JSON arrays, especially limitations. Evidence must be {"type":"direct_quote","section":"...","paragraph_id":"exact input id","excerpt":"exact input quote"}. Use only supplied paragraphs; do not predict acceptance or invent evidence."""

STOPWORDS = {
    "about", "after", "also", "although", "among", "another", "authors", "because", "been",
    "before", "being", "between", "both", "could", "does", "from", "have", "however", "into",
    "more", "most", "much", "paper", "provide", "results", "review", "should", "some", "such",
    "than", "that", "their", "there", "these", "they", "this", "through", "using", "very",
    "what", "when", "where", "which", "while", "with", "would", "work", "method", "approach",
    "unclear", "missing", "limited", "lack", "needs", "need", "please", "question", "concern",
}

CATEGORY_RULES = (
    ("statistical_analysis", r"statistic|significan|confidence interval|variance|error bar"),
    ("reproducibility", r"reproduc|code|hyperparameter|implementation detail|random seed"),
    ("related_work", r"related work|prior work|citation|literature|reference"),
    ("figures_tables", r"figure|table|caption|axis|plot"),
    ("writing_clarity", r"writing|unclear|readability|presentation|typo|grammar|explain"),
    ("data_quality", r"dataset|data quality|sample size|annotation|label"),
    ("experimental_design", r"experiment|evaluation|baseline|ablation|benchmark|metric"),
    ("conclusion_support", r"conclusion|claim|overclaim|support|evidence"),
    ("methodology", r"method|algorithm|objective|assumption|theory|proof|model"),
)

IMPACT = {
    "writing_clarity": "The current presentation prevents readers from verifying the intended technical meaning.",
    "related_work": "The missing comparison makes the novelty and scope of the contribution difficult to assess.",
    "figures_tables": "The current visual presentation makes the reported evidence difficult to interpret reliably.",
    "experimental_design": "This limits whether the reported empirical advantage can support the central claim.",
    "statistical_analysis": "This prevents readers from judging uncertainty and the robustness of the reported result.",
    "data_quality": "This creates uncertainty about whether the evidence generalizes beyond the evaluated data.",
    "reproducibility": "This prevents an independent reader from reproducing and checking the reported result.",
    "conclusion_support": "The stated conclusion may extend beyond what the presented evidence can establish.",
    "methodology": "This leaves a core part of the proposed method insufficiently justified or verifiable.",
    "other": "This issue may materially affect the interpretation and reliability of the paper's contribution.",
}

REQUEST = {
    "writing_clarity": "Revise the relevant explanation and define the technical terms and reasoning explicitly.",
    "related_work": "Add a direct comparison with the most relevant prior work and clarify the distinct contribution.",
    "figures_tables": "Revise the figure or table so its labels, quantities, and connection to the claim are explicit.",
    "experimental_design": "Add the missing experimental control or analysis and explain how it tests the stated claim.",
    "statistical_analysis": "Report the statistical procedure, uncertainty, and sufficient results to verify robustness.",
    "data_quality": "Document the data construction and limitations, and test whether the conclusion is robust to them.",
    "reproducibility": "Provide the implementation and training details needed to reproduce the reported result.",
    "conclusion_support": "Narrow the conclusion or add evidence that directly supports the full stated claim.",
    "methodology": "Clarify the method, assumptions, and derivation sufficiently for an independent technical check.",
    "other": "Address this issue with a concrete revision and provide evidence that the concern has been resolved.",
}


def tokenize(text):
    words = re.findall(r"[a-z][a-z0-9-]{2,}", str(text or "").lower())
    normalized = []
    for word in words:
        if word in STOPWORDS:
            continue
        for suffix in ("ization", "ation", "ments", "ment", "ing", "ed", "es", "s"):
            if word.endswith(suffix) and len(word) - len(suffix) >= 4:
                word = word[:-len(suffix)]
                break
        if word not in STOPWORDS:
            normalized.append(word)
    return normalized


def manuscript_paragraphs(markdown):
    heading_pattern = re.compile(r"(?m)^#{1,3}\s+(.+?)\s*$")
    headings = list(heading_pattern.finditer(markdown or ""))
    paragraphs = []
    section_number = 0
    for index, heading in enumerate(headings):
        section = redact(heading.group(1))[:280]
        if re.search(r"acknowledg|references|bibliography|appendix", section, flags=re.I):
            continue
        section_number += 1
        end = headings[index + 1].start() if index + 1 < len(headings) else len(markdown)
        body = markdown[heading.end():end]
        blocks = [redact(item) for item in re.split(r"\n\s*\n", body) if redact(item)]
        expanded = []
        for block in blocks:
            if len(block) <= 700:
                expanded.append(block)
                continue
            sentences = re.split(r"(?<=[.!?])\s+", block)
            current = ""
            for sentence in sentences:
                candidate = (current + " " + sentence).strip()
                if current and len(candidate) > 650:
                    expanded.append(current)
                    current = sentence
                else:
                    current = candidate
            if current:
                expanded.append(current)
        for paragraph_index, text in enumerate(expanded, start=1):
            if len(text) < 80:
                continue
            paragraphs.append({
                "order": len(paragraphs),
                "section": section,
                "paragraph_id": "section-{:02d}-p{:03d}".format(section_number, paragraph_index),
                "text": text[:900],
            })
    return paragraphs


def tfidf_vectors(paragraphs):
    documents = [collections.Counter(tokenize(item["text"])) for item in paragraphs]
    document_frequency = collections.Counter()
    for document in documents:
        document_frequency.update(document.keys())
    total = max(1, len(documents))
    idf = {token: math.log((total + 1) / (count + 1)) + 1 for token, count in document_frequency.items()}
    return documents, idf


def cosine(query, document, idf):
    query_counter = collections.Counter(tokenize(query))
    if len(query_counter) < 3:
        return 0
    common = set(query_counter) & set(document)
    numerator = sum(query_counter[token] * document[token] * idf.get(token, 1) ** 2 for token in common)
    query_norm = math.sqrt(sum((count * idf.get(token, 1)) ** 2 for token, count in query_counter.items()))
    document_norm = math.sqrt(sum((count * idf.get(token, 1)) ** 2 for token, count in document.items()))
    return numerator / (query_norm * document_norm) if query_norm and document_norm else 0


def align(query, paragraphs, vectors, idf, threshold, margin):
    ranked = sorted(
        ((cosine(query, vector, idf), paragraph) for vector, paragraph in zip(vectors, paragraphs)),
        key=lambda item: item[0], reverse=True,
    )
    if not ranked:
        return None
    best_score, best = ranked[0]
    second_score = ranked[1][0] if len(ranked) > 1 else 0
    if best_score < threshold or best_score - second_score < margin:
        return None
    return {"score": best_score, "margin": best_score - second_score, "paragraph": best}


def category_for(text):
    for category, pattern in CATEGORY_RULES:
        if re.search(pattern, text, flags=re.I):
            return category
    return "other"


def evidence(match):
    paragraph = match["paragraph"]
    return [{
        "type": "direct_quote",
        "section": paragraph["section"],
        "paragraph_id": paragraph["paragraph_id"],
        "excerpt": paragraph["text"][:240],
    }]


def make_core_target(review, alignments):
    strengths = []
    major = []
    minor = []
    audit = []
    for index, item in enumerate(alignments["strengths"], start=1):
        strengths.append({
            "id": "strength-{:02d}".format(index),
            "category": category_for(item["text"]),
            "point": item["text"][:320],
            "evidence": evidence(item["match"]),
            "confidence": round(min(0.95, 0.55 + item["match"]["score"]), 3),
        })
        audit.append(("strength", item))
    for item in alignments["concerns"]:
        category = category_for(item["text"])
        destination = minor if category in {"writing_clarity", "figures_tables", "related_work"} else major
        identifier = "{}-{:02d}".format("minor" if destination is minor else "major", len(destination) + 1)
        destination.append({
            "id": identifier,
            "category": category,
            "problem": item["text"][:350],
            "impact": IMPACT[category],
            "request": REQUEST[category],
            "evidence": evidence(item["match"]),
            "confidence": round(min(0.95, 0.5 + item["match"]["score"]), 3),
        })
        item["concern_id"] = identifier
        audit.append(("concern", item))
    concerns = major + minor
    questions = []
    for index, question in enumerate(alignments["questions"], start=1):
        query_tokens = set(tokenize(question))
        linked = sorted(
            concerns,
            key=lambda concern: len(query_tokens & set(tokenize(concern["problem"]))),
            reverse=True,
        )
        related = [linked[0]["id"]] if linked and query_tokens & set(tokenize(linked[0]["problem"])) else []
        questions.append({
            "id": "question-{:02d}".format(index),
            "question": question[:350],
            "reason": "The human review identified this clarification as necessary to assess the manuscript.",
            "related_concern_ids": related,
        })
    tasks = []
    for index, concern in enumerate(concerns, start=1):
        tasks.append({
            "id": "task-{:02d}".format(index),
            "source_concern_ids": [concern["id"]],
            "priority": "high" if concern["id"].startswith("major-") else "medium",
            "action": concern["request"],
            "acceptance_criteria": "The revision explicitly addresses the concern and cites verifiable manuscript evidence.",
        })
    central = None
    if alignments.get("summary"):
        central = {
            "claim": redact(review.get("summary"))[:350],
            "evidence": evidence(alignments["summary"]),
            "confidence": round(min(0.9, 0.5 + alignments["summary"]["score"]), 3),
        }
    verdict = "major_revision" if major else "minor_revision"
    rationale = (
        "The manuscript has substantive methodological or empirical concerns that require revision before submission."
        if major else
        "The core contribution is identifiable, but presentation and contextual issues should be revised before submission."
    )
    target = {
        "recommendation": {"verdict": verdict, "rationale": rationale, "confidence": 0.7},
        "summary": redact(review.get("summary"))[:450],
        "central_contribution": central,
        "strengths": strengths,
        "major_concerns": major,
        "minor_concerns": minor,
        "questions": questions,
        "revision_tasks": tasks,
        "limitations": [],
    }
    return target, audit


def build_example(row, review, threshold, margin, prepared=None):
    paragraphs = prepared[0] if prepared else manuscript_paragraphs(row.get("markdown", {}).get("content", ""))
    if len(paragraphs) < 3:
        return None
    vectors, idf = prepared[1:] if prepared else tfidf_vectors(paragraphs)
    alignments = {"strengths": [], "concerns": [], "questions": []}
    summary_match = align(review.get("summary"), paragraphs, vectors, idf, threshold * 0.8, margin * 0.5)
    alignments["summary"] = summary_match
    for key, source_key, limit in (("strengths", "strengths", 1), ("concerns", "weaknesses", 1)):
        for text in split_review_items(review.get(source_key)):
            match = align(text, paragraphs, vectors, idf, threshold, margin)
            if match:
                alignments[key].append({"text": text, "match": match})
            if len(alignments[key]) >= limit:
                break
    alignments["questions"] = split_review_items(review.get("questions"))[:1]
    if not alignments["concerns"]:
        return None
    target, audit_items = make_core_target(review, alignments)
    used = {}
    for _, item in audit_items:
        paragraph = item["match"]["paragraph"]
        used[paragraph["paragraph_id"]] = paragraph
    if summary_match:
        paragraph = summary_match["paragraph"]
        used[paragraph["paragraph_id"]] = paragraph
    selected = sorted(used.values(), key=lambda item: item["order"])
    case = {
        "case_id": row["paper_id"],
        "manuscript": {
            "title": redact(row.get("title")),
            "language": "en",
            "paragraphs": [
                {"section": item["section"], "paragraph_id": item["paragraph_id"], "text": item["text"][:320]}
                for item in selected
            ],
        },
    }
    body = "\n\n".join(
        "paragraph_id: {paragraph_id}\nsection: {section}\ntext: {text}".format(**paragraph)
        for paragraph in case["manuscript"]["paragraphs"]
    )
    messages = [
        {"role": "system", "content": SCHEMA_ALIGNMENT_PROMPT},
        {"role": "user", "content": "Review this paper in English.\n\nPaper title: {}\n\nPaper content:\n{}".format(case["manuscript"]["title"], body)},
    ]
    messages.append({"role": "assistant", "content": json.dumps(target, ensure_ascii=False, separators=(",", ":"))})
    audit = {
        "paper_id": row["paper_id"],
        "review_id": review.get("id"),
        "alignments": [
            {
                "kind": kind,
                "review_text": item["text"],
                "score": round(item["match"]["score"], 4),
                "margin": round(item["match"]["margin"], 4),
                "paragraph_id": item["match"]["paragraph"]["paragraph_id"],
                "excerpt": item["match"]["paragraph"]["text"][:420],
            }
            for kind, item in audit_items
        ],
    }
    return {"messages": messages}, audit


def write_jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def convert(args):
    source = pathlib.Path(args.source_dir) / "data"
    output = {"train": [], "valid": [], "test": []}
    audits = {"train": [], "valid": [], "test": []}
    source_papers = {"train": 0, "valid": 0, "test": 0}
    for source_split, file_name in (
        ("train", "train-00000-of-00001.parquet"),
        ("test", "test-00000-of-00001.parquet"),
    ):
        rows = parquet.read_table(source / file_name).to_pylist()
        if args.max_papers:
            rows = rows[:args.max_papers]
        for row in rows:
            split = source_split
            if source_split == "train" and stable_validation(row["paper_id"], args.validation_ratio, args.seed):
                split = "valid"
            reviews = sorted(row.get("reviews") or [], key=lambda item: (-int(item.get("confidence") or 0), str(item.get("id") or "")))
            paragraphs = manuscript_paragraphs(row.get("markdown", {}).get("content", ""))
            if len(paragraphs) < 3:
                continue
            vectors, idf = tfidf_vectors(paragraphs)
            prepared = (paragraphs, vectors, idf)
            for review in reviews:
                built = build_example(row, review, args.min_score, args.min_margin, prepared)
                if built:
                    example, audit = built
                    output[split].append(example)
                    audits[split].append(audit)
                    source_papers[split] += 1
                    break
    destination = pathlib.Path(args.out)
    for split in output:
        write_jsonl(destination / "{}.jsonl".format(split), output[split])
        write_jsonl(destination / "audit-{}.jsonl".format(split), audits[split])
    scores = [item["score"] for values in audits.values() for audit in values for item in audit["alignments"]]
    manifest = {
        "dataset": "UKPLab/ProReviewer-Dataset",
        "dataset_revision": args.dataset_revision,
        "objective": "review_schema_core_weak_alignment",
        "label_quality": "weak_supervision_requires_expert_audit",
        "min_alignment_score": args.min_score,
        "min_alignment_margin": args.min_margin,
        "split_policy": "ICLR 2025 paper-hash train/valid; ICLR 2026 held-out test",
        "examples": {key: len(value) for key, value in output.items()},
        "alignment_count": len(scores),
        "alignment_score_mean": round(sum(scores) / len(scores), 4) if scores else None,
        "excluded_supervision": ["initial_rating", "decision", "meta_review", "reviewer_identity"],
    }
    with (destination / "manifest.json").open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return manifest


def main():
    parser = argparse.ArgumentParser(description="Prepare weak review-schema alignment SFT data")
    parser.add_argument("--source-dir", default="data/openreview/external/proreview")
    parser.add_argument("--out", default="data/openreview/sft/proreview-schema-weak-v0.1")
    parser.add_argument("--dataset-revision", required=True)
    parser.add_argument("--min-score", type=float, default=0.16)
    parser.add_argument("--min-margin", type=float, default=0.025)
    parser.add_argument("--validation-ratio", type=float, default=0.1)
    parser.add_argument("--seed", default="onescience-proreview-v0.1")
    parser.add_argument("--max-papers", type=int, default=0)
    args = parser.parse_args()
    print(json.dumps(convert(args), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
