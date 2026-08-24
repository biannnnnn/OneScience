#!/usr/bin/env python3
"""Prepare leakage-safe decision cases from the version-matched ProReviewer data."""

import argparse
import hashlib
import json
import pathlib
import re

import pyarrow.parquet as parquet


SECTION_PRIORITY = (
    "abstract", "introduction", "method", "approach", "experiment", "evaluation",
    "result", "discussion", "limitation", "conclusion",
)


def redact(text):
    value = str(text or "")
    value = re.sub(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", "[EMAIL]", value, flags=re.I)
    value = re.sub(r"https?://openreview\.net/profile\?id=[^\s)]+", "[OPENREVIEW_PROFILE]", value, flags=re.I)
    value = re.sub(r"\b\d{4}-\d{4}-\d{4}-\d{3}[\dX]\b", "[ORCID]", value, flags=re.I)
    return re.sub(r"\s+", " ", value).strip()


def stable_validation(paper_id, ratio, seed):
    digest = hashlib.sha256("{}:{}".format(seed, paper_id).encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") / 2 ** 64 < ratio


def normalize_decision(value):
    """Map public final decisions to binary labels; ambiguous decisions are excluded."""
    text = re.sub(r"\s+", " ", str(value or "")).strip().lower()
    if not text:
        return None
    # A withdrawal is not an editorial rejection and must not be used as one.
    if re.search(r"withdraw", text):
        return None
    if re.search(r"reject|desk reject|decline", text):
        return 0
    if re.search(r"\baccept\b|poster|spotlight|oral", text):
        return 1
    return None


def _split_blocks(body):
    blocks = []
    for raw in re.split(r"\n\s*\n", body or ""):
        value = redact(raw)
        if len(value) < 60:
            continue
        if len(value) <= 1200:
            blocks.append(value)
            continue
        sentences = re.split(r"(?<=[.!?])\s+", value)
        current = ""
        for sentence in sentences:
            candidate = (current + " " + sentence).strip()
            if current and len(candidate) > 1000:
                blocks.append(current)
                current = sentence
            else:
                current = candidate
        if current:
            blocks.append(current)
    return blocks


def manuscript_paragraphs(markdown, max_characters=24000, max_paragraphs=80):
    heading_pattern = re.compile(r"(?m)^#{1,3}\s+(.+?)\s*$")
    headings = list(heading_pattern.finditer(markdown or ""))
    sections = []
    for index, heading in enumerate(headings):
        title = redact(heading.group(1))[:280]
        if re.search(r"acknowledg|references|bibliography|appendix", title, flags=re.I):
            continue
        end = headings[index + 1].start() if index + 1 < len(headings) else len(markdown)
        blocks = _split_blocks(markdown[heading.end():end])
        if blocks:
            sections.append({"order": len(sections), "title": title, "blocks": blocks})
    if not sections:
        blocks = _split_blocks(markdown)
        sections = [{"order": 0, "title": "Manuscript", "blocks": blocks}] if blocks else []

    def priority(section):
        lowered = section["title"].lower()
        for index, keyword in enumerate(SECTION_PRIORITY):
            if keyword in lowered:
                return index
        return len(SECTION_PRIORITY)

    selected = []
    used_characters = 0
    for section in sorted(sections, key=lambda item: (priority(item), item["order"])):
        section_number = section["order"] + 1
        for paragraph_index, text in enumerate(section["blocks"], start=1):
            remaining = max_characters - used_characters
            if remaining < 60 or len(selected) >= max_paragraphs:
                break
            excerpt = text[: min(1200, remaining)]
            selected.append({
                "section": section["title"],
                "paragraph_id": "section-{:02d}-p{:03d}".format(section_number, paragraph_index),
                "text": excerpt,
            })
            used_characters += len(excerpt)
        if used_characters >= max_characters or len(selected) >= max_paragraphs:
            break
    return selected


def make_case(row, split, year, max_characters, max_paragraphs):
    decision_text = (row.get("decision") or {}).get("decision")
    label = normalize_decision(decision_text)
    paragraphs = manuscript_paragraphs(
        (row.get("markdown") or {}).get("content", ""),
        max_characters=max_characters,
        max_paragraphs=max_paragraphs,
    )
    if label is None or not paragraphs:
        return None
    metadata = row.get("metadata") or {}
    source_venue_id = str(
        metadata.get("venueid") or metadata.get("venue") or "ICLR-{}".format(year)
    )
    paper_id = str(row["paper_id"])
    case = {
        "decision_case_schema_version": "1.0.0",
        "case_id": paper_id,
        "split": split,
        "source": {
            "kind": "openreview",
            "dataset": "UKPLab/ProReviewer-Dataset",
            "paper_id": paper_id,
            "venue_id": source_venue_id,
            "year": year,
        },
        # OpenReview's venue field contains outcome-specific values such as
        # Rejected_Submission, Poster, Spotlight and Oral. Those are provenance,
        # not inference-time target venue data, so never expose them to the
        # frozen reviewer or acceptance classifier.
        "target_venue": {
            "id": "ICLR.cc/{}/Conference".format(year),
            "name": "ICLR {}".format(year),
        },
        "manuscript": {
            "paper_id": paper_id,
            "title": redact(row.get("title"))[:1000],
            "language": "en",
            "fingerprint": None,
            "paragraphs": paragraphs,
        },
        "decision_label": label,
    }
    audit = {
        "case_id": paper_id,
        "split": split,
        "raw_decision": decision_text,
        "normalized_label": label,
    }
    return case, audit


def write_jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def convert(args):
    source = pathlib.Path(args.source_dir) / "data"
    cases = []
    audits = []
    source_counts = {}
    excluded = {"ambiguous_or_missing_decision": 0, "missing_manuscript": 0}
    for source_split, filename, year in (
        ("train", "train-00000-of-00001.parquet", 2025),
        ("test", "test-00000-of-00001.parquet", 2026),
    ):
        rows = parquet.read_table(source / filename).to_pylist()
        if args.max_papers:
            rows = rows[: args.max_papers]
        source_counts[source_split] = len(rows)
        for row in rows:
            split = source_split
            if source_split == "train" and stable_validation(row["paper_id"], args.validation_ratio, args.seed):
                split = "validation"
            built = make_case(row, split, year, args.max_input_characters, args.max_paragraphs)
            if not built:
                if normalize_decision((row.get("decision") or {}).get("decision")) is None:
                    excluded["ambiguous_or_missing_decision"] += 1
                else:
                    excluded["missing_manuscript"] += 1
                continue
            case, audit = built
            cases.append(case)
            audits.append(audit)

    destination = pathlib.Path(args.out)
    write_jsonl(destination / "cases.jsonl", cases)
    write_jsonl(destination / "decision-audit.jsonl", audits)
    distribution = {}
    for split in ("train", "validation", "test"):
        selected = [case for case in cases if case["split"] == split]
        distribution[split] = {
            "total": len(selected),
            "accept": sum(case["decision_label"] for case in selected),
            "reject": sum(1 - case["decision_label"] for case in selected),
        }
    manifest = {
        "dataset": "UKPLab/ProReviewer-Dataset",
        "dataset_revision": args.dataset_revision,
        "objective": "acceptance_probability_calibration",
        "input_version": "initial submission before rebuttal",
        "split_policy": "ICLR 2025 paper-hash train/validation; ICLR 2026 temporal test",
        "label": "final binary accept/reject decision",
        "forbidden_inputs": ["human review scores", "meta-review", "decision text", "author identity"],
        "review_features": "must be generated by one frozen OneScience reviewer for every split",
        "seed": args.seed,
        "validation_ratio": args.validation_ratio,
        "source_counts": source_counts,
        "excluded": excluded,
        "distribution": distribution,
    }
    destination.mkdir(parents=True, exist_ok=True)
    with (destination / "manifest.json").open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return manifest


def main():
    parser = argparse.ArgumentParser(description="Prepare leakage-safe ProReviewer decision cases")
    parser.add_argument("--source-dir", default="data/openreview/external/proreview")
    parser.add_argument("--out", default="data/openreview/acceptance/proreview-v0.1")
    parser.add_argument("--dataset-revision", required=True)
    # Keep this identical to the Reviewer SFT paper split. Calibration papers
    # therefore were not used to train either Reviewer adapter.
    parser.add_argument("--validation-ratio", type=float, default=0.1)
    parser.add_argument("--seed", default="onescience-proreview-v0.1")
    parser.add_argument("--max-input-characters", type=int, default=24000)
    parser.add_argument("--max-paragraphs", type=int, default=80)
    parser.add_argument("--max-papers", type=int, default=0)
    args = parser.parse_args()
    if not 0 < args.validation_ratio < 1:
        parser.error("--validation-ratio 必须位于 0 和 1 之间")
    print(json.dumps(convert(args), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
