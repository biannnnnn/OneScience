import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, readJsonl, requireArg, writeJson } from '../openreview/lib.mjs';
import { writeFile } from 'node:fs/promises';

const VERDICTS = [
  'ready_for_submission',
  'minor_revision',
  'major_revision',
  'fundamental_revision',
  'insufficient_evidence',
];
const CATEGORIES = new Set([
  'research_question', 'contribution_novelty', 'scope_relevance', 'related_work',
  'methodology', 'experimental_design', 'data_quality', 'statistical_analysis',
  'results_interpretation', 'conclusion_support', 'reproducibility',
  'ethics_compliance', 'limitations', 'writing_clarity', 'structure',
  'figures_tables', 'references', 'other',
]);

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function concernList(review) {
  return [
    ...(Array.isArray(review?.major_concerns)
      ? review.major_concerns.map((item) => ({ ...item, severity: 'major' }))
      : []),
    ...(Array.isArray(review?.minor_concerns)
      ? review.minor_concerns.map((item) => ({ ...item, severity: 'minor' }))
      : []),
  ];
}

function validLocation(location) {
  return Boolean(location?.section && location?.paragraph_id && location?.excerpt);
}

function validEvidence(evidence) {
  if (evidence?.type === 'direct_quote') return validLocation(evidence);
  if (evidence?.type === 'absence') {
    return Boolean(evidence.description && Array.isArray(evidence.searched_sections) && evidence.searched_sections.length);
  }
  if (evidence?.type === 'cross_section') {
    return Boolean(
      evidence.description
      && Array.isArray(evidence.locations)
      && evidence.locations.length >= 2
      && evidence.locations.every(validLocation)
    );
  }
  return false;
}

function coreContractChecks(review) {
  const errors = [];
  if (!review || typeof review !== 'object') return ['review_missing'];
  if (!VERDICTS.includes(review.recommendation?.verdict)) errors.push('invalid_recommendation');
  if (typeof review.summary !== 'string' || review.summary.length < 20) errors.push('invalid_summary');
  for (const key of ['strengths', 'major_concerns', 'minor_concerns', 'questions', 'revision_tasks', 'limitations']) {
    if (!Array.isArray(review[key])) errors.push(`${key}_not_array`);
  }
  const concerns = concernList(review);
  const concernIds = new Set(concerns.map((item) => item.id));
  for (const concern of concerns) {
    if (!concern.id || !concern.category || !concern.problem || !concern.impact || !concern.request) {
      errors.push('incomplete_concern');
    }
    if (!CATEGORIES.has(concern.category)) errors.push('invalid_category');
    if (!Array.isArray(concern.evidence) || !concern.evidence.length) errors.push('concern_without_evidence');
    else if (!concern.evidence.every(validEvidence)) errors.push('invalid_evidence_shape');
  }
  for (const strength of review.strengths || []) {
    if (!strength.id || !CATEGORIES.has(strength.category) || !strength.point) errors.push('incomplete_strength');
    if (!Array.isArray(strength.evidence) || !strength.evidence.length || !strength.evidence.every(validEvidence)) {
      errors.push('strength_invalid_evidence');
    }
  }
  if (review.central_contribution !== null) {
    if (
      !review.central_contribution?.claim
      || !Array.isArray(review.central_contribution?.evidence)
      || !review.central_contribution.evidence.length
      || !review.central_contribution.evidence.every(validEvidence)
    ) errors.push('invalid_central_contribution');
  }
  for (const task of review.revision_tasks || []) {
    if (!Array.isArray(task.source_concern_ids) || !task.source_concern_ids.length) errors.push('task_without_source');
    else if (task.source_concern_ids.some((id) => !concernIds.has(id))) errors.push('task_invalid_source');
    if (!task.action || !task.acceptance_criteria) errors.push('incomplete_task');
  }
  return [...new Set(errors)];
}

function allEvidence(review) {
  const owners = [];
  if (review?.central_contribution?.evidence) owners.push(...review.central_contribution.evidence);
  for (const item of review?.strengths || []) owners.push(...(item.evidence || []));
  for (const item of concernList(review)) owners.push(...(item.evidence || []));
  return owners;
}

function evidenceLocations(evidence) {
  if (evidence?.type === 'direct_quote') return [evidence];
  if (evidence?.type === 'cross_section') return Array.isArray(evidence.locations) ? evidence.locations : [];
  return [];
}

