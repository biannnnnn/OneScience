#!/usr/bin/env node
import 'dotenv/config';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { scorePapersWithDeepSeek } from '../../server/lib/deepseek-scorer.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function ranks(values) {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const result = Array(values.length).fill(0);
  for (let start = 0; start < order.length;) {
    let end = start + 1;
    while (end < order.length && order[end].value === order[start].value) end += 1;
    const average = (start + end - 1) / 2;
    for (let index = start; index < end; index += 1) result[order[index].index] = average;
    start = end;
  }
  return result;
}

function pearson(left, right) {
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  const numerator = left.reduce((sum, value, index) => sum + (value - leftMean) * (right[index] - rightMean), 0);
  const leftScale = Math.sqrt(left.reduce((sum, value) => sum + (value - leftMean) ** 2, 0));
  const rightScale = Math.sqrt(right.reduce((sum, value) => sum + (value - rightMean) ** 2, 0));
  return leftScale && rightScale ? numerator / (leftScale * rightScale) : 0;
}

function spearman(left, right) {
  return pearson(ranks(left), ranks(right));
}

function auc(labels, scores) {
  const scoreRanks = ranks(scores).map((rank) => rank + 1);
  const positives = labels.reduce((sum, label) => sum + label, 0);
  const negatives = labels.length - positives;
  const positiveRankSum = scoreRanks.reduce((sum, rank, index) => sum + (labels[index] ? rank : 0), 0);
  return (positiveRankSum - positives * (positives + 1) / 2) / (positives * negatives);
}

function pairwiseAccuracy(target, predicted) {
  let correct = 0;
  let comparable = 0;
  for (let left = 0; left < target.length; left += 1) {
    for (let right = left + 1; right < target.length; right += 1) {
      const targetDiff = target[left] - target[right];
      const predictedDiff = predicted[left] - predicted[right];
      if (targetDiff === 0 || predictedDiff === 0) continue;
      comparable += 1;
      if (Math.sign(targetDiff) === Math.sign(predictedDiff)) correct += 1;
    }
  }
  return { accuracy: comparable ? correct / comparable : 0, comparable };
}

function groupedPairwise(target, predicted, groups, mode = 'continuous') {
  let correct = 0;
  let comparable = 0;
  for (let left = 0; left < target.length; left += 1) {
    for (let right = left + 1; right < target.length; right += 1) {
      if (groups[left] !== groups[right]) continue;
      const targetDiff = target[left] - target[right];
      const predictedDiff = predicted[left] - predicted[right];
      if (targetDiff === 0) continue;
      comparable += 1;
      if (predictedDiff === 0) correct += mode === 'binary' ? 0.5 : 0;
      else if (Math.sign(targetDiff) === Math.sign(predictedDiff)) correct += 1;
    }
  }
  return { accuracy: comparable ? correct / comparable : 0, comparable };
}

function distribution(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    mean: round(mean, 2),
    standard_deviation: round(Math.sqrt(variance), 2),
    unique_values: new Set(values).size,
  };
}

function round(value, digits = 4) {
  return Math.round(value * 10 ** digits) / 10 ** digits;
}

