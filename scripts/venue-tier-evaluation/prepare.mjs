#!/usr/bin/env node
import path from 'node:path';
import { preparePairs } from './lib.mjs';
import { argument, readJsonl, writeJson, writeJsonl } from './io.mjs';

const input = argument('input');
const outputDir = path.resolve(argument('output-dir', 'evaluation/venue-tier/runs/pilot'));
if (!input) throw new Error('Usage: --input papers.jsonl [--output-dir DIR]');

const result = preparePairs(await readJsonl(path.resolve(input)), {
  seed: argument('seed', '42'),
  maxYearGap: Number(argument('max-year-gap', 2)),
  minSimilarity: Number(argument('min-similarity', 0.05)),
  maxPairs: Number(argument('max-pairs', Number.POSITIVE_INFINITY)),
  maxUsesPerPaper: Number(argument('max-uses-per-paper', 1)),
});
await Promise.all([
  writeJsonl(path.join(outputDir, 'pairs.private.jsonl'), result.privatePairs),
  writeJsonl(path.join(outputDir, 'pairs.dataset.jsonl'), result.pairedDataset),
  writeJsonl(path.join(outputDir, 'papers.blind.jsonl'), result.blindPapers),
  writeJson(path.join(outputDir, 'manifest.json'), result.manifest),
]);
console.log(JSON.stringify(result.manifest, null, 2));
