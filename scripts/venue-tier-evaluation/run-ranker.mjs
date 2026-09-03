#!/usr/bin/env node
import 'dotenv/config';
import path from 'node:path';
import { scorePapersWithRanker } from '../../server/lib/ranker-client.mjs';
import { argument, readJsonl, writeJson, writeJsonl } from './io.mjs';

const input = argument('input');
const outputDir = path.resolve(argument('output-dir', 'evaluation/venue-tier/runs/pilot'));
const batchSize = Number(argument('batch-size', 64));
if (!input || batchSize < 1 || batchSize > 64) throw new Error('Usage: --input papers.blind.jsonl [--batch-size 1..64]');
const papers = await readJsonl(path.resolve(input));
const scores = [];
const traces = [];
for (let start = 0; start < papers.length; start += batchSize) {
  const batch = papers.slice(start, start + batchSize);
  const result = await scorePapersWithRanker(
    batch.map((paper) => ({ paperId: paper.paper_id, title: paper.title, abstract: paper.abstract })),
    { requestId: `venue-tier-${String(start / batchSize + 1).padStart(4, '0')}` },
  );
  scores.push(...result.scores);
  traces.push(result.modelTrace);
  console.log(JSON.stringify({ event: 'ranker_batch_complete', batch: start / batchSize + 1, papers: batch.length }));
}
await Promise.all([
  writeJsonl(path.join(outputDir, 'ranker-scores.jsonl'), scores),
  writeJson(path.join(outputDir, 'ranker-run.json'), { schema_version: '1.0.0', papers: scores.length, batches: traces.length, model_traces: traces }),
]);
