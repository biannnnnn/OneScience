#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function loadJsonl(filePath) {
  return readFile(filePath, 'utf8').then((text) => text.trim().split('\n').filter(Boolean).map(JSON.parse));
}

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}

const root = path.resolve(process.argv[2] || 'evaluation/deepseek-vs-naipv2/runs');
const cases = await loadJsonl(path.join(root, 'seed42-n32/cases.jsonl'));
const originalListwise = await loadJsonl(path.join(root, 'seed42-n32-ranking-protocols/listwise-results.jsonl'));
const reversedListwise = await loadJsonl(path.join(root, 'seed42-n32-listwise-reversed/listwise-results.jsonl'));
const originalPairs = await loadJsonl(path.join(root, 'seed42-n32-ranking-protocols/pairs.jsonl'));
const originalPairResults = await loadJsonl(path.join(root, 'seed42-n32-ranking-protocols/pairwise-results.jsonl'));
const swappedPairs = await loadJsonl(path.join(root, 'seed42-n32-pairwise-swapped/pairs.jsonl'));
const swappedPairResults = await loadJsonl(path.join(root, 'seed42-n32-pairwise-swapped/pairwise-results.jsonl'));
const listwise4Original = await loadJsonl(path.join(root, 'seed42-n32-listwise4-original/listwise-results.jsonl'));
const listwise4Reversed = await loadJsonl(path.join(root, 'seed42-n32-listwise4-reversed/listwise-results.jsonl'));
const listwise4Repeat = await loadJsonl(path.join(root, 'seed42-n32-listwise4-original-repeat2/listwise-results.jsonl'));

function aggregateListwise(first, second, batchSize) {
  let pairs = 0;
  let rtsCorrect = 0;
  let rtsTies = 0;
  let acceptCorrect = 0;
  let acceptTies = 0;
  let acceptPairs = 0;
  const orders = [];
  for (let batchIndex = 0; batchIndex < first.length; batchIndex += 1) {
    const firstRanks = new Map(first[batchIndex].ranking.map((item, index) => [item.paper_id, index]));
    const secondRanks = new Map(second[batchIndex].ranking.map((item, index) => [item.paper_id, index]));
    const batch = cases.slice(batchIndex * batchSize, batchIndex * batchSize + batchSize);
    for (let left = 0; left < batch.length; left += 1) {
      for (let right = left + 1; right < batch.length; right += 1) {
        const a = batch[left];
        const b = batch[right];
        const prediction = -Math.sign(
          (firstRanks.get(a.paper_id) + secondRanks.get(a.paper_id))
          - (firstRanks.get(b.paper_id) + secondRanks.get(b.paper_id)),
        );
        orders.push(prediction);
        pairs += 1;
        if (prediction === 0) rtsTies += 1;
        else if (prediction === Math.sign(a.rts - b.rts)) rtsCorrect += 1;
        if (a.accept !== b.accept) {
          acceptPairs += 1;
          if (prediction === 0) acceptTies += 1;
          else if (prediction === Math.sign(a.accept - b.accept)) acceptCorrect += 1;
        }
      }
    }
  }
  return {
    pairs,
    rts_ties: rtsTies,
    rts_tie_half_accuracy: round((rtsCorrect + rtsTies * 0.5) / pairs),
    accept_pairs: acceptPairs,
    accept_ties: acceptTies,
    accept_tie_half_accuracy: round((acceptCorrect + acceptTies * 0.5) / acceptPairs),
    orders,
  };
}

function rawListwiseAgreement(first, second, batchSize) {
  let same = 0;
  let pairs = 0;
  for (let batchIndex = 0; batchIndex < first.length; batchIndex += 1) {
    const firstRanks = new Map(first[batchIndex].ranking.map((item, index) => [item.paper_id, index]));
    const secondRanks = new Map(second[batchIndex].ranking.map((item, index) => [item.paper_id, index]));
    const batch = cases.slice(batchIndex * batchSize, batchIndex * batchSize + batchSize);
    for (let left = 0; left < batch.length; left += 1) {
      for (let right = left + 1; right < batch.length; right += 1) {
        pairs += 1;
        if (Math.sign(firstRanks.get(batch[left].paper_id) - firstRanks.get(batch[right].paper_id))
          === Math.sign(secondRanks.get(batch[left].paper_id) - secondRanks.get(batch[right].paper_id))) same += 1;
      }
    }
  }
  return round(same / pairs);
}

const listwise4Run1 = aggregateListwise(listwise4Original, listwise4Reversed, 4);
const listwise4Run2 = aggregateListwise(listwise4Repeat, listwise4Reversed, 4);
let listwisePairs = 0;
let sameListwiseOrder = 0;
let originalFollowsInput = 0;
let reversedFollowsInput = 0;
let aggregateRtsCorrect = 0;
let aggregateRtsTies = 0;
let aggregateRtsPairs = 0;
let aggregateAcceptCorrect = 0;
let aggregateAcceptTies = 0;
let aggregateAcceptPairs = 0;
let aggregateNaipAgreement = 0;
let aggregateNonTies = 0;

