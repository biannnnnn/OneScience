"""DeepSeek V4 Pro client for structuring natural language reviews into JSON.

Usage:
    structurer = DeepSeekStructurer(api_key="sk-...", schema_path="schemas/review-schema.json")
    parsed_json = structurer.structure(nl_review_text, manuscript_title="...")
"""

import json
import pathlib
import re
import urllib.error
import urllib.request

from jsonschema import Draft202012Validator, FormatChecker


PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent

STRUCTURING_SYSTEM_PROMPT = """你是学术审稿结构化助手。你的任务是将自然语言审稿内容转换为符合 JSON Schema 的结构化 JSON。

规则：
1. 严格按提供的 JSON Schema 输出，所有必填字段必须存在
2. 从自然语言审稿中提取信息，不得编造原文中没有的内容
3. 每个 concern（major_concerns/minor_concerns）的 problem、impact、request 必须是至少 15 个中文字符的具体完整句子
4. evidence 必须从自然语言审稿的证据描述中提取，类型只能是 direct_quote/absence/cross_section
5. 如果自然语言审稿没有提到某类内容，对应的顶层字段输出空数组 []
6. 只输出纯 JSON 对象，不输出 Markdown、思考过程或额外文字
7. recommendation.verdict 只能是: ready_for_submission, minor_revision, major_revision, fundamental_revision, insufficient_evidence
8. concern.category 只能是: research_question, contribution_novelty, scope_relevance, related_work, methodology, experimental_design, data_quality, statistical_analysis, results_interpretation, conclusion_support, reproducibility, ethics_compliance, limitations, writing_clarity, structure, figures_tables, references, other
9. revision_tasks.priority 只能是: critical, high, medium, low
10. limitations 必须是字符串数组，表示本次审稿受输入缺失或能力边界影响的限制

关键约束（违反会导致 Schema 校验失败）：
- evidence 数组绝不能为空（minItems=1）。如果某条 claim/point/concern 没有可引用的证据：central_contribution 直接输出 null；strength 或 concern 要么删除该项，要么用 absence 类型证据描述缺失内容（例如 {"type":"absence","description":"论文未说明该实验的设置","searched_sections":["实验"]}）。
- problem、impact、request 都必须是具体、可执行的完整句子（至少 15 个中文字符），绝不能使用"需要进行改进""存在不足"等空泛短语。request 必须给出明确的操作建议。
- 从自然语言审稿中把每条 concern 的 problem（问题是什么）、impact（为什么重要/有什么影响）、request（具体怎么改）三部分分别写清楚，不要合并成一句话。"""