const casesPath = path.resolve(argument('cases', 'evaluation/deepseek-vs-naipv2/runs/seed42-n32/cases.jsonl'));
const outputDir = path.resolve(argument('output-dir', path.dirname(casesPath)));
const batchSize = Math.max(2, Math.min(Number(argument('batch-size', '8')), 9));
const thinkingArgument = argument('thinking', '');
const thinking = ['enabled', 'disabled'].includes(thinkingArgument) ? thinkingArgument : undefined;
const cases = (await readFile(casesPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
await mkdir(outputDir, { recursive: true });
const predictionsPath = path.join(outputDir, 'deepseek-predictions.jsonl');
let existing = [];
try {
  existing = (await readFile(predictionsPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const resultById = new Map(existing.map((row) => [row.paper_id, row]));

for (let start = 0; start < cases.length; start += batchSize) {
  const batch = cases.slice(start, start + batchSize);
  if (batch.every((item) => resultById.has(item.paper_id))) continue;
  const started = performance.now();
  const result = await scorePapersWithDeepSeek(batch.map((item) => ({
    paperId: item.paper_id,
    title: item.title,
    abstract: item.abstract,
  })), { timeoutMs: 180_000, ...(thinking ? { thinking } : {}) });
  const latencyMs = Math.round(performance.now() - started);
  for (const score of result.scores) {
    const row = {
      ...score,
      latency_ms_batch: latencyMs,
      usage_batch: result.modelTrace.usage,
      request_id: result.modelTrace.requestId,
      model: result.modelTrace.model,
      prompt_version: result.modelTrace.prompt_version,
      thinking: thinking || 'configured-default',
    };
    resultById.set(row.paper_id, row);
    await appendFile(predictionsPath, `${JSON.stringify(row)}\n`, 'utf8');
  }
  console.log(JSON.stringify({ event: 'batch_complete', start, size: batch.length, latency_ms: latencyMs, usage: result.modelTrace.usage }));
}

const effectiveThinking = thinking || (process.env.DEEPSEEK_SCORING_THINKING === 'enabled' ? 'enabled' : 'disabled');
const joined = cases.map((item) => ({
  ...item,
  deepseek: resultById.has(item.paper_id)
    ? { ...resultById.get(item.paper_id), thinking: resultById.get(item.paper_id).thinking || effectiveThinking }
    : null,
}));
if (joined.some((item) => !item.deepseek)) throw new Error('DeepSeek predictions are incomplete.');
// Normalize the resumable append log after a complete run. This also removes
// duplicate rows if two resumed evaluator processes briefly overlapped.
await writeFile(
  predictionsPath,
  `${joined.map((item) => JSON.stringify(item.deepseek)).join('\n')}\n`,
  'utf8',
);
const labels = joined.map((item) => item.accept);
const rts = joined.map((item) => item.rts);
const deepseek = joined.map((item) => item.deepseek.score);
const naipv2 = joined.map((item) => item.naipv2_score);
const requestIds = joined.map((item) => item.deepseek.request_id);
const batchRequests = new Map();
for (const item of joined) {
  batchRequests.set(item.deepseek.request_id, {
    latency_ms: item.deepseek.latency_ms_batch,
    usage: item.deepseek.usage_batch,
  });
}
const requests = [...batchRequests.values()];
const totals = requests.reduce((accumulator, request) => ({
  latency_ms: accumulator.latency_ms + request.latency_ms,
  prompt_tokens: accumulator.prompt_tokens + (request.usage?.promptTokens || 0),
  completion_tokens: accumulator.completion_tokens + (request.usage?.completionTokens || 0),
  total_tokens: accumulator.total_tokens + (request.usage?.totalTokens || 0),
}), { latency_ms: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });

const metrics = {
  schema_version: '1.0.0',
  dataset: 'NAIDv2 fixed public test stratified subset',
  rows: joined.length,
  note: 'NAIPv2 scores are archived predictions from official published weights, not the currently unreachable private retrained service.',
  deepseek: {
    model: joined[0].deepseek.model,
    prompt_version: joined[0].deepseek.prompt_version,
    thinking: joined[0].deepseek.thinking,
    auc_vs_accept: round(auc(labels, deepseek)),
    spearman_vs_rts: round(spearman(deepseek, rts)),
    pairwise_accuracy_vs_rts: round(pairwiseAccuracy(rts, deepseek).accuracy),
    within_batch_auc_vs_accept: round(groupedPairwise(labels, deepseek, requestIds, 'binary').accuracy),
    within_batch_pairwise_accuracy_vs_rts: round(groupedPairwise(rts, deepseek, requestIds).accuracy),
    mean_accept_score: round(deepseek.filter((_, index) => labels[index] === 1).reduce((sum, value) => sum + value, 0) / labels.filter(Boolean).length, 2),
    mean_reject_score: round(deepseek.filter((_, index) => labels[index] === 0).reduce((sum, value) => sum + value, 0) / labels.filter((value) => !value).length, 2),
    score_distribution: distribution(deepseek),
  },
  naipv2_official_weights: {
    auc_vs_accept: round(auc(labels, naipv2)),
    spearman_vs_rts: round(spearman(naipv2, rts)),
    pairwise_accuracy_vs_rts: round(pairwiseAccuracy(rts, naipv2).accuracy),
    within_batch_auc_vs_accept: round(groupedPairwise(labels, naipv2, requestIds, 'binary').accuracy),
    within_batch_pairwise_accuracy_vs_rts: round(groupedPairwise(rts, naipv2, requestIds).accuracy),
    score_distribution: distribution(naipv2),
  },
  agreement: {
    spearman_scores: round(spearman(deepseek, naipv2)),
    pairwise_order_agreement: round(pairwiseAccuracy(naipv2, deepseek).accuracy),
  },
  deepseek_runtime: {
    requests: requests.length,
    batch_size: batchSize,
    ...totals,
    mean_latency_ms_per_request: round(totals.latency_ms / requests.length, 1),
  },
};
await writeFile(path.join(outputDir, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');
await writeFile(path.join(outputDir, 'joined-results.json'), `${JSON.stringify(joined, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(metrics, null, 2));
