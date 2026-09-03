#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { argument } from './io.mjs';

const round = (value, digits = 4) => Number(value.toFixed(digits));

async function readJsonl(filePath) {
  return (await readFile(filePath, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function wilson(successes, total, z = 1.959964) {
  if (!total) return null;
  const p = successes / total;
  const denominator = 1 + z ** 2 / total;
  const center = (p + z ** 2 / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z ** 2 / (4 * total)) / total) / denominator;
  return [round(Math.max(0, center - margin)), round(Math.min(1, center + margin))];
}

function metrics(rows) {
  const ties = rows.filter((row) => row.winner === 'tie').length;
  const correct = rows.filter((row) => row.winner === row.expected).length;
  const nonTies = rows.length - ties;
  return {
    pairs: rows.length,
    correct,
    ties,
    tie_rate: round(ties / rows.length),
    non_tie_accuracy: nonTies ? round(correct / nonTies) : null,
    non_tie_accuracy_95ci_wilson: wilson(correct, nonTies),
    tie_half_accuracy: round((correct + 0.5 * ties) / rows.length),
  };
}

function byTopic(rows) {
  return Object.fromEntries([...new Set(rows.map((row) => row.topic))].sort()
    .map((topic) => [topic, metrics(rows.filter((row) => row.topic === topic))]));
}

function byField(rows) {
  return Object.fromEntries([...new Set(rows.map((row) => row.field))].sort()
    .map((field) => [field, metrics(rows.filter((row) => row.field === field))]));
}

function pairedBootstrapDifference(largeRows, rankerRows, iterations = 5_000) {
  let state = 42;
  const random = () => ((state = (1664525 * state + 1013904223) >>> 0) / 2 ** 32);
  const differences = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let large = 0;
    let ranker = 0;
    for (let draw = 0; draw < largeRows.length; draw += 1) {
      const index = Math.floor(random() * largeRows.length);
      large += largeRows[index].winner === largeRows[index].expected ? 1 : largeRows[index].winner === 'tie' ? 0.5 : 0;
      ranker += rankerRows[index].winner === rankerRows[index].expected ? 1 : rankerRows[index].winner === 'tie' ? 0.5 : 0;
    }
    differences.push((large - ranker) / largeRows.length);
  }
  differences.sort((a, b) => a - b);
  return [round(differences[Math.floor(iterations * 0.025)]), round(differences[Math.floor(iterations * 0.975)])];
}

const pairsPath = path.resolve(argument('pairs', 'evaluation/venue-tier/runs/ccf-1000/pairs.private.jsonl'));
const rankerScoresPath = path.resolve(argument('ranker-scores', 'evaluation/venue-tier/runs/ccf-1000/ranker-scores.jsonl'));
const largeResultsPath = path.resolve(argument('large-results', 'evaluation/venue-tier/runs/ccf-1000/deepseek/pairwise-results.jsonl'));
const largeSwappedArgument = argument('large-swapped-results');
const largeSwappedPath = largeSwappedArgument ? path.resolve(largeSwappedArgument) : null;
const outputPath = path.resolve(argument('output', 'evaluation/venue-tier/runs/ccf-1000/model-comparison.json'));
const datasetLabel = argument('dataset-label', 'CCF 2025 T1/T2 venue-tier weak-label pairs');
const [pairs, rankerScores, largeResults, largeSwappedResults] = await Promise.all([
  readJsonl(pairsPath), readJsonl(rankerScoresPath), readJsonl(largeResultsPath), largeSwappedPath ? readJsonl(largeSwappedPath) : Promise.resolve([]),
]);
const rankerById = new Map(rankerScores.map((row) => [row.paper_id, row]));
const largeById = new Map(largeResults.map((row) => [row.pair_id, row]));
const largeSwappedById = new Map(largeSwappedResults.map((row) => [row.pair_id, row]));

const rankerRows = pairs.map((pair) => {
  const a = rankerById.get(pair.a_id)?.raw_score;
  const b = rankerById.get(pair.b_id)?.raw_score;
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`Missing Ranker score for ${pair.pair_id}.`);
  return { pair_id: pair.pair_id, field: pair.field, topic: pair.topic, expected: pair.expected_venue_winner, winner: a === b ? 'tie' : a > b ? 'A' : 'B' };
});
const largeRows = pairs.map((pair) => {
  const result = largeById.get(pair.pair_id);
  if (!result) throw new Error(`Missing large-model result for ${pair.pair_id}.`);
  const swapped = largeSwappedPath ? largeSwappedById.get(pair.pair_id) : null;
  if (largeSwappedPath && !swapped) throw new Error(`Missing swapped large-model result for ${pair.pair_id}.`);
  const winner = swapped && swapped.winner !== result.winner ? 'tie' : result.winner;
  return { pair_id: pair.pair_id, field: pair.field, topic: pair.topic, expected: pair.expected_venue_winner, winner };
});

const discordance = { large_correct_ranker_wrong: 0, ranker_correct_large_wrong: 0, both_correct: 0, both_wrong_or_tie: 0 };
let agreement = 0;
for (let index = 0; index < pairs.length; index += 1) {
  const largeCorrect = largeRows[index].winner === largeRows[index].expected;
  const rankerCorrect = rankerRows[index].winner === rankerRows[index].expected;
  if (largeRows[index].winner === rankerRows[index].winner) agreement += 1;
  if (largeCorrect && rankerCorrect) discordance.both_correct += 1;
  else if (largeCorrect) discordance.large_correct_ranker_wrong += 1;
  else if (rankerCorrect) discordance.ranker_correct_large_wrong += 1;
  else discordance.both_wrong_or_tie += 1;
}
const largeMetrics = metrics(largeRows);
const rankerMetrics = metrics(rankerRows);
const report = {
  schema_version: '1.0.0',
  dataset: datasetLabel,
  interpretation: 'This measures agreement with venue-tier weak labels, not objective paper quality or acceptance probability.',
  pairs: pairs.length,
  ranker: { ...rankerMetrics, by_field: byField(rankerRows), by_topic: byTopic(rankerRows) },
  large_model: { protocol: largeSwappedPath ? 'dual_orientation_consensus' : 'single_orientation', ...largeMetrics, by_field: byField(largeRows), by_topic: byTopic(largeRows) },
  comparison: {
    large_minus_ranker_tie_half_accuracy: round(largeMetrics.tie_half_accuracy - rankerMetrics.tie_half_accuracy),
    paired_bootstrap_95ci: pairedBootstrapDifference(largeRows, rankerRows),
    exact_winner_agreement: round(agreement / pairs.length),
    discordance,
  },
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
