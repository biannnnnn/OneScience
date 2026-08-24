#!/usr/bin/env python3
"""Quick end-to-end test of the Plan B pipeline (7B Domain-SFT → DeepSeek V4).

Usage:
    # Test with a single case from the held-out eval set
    python scripts/reviewer-server/test-planb-pipeline.py \
      --config config/reviewer-server/model-qwen25-7b-planb.json \
      --cases evaluation/reviewer-baseline/runs/openreview-2026-heldout-100.jsonl \
      --limit 1

    # Test with a mock manuscript (no server needed)
    python scripts/reviewer-server/test-planb-pipeline.py \
      --config config/reviewer-server/model-qwen25-7b-planb.json \
      --mock
"""

import argparse
import json
import os
import pathlib
import sys
import time

PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from jsonschema import Draft202012Validator, FormatChecker
from reviewer_service.backends import PlanBBackend, BackendError
from reviewer_service.core import build_request_context, assemble_review
from reviewer_service.deepseek import DeepSeekStructurer, StructuringError
from reviewer_service.nl_prompt import NL_SYSTEM_PROMPT


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def read_jsonl(path):
    with open(path, "r", encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def make_request(case, language="zh-CN"):
    manuscript = case["manuscript"]
    return {
        "request_id": case["case_id"],
        "review_type": "general",
        "review_language": language,
        "target_venue": None,
        "manuscript": {
            "paper_id": case["case_id"],
            "title": manuscript["title"],
            "language": manuscript["language"],
            "fingerprint": None,
            "paragraphs": manuscript["paragraphs"],
        },
    }


def schema_errors(validator, review):
    return [
        {
            "path": "/" + "/".join(str(p) for p in error.absolute_path),
            "message": error.message,
        }
        for error in sorted(validator.iter_errors(review), key=lambda e: list(e.absolute_path))
    ]


def test_deepseek_standalone(api_key, schema_path):
    """Test DeepSeek V4 structuring with a mock NL review."""
    print("=" * 60)
    print("Test 1: DeepSeek V4 Pro standalone structuring")
    print("=" * 60)

    mock_nl = """## 1. 总体推荐
verdict: minor_revision
rationale: 论文提出了一个新的方法来解决图像分类中的领域自适应问题，实验设计总体合理，但缺少与最新SOTA方法的充分对比，部分实验细节需要补充。
confidence: 0.75

## 2. 论文概要
本文提出了一种基于对抗训练的领域自适应方法，在多个标准数据集上取得了有竞争力的结果。

## 3. 核心贡献
提出了一种新的梯度反转层设计，使得特征对齐更加稳定。
evidence: 第3.2节描述了梯度反转层的具体设计。

## 4. 主要优势
1. 方法创新性 - 梯度反转层的改进设计具有理论依据
   evidence: paragraph_id=p4, section=3.2, excerpt="我们证明了改进后的梯度反转层在理论上保证了收敛性"

## 5. 主要问题
1. category: experimental_design
   problem: 实验缺少与DomainNet上最新方法的对比，无法充分证明方法的优越性
   impact: 这削弱了方法在更广泛领域的适用性声明，审稿人和读者可能质疑方法的实际优势
   request: 请至少在DomainNet数据集上补充与3种以上最新方法的对比实验
   evidence: absence - 论文中未提及DomainNet数据集的实验结果

## 6. 次要问题
无

## 7. 提问
无

## 8. 修改任务
1. priority: high
   action: 在DomainNet数据集上补充对比实验
   acceptance_criteria: 提供完整的对比表格，包含至少3种SOTA方法

## 9. 审稿局限性
- 无法验证论文中的数学证明
"""

    structurer = DeepSeekStructurer(api_key=api_key, schema_path=schema_path)
    try:
        result = structurer.structure(mock_nl, "Test Paper: A Novel Domain Adaptation Method")
        print("✅ Structuring succeeded!")
        print(f"   Keys: {list(result.keys())}")
        print(f"   Recommendation: {result.get('recommendation', {}).get('verdict')}")
        print(f"   Summary length: {len(result.get('summary', ''))} chars")
        print(f"   Strengths: {len(result.get('strengths', []))}")
        print(f"   Major concerns: {len(result.get('major_concerns', []))}")
        print(f"   Minor concerns: {len(result.get('minor_concerns', []))}")
        return result
    except StructuringError as e:
        print(f"❌ Structuring failed: {e}")
        return None


def test_full_pipeline(config_path, cases_path, limit, schema_path):
    """Test the full Plan B pipeline (7B → DeepSeek)."""
    print("\n" + "=" * 60)
    print("Test 2: Full Plan B pipeline (7B → DeepSeek)")
    print("=" * 60)

    config = load_json(config_path)
    cases = read_jsonl(cases_path)
    if limit:
        cases = cases[:limit]

    validator = Draft202012Validator(load_json(schema_path), format_checker=FormatChecker())

    try:
        backend = PlanBBackend(config)
        print(f"✅ PlanBBackend initialized")
        print(f"   7B endpoint: {backend.completions_url}")
        print(f"   7B model: {backend.served_model_name}")
    except BackendError as e:
        print(f"❌ Backend init failed: {e}")
        return

    for case in cases:
        request = make_request(case)
        print(f"\n--- Case: {case['case_id']} ---")
        print(f"   Title: {case['manuscript']['title'][:80]}...")
        print(f"   Paragraphs: {len(case['manuscript']['paragraphs'])}")

        try:
            started = time.perf_counter()
            result = backend.review(request)
            latency = round((time.perf_counter() - started) * 1000)
            review = result["review"]
            usage = result["usage"]

            errors = schema_errors(validator, review)
            schema_valid = len(errors) == 0

            print(f"   Status: OK")
            print(f"   Total latency: {latency}ms")
            planb = usage.get("plan_b", {})
            print(f"   Stage 1 (7B): {planb.get('stage1_latency_ms')}ms")
            print(f"   Stage 2 (DeepSeek): {planb.get('stage2_latency_ms')}ms")
            print(f"   NL review chars: {planb.get('nl_review_chars')}")
            print(f"   Prompt tokens: {usage['prompt_tokens']}")
            print(f"   Output tokens: {usage['output_tokens']}")
            print(f"   Schema valid: {schema_valid}")
            if errors:
                print(f"   Schema errors ({len(errors)}):")
                for err in errors[:5]:
                    print(f"     - {err['path']}: {err['message'][:100]}")
                if len(errors) > 5:
                    print(f"     ... and {len(errors) - 5} more")
            else:
                print(f"   ✅ Schema validation PASSED!")

        except BackendError as e:
            print(f"   ❌ Failed: {e.code} - {e}")
        except Exception as e:
            print(f"   ❌ Unexpected error: {type(e).__name__}: {e}")


def test_nl_prompt(config_path, cases_path, limit):
    """Test that the NL prompt is built correctly (no model calls)."""
    print("=" * 60)
    print("Test 0: NL prompt construction (dry run)")
    print("=" * 60)

    config = load_json(config_path)
    cases = read_jsonl(cases_path)
    if limit:
        cases = cases[:limit]

    for case in cases:
        request = make_request(case)
        case_obj, effective_config, messages, coverage = build_request_context(request, config)

        # Swap to NL prompt
        nl_messages = list(messages)
        nl_messages[0] = {"role": "system", "content": NL_SYSTEM_PROMPT}

        print(f"\nCase: {case['case_id']}")
        print(f"  System prompt length: {len(NL_SYSTEM_PROMPT)} chars")
        print(f"  User prompt length: {len(nl_messages[1]['content'])} chars")
        print(f"  Coverage: {coverage['analyzed_paragraphs']}/{coverage['total_paragraphs']} paragraphs")
        print(f"  Supplied chars: {coverage['supplied_characters']}")
        # Verify no JSON format instructions in system prompt
        has_json_instr = any(kw in NL_SYSTEM_PROMPT for kw in ['"major_concerns"', '必须包含', '输出前自行检查'])
        print(f"  JSON instructions in system prompt: {has_json_instr} (should be False)")
        if has_json_instr:
            print("  ⚠️  WARNING: NL system prompt still contains JSON instructions!")
        else:
            print("  ✅ NL system prompt is clean (no JSON instructions)")


def main():
    parser = argparse.ArgumentParser(description="Test Plan B pipeline")
    parser.add_argument("--config", default="config/reviewer-server/model-qwen25-7b-planb.json")
    parser.add_argument("--schema", default="schemas/review-schema.json")
    parser.add_argument("--cases", default="evaluation/reviewer-baseline/runs/openreview-2026-heldout-100.jsonl")
    parser.add_argument("--limit", type=int, default=1)
    parser.add_argument("--mock", action="store_true", help="Test DeepSeek with mock NL review only")
    parser.add_argument("--dry-run", action="store_true", help="Only test prompt construction")
    parser.add_argument("--deepseek-only", action="store_true", help="Only test DeepSeek structuring")
    args = parser.parse_args()

    if args.dry_run:
        test_nl_prompt(args.config, args.cases, args.limit)
        return

    if args.deepseek_only:
        config = load_json(args.config)
        api_key = config["deepseek"]["api_key"]
        test_deepseek_standalone(api_key, args.schema)
        return

    if args.mock:
        config = load_json(args.config)
        api_key = config["deepseek"]["api_key"]
        test_deepseek_standalone(api_key, args.schema)
        return

    # Full pipeline test
    test_nl_prompt(args.config, args.cases, args.limit)
    test_full_pipeline(args.config, args.cases, args.limit, args.schema)


if __name__ == "__main__":
    main()
