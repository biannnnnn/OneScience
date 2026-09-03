#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { argument } from './io.mjs';

const round = (value, digits = 4) => Number(value.toFixed(digits));
const readJsonl = async (filePath) => (await readFile(filePath, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);

function wilson(successes, total, z = 1.959964) {
  if (!total) return null;
  const p = successes / total;
  const d = 1 + z ** 2 / total;
  const c = (p + z ** 2 / (2 * total)) / d;
  const m = z * Math.sqrt((p * (1 - p) + z ** 2 / (4 * total)) / total) / d;
  return [round(Math.max(0, c - m)), round(Math.min(1, c + m))];
}

function summarize(rows) {
  const ties = rows.filter((row) => row.winner === 'tie').length;
  const correct = rows.filter((row) => row.winner === row.label).length;
  const nonTies = rows.length - ties;
  return {
    pairs: rows.length,
    correct,
    ties,
    coverage_without_orientation_conflict: round(nonTies / rows.length),
    non_tie_accuracy: nonTies ? round(correct / nonTies) : null,
    non_tie_accuracy_95ci_wilson: wilson(correct, nonTies),
    tie_half_accuracy: round((correct + 0.5 * ties) / rows.length),
  };
}

const pairsPath = path.resolve(argument('pairs', 'evaluation/venue-tier/runs/ccf-1000/pairs.dataset.jsonl'));
const originalPath = path.resolve(argument('original', 'evaluation/venue-tier/runs/ccf-1000/deepseek/pairwise-results.jsonl'));
const swappedPath = path.resolve(argument('swapped', 'evaluation/venue-tier/runs/ccf-1000/deepseek-swapped/pairwise-results.jsonl'));
const outputPath = path.resolve(argument('output', 'evaluation/venue-tier/runs/ccf-1000/deepseek-dual-orientation.json'));
const [pairs, original, swapped] = await Promise.all([readJsonl(pairsPath), readJsonl(originalPath), readJsonl(swappedPath)]);
const originalById = new Map(original.map((row) => [row.pair_id, row]));
const swappedById = new Map(swapped.map((row) => [row.pair_id, row]));
const rows = pairs.map((pair) => {
  const first = originalById.get(pair.pair_id)?.winner;
  const second = swappedById.get(pair.pair_id)?.winner;
  if (!first || !second) throw new Error(`Missing orientation result for ${pair.pair_id}.`);
  return { pair_id: pair.pair_id, field: pair.field, topic: pair.topic, label: pair.label, original: first, swapped: second, winner: first === second ? first : 'tie' };
});
const byField = Object.fromEntries([...new Set(rows.map((row) => row.field))].sort()
  .map((field) => [field, summarize(rows.filter((row) => row.field === field))]));
const byTopic = Object.fromEntries([...new Set(rows.map((row) => row.topic))].sort()
  .map((topic) => [topic, summarize(rows.filter((row) => row.topic === topic))]));
const report = {
  schema_version: '1.0.0',
  method: 'dual-orientation-consensus',
  interpretation: 'A physical-paper winner is retained only when original and swapped inputs agree; conflicts become ties.',
  overall: summarize(rows),
  orientation_consistency: round(rows.filter((row) => row.original === row.swapped).length / rows.length),
  by_field: byField,
  by_topic: byTopic,
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
