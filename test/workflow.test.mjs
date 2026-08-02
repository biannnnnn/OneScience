import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateMaterials,
  generateRebuttal,
  generateReview,
  recommendJournals,
} from '../server/lib/workflow.mjs';

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
      issues: [
        {
          severity: 'medium',
          category: '可复现性',
          title: '复现实验信息不足',
          detail: '参数信息不完整。',
          action: '补充参数设置。',
        },
      ],
    },
  };
}

test('journal recommendation returns ranked explainable results', () => {
  const result = recommendJournals(projectFixture());
  assert.equal(result.items.length, 5);
  assert.ok(result.items[0].matchScore >= result.items[1].matchScore);
  assert.ok(result.items.every((item) => item.reasons.length > 0));
  assert.match(result.notice, /演示目录/);
});

test('review and materials form a complete preparation chain', () => {
  const project = projectFixture();
  project.selectedJournal = recommendJournals(project).items[0];
  const review = generateReview(project);
  assert.ok(review.comments.length >= 2);
  assert.ok(review.tasks.length >= 1);
  project.review = review;
  const materials = generateMaterials(project);
  assert.match(materials.coverLetter, new RegExp(project.selectedJournal.name));
  assert.equal(materials.checklist.length, 6);
});

test('reviewer comments are split into rebuttal items with evidence placeholders', () => {
  const project = projectFixture();
  const result = generateRebuttal(
    project,
    '1. Please add an ablation experiment and report the results.\n\n2. The method description is unclear.',
  );
  assert.equal(result.items.length, 2);
  assert.ok(result.items[0].action.includes('实验'));
  assert.ok(result.items.every((item) => item.response.includes('[X]')));
});