function evidenceMetrics(review, manuscript) {
  const paragraphs = new Map(manuscript.paragraphs.map((item) => [item.paragraph_id, item]));
  const sections = new Set(manuscript.paragraphs.map((item) => item.section));
  const evidence = allEvidence(review);
  let checked = 0;
  let grounded = 0;
  for (const item of evidence) {
    if (item?.type === 'absence') {
      checked += 1;
      const searched = Array.isArray(item.searched_sections) ? item.searched_sections : [];
      if (searched.length && searched.every((section) => sections.has(section))) grounded += 1;
      continue;
    }
    const locations = evidenceLocations(item);
    if (!locations.length) {
      checked += 1;
      continue;
    }
    for (const location of locations) {
      checked += 1;
      const paragraph = paragraphs.get(location.paragraph_id);
      if (
        paragraph
        && paragraph.section === location.section
        && typeof location.excerpt === 'string'
        && paragraph.text.includes(location.excerpt)
      ) grounded += 1;
    }
  }
  return { checked, grounded };
}

function predictedEvidenceIds(concern) {
  const result = new Set();
  for (const evidence of concern.evidence || []) {
    for (const location of evidenceLocations(evidence)) {
      if (location.paragraph_id) result.add(location.paragraph_id);
    }
  }
  return result;
}

function matchesGold(predicted, gold) {
  const categories = gold.acceptable_categories || [gold.category];
  if (predicted.severity !== gold.severity || !categories.includes(predicted.category)) return false;
  if (!gold.evidence_paragraph_ids?.length) return true;
  const predictedIds = predictedEvidenceIds(predicted);
  return gold.evidence_paragraph_ids.some((id) => predictedIds.has(id));
}

function goldMetrics(review, gold) {
  if (!gold) return null;
  const predicted = concernList(review);
  const matchedGold = new Set();
  const matchedPredicted = new Set();
  predicted.forEach((concern, predictedIndex) => {
    gold.issues.forEach((issue, goldIndex) => {
      if (!matchedGold.has(goldIndex) && matchesGold(concern, issue)) {
        matchedGold.add(goldIndex);
        matchedPredicted.add(predictedIndex);
      }
    });
  });
  const precision = ratio(matchedPredicted.size, predicted.length);
  const recall = ratio(matchedGold.size, gold.issues.length);
  return {
    matched: matchedGold.size,
    predicted: predicted.length,
    expected: gold.issues.length,
    precision,
    recall,
    f1: precision === null || recall === null || precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall),
    verdict_correct: gold.acceptable_verdicts.includes(review.recommendation?.verdict),
  };
}

export function evaluatePredictions(cases, predictions) {
  const caseById = new Map(cases.map((item) => [item.case_id, item]));
  const details = [];
  for (const prediction of predictions) {
    const evaluationCase = caseById.get(prediction.case_id);
    if (!evaluationCase) continue;
    const review = prediction.review;
    const contractErrors = coreContractChecks(review);
    const evidence = review
      ? evidenceMetrics(review, evaluationCase.manuscript)
      : { checked: 0, grounded: 0 };
    const gold = review ? goldMetrics(review, evaluationCase.gold) : null;
    details.push({
      case_id: prediction.case_id,
      status: prediction.status,
      json_valid: Boolean(review),
      schema_valid: typeof prediction.schema_valid === 'boolean'
        ? prediction.schema_valid
        : null,
      schema_errors: prediction.schema_errors || [],
      contract_valid: Boolean(review) && contractErrors.length === 0,
      contract_errors: contractErrors,
      evidence,
      gold,
      latency_ms: review?.model_trace?.latency_ms ?? null,
      peak_memory_gb: prediction.usage?.peak_memory_gb ?? null,
    });
  }

  const goldDetails = details.filter((item) => item.gold);
  const evidenceChecked = details.reduce((sum, item) => sum + item.evidence.checked, 0);
  const evidenceGrounded = details.reduce((sum, item) => sum + item.evidence.grounded, 0);
  const latencies = details.map((item) => item.latency_ms).filter(Number.isFinite);
  const memories = details.map((item) => item.peak_memory_gb).filter(Number.isFinite);
  return {
    summary: {
      cases_expected: cases.length,
      predictions_received: details.length,
      generation_success_rate: ratio(details.filter((item) => item.status === 'ok').length, cases.length),
      json_valid_rate: ratio(details.filter((item) => item.json_valid).length, cases.length),
      schema_valid_rate: details.some((item) => item.schema_valid !== null)
        ? ratio(details.filter((item) => item.schema_valid).length, cases.length)
        : null,
      contract_valid_rate: ratio(details.filter((item) => item.contract_valid).length, cases.length),
      evidence_grounded_rate: ratio(evidenceGrounded, evidenceChecked),
      issue_precision_macro: mean(goldDetails.map((item) => item.gold.precision).filter((value) => value !== null)),
      issue_recall_macro: mean(goldDetails.map((item) => item.gold.recall).filter((value) => value !== null)),
      issue_f1_macro: mean(goldDetails.map((item) => item.gold.f1)),
      verdict_accuracy: ratio(goldDetails.filter((item) => item.gold.verdict_correct).length, goldDetails.length),
      latency_ms_p50: percentile(latencies, 0.5),
      latency_ms_p95: percentile(latencies, 0.95),
      peak_memory_gb_max: memories.length ? Math.max(...memories) : null,
    },
    details,
  };
}

