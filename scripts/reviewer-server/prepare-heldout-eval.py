#!/usr/bin/env python3
"""Convert the held-out Schema SFT split into inference-only evaluation cases."""

import argparse
import json
import pathlib
import re


TITLE_AND_BODY = re.compile(
    r"Paper title:\s*(?P<title>.*?)\n\nPaper content:\n(?P<body>[\s\S]*)\Z"
)
PARAGRAPH = re.compile(
    r"(?:\A|\n\n)paragraph_id:\s*(?P<paragraph_id>[^\n]+)\n"
    r"section:\s*(?P<section>[^\n]+)\n"
    r"text:\s*(?P<text>[\s\S]*?)(?=\n\nparagraph_id:|\Z)"
)


def read_jsonl(path):
    with pathlib.Path(path).open("r", encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def user_message(example):
    for message in example.get("messages", []):
        if message.get("role") == "user":
            return message.get("content", "")
    raise ValueError("样本缺少 user 消息。")


def convert(source_rows, audit_rows, limit):
    if len(source_rows) != len(audit_rows):
        raise ValueError("Schema test 与 audit-test 行数不一致。")
    output = []
    selected = zip(source_rows, audit_rows)
    for index, (source, audit) in enumerate(selected):
        if limit and len(output) >= limit:
            break
        content = user_message(source)
        match = TITLE_AND_BODY.search(content)
        if not match:
            raise ValueError("第 {} 条样本无法解析标题或正文。".format(index + 1))
        paragraphs = [
            {
                "paragraph_id": item.group("paragraph_id").strip(),
                "section": item.group("section").strip(),
                "text": item.group("text").strip(),
            }
            for item in PARAGRAPH.finditer(match.group("body"))
        ]
        if not paragraphs:
            raise ValueError("第 {} 条样本没有可评测段落。".format(index + 1))
        paper_id = audit.get("paper_id") or "heldout-{:04d}".format(index + 1)
        output.append({
            "case_schema_version": "1.0.0",
            "case_id": str(paper_id),
            "source": {
                "kind": "openreview",
                "dataset": "UKPLab/ProReviewer-Dataset",
                "split": "ICLR-2026-heldout-test",
                "forum_id": str(paper_id),
                "venue_id": "ICLR.cc/2026/Conference",
                "year": 2026,
            },
            "manuscript": {
                "title": match.group("title").strip(),
                "language": "en",
                "paragraphs": paragraphs,
            },
            "gold": None,
            "human_references": [],
        })
    return output


def main():
    parser = argparse.ArgumentParser(description="Prepare frozen held-out reviewer evaluation cases")
    parser.add_argument("--input", required=True, help="Schema test.jsonl")
    parser.add_argument("--audit", required=True, help="Matching audit-test.jsonl")
    parser.add_argument("--out", required=True)
    parser.add_argument("--limit", type=int, default=100)
    args = parser.parse_args()

    cases = convert(read_jsonl(args.input), read_jsonl(args.audit), args.limit)
    destination = pathlib.Path(args.out)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", encoding="utf-8") as handle:
        for case in cases:
            handle.write(json.dumps(case, ensure_ascii=False) + "\n")
    print("已生成 {} 条冻结评测样本：{}".format(len(cases), destination))


if __name__ == "__main__":
    main()