for (let batchIndex = 0; batchIndex < originalListwise.length; batchIndex += 1) {
  const originalRanking = new Map(originalListwise[batchIndex].ranking.map((item, index) => [item.paper_id, index]));
  const reversedRanking = new Map(reversedListwise[batchIndex].ranking.map((item, index) => [item.paper_id, index]));
  const batch = cases.slice(batchIndex * 8, batchIndex * 8 + 8);
  const originalInput = new Map(batch.map((item, index) => [item.paper_id, index]));
  const reversedInput = new Map([...batch].reverse().map((item, index) => [item.paper_id, index]));
  for (let left = 0; left < batch.length; left += 1) {
    for (let right = left + 1; right < batch.length; right += 1) {
      const a = batch[left];
      const b = batch[right];
      const originalOrder = Math.sign(originalRanking.get(a.paper_id) - originalRanking.get(b.paper_id));
      const reversedOrder = Math.sign(reversedRanking.get(a.paper_id) - reversedRanking.get(b.paper_id));
      listwisePairs += 1;
      if (originalOrder === reversedOrder) sameListwiseOrder += 1;
      if (originalOrder === Math.sign(originalInput.get(a.paper_id) - originalInput.get(b.paper_id))) originalFollowsInput += 1;
      if (reversedOrder === Math.sign(reversedInput.get(a.paper_id) - reversedInput.get(b.paper_id))) reversedFollowsInput += 1;

      const rankSumA = originalRanking.get(a.paper_id) + reversedRanking.get(a.paper_id);
      const rankSumB = originalRanking.get(b.paper_id) + reversedRanking.get(b.paper_id);
      const aggregateOrder = -Math.sign(rankSumA - rankSumB);
      if (a.rts !== b.rts) {
        aggregateRtsPairs += 1;
        if (aggregateOrder === 0) aggregateRtsTies += 1;
        else if (aggregateOrder === Math.sign(a.rts - b.rts)) aggregateRtsCorrect += 1;
      }
      if (a.accept !== b.accept) {
        aggregateAcceptPairs += 1;
        if (aggregateOrder === 0) aggregateAcceptTies += 1;
        else if (aggregateOrder === Math.sign(a.accept - b.accept)) aggregateAcceptCorrect += 1;
      }
      if (aggregateOrder !== 0) {
        aggregateNonTies += 1;
        if (aggregateOrder === Math.sign(a.naipv2_score - b.naipv2_score)) aggregateNaipAgreement += 1;
      }
    }
  }
}

const originalResultById = new Map(originalPairResults.map((item) => [item.pair_id, item]));
const swappedResultById = new Map(swappedPairResults.map((item) => [item.pair_id, item]));
let pairwiseSameWinner = 0;
let pairwiseRtsCorrect = 0;
let pairwiseAcceptCorrect = 0;
let pairwiseAcceptCovered = 0;
for (let index = 0; index < originalPairs.length; index += 1) {
  const original = originalPairs[index];
  const swapped = swappedPairs[index];
  const originalChoice = originalResultById.get(original.pair_id).winner;
  const swappedChoice = swappedResultById.get(swapped.pair_id).winner;
  const originalWinnerId = originalChoice === 'A' ? original.a_id : original.b_id;
  const swappedWinnerId = swappedChoice === 'A' ? swapped.a_id : swapped.b_id;
  if (originalWinnerId !== swappedWinnerId) continue;
  pairwiseSameWinner += 1;
  const expectedRtsId = original.expected_rts_winner === 'A' ? original.a_id : original.b_id;
  if (originalWinnerId === expectedRtsId) pairwiseRtsCorrect += 1;
  if (original.expected_accept_winner) {
    pairwiseAcceptCovered += 1;
    const expectedAcceptId = original.expected_accept_winner === 'A' ? original.a_id : original.b_id;
    if (originalWinnerId === expectedAcceptId) pairwiseAcceptCorrect += 1;
  }
}

const metrics = {
  schema_version: '1.0.0',
  listwise_orientation_audit: {
    pairs: listwisePairs,
    original_vs_reversed_order_agreement: round(sameListwiseOrder / listwisePairs),
    original_output_vs_input_order: round(originalFollowsInput / listwisePairs),
    reversed_output_vs_input_order: round(reversedFollowsInput / listwisePairs),
  },
  dual_orientation_borda: {
    rts_pairs: aggregateRtsPairs,
    rts_ties: aggregateRtsTies,
    rts_non_tie_accuracy: round(aggregateRtsCorrect / (aggregateRtsPairs - aggregateRtsTies)),
    rts_tie_half_accuracy: round((aggregateRtsCorrect + aggregateRtsTies * 0.5) / aggregateRtsPairs),
    accept_pairs: aggregateAcceptPairs,
    accept_ties: aggregateAcceptTies,
    accept_non_tie_accuracy: round(aggregateAcceptCorrect / (aggregateAcceptPairs - aggregateAcceptTies)),
    accept_tie_half_accuracy: round((aggregateAcceptCorrect + aggregateAcceptTies * 0.5) / aggregateAcceptPairs),
    coverage_without_ties: round(aggregateNonTies / listwisePairs),
    naipv2_order_agreement_on_non_ties: round(aggregateNaipAgreement / aggregateNonTies),
  },
  pairwise_orientation_audit: {
    pairs: originalPairs.length,
    same_physical_winner: pairwiseSameWinner,
    orientation_consistency: round(pairwiseSameWinner / originalPairs.length),
    rts_accuracy_when_consistent: round(pairwiseRtsCorrect / pairwiseSameWinner),
    cross_label_consistent_pairs: pairwiseAcceptCovered,
    accept_accuracy_when_consistent: round(pairwiseAcceptCorrect / pairwiseAcceptCovered),
  },
  listwise_batch4_audit: {
    original_repeat_order_agreement: rawListwiseAgreement(listwise4Original, listwise4Repeat, 4),
    dual_borda_repeat_order_agreement: round(
      listwise4Run1.orders.filter((value, index) => value === listwise4Run2.orders[index]).length
      / listwise4Run1.orders.length,
    ),
    run1: { ...listwise4Run1, orders: undefined },
    run2: { ...listwise4Run2, orders: undefined },
  },
};
const output = path.join(root, 'seed42-n32-ranking-protocols/orientation-audit.json');
await writeFile(output, `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(metrics, null, 2));
