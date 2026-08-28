#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function argument(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function readJsonl(filePath) {
  return (await readFile(filePath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
}

function round(value, digits = 4) {
  return Math.round(value * 10 ** digits) / 10 ** digits;
}

function percentile(values, ratio) {
  const ordered = [...values].sort((a, b) => a - b);
  const index = (ordered.length - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return ordered[lower];
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower);
}

function requestRows(results, orientation) {
  return results.map((item) => ({
    orientation,
    batch_id: item.batch_id,
    request_id: item.request_id,
    model: item.model,
    papers: item.ranking.length,
    latency_ms: item.latency_ms_batch,
    prompt_tokens: item.usage_batch?.promptTokens || 0,
    completion_tokens: item.usage_batch?.completionTokens || 0,
    total_tokens: item.usage_batch?.totalTokens || 0,
  }));
}

function runtimeSummary(rows) {
  const latencies = rows.map((item) => item.latency_ms);
  const sum = (key) => rows.reduce((total, item) => total + item[key], 0);
  return {
    requests: rows.length,
    latency_ms_total: sum('latency_ms'),
    latency_ms_mean: round(sum('latency_ms') / rows.length, 1),
    latency_ms_p50: round(percentile(latencies, 0.5), 1),
    latency_ms_p95: round(percentile(latencies, 0.95), 1),
    latency_ms_min: Math.min(...latencies),
    latency_ms_max: Math.max(...latencies),
    prompt_tokens: sum('prompt_tokens'),
    completion_tokens: sum('completion_tokens'),
    total_tokens: sum('total_tokens'),
    tokens_mean_per_request: round(sum('total_tokens') / rows.length, 1),
  };
}

const casesPath = path.resolve(argument('cases'));
const originalPath = path.resolve(argument('original'));
const reversedPath = path.resolve(argument('reversed'));
const outputDir = path.resolve(argument('output-dir', path.dirname(originalPath)));
const cases = await readJsonl(casesPath);
const original = await readJsonl(originalPath);
const reversed = await readJsonl(reversedPath);
if (original.length !== reversed.length) throw new Error('Original and reversed batch counts differ.');

const batchSize = original[0]?.ranking?.length || 0;
if (!batchSize || cases.length !== original.length * batchSize) {
  throw new Error('Cases do not match listwise batches.');
}

let totalPairs = 0;
let orientationAgreement = 0;
let originalFollowsInput = 0;
let reversedFollowsInput = 0;
let rtsCorrect = 0;
let rtsTies = 0;
let rtsPairs = 0;
let acceptCorrect = 0;
let acceptTies = 0;
let acceptPairs = 0;
let naipRtsCorrect = 0;
let naipAcceptCorrect = 0;
let aggregateNaipAgreement = 0;
let aggregateNonTies = 0;
const aggregatedRankings = [];

for (let batchIndex = 0; batchIndex < original.length; batchIndex += 1) {
  const batch = cases.slice(batchIndex * batchSize, batchIndex * batchSize + batchSize);
  const originalRanks = new Map(original[batchIndex].ranking.map((item) => [item.paper_id, item.rank]));
  const reversedRanks = new Map(reversed[batchIndex].ranking.map((item) => [item.paper_id, item.rank]));
  const originalInput = new Map(batch.map((item, index) => [item.paper_id, index]));
  const reversedInput = new Map([...batch].reverse().map((item, index) => [item.paper_id, index]));
  aggregatedRankings.push({
    batch_id: original[batchIndex].batch_id,
    papers: batch.map((item) => ({
      paper_id: item.paper_id,
      original_rank: originalRanks.get(item.paper_id),
      reversed_rank: reversedRanks.get(item.paper_id),
      borda_rank_sum: originalRanks.get(item.paper_id) + reversedRanks.get(item.paper_id),
      rts: item.rts,
      accept: item.accept,
      naipv2_score: item.naipv2_score,
    })).sort((left, right) => left.borda_rank_sum - right.borda_rank_sum || left.paper_id.localeCompare(right.paper_id)),
  });
  for (let left = 0; left < batch.length; left += 1) {
    for (let right = left + 1; right < batch.length; right += 1) {
      const a = batch[left];
      const b = batch[right];
      const originalOrder = Math.sign(originalRanks.get(a.paper_id) - originalRanks.get(b.paper_id));
      const reversedOrder = Math.sign(reversedRanks.get(a.paper_id) - reversedRanks.get(b.paper_id));
      const aggregateOrder = -Math.sign(
        (originalRanks.get(a.paper_id) + reversedRanks.get(a.paper_id))
        - (originalRanks.get(b.paper_id) + reversedRanks.get(b.paper_id)),
      );
      totalPairs += 1;
      if (originalOrder === reversedOrder) orientationAgreement += 1;
      if (originalOrder === Math.sign(originalInput.get(a.paper_id) - originalInput.get(b.paper_id))) originalFollowsInput += 1;
      if (reversedOrder === Math.sign(reversedInput.get(a.paper_id) - reversedInput.get(b.paper_id))) reversedFollowsInput += 1;
      if (a.rts !== b.rts) {
        rtsPairs += 1;
        if (aggregateOrder === 0) rtsTies += 1;
        else if (aggregateOrder === Math.sign(a.rts - b.rts)) rtsCorrect += 1;
      }
      if (aggregateOrder !== 0) {
        aggregateNonTies += 1;
        if (aggregateOrder === Math.sign(a.naipv2_score - b.naipv2_score)) aggregateNaipAgreement += 1;
      }
      if (a.rts !== b.rts && Math.sign(a.naipv2_score - b.naipv2_score) === Math.sign(a.rts - b.rts)) naipRtsCorrect += 1;
      if (a.accept !== b.accept) {
        acceptPairs += 1;
        if (aggregateOrder === 0) acceptTies += 1;
        else if (aggregateOrder === Math.sign(a.accept - b.accept)) acceptCorrect += 1;
        if (Math.sign(a.naipv2_score - b.naipv2_score) === Math.sign(a.accept - b.accept)) naipAcceptCorrect += 1;
      }
    }
  }
}

const requests = [...requestRows(original, 'original'), ...requestRows(reversed, 'reversed')];
const metrics = {
  schema_version: '1.0.0',
  dataset_rows: cases.length,
  batches: original.length,
  batch_size: batchSize,
  api_requests: requests.length,
  orientation: {
    pair_order_agreement: round(orientationAgreement / totalPairs),
    original_output_follows_input: round(originalFollowsInput / totalPairs),
    reversed_output_follows_input: round(reversedFollowsInput / totalPairs),
  },
  dual_listwise_borda: {
    rts_pairs: rtsPairs,
    rts_ties: rtsTies,
    rts_non_tie_accuracy: round(rtsCorrect / (rtsPairs - rtsTies)),
    rts_tie_half_accuracy: round((rtsCorrect + rtsTies * 0.5) / rtsPairs),
    accept_pairs: acceptPairs,
    accept_ties: acceptTies,
    accept_non_tie_accuracy: round(acceptCorrect / (acceptPairs - acceptTies)),
    accept_tie_half_accuracy: round((acceptCorrect + acceptTies * 0.5) / acceptPairs),
    non_tie_coverage: round(aggregateNonTies / totalPairs),
    naipv2_order_agreement_on_non_ties: round(aggregateNaipAgreement / aggregateNonTies),
  },
  naipv2_same_pairs: {
    rts_accuracy: round(naipRtsCorrect / rtsPairs),
    accept_accuracy: round(naipAcceptCorrect / acceptPairs),
  },
  runtime: {
    original: runtimeSummary(requests.filter((item) => item.orientation === 'original')),
    reversed: runtimeSummary(requests.filter((item) => item.orientation === 'reversed')),
    combined: runtimeSummary(requests),
  },
};

const csvHeaders = Object.keys(requests[0]);
const csv = [
  csvHeaders.join(','),
  ...requests.map((row) => csvHeaders.map((header) => JSON.stringify(row[header] ?? '')).join(',')),
].join('\n');
await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, 'request-costs.csv'), `${csv}\n`, 'utf8');
await writeFile(path.join(outputDir, 'borda-rankings.json'), `${JSON.stringify(aggregatedRankings, null, 2)}\n`, 'utf8');
await writeFile(path.join(outputDir, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(metrics, null, 2));
