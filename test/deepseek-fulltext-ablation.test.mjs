import assert from 'node:assert/strict';
import test from 'node:test';

import { __testables } from '../scripts/naipv2/evaluate_deepseek_fulltext_ablation.mjs';

test('DeepSeek full-text ablation sends declared evidence but excludes labels and metadata', () => {
  const paper = {
    paper_id: 'p1', title: 'Title', abstract: 'Abstract',
    research_question_contributions: 'Contribution',
    experimental_setup_datasets: 'Experiment',
    key_findings_conclusion: 'Conclusion',
    rts: 9, accept: 1, venue: 'Hidden', authors: ['Hidden'], fixed_order: 0,
  };
  assert.deepEqual(Object.keys(__testables.inputFor(paper, 'title_abstract')).sort(), [
    'abstract', 'paper_id', 'title',
  ]);
  const fulltext = __testables.inputFor(paper, 'fulltext_evidence');
  assert.deepEqual(Object.keys(fulltext).sort(), [
    'abstract', 'experimental_setup_datasets', 'key_findings_conclusion', 'paper_id',
    'research_question_contributions', 'title',
  ]);
  assert.equal(fulltext.rts, undefined);
  assert.equal(fulltext.accept, undefined);
  assert.equal(fulltext.paper_id, 'p000001');
});

test('DeepSeek full-text ablation rejects dimension totals that do not match score', () => {
  const batch = [{ paper_id: 'p1' }];
  const valid = {
    evaluations: [{
      paper_id: 'p1',
      dimensions: {
        originality_significance: 20,
        methodological_reliability: 20,
        evidence_sufficiency: 20,
        clarity_reproducibility: 20,
      },
      score: 80,
      confidence: 0.8,
      rationale: 'Evidence bounded.',
    }],
  };
  assert.equal(__testables.validateResponse(valid, batch)[0].score, 80);
  assert.throws(() => __testables.validateResponse({
    evaluations: [{ ...valid.evaluations[0], score: 90 }],
  }, batch), /dimension sum mismatch/);
});
