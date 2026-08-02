import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeManuscriptWithDeepSeek,
  getDeepSeekStatus,
  rerankJournalsWithDeepSeek,
  __testables,
} from '../server/lib/deepseek.mjs';

test('model status never exposes the API key', () => {
  const status = getDeepSeekStatus({
    DEEPSEEK_API_KEY: 'test-secret-key',
    DEEPSEEK_MODEL: 'deepseek-v4-pro',
  });
  assert.equal(status.configured, true);
  assert.equal(status.model, 'deepseek-v4-pro');
  assert.doesNotMatch(JSON.stringify(status), /test-secret-key/);
});

test('JSON parser accepts fenced structured output', () => {
  const result = __testables.parseJsonContent('```json\n{"confidence":0.81}\n```');
  assert.equal(result.confidence, 0.81);
});

test('DeepSeek assessment uses structured output and normalizes results', async () => {
  let capturedRequest;
  const fetchImpl = async (url, init) => {
    capturedRequest = { url, init, body: JSON.parse(init.body) };
    return {
      ok: true,
      json: async () => ({
        id: 'test-request',
        model: 'deepseek-v4-pro',
        usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
        choices: [
          {
            message: {
              content: JSON.stringify({
                overall_assessment: '研究结构完整，但贡献边界仍需收紧。',
                central_contribution: '构建可解释投稿辅助流程。',
                strengths: [{ point: '流程完整', evidence: '方法章节描述了完整流程。' }],
                major_issues: [
                  {
                    category: '实验设计',
                    issue: '样本规模较小',
                    evidence: '正文仅报告30个测试样例。',
                    suggestion: '扩大样本并报告置信区间。',
                  },
                ],
                minor_issues: [],
                recommended_actions: ['补充更大规模实验'],
                confidence: 0.78,
              }),
            },
          },
        ],
      }),
    };
  };

  const assessment = await analyzeManuscriptWithDeepSeek(
    {
      title: '示例论文',
      language: '中文',
      keywords: ['智能体'],
      referenceCount: 12,
      text: '摘要和正文内容。'.repeat(100),
    },
    {
      fetchImpl,
      env: {
        DEEPSEEK_API_KEY: 'test-key',
        DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
        DEEPSEEK_MODEL: 'deepseek-v4-pro',
        DEEPSEEK_THINKING: 'enabled',
      },
    },
  );

  assert.equal(capturedRequest.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(capturedRequest.body.model, 'deepseek-v4-pro');
  assert.deepEqual(capturedRequest.body.response_format, { type: 'json_object' });
  assert.equal(capturedRequest.body.thinking.type, 'enabled');
  assert.equal(assessment.status, 'ready');
  assert.equal(assessment.majorIssues[0].category, '实验设计');
  assert.equal(assessment.trace.usage.totalTokens, 200);
});

test('long manuscripts are bounded before remote transmission', () => {
  const context = __testables.manuscriptContext({ text: 'a'.repeat(90_000) });
  assert.equal(context.truncated, true);
  assert.ok(context.text.length < 61_000);
  assert.equal(context.suppliedCharacters, 60_000);
});

test('DeepSeek journal ranking is restricted to supplied candidates and blended with rule scores', async () => {
  const candidates = [
    {
      id: 'journal-a', name: 'Journal A', fields: ['人工智能'], profile: 'AI methods',
      audience: ['AI researchers'], evidencePreferences: ['strong experiments'], access: '混合模式',
      ruleScore: 80, matchScore: 80, topicalFit: 80, audienceFit: 75, evidenceFit: 70,
      reasons: ['规则理由 A'], risks: [], preparationActions: [],
    },
    {
      id: 'journal-b', name: 'Journal B', fields: ['智能体'], profile: 'Agent systems',
      audience: ['Agent researchers'], evidencePreferences: ['system validation'], access: '开放获取',
      ruleScore: 60, matchScore: 60, topicalFit: 65, audienceFit: 65, evidenceFit: 70,
      reasons: ['规则理由 B'], risks: [], preparationActions: [],
    },
    {
      id: 'journal-c', name: 'Journal C', fields: ['机器人'], profile: 'Robotics',
      audience: ['Robotics researchers'], evidencePreferences: ['system experiments'], access: '混合模式',
      ruleScore: 55, matchScore: 55, topicalFit: 55, audienceFit: 55, evidenceFit: 70,
      reasons: ['规则理由 C'], risks: [], preparationActions: [],
    },
  ];
  let capturedRequest;
  const fetchImpl = async (_url, init) => {
    capturedRequest = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
      id: 'journal-ranking-request',
      model: 'deepseek-v4-pro',
      choices: [{ message: { content: JSON.stringify({
        rankings: [
          {
            journal_id: 'journal-b', fit_score: 96, scope_fit: 95, audience_fit: 92,
            evidence_fit: 78, reasons: ['论文主题与智能体读者直接相关'],
            concerns: ['需要补充系统验证'], preparation_actions: ['增加多任务实验'],
          },
          { journal_id: 'invented-journal', fit_score: 100, reasons: ['不得进入结果'] },
          { journal_name: 'Journal C', fit_score: 70, reasons: ['机器人方向可作为补充候选'] },
          { journal_id: 'journal-a', fit_score: 50, reasons: ['主题关联较弱'] },
        ],
        confidence: 0.82,
      }) } }],
      }),
    };
  };

  const result = await rerankJournalsWithDeepSeek(
    {
      document: { title: '智能体系统', abstract: '本文提出一种智能体系统。', keywords: ['智能体'] },
      profile: { researchField: '人工智能', accessPreference: '不限' },
      analysis: { overall: 72, issues: [] },
    },
    candidates,
    { fetchImpl, env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_MODEL: 'deepseek-v4-pro' } },
  );

  assert.equal(result.method, 'deepseek-assisted');
  assert.equal(capturedRequest.thinking.type, 'disabled');
  assert.equal(result.items[0].id, 'journal-b');
  assert.equal(result.items.some((item) => item.id === 'invented-journal'), false);
  assert.equal(result.items.some((item) => item.id === 'journal-c'), true);
  assert.equal(result.items[0].fitBreakdown.scope, 95);
  assert.equal(result.confidence, 0.82);
});