function percent(value) {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function markdownReport(report, metadata) {
  const summary = report.summary;
  const title = metadata.adapter_version ? 'Qwen3-4B OpenReview LoRA 审稿基线' : 'Qwen3-4B 未微调审稿基线';
  return `# ${title}\n\n`
    + `- 样本数：${summary.predictions_received}/${summary.cases_expected}\n`
    + `- 模型：${metadata.model_id}\n`
    + `- 模型 revision：${metadata.model_revision}\n`
    + `- 运行时：${metadata.runtime} ${metadata.runtime_version}\n`
    + `- MLX：${metadata.mlx_version}\n`
    + `- Prompt：${metadata.prompt_version}\n`
    + `- 基线版本：${metadata.baseline_version}\n`
    + `- 生成时间：${new Date().toISOString()}\n\n`
    + `| 指标 | 结果 |\n|---|---:|\n`
    + `| 生成成功率 | ${percent(summary.generation_success_rate)} |\n`
    + `| JSON 有效率 | ${percent(summary.json_valid_rate)} |\n`
    + `| 完整 review-schema 通过率 | ${percent(summary.schema_valid_rate)} |\n`
    + `| 核心协议通过率 | ${percent(summary.contract_valid_rate)} |\n`
    + `| 证据可定位率 | ${percent(summary.evidence_grounded_rate)} |\n`
    + `| 问题精确率（宏平均） | ${percent(summary.issue_precision_macro)} |\n`
    + `| 问题召回率（宏平均） | ${percent(summary.issue_recall_macro)} |\n`
    + `| 问题 F1（宏平均） | ${percent(summary.issue_f1_macro)} |\n`
    + `| 准备度结论准确率 | ${percent(summary.verdict_accuracy)} |\n`
    + `| P50 时延 | ${summary.latency_ms_p50 ?? '—'} ms |\n`
    + `| P95 时延 | ${summary.latency_ms_p95 ?? '—'} ms |\n`
    + `| 峰值内存 | ${summary.peak_memory_gb_max ?? '—'} GB |\n\n`
    + `> 样例集只用于流水线烟雾测试，不能代表模型真实学术审稿能力。正式结论必须使用冻结的 OpenReview 时间留出集和专家盲评集。\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cases = await readJsonl(path.resolve(requireArg(args, 'cases')));
  const predictions = await readJsonl(path.resolve(requireArg(args, 'predictions')));
  const config = JSON.parse(await (await import('node:fs/promises')).readFile(path.resolve(requireArg(args, 'config')), 'utf8'));
  const outputDir = path.resolve(requireArg(args, 'out'));
  const report = evaluatePredictions(cases, predictions);
  await writeJson(path.join(outputDir, 'metrics.json'), { metadata: config, ...report });
  await writeFile(path.join(outputDir, 'report.md'), markdownReport(report, config), 'utf8');
  console.log(`评测完成：${report.summary.predictions_received}/${report.summary.cases_expected} 个样本`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

export const __testables = { coreContractChecks, evidenceMetrics, goldMetrics };
