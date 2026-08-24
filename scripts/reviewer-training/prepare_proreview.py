#!/usr/bin/env python3
"""Convert version-matched ProReviewer OpenReview data to MLX-LM chat SFT files."""

import argparse
import hashlib
import json
import pathlib
import re

import pyarrow.parquet as parquet


SYSTEM_PROMPT = (
    "You are a rigorous pre-submission academic reviewer. Review only the supplied manuscript text. "
    "Return one JSON object with summary, strengths, concerns, and questions. Do not predict acceptance, "
    "invent evidence, or mention reviewer scores."
)

SECTION_PRIORITY = (
    "abstract", "method", "approach", "experiment", "evaluation", "result",
    "discussion", "limitation", "conclusion", "introduction",
)


def redact(text):
    value = str(text or "")
    value = re.sub(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", "[EMAIL]", value, flags=re.I)
    value = re.sub(r"https?://openreview\.net/profile\?id=[^\s)]+", "[OPENREVIEW_PROFILE]", value, flags=re.I)
    value = re.sub(r"\b\d{4}-\d{4}-\d{4}-\d{3}[\dX]\b", "[ORCID]", value, flags=re.I)
    return re.sub(r"\s+", " ", value).strip()


def section_chunks(markdown):
    matches = list(re.finditer(r"(?m)^#{1,3}\s+(.+?)\s*$", markdown or ""))
    chunks = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(markdown)
        heading = redact(match.group(1))
        if re.search(r"acknowledg|references|bibliography|appendix", heading, flags=re.I):
            continue
        body = redact(markdown[match.end():end])
        if body:
            chunks.append((heading, body))
    if chunks:
        return chunks
    fallback = redact(markdown)
    return [("Manuscript", fallback)] if fallback else []


def manuscript_excerpt(markdown, max_characters):
    chunks = section_chunks(markdown)
    def priority(item):
        heading = item[0].lower()
        for index, keyword in enumerate(SECTION_PRIORITY):
            if keyword in heading:
                return index
        return len(SECTION_PRIORITY)
    selected = sorted(enumerate(chunks), key=lambda item: (priority(item[1]), item[0]))[:8]
    if not selected:
        return ""
    per_section = max(160, max_characters // len(selected))
    rendered = []
    for _, (heading, body) in selected:
        rendered.append("## {}\n{}".format(heading, body[:per_section]))
    return "\n\n".join(rendered)[:max_characters]


def split_review_items(text):
    value = str(text or "").strip()
    if not value:
        return []
    parts = re.split(r"(?:\r?\n)+(?=\s*(?:[-*•]|\d+[.)]))", value)
    if len(parts) == 1:
        parts = re.split(r"\n{2,}", value)
    cleaned = [redact(re.sub(r"^\s*(?:[-*•]|\d+[.)])\s*", "", item)) for item in parts]
    return [item for item in cleaned if len(item) >= 8]


def bounded_target(review, max_characters):
    source = {
        "strengths": split_review_items(review.get("strengths"))[:4],
        "concerns": split_review_items(review.get("weaknesses"))[:5],
        "questions": split_review_items(review.get("questions"))[:4],
    }
    target = {
        "summary": redact(review.get("summary"))[:350],
        "strengths": [],
        "concerns": [],
        "questions": [],
    }
    candidates = []
    for index in range(5):
        for key, limit in (("concerns", 300), ("strengths", 250), ("questions", 220)):
            if index < len(source[key]):
                candidates.append((key, source[key][index][:limit]))
    for key, item in candidates:
        candidate = {**target, key: [*target[key], item]}
        if len(json.dumps(candidate, ensure_ascii=False)) <= max_characters:
            target = candidate
    return target


def stable_validation(paper_id, ratio, seed):
    digest = hashlib.sha256("{}:{}".format(seed, paper_id).encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") / 2 ** 64 < ratio


def row_examples(row, max_reviews, max_input_characters, max_output_characters):
    manuscript = manuscript_excerpt(row.get("markdown", {}).get("content", ""), max_input_characters)
    if len(manuscript) < 500:
        return []
    reviews = sorted(
        row.get("reviews") or [],
        key=lambda item: (-int(item.get("confidence") or 0), str(item.get("id") or "")),
    )[:max_reviews]
    examples = []
    for review in reviews:
        target = bounded_target(review, max_output_characters)
        if len(target["summary"]) < 50 or not (target["strengths"] or target["concerns"]):
            continue
        user = "Paper title: {}\n\nManuscript excerpt:\n{}".format(redact(row.get("title")), manuscript)
        examples.append({
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user},
                {"role": "assistant", "content": json.dumps(target, ensure_ascii=False, separators=(",", ":"))},
            ]
        })
    return examples


def write_jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def convert(args):
    source = pathlib.Path(args.source_dir)
    train_table = parquet.read_table(source / "data" / "train-00000-of-00001.parquet")
    test_table = parquet.read_table(source / "data" / "test-00000-of-00001.parquet")
    train_rows = train_table.to_pylist()
    test_rows = test_table.to_pylist()
    if args.max_train_papers:
        train_rows = train_rows[:args.max_train_papers]
    if args.max_test_papers:
        test_rows = test_rows[:args.max_test_papers]

    output = {"train": [], "valid": [], "test": []}
    paper_counts = {"train": 0, "valid": 0, "test": 0}
    for row in train_rows:
        split = "valid" if stable_validation(row["paper_id"], args.validation_ratio, args.seed) else "train"
        examples = row_examples(row, args.reviews_per_paper, args.max_input_characters, args.max_output_characters)
        if examples:
            output[split].extend(examples)
            paper_counts[split] += 1
    for row in test_rows:
        examples = row_examples(row, args.reviews_per_paper, args.max_input_characters, args.max_output_characters)
        if examples:
            output["test"].extend(examples)
            paper_counts["test"] += 1

    destination = pathlib.Path(args.out)
    for split, examples in output.items():
        write_jsonl(destination / "{}.jsonl".format(split), examples)
    manifest = {
        "dataset": "UKPLab/ProReviewer-Dataset",
        "dataset_revision": args.dataset_revision,
        "dataset_license": "MIT (per dataset card; re-check before commercial use)",
        "objective": "openreview_review_content_sft",
        "schema_alignment": False,
        "excluded_targets": ["initial_rating", "decision", "meta_review", "reviewer_identity"],
        "split_policy": "ICLR 2025 train with paper-level hash validation; ICLR 2026 held-out test",
        "seed": args.seed,
        "validation_ratio": args.validation_ratio,
        "reviews_per_paper": args.reviews_per_paper,
        "max_input_characters": args.max_input_characters,
        "max_output_characters": args.max_output_characters,
        "papers": paper_counts,
        "examples": {key: len(value) for key, value in output.items()},
    }
    with (destination / "manifest.json").open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return manifest


def main():
    parser = argparse.ArgumentParser(description="Prepare ProReviewer for MLX-LM domain SFT")
    parser.add_argument("--source-dir", default="data/openreview/external/proreview")
    parser.add_argument("--out", default="data/openreview/sft/proreview-domain-v0.1")
    parser.add_argument("--dataset-revision", required=True)
    parser.add_argument("--reviews-per-paper", type=int, default=1)
    parser.add_argument("--validation-ratio", type=float, default=0.1)
    parser.add_argument("--seed", default="onescience-proreview-v0.1")
    parser.add_argument("--max-input-characters", type=int, default=1800)
    parser.add_argument("--max-output-characters", type=int, default=1200)
    parser.add_argument("--max-train-papers", type=int, default=0)
    parser.add_argument("--max-test-papers", type=int, default=0)
    args = parser.parse_args()
    if not 0 < args.validation_ratio < 1:
        parser.error("--validation-ratio 必须位于 0 和 1 之间")
    if args.reviews_per_paper < 1:
        parser.error("--reviews-per-paper 必须大于 0")
    print(json.dumps(convert(args), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
