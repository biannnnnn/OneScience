#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { argument } from './io.mjs';

const round = (value, digits = 4) => Number(value.toFixed(digits));
const readJsonl = async (filePath) => (await readFile(filePath, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);

function wilson(successes, total, z = 1.959964) {
  if (!total) return null;
  const p = successes / total;
  const denominator = 1 + z ** 2 / total;
  const center = (p + z ** 2 / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z ** 2 / (4 * total)) / total) / denominator;
  return [round(Math.max(0, center - margin)), round(Math.min(1, center + margin))];
}

function summarize(rows) {
  const ties = rows.filter((row) => row.winner === 'tie').length;
  const correct = rows.filter((row) => row.winner === row.label).length;
  const nonTies = rows.length - ties;
  return {
    pairs: rows.length,
    correct,
    ties,
    non_tie_accuracy: nonTies ? round(correct / nonTies) : null,
    non_tie_accuracy_95ci_wilson: wilson(correct, nonTies),
    tie_half_accuracy: round((correct + 0.5 * ties) / rows.length),
  };
}

const pairsPath = path.resolve(argument('pairs', 'evaluation/venue-tier/runs/ccf-1000/pairs.dataset.jsonl'));
const resultsPath = path.resolve(argument('results', 'evaluation/venue-tier/runs/ccf-1000/deepseek/pairwise-results.jsonl'));
const runPath = path.resolve(argument('run', 'evaluation/venue-tier/runs/ccf-1000/deepseek/run.json'));
const outputPath = path.resolve(argument('output', 'evaluation/venue-tier/runs/ccf-1000/deepseek/metrics.json'));
const datasetLabel = argument('dataset-label', 'CCF 2025 T1/T2 venue-tier weak-label pairs');
const [pairs, results, run] = await Promise.all([readJsonl(pairsPath), readJsonl(resultsPath), readFile(runPath, 'utf8').then(JSON.parse)]);
const resultById = new Map(results.map((row) => [row.pair_id, row]));
const joined = pairs.map((pair) => {
  const result = resultById.get(pair.pair_id);
  if (!result) throw new Error(`Missing result for ${pair.pair_id}.`);
  return { ...pair, winner: result.winner, confidence: Number(result.confidence) || 0 };
});
const grouped = (field) => Object.fromEntries([...new Set(joined.map((row) => row[field]))].sort()
  .map((value) => [value, summarize(joined.filter((row) => row[field] === value))]));
const report = {
  schema_version: '1.0.0',
  dataset: datasetLabel,
  interpretation: 'Experimental agreement with venue-tier weak labels; not objective paper quality or acceptance probability.',
  model: run.model,
  prompt_version: run.prompt_version,
  protocol: { type: 'independent_pairwise_comparison', batch_size: run.batch_size, thinking: run.thinking },
  overall: summarize(joined),
  by_topic: grouped('topic'),
  orientation_audit: {
    label_a_pairs: joined.filter((row) => row.label === 'A').length,
    label_b_pairs: joined.filter((row) => row.label === 'B').length,
    accuracy_when_label_a: summarize(joined.filter((row) => row.label === 'A')).non_tie_accuracy,
    accuracy_when_label_b: summarize(joined.filter((row) => row.label === 'B')).non_tie_accuracy,
    predicted_a_rate: round(joined.filter((row) => row.winner === 'A').length / joined.length),
    predicted_b_rate: round(joined.filter((row) => row.winner === 'B').length / joined.length),
    predicted_tie_rate: round(joined.filter((row) => row.winner === 'tie').length / joined.length),
  },
  mean_confidence: round(joined.reduce((sum, row) => sum + row.confidence, 0) / joined.length),
  runtime: run.runtime,
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
