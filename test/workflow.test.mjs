import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateMaterials,
  generateRebuttal,
  generateReview,
  recommendJournals,
} from '../server/lib/workflow.mjs';
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
  assert.equal(result.catalog.size, 71);
  assert.ok(result.items[0].matchScore >= result.items[1].matchScore);
  assert.ok(result.items.every((item) => item.reasons.length > 0));
  assert.ok(result.items.every((item) => item.source.url.startsWith('https://')));
  assert.match(result.notice, /不代表录用概率/);
});

test('journal catalog includes the complete CCF 2025 T1 and T2 lists', () => {
  assert.equal(journals.length, 71);
  assert.equal(journals.filter((journal) => journal.ccfTier === 'CCF-T1').length, 19);
  assert.equal(journals.filter((journal) => journal.ccfTier === 'CCF-T2').length, 22);
  assert.equal(new Set(journals.map((journal) => journal.id)).size, journals.length);
  assert.ok(journals.filter((journal) => journal.ccfTier).every((journal) => journal.cn && journal.language && journal.organizer));
});

test('international journals expose versioned CCF and CAS ranking labels', () => {
  const byId = new Map(journals.map((journal) => [journal.id, journal]));
  assert.deepEqual(
    [byId.get('ieee-tpami').ccfRank, byId.get('ieee-tpami').casZone],
    ['CCF-A', '中科院1区'],
  );
  assert.deepEqual(
    [byId.get('eswa').ccfRank, byId.get('eswa').casZone],
    ['CCF-C', '中科院1区'],
  );
  assert.deepEqual(
    [byId.get('machine-learning').ccfRank, byId.get('machine-learning').casZone],
    ['CCF-B', '中科院4区'],
  );
  assert.equal(byId.get('nature-machine-intelligence').ccfRank, undefined);
  assert.equal(byId.get('nature-machine-intelligence').casZone, '中科院1区');
  assert.equal(byId.get('ieee-tai').ccfRank, undefined);
  assert.equal(byId.get('ieee-tai').casZone, undefined);
  assert.ok(journals.filter((journal) => journal.ccfRank).every((journal) => journal.rankingVersions.ccf === '2022'));
  assert.ok(journals.filter((journal) => journal.casZone).every((journal) => journal.rankingVersions.cas === '2025年3月升级版'));
});

test('specific embodied multi-agent terms outrank generic computer terms', () => {
  const project = projectFixture();
  project.document = {
    title: '面向无人作战的具身群体智能协同决策方法',
    abstract: '研究多智能体与无人系统中的协同决策，并在仿真任务中验证。',
    keywords: ['具身群体智能', '多智能体', '无人作战'],
  };
  const result = recommendJournals(project, {}, { limit: 8 });
  const topIds = result.items.slice(0, 5).map((item) => item.id);
  assert.ok(topIds.includes('ieee-ral'));
  assert.ok(topIds.includes('robotics-and-autonomous-systems'));
  assert.equal(topIds.includes('ieee-tse'), false);
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
