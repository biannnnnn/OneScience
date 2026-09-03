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

function byGroup(rows, key) {
  return Object.fromEntries([...new Set(rows.map((row) => row[key]))].sort()
    .map((value) => [value, metrics(rows.filter((row) => row[key] === value))]));
}

function credit(row) {
  if (row.winner === row.expected) return 1;
  if (row.winner === 'tie') return 0.5;
  return 0;
}

function pairedBootstrapDifference(firstRows, secondRows, iterations = 10_000) {
  let state = 42;
  const random = () => ((state = (1664525 * state + 1013904223) >>> 0) / 2 ** 32);
  const differences = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let difference = 0;
    for (let draw = 0; draw < firstRows.length; draw += 1) {
      const index = Math.floor(random() * firstRows.length);
      difference += credit(firstRows[index]) - credit(secondRows[index]);
    }
    differences.push(difference / firstRows.length);
  }
  differences.sort((a, b) => a - b);
  return [round(differences[Math.floor(iterations * 0.025)]), round(differences[Math.floor(iterations * 0.975)])];
}

function compare(firstName, firstRows, secondName, secondRows) {
  let agreement = 0;
  const discordance = { both_correct: 0, first_only_correct: 0, second_only_correct: 0, neither_correct: 0 };
  for (let index = 0; index < firstRows.length; index += 1) {
    const firstCorrect = firstRows[index].winner === firstRows[index].expected;
    const secondCorrect = secondRows[index].winner === secondRows[index].expected;
    if (firstRows[index].winner === secondRows[index].winner) agreement += 1;
    if (firstCorrect && secondCorrect) discordance.both_correct += 1;
    else if (firstCorrect) discordance.first_only_correct += 1;
    else if (secondCorrect) discordance.second_only_correct += 1;
    else discordance.neither_correct += 1;
  }
  const firstMetrics = metrics(firstRows);
  const secondMetrics = metrics(secondRows);
  return {
    first: firstName,
    second: secondName,
    first_minus_second_tie_half_accuracy: round(firstMetrics.tie_half_accuracy - secondMetrics.tie_half_accuracy),
    paired_bootstrap_95ci: pairedBootstrapDifference(firstRows, secondRows),
    exact_winner_agreement: round(agreement / firstRows.length),
    discordance,
  };
}

const pairsPath = path.resolve(argument('pairs'));
const outputPath = path.resolve(argument('output'));
const modelSpecs = [
  ['ranker_8b', path.resolve(argument('ranker-8b'))],
  ['qwen25_3b', path.resolve(argument('ranker-3b'))],
  ['qwen3_0_6b', path.resolve(argument('ranker-0.6b'))],
];
const pairs = await readJsonl(pairsPath);
const modelRows = {};

for (const [name, scoresPath] of modelSpecs) {
  const scores = await readJsonl(scoresPath);
  const byId = new Map(scores.map((row) => [row.paper_id, row.raw_score]));
  if (byId.size !== scores.length) throw new Error(`${name}: duplicate paper_id in ${scoresPath}`);
  modelRows[name] = pairs.map((pair) => {
    const a = byId.get(pair.a_id);
    const b = byId.get(pair.b_id);
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`${name}: missing score for ${pair.pair_id}`);
    return {
      pair_id: pair.pair_id,
      field: pair.field,
      topic: pair.topic,
      expected: pair.expected_venue_winner,
      winner: a === b ? 'tie' : a > b ? 'A' : 'B',
    };
  });
}

const models = Object.fromEntries(modelSpecs.map(([name]) => [name, {
  ...metrics(modelRows[name]),
  by_field: byGroup(modelRows[name], 'field'),
  by_topic: byGroup(modelRows[name], 'topic'),
}]));
const comparisons = [];
for (let first = 0; first < modelSpecs.length; first += 1) {
  for (let second = first + 1; second < modelSpecs.length; second += 1) {
    const firstName = modelSpecs[first][0];
    const secondName = modelSpecs[second][0];
    comparisons.push(compare(firstName, modelRows[firstName], secondName, modelRows[secondName]));
  }
}

const report = {
  schema_version: '1.0.0',
  dataset: 'CCF-A versus CCF-C physical-paper pairs',
  interpretation: 'Venue tiers are weak labels. Results measure agreement with venue tier, not objective paper quality or acceptance probability.',
  pairs: pairs.length,
  models,
  comparisons,
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
