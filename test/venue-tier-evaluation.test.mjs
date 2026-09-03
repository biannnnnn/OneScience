import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, preparePairs } from '../scripts/venue-tier-evaluation/lib.mjs';

const papers = [
  { paper_id: 'h1', title: 'Graph model for molecules', abstract: 'A graph neural method predicts molecular properties with controlled experiments.', venue: 'High', venue_tier: 'A', tier_rank: 1, field: 'AI', topic: 'graphs', article_type: 'research', year: 2025, authors: ['Hidden'] },
  { paper_id: 'l1', title: 'Graph learning for molecules', abstract: 'A graph learning method predicts molecular properties with an experimental comparison.', venue: 'Low', venue_tier: 'C', tier_rank: 3, field: 'AI', topic: 'graphs', article_type: 'research', year: 2024, citation_count: 99 },
  { paper_id: 'h2', title: 'Reliable language generation', abstract: 'A language generation system is evaluated for reliability and factual consistency.', venue: 'High 2', venue_tier: 'A', tier_rank: 1, field: 'AI', topic: 'language', article_type: 'research', year: 2025 },
  { paper_id: 'l2', title: 'Language generation reliability', abstract: 'A language generation model is tested for factual reliability and consistency.', venue: 'Low 2', venue_tier: 'B', tier_rank: 2, field: 'AI', topic: 'language', article_type: 'research', year: 2025 },
];

test('preparation creates matched one-to-one pairs and blind model inputs', () => {
  const result = preparePairs(papers, { seed: 7, minSimilarity: 0.01 });
  assert.equal(result.privatePairs.length, 2);
  assert.equal(result.pairedDataset.length, 2);
  assert.equal(result.blindPapers.length, 4);
  assert.deepEqual(Object.keys(result.blindPapers[0]).sort(), ['abstract', 'paper_id', 'title']);
  assert.ok(result.privatePairs.every((pair) => pair.high_tier.tier_rank < pair.lower_tier.tier_rank));
  assert.equal(new Set(result.privatePairs.flatMap((pair) => [pair.a_id, pair.b_id])).size, 4);
  assert.ok(!JSON.stringify(result.blindPapers).includes('High'));
  assert.ok(!JSON.stringify(result.blindPapers).includes('Hidden'));
  assert.ok(result.pairedDataset.every((pair) => ['A', 'B'].includes(pair.label)));
  assert.ok(result.pairedDataset.every((pair) => !('high_tier' in pair) && !('lower_tier' in pair)));
  assert.ok(result.pairedDataset.every((pair) => Object.keys(pair.paper_a).length === 3));
});

test('evaluation reports venue weak-label pairwise accuracy', () => {
  const prepared = preparePairs(papers, { seed: 7, minSimilarity: 0.01 });
  const scores = [];
  for (const pair of prepared.privatePairs) {
    scores.push({ paper_id: pair.a_id, raw_score: pair.expected_venue_winner === 'A' ? 10 : 1 });
    scores.push({ paper_id: pair.b_id, raw_score: pair.expected_venue_winner === 'B' ? 10 : 1 });
  }
  const report = evaluate(prepared.privatePairs, scores);
  assert.equal(report.venue_weak_label.overall.non_tie_accuracy, 1);
  assert.equal(report.venue_weak_label.overall.non_tie_accuracy_95ci_wilson.length, 2);
  assert.deepEqual(Object.keys(report).sort(), ['interpretation', 'schema_version', 'venue_weak_label']);
});

test('pair preparation can expand pairs while enforcing a paper reuse cap', () => {
  const result = preparePairs(papers, { seed: 7, minSimilarity: 0, maxUsesPerPaper: 2, maxPairs: 4 });
  const useCounts = new Map();
  for (const pair of result.privatePairs) {
    for (const id of [pair.a_id, pair.b_id]) useCounts.set(id, (useCounts.get(id) || 0) + 1);
  }
  assert.ok(result.privatePairs.length >= 2);
  assert.ok(Math.max(...useCounts.values()) <= 2);
  assert.equal(result.manifest.max_uses_per_paper, 2);
  assert.equal(Object.values(result.manifest.pair_statistics.labels).reduce((sum, count) => sum + count, 0), result.privatePairs.length);
});
