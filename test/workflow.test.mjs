import test from 'node:test';
import assert from 'node:assert/strict';
import { rankJournalCandidates } from '../server/lib/workflow.mjs';
import {
  compareWithJournalBenchmark,
  enrichJournalMetrics,
  selectDistinctJournals,
  workflowKeywords,
} from '../server/lib/review-flow.mjs';
import {
  getReviewerServiceStatus,
  scoreFromVenueBatch,
  scorePapersForVenue,
  scoreStructuredReview,
} from '../server/lib/reviewer-client.mjs';
import { __testables as searchTestables } from '../server/lib/scholarly-search.mjs';
import { journals } from '../server/data/journals.mjs';

function projectFixture() {
  return {
    id: 'demo',
    stage: 1,
    profile: {
      researchField: '计算机科学',
      keywords: ['人工智能', '智能体'],
      accessPreference: '不限',
    },
    document: {
      title: '科研智能体论文评估方法',
      abstract: '本文提出一种人工智能论文评估方法。实验结果表明该方法能够提升任务覆盖率。该方法适用于科研工作流。',
      keywords: ['人工智能', '论文评估'],
    },
    analysis: {
      overall: 74,
      scores: { novelty: 70, reproducibility: 68, evidence: 72 },
      strengths: ['具有清晰的实验结果'],
      issues: [{ severity: 'medium', title: '复现实验信息不足', action: '补充参数设置。' }],
    },
  };
}

test('current workflow extracts stable unique keywords', () => {
  assert.deepEqual(
    workflowKeywords(projectFixture()),
    ['人工智能', '论文评估', '智能体', '计算机科学'],
  );
});

test('journal ranking remains topical and explainable', () => {
  const result = rankJournalCandidates(projectFixture());
  assert.equal(result.length, 71);
  assert.ok(result[0].matchScore >= result[1].matchScore);
  assert.ok(result.every((item) => item.reasons.length > 0));
  assert.ok(result.every((item) => item.source.url.startsWith('https://')));
});

test('candidate set is differentiated by prestige bands', () => {
  const ranked = rankJournalCandidates(projectFixture());
  const selected = selectDistinctJournals(ranked, 5);
  assert.equal(selected.length, 5);
  assert.equal(new Set(selected.map((item) => item.id)).size, 5);
  assert.deepEqual(new Set(selected.map((item) => item.prestigeBand)), new Set(['leading', 'strong', 'broad']));
});