def _load_schema(schema_path):
    """Load and return the review JSON Schema."""
    path = pathlib.Path(schema_path)
    if not path.is_absolute():
        path = PROJECT_ROOT / path
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _extract_json(text):
    """Extract JSON object from model output that may contain extra text."""
    text = text.strip()
    # Remove think blocks
    text = re.sub(r"<think>[\s\S]*?</think>", "", text, flags=re.IGNORECASE)
    # Remove markdown code fences
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*```$", "", text)
    # Find JSON boundaries
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        return text[start:end + 1]
    return text


class StructuringError(RuntimeError):
    """Raised when structuring fails."""
    def __init__(self, message, details=None):
        super().__init__(message)
        self.details = details or []


class DeepSeekStructurer:
    """Call DeepSeek V4 Pro to structure a natural language review into JSON."""

    def __init__(self, api_key, schema_path="schemas/review-schema.json", base_url=None):
        self.api_key = api_key
        self.base_url = (base_url or "https://api.deepseek.com").rstrip("/")
        self.completions_url = self.base_url + "/chat/completions"
        self.schema = _load_schema(schema_path)
        self.schema_path = schema_path
        self.timeout_seconds = 120

    def _build_user_prompt(self, nl_review, manuscript_title):
        schema_json = json.dumps(self.schema, ensure_ascii=False, indent=2)
        return (
            f"论文标题：{manuscript_title}\n\n"
            f"自然语言审稿内容：\n{nl_review}\n\n"
            f"目标 JSON Schema：\n{schema_json}\n\n"
            "请将上述自然语言审稿转换为符合 Schema 的 JSON 对象。只输出 JSON。"
        )

    def _call(self, messages):
        """Call DeepSeek and return the raw message content."""
        payload = {
            "model": "deepseek-chat",
            "messages": messages,
            "temperature": 0,
            "max_tokens": 4096,
            "stream": False,
        }
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
        }
        request = urllib.request.Request(
            self.completions_url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                result = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            body = ""
            try:
                body = error.read().decode("utf-8")[:500]
            except Exception:
                pass
            raise StructuringError(f"DeepSeek API 返回 HTTP {error.code}", [body]) from error
        except (urllib.error.URLError, TimeoutError) as error:
            raise StructuringError(
                "无法连接 DeepSeek API", [str(getattr(error, "reason", error))]
            ) from error
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise StructuringError("DeepSeek API 返回了无效响应") from error
        try:
            return result["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as error:
            raise StructuringError("DeepSeek 响应缺少生成文本") from error

    @staticmethod
    def _repair_truncated_json(text):
        """Try to repair a truncated JSON by closing unclosed brackets and strings."""
        text = text.strip()
        depth = 0
        in_string = False
        escape = False
        for ch in text:
            if escape:
                escape = False
                continue
            if ch == '\\':
                escape = True
                continue
            if ch == '"':
                in_string = not in_string
            elif not in_string:
                if ch in '{[':
                    depth += 1
                elif ch in '}]':
                    depth -= 1
        if depth <= 0 and not in_string:
            return text, False
        repaired = text
        if in_string:
            repaired += '"'
        open_brackets = []
        in_string2 = False
        escape2 = False
        for ch in repaired:
            if escape2:
                escape2 = False
                continue
            if ch == '\\':
                escape2 = True
                continue
            if ch == '"':
                in_string2 = not in_string2
            elif not in_string2:
                if ch == '{':
                    open_brackets.append('}')
                elif ch == '[':
                    open_brackets.append(']')
                elif ch in '}]':
                    if open_brackets and open_brackets[-1] == ch:
                        open_brackets.pop()
        for closer in reversed(open_brackets):
            repaired += closer
        if repaired == text:
            return text, False
        return repaired, True

    def _parse_output(self, raw_output):
        """Extract and parse JSON from DeepSeek output, with truncation repair."""
        json_text = _extract_json(raw_output)
        try:
            return json.loads(json_text), None
        except json.JSONDecodeError as error:
            repaired, was_repaired = self._repair_truncated_json(json_text)
            if was_repaired:
                try:
                    return json.loads(repaired), None
                except json.JSONDecodeError:
                    pass
            return None, str(error)

    def _schema_errors(self, parsed):
        """Return list of human-readable schema validation errors."""
        validator = Draft202012Validator(self.schema, format_checker=FormatChecker())
        errors = []
        for error in sorted(validator.iter_errors(parsed), key=lambda e: list(e.absolute_path)):
            path = "/" + "/".join(str(p) for p in error.absolute_path)
            errors.append(f"{path}: {error.message}")
        return errors

    _ARRAY_FIELDS = (
        "strengths",
        "major_concerns",
        "minor_concerns",
        "questions",
        "revision_tasks",
        "limitations",
    )

    @classmethod
    def _normalize(cls, parsed):
        """Deterministically fix common mechanical schema violations.

        LLMs frequently emit `null` where the schema requires an array, and
        empty `evidence` arrays where the schema requires minItems=1. These
        are fixed mechanically instead of relying on the model to self-correct.
        """
        if not isinstance(parsed, dict):
            return parsed

        # 1. null → [] for top-level array fields
        for field in cls._ARRAY_FIELDS:
            if parsed.get(field) is None:
                parsed[field] = []

        # 2. central_contribution with empty evidence → null
        cc = parsed.get("central_contribution")
        if isinstance(cc, dict) and not cc.get("evidence"):
            parsed["central_contribution"] = None

        # 3. Drop strength/concern items with empty or missing evidence
        for field in ("strengths", "major_concerns", "minor_concerns"):
            items = parsed.get(field)
            if isinstance(items, list):
                parsed[field] = [
                    item
                    for item in items
                    if isinstance(item, dict) and item.get("evidence")
                ]

        return parsed

    def structure(self, nl_review, manuscript_title=""):
        """Convert natural language review to structured JSON.

        Includes a self-repair loop: if the first attempt produces invalid JSON
        or violates the schema, the schema errors are fed back to DeepSeek for
        one correction pass.

        Args:
            nl_review: The natural language review text from the 7B model
            manuscript_title: Paper title for context

        Returns:
            Parsed JSON dict conforming to review-schema.json

        Raises:
            StructuringError: If the API call fails or output is invalid after retry
        """
        messages = [
            {"role": "system", "content": STRUCTURING_SYSTEM_PROMPT},
            {"role": "user", "content": self._build_user_prompt(nl_review, manuscript_title)},
        ]

        raw_output = self._call(messages)
        parsed, parse_error = self._parse_output(raw_output)

        # Self-repair pass 1: invalid JSON → ask for a corrected, valid JSON
        if parsed is None:
            repair_messages = list(messages)
            repair_messages.append({
                "role": "user",
                "content": (
                    "你上一次的输出不是有效 JSON。请重新输出一个完整、有效的 JSON 对象，"
                    "以 } 结尾，不要包含 Markdown 代码块或任何额外文字。\n"
                    f"解析错误：{parse_error}"
                ),
            })
            try:
                raw_output = self._call(repair_messages)
                parsed, parse_error = self._parse_output(raw_output)
            except StructuringError:
                pass

        if parsed is None:
            raise StructuringError(
                "DeepSeek 输出不是有效 JSON",
                [parse_error, f"raw (first 500 chars): {raw_output[:500]}"],
            )

        if not isinstance(parsed, dict):
            raise StructuringError("DeepSeek 输出不是 JSON 对象")

        # Deterministic mechanical fixes (null→[], empty evidence, etc.)
        self._normalize(parsed)

        # Self-repair pass 2: remaining schema violations → feed errors back
        schema_errors = self._schema_errors(parsed)
        if schema_errors:
            fix_messages = list(messages)
            fix_messages.append({
                "role": "user",
                "content": (
                    "你上一次输出的 JSON 未通过 Schema 校验，存在以下错误：\n"
                    + "\n".join(f"- {e}" for e in schema_errors[:15])
                    + "\n\n请修正这些问题后重新输出完整的 JSON 对象。"
                    "注意：evidence 数组不能为空；problem/impact/request 必须是具体完整的句子；"
                    "如果某项没有证据，central_contribution 输出 null，strength/concern 删除该项。"
                ),
            })
            try:
                raw_output = self._call(fix_messages)
                fixed, _ = self._parse_output(raw_output)
                if isinstance(fixed, dict):
                    self._normalize(fixed)
                    remaining_errors = self._schema_errors(fixed)
                    if len(remaining_errors) < len(schema_errors):
                        parsed = fixed
                        schema_errors = remaining_errors
            except StructuringError:
                pass

        # Return the best-effort parsed result; the caller (service) will
        # surface any remaining schema errors.
        return parsed


class ScoreStructurer(DeepSeekStructurer):
    """DeepSeek fallback that normalizes a local model's raw score output into a
    single valid venue-score object (used by the per-paper scoring path).

    Unlike the review structurer, this does a single structuring pass: the local
    model already produces JSON-shaped content, and DeepSeek only needs to strip
    noise, fill gaps and enforce the single-paper score schema.
    """

    SCORE_SYSTEM_PROMPT = """你是学术论文评分结构化助手。你的任务是将本地小模型对一篇论文的评分输出（可能是格式不规范、字段缺失或夹杂了额外内容）规范化为符合给定 JSON Schema 的单篇评分对象。

规则：
1. 严格按提供的 JSON Schema 输出，所有必填字段必须存在。
2. originality/rigor/evidence/clarity/reproducibility/venue_fit/overall 必须是 0 到 100 的数字。
3. confidence 必须是 0 到 1 的数字。
4. 只依据输入内容评分，不得编造输入中没有的信息；若某维度缺失，给出保守估计并降低 confidence。
5. strengths 最多 3 条、risks 最多 4 条、limitations 至少 1 条且最多 4 条，每条都是具体完整的中文短句。
6. rationale 不超过 240 字。
7. 只输出纯 JSON 对象，不输出 Markdown、思考过程或额外文字。
"""

    def __init__(self, api_key, schema_path="schemas/venue-score.json", base_url=None):
        super().__init__(api_key, schema_path=schema_path, base_url=base_url)

    def structure(self, raw_output, paper_title=""):
        schema_json = json.dumps(self.schema, ensure_ascii=False, indent=2)
        messages = [
            {"role": "system", "content": self.SCORE_SYSTEM_PROMPT},
            {"role": "user", "content": (
                "论文标题：{}\n\n"
                "本地小模型评分原始输出：\n{}\n\n"
                "目标 JSON Schema：\n{}\n\n"
                "请将上述输出规范化为符合 Schema 的单篇评分 JSON 对象。只输出 JSON。"
            ).format(paper_title, raw_output, schema_json)},
        ]
        raw = self._call(messages)
        parsed, parse_error = self._parse_output(raw)
        if not isinstance(parsed, dict):
            raise StructuringError(
                "DeepSeek 评分结构化输出无效",
                [parse_error or "输出不是 JSON 对象", f"raw (first 500 chars): {raw[:500]}"],
            )
        return parsed
