import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getRankerServiceStatus,
  scoreFromRanker,
  scorePapersWithRanker,
} from '../server/lib/ranker-client.mjs';


test('Ranker client sends only paper id, title and abstract', async () => {
  let requestBody;
  const result = await scorePapersWithRanker([
    {
      paperId: 'manuscript-1',
      title: 'A paper',
      abstract: 'A sufficiently descriptive abstract for paper quality ranking.',
      text: 'This full manuscript must not be sent to the Ranker.',
      language: 'en',
    },
  ], {
    env: { RANKER_SERVICE_URL: 'http://ranker.test' },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://ranker.test/v1/paper-scores');
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        scores: [{
          paper_id: 'manuscript-1', title: 'A paper', raw_score: 1.25,
          score: 72.4, score_method: 'validation_empirical_cdf',
        }],
        model_trace: { model: 'meta-llama/Meta-Llama-3-8B' },
        disclaimer: 'not an acceptance probability',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  assert.deepEqual(Object.keys(requestBody.papers[0]).sort(), ['abstract', 'paper_id', 'title']);
  assert.equal(requestBody.papers[0].text, undefined);
  assert.equal(result.scores[0].raw_score, 1.25);
});


test('Ranker output maps to the existing workflow score contract', () => {
  const result = scoreFromRanker({
    raw_score: -0.42,
    score: 63.1,
    score_method: 'validation_empirical_cdf',
  }, { adapter_version: 'retrained-paper-faithful-seed42' });
  assert.equal(result.score, 63.1);
  assert.equal(result.rawScore, -0.42);
  assert.equal(result.verdict, 'paper_ranker');
  assert.match(result.rationale, /validation/);
  assert.match(result.limitations[0], /不是.*录用概率/);
});


test('Ranker status verifies both health and authenticated model discovery', async () => {
  const calls = [];
  const status = await getRankerServiceStatus({
    env: { RANKER_SERVICE_URL: 'http://ranker.test', RANKER_SERVICE_API_KEY: 'secret' },
    fetchImpl: async (url, options) => {
      calls.push({ url, authorization: options.headers.Authorization });
      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({
          status: 'ready',
          backend: { model: 'meta-llama/Meta-Llama-3-8B' },
          capabilities: ['paper_score_batch'],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        active: { model: 'meta-llama/Meta-Llama-3-8B', backend: 'transformers' },
        capabilities: ['paper_score_batch'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  assert.equal(status.available, true);
  assert.ok(status.capabilities.includes('paper_score_batch'));
  assert.ok(calls.every((call) => call.authorization === 'Bearer secret'));
});