test('verified impact factor remains sparse and sourced', () => {
  const ieeeAccess = enrichJournalMetrics(journals.find((item) => item.id === 'ieee-access'));
  const tpami = enrichJournalMetrics(journals.find((item) => item.id === 'ieee-tpami'));
  assert.equal(ieeeAccess.metrics.impactFactor, 4.2);
  assert.match(ieeeAccess.metrics.impactFactorSource, /^https:\/\//);
  assert.equal(tpami.metrics.impactFactor, null);
});

test('recent-paper distribution comparison does not invent probability', () => {
  const references = [62, 70, 78].map((score, index) => ({ id: `p-${index}`, modelScore: { score } }));
  const result = compareWithJournalBenchmark({ score: 77 }, references);
  assert.equal(result.recentPaperMedian, 70);
  assert.equal(result.scoreDelta, 7);
  assert.equal(result.benchmarkVerdict, 'above_recent_baseline');
  assert.equal(result.isCalibratedProbability, false);
  assert.match(result.notice, /不是期刊真实录用概率/);
});

test('calibrated prediction takes precedence when provided', () => {
  const prediction = { prediction: 'borderline', acceptance_probability: 0.52, disclaimer: '实验性校准结果，仅供辅助判断。' };
  const result = compareWithJournalBenchmark({ score: 65 }, [], prediction);
  assert.equal(result.decision, 'borderline');
  assert.equal(result.isCalibratedProbability, true);
});

test('structured reviewer output maps to a bounded score', () => {
  const result = scoreStructuredReview({
    recommendation: { verdict: 'minor_revision', confidence: 0.8, rationale: '基本达到投稿要求。' },
    strengths: [{ point: '贡献清晰' }, { point: '实验完整' }],
    major_concerns: [{ problem: '外部验证不足' }],
    minor_concerns: [],
    model_trace: { model: 'qwen' },
  });
  assert.equal(result.score, 76);
  assert.deepEqual(result.strengths, ['贡献清晰', '实验完整']);
  assert.deepEqual(result.risks, ['外部验证不足']);
});

test('venue batch output maps to the workflow score contract', () => {
  const result = scoreFromVenueBatch({
    overall: 73,
    confidence: 0.61,
    rationale: '与期刊方向相符，但证据仍有限。',
    strengths: ['主题契合'],
    risks: ['仅有摘要'],
    limitations: ['未读取全文'],
    originality: 74,
    rigor: 68,
    evidence: 65,
    clarity: 80,
    reproducibility: 60,
    venue_fit: 82,
  }, { model: 'qwen/Qwen3-8B' });
  assert.equal(result.score, 73);
  assert.equal(result.verdict, 'venue_score');
  assert.equal(result.dimensions.venueFit, 82);
  assert.deepEqual(result.limitations, ['未读取全文']);
  assert.equal(result.modelTrace.model, 'qwen/Qwen3-8B');
});

test('venue scoring sends manuscript and references in one bounded request', async () => {
  let requestBody;
  const result = await scorePapersForVenue([
    {
      paperId: 'manuscript-1', title: 'Manuscript', language: 'en',
      inputType: 'manuscript', text: 'M'.repeat(20_000),
    },
    {
      paperId: 'reference-1', title: 'Reference', language: 'en',
      inputType: 'abstract', text: 'R'.repeat(5_000),
    },
  ], { id: 'venue-1', name: 'Venue One', profile: 'Scope' }, {
    env: { REVIEWER_SERVICE_URL: 'http://reviewer.test' },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        score_batch: {
          scores: [{ paper_id: 'manuscript-1', overall: 70 }],
          model_trace: { model: 'qwen' },
          disclaimer: 'not a probability',
        },
        backend: { model: 'qwen' },
        usage: {},
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  assert.equal(requestBody.papers.length, 2);
  assert.equal(requestBody.papers[0].text.length, 15_000);
  assert.equal(requestBody.papers[1].text.length, 3_500);
  assert.equal(requestBody.target_venue.name, 'Venue One');
  assert.equal(result.scores[0].paper_id, 'manuscript-1');
});

test('Reviewer health does not report available when model API is unauthorized', async () => {
  const calls = [];
  const status = await getReviewerServiceStatus({
    env: {
      REVIEWER_SERVICE_URL: 'http://reviewer.test',
      ONESCIENCE_REVIEWER_API_KEY: 'test-secret',
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, authorization: options.headers.Authorization });
      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({
          backend: { model: 'qwen/Qwen3-8B' },
          acceptance_prediction: { loaded: false },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        error: { code: 'UNAUTHORIZED', message: 'invalid key' },
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    },
  });
  assert.equal(status.available, false);
  assert.equal(status.healthAvailable, true);
  assert.equal(status.authenticated, false);
  assert.match(status.error, /缺少或使用了无效/);
  assert.ok(calls.every((call) => call.authorization === 'Bearer test-secret'));
});

test('OpenAlex inverted index is reconstructed deterministically', () => {
  assert.equal(
    searchTestables.reconstructAbstract({ paper: [1], This: [0], works: [2] }),
    'This paper works',
  );
});

test('journal catalog still includes complete CCF T1/T2 lists', () => {
  assert.equal(journals.length, 71);
  assert.equal(journals.filter((journal) => journal.ccfTier === 'CCF-T1').length, 19);
  assert.equal(journals.filter((journal) => journal.ccfTier === 'CCF-T2').length, 22);
  assert.equal(new Set(journals.map((journal) => journal.id)).size, journals.length);
});

test('specific embodied multi-agent terms outrank generic software venues', () => {
  const project = projectFixture();
  project.document = {
    title: '面向无人作战的具身群体智能协同决策方法',
    abstract: '研究多智能体与无人系统中的协同决策，并在仿真任务中验证。',
    keywords: ['具身群体智能', '多智能体', '无人作战'],
  };
  const topIds = rankJournalCandidates(project).slice(0, 5).map((item) => item.id);
  assert.ok(topIds.includes('ieee-ral'));
  assert.ok(topIds.includes('robotics-and-autonomous-systems'));
  assert.equal(topIds.includes('ieee-tse'), false);
});
