import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeEvaluationCase } from '../scripts/reviewer-baseline/prepare.mjs';
import { evaluatePredictions, __testables } from '../scripts/reviewer-baseline/evaluate.mjs';

const readJson = async (relativePath) =>
  JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8'));

const readJsonl = async (relativePath) =>
  (await readFile(new URL(relativePath, import.meta.url), 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean)
    .map(JSON.parse);

test('reviewer evaluation cases follow the declared smoke-test contract', async () => {
  const [schema, cases] = await Promise.all([
    readJson('../evaluation/reviewer-baseline/case-schema.json'),
    readJsonl('../evaluation/reviewer-baseline/cases.sample.jsonl'),
  ]);
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(cases.length, 2);
  for (const evaluationCase of cases) {
    assert.equal(evaluationCase.case_schema_version, '1.0.0');
    assert.ok(evaluationCase.manuscript.paragraphs.length > 0);
    assert.equal(
      new Set(evaluationCase.manuscript.paragraphs.map((item) => item.paragraph_id)).size,
      evaluationCase.manuscript.paragraphs.length,
    );
    assert.ok(evaluationCase.gold.acceptable_verdicts.length > 0);
  }
});

test('clean OpenReview records can be converted into unlabelled evaluation cases', () => {
  const record = {
    dataset_schema_version: '1.0.0',
    source: { forum_id: 'forum-1', venue_id: 'Venue/2024', year: 2024 },
    paper: {
      title: 'A Reliable Reviewer',
      abstract: 'We evaluate a reviewer.',
      paragraphs: [{ section: 'Abstract', paragraph_id: 'p-01', text: 'We evaluate a reviewer.' }],
    },
    reviews: [{ review_id: 'review-1', combined_text: 'The evaluation is clear.', rating: 7 }],
  };
  const result = makeEvaluationCase(record, 'test');
  assert.equal(result.case_id, 'openreview-forum-1');
  assert.equal(result.manuscript.language, 'en');
  assert.equal(result.gold, null);
  assert.equal(result.human_references[0].review_id, 'review-1');
});

function perfectReview(evaluationCase) {
  return {
    schema_version: '1.0.0',
    review_id: `baseline-${evaluationCase.case_id}`,
    review_type: 'general',
    review_language: 'zh-CN',
    manuscript: {
      paper_id: evaluationCase.case_id,
      title: evaluationCase.manuscript.title,
      language: evaluationCase.manuscript.language,
      fingerprint: null,
    },
    target_venue: null,
    recommendation: {
      verdict: evaluationCase.gold.acceptable_verdicts[0],
      rationale: '主要实验问题需要在投稿前处理。',
      confidence: 0.9,
    },
    summary: '论文提出了明确的研究方向，但当前证据不足以完整支撑核心结论，需要进一步修改。',
    central_contribution: null,
    strengths: [],
    major_concerns: evaluationCase.gold.issues
      .filter((issue) => issue.severity === 'major')
      .map((issue, index) => {
        const paragraphId = issue.evidence_paragraph_ids[0];
        const paragraph = evaluationCase.manuscript.paragraphs.find((item) => item.paragraph_id === paragraphId);
        return {
          id: `major-${String(index + 1).padStart(2, '0')}`,
          category: issue.category,
          problem: '该问题会影响核心结论的可信度。',
          impact: '现有输入不足以排除替代解释。',
          request: '补充相应说明、分析或实验并核对结论范围。',
          evidence: paragraph
            ? [{ type: 'direct_quote', section: paragraph.section, paragraph_id: paragraph.paragraph_id, excerpt: paragraph.text }]
            : [{ type: 'absence', description: '未提供必要的方法信息。', searched_sections: evaluationCase.manuscript.paragraphs.map((item) => item.section) }],
          confidence: 0.9,
        };
      }),
    minor_concerns: evaluationCase.gold.issues
      .filter((issue) => issue.severity === 'minor')
      .map((issue, index) => {
        const paragraph = evaluationCase.manuscript.paragraphs.find(
          (item) => item.paragraph_id === issue.evidence_paragraph_ids[0],
        );
        return {
          id: `minor-${String(index + 1).padStart(2, '0')}`,
          category: issue.category,
          problem: '统计报告仍不完整。',
          impact: '读者无法判断结果的不确定性。',
          request: '补充统计方法和不确定性结果。',
          evidence: [{ type: 'direct_quote', section: paragraph.section, paragraph_id: paragraph.paragraph_id, excerpt: paragraph.text }],
          confidence: 0.9,
        };
      }),
    questions: [],
    revision_tasks: [],
    limitations: [],
    input_coverage: {
      analyzed_sections: [...new Set(evaluationCase.manuscript.paragraphs.map((item) => item.section))],
      omitted_sections: [],
      total_paragraphs: evaluationCase.manuscript.paragraphs.length,
      analyzed_paragraphs: evaluationCase.manuscript.paragraphs.length,
      truncated: false,
    },
    model_trace: {
      provider: 'test', model: 'test', model_version: '1', adapter_version: null,
      prompt_version: 'test', quantization: null, generated_at: '2026-08-10T00:00:00Z', latency_ms: 100,
    },
  };
}

test('baseline evaluator measures contract, grounded evidence and gold issue matches', async () => {
  const [evaluationCase] = await readJsonl('../evaluation/reviewer-baseline/cases.sample.jsonl');
  const review = perfectReview(evaluationCase);
  assert.deepEqual(__testables.coreContractChecks(review), []);
  const evidence = __testables.evidenceMetrics(review, evaluationCase.manuscript);
  assert.equal(evidence.checked, evidence.grounded);

  const report = evaluatePredictions(
    [evaluationCase],
    [{
      case_id: evaluationCase.case_id,
      status: 'ok',
      schema_valid: true,
      schema_errors: [],
      review,
      usage: { peak_memory_gb: 3.2 },
    }],
  );
  assert.equal(report.summary.generation_success_rate, 1);
  assert.equal(report.summary.schema_valid_rate, 1);
  assert.equal(report.summary.contract_valid_rate, 1);
  assert.equal(report.summary.evidence_grounded_rate, 1);
  assert.equal(report.summary.issue_precision_macro, 1);
  assert.equal(report.summary.issue_recall_macro, 1);
  assert.equal(report.summary.verdict_accuracy, 1);
});

test('baseline evaluator keeps full Schema validity separate from the core contract', async () => {
  const [evaluationCase] = await readJsonl('../evaluation/reviewer-baseline/cases.sample.jsonl');
  const review = perfectReview(evaluationCase);
  const report = evaluatePredictions(
    [evaluationCase],
    [{
      case_id: evaluationCase.case_id,
      status: 'ok',
      schema_valid: false,
      schema_errors: [{ path: '/questions', message: "null is not of type 'array'" }],
      review,
      usage: {},
    }],
  );
  assert.equal(report.summary.json_valid_rate, 1);
  assert.equal(report.summary.contract_valid_rate, 1);
  assert.equal(report.summary.schema_valid_rate, 0);
});
