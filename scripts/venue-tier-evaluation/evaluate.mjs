#!/usr/bin/env node
import path from 'node:path';
import { evaluate } from './lib.mjs';
import { argument, readJsonl, writeJson } from './io.mjs';

const pairsPath = argument('pairs');
const scoresPath = argument('scores');
const output = path.resolve(argument('output', 'evaluation/venue-tier/runs/pilot/metrics.json'));
if (!pairsPath || !scoresPath) throw new Error('Usage: --pairs pairs.private.jsonl --scores ranker-scores.jsonl');
const report = evaluate(
  await readJsonl(path.resolve(pairsPath)),
  await readJsonl(path.resolve(scoresPath)),
  { tieThreshold: Number(argument('tie-threshold', 0)) },
);
await writeJson(output, report);
console.log(JSON.stringify(report, null, 2));
