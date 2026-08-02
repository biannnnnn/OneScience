import { journals, journalCatalogNotice } from '../data/journals.mjs';

const normalizeTokens = (values) =>
  values
    .flatMap((value) => String(value || '').toLowerCase().split(/[\s,，;；、/|]+/))
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);

export function recommendJournals(project, preferences = {}) {
  const documentTokens = normalizeTokens([
    project.profile?.researchField,
    ...(project.profile?.keywords || []),
    ...(project.document?.keywords || []),
    project.document?.title,
    project.document?.abstract,
  ]);
  const preferredAccess = preferences.access || project.profile?.accessPreference || '不限';

  const recommendations = journals.map((journal) => {
    const journalTokens = normalizeTokens([...journal.fields, ...journal.keywords]);
    const hits = [
      ...new Set(
        journalTokens.filter((journalToken) =>
          documentTokens.some(
            (token) => journalToken.includes(token) || token.includes(journalToken),
          ),
        ),
      ),
    ].filter((token) => token.length <= 32);
    const fieldHit = project.profile?.researchField
      ? journal.fields.some((field) =>
          field.includes(project.profile.researchField) || project.profile.researchField.includes(field),
        )
      : false;
    const topicalFit = Math.min(92, 44 + hits.length * 8 + (fieldHit ? 18 : 0));
    const accessFit = preferredAccess === '不限' || preferredAccess === journal.access ? 100 : 58;
    const readiness = project.analysis.overall;
    const matchScore = Math.round(topicalFit * 0.62 + readiness * 0.25 + accessFit * 0.13);
    const reasons = [
      fieldHit && `与“${project.profile.researchField}”研究方向直接相关`,
      hits.length > 0 && `主题词匹配：${hits.slice(0, 4).join('、')}`,
      readiness >= 70 ? '当前稿件结构具备进一步适配基础' : '可在完成关键修改后进一步评估',
    ].filter(Boolean);
    const risks = project.analysis.issues
      .filter((issue) => issue.severity !== 'low')
      .slice(0, 2)
      .map((issue) => issue.title);

    return {
      ...journal,
      matchScore,
      topicalFit,
      reasons: reasons.length ? reasons : ['属于可作为对照的综合性投稿方向'],
      risks,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    notice: journalCatalogNotice,
    items: recommendations.sort((a, b) => b.matchScore - a.matchScore).slice(0, 5),
  };
}

function severityFromIssue(issue) {
  return issue.severity === 'high' ? '主要问题' : issue.severity === 'medium' ? '重要问题' : '次要问题';
}

export function generateReview(project) {
  if (!project.selectedJournal) throw new Error('请先选择目标期刊。');

  const issueComments = project.analysis.issues.slice(0, 6).map((issue, index) => ({
    id: `review-${index + 1}`,
    type: severityFromIssue(issue),
    category: issue.category,
    comment: issue.detail,
    request: issue.action,
    source: '稿件结构检查',
  }));

  const comments = [
    {
      id: 'review-summary',
      type: '总体评价',
      category: '期刊适配',
      comment: `稿件主题与 ${project.selectedJournal.name} 的演示范围具有一定关联，但仍需用更明确的贡献表述说明其对该刊读者的价值。`,
      request: '在摘要末尾和引言末尾分别补充面向目标期刊读者的贡献与影响说明。',
      source: '目标期刊适配检查',
    },
    ...issueComments,
  ];

  const tasks = comments
    .filter((comment) => comment.type !== '总体评价')
    .map((comment, index) => ({
      id: `task-${index + 1}`,
      title: comment.request,
      category: comment.category,
      priority: comment.type === '主要问题' ? '高' : comment.type === '重要问题' ? '中' : '低',
      completed: false,
    }));

  return {
    generatedAt: new Date().toISOString(),
    recommendation:
      project.analysis.overall >= 82
        ? '小修后再评估'
        : project.analysis.overall >= 62
          ? '大修后再评估'
          : '建议完成核心修改后重新选刊',
    summary: `本次模拟审稿共识别 ${comments.length - 1} 项具体问题。结果用于投稿前准备，不代表 ${project.selectedJournal.name} 的真实编辑决定。`,
    comments,
    tasks,
  };
}

function sentenceHighlights(text) {
  const sentences = String(text || '')
    .split(/(?<=[。！？.!?])\s*/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 20);
  return sentences.slice(0, 3).map((sentence) => sentence.slice(0, 180));
}

export function generateMaterials(project) {
  if (!project.selectedJournal) throw new Error('请先选择目标期刊。');
  const highlights = sentenceHighlights(project.document.abstract);
  const title = project.document.title;
  const journalName = project.selectedJournal.name;
  const field = project.profile?.researchField || '相关领域';

  return {
    generatedAt: new Date().toISOString(),
    coverLetter: `Dear Editor,\n\nWe are pleased to submit our manuscript entitled “${title}” for consideration in ${journalName}. This work addresses an important problem in ${field} and presents a structured study supported by the evidence described in the manuscript.\n\nThe manuscript is original, has not been published previously, and is not under consideration elsewhere. All authors have approved the submission. We believe the work will be of interest to the journal's readership because its central contribution aligns with the scope identified during our pre-submission assessment.\n\nThank you for your consideration.\n\nSincerely,\n[Corresponding author]`,
    highlights: highlights.length
      ? highlights
      : [
          '明确概括本文解决的核心研究问题。',
          '补充最重要的方法创新或技术贡献。',
          '填写能够量化支撑结论的核心结果。',
        ],
    checklist: [
      { id: 'check-title', label: '标题、摘要和关键词与投稿系统保持一致', checked: false },
      { id: 'check-guide', label: '已核对目标期刊最新作者指南与稿件类型', checked: false },
      { id: 'check-figures', label: '图表编号、清晰度、引用和版权信息完整', checked: false },
      { id: 'check-data', label: '数据、代码、伦理与利益冲突声明已按需填写', checked: false },
      { id: 'check-authors', label: '作者顺序、单位、邮箱和贡献声明已确认', checked: false },
      { id: 'check-proof', label: '完成语言、参考文献及格式最终校对', checked: false },
    ],
  };
}

function parseReviewComments(rawComments) {
  return String(rawComments || '')
    .replace(/\r/g, '')
    .split(/\n(?=(?:\s*(?:\d+[.)、]|[-*•]|Reviewer\s*#?\d+|审稿人\s*\d+)))/i)
    .flatMap((block) => block.split(/\n{2,}/))
    .map((block) => block.replace(/^\s*(?:\d+[.)、]|[-*•])\s*/, '').trim())
    .filter((block) => block.length >= 8)
    .slice(0, 20);
}

export function generateRebuttal(project, rawComments) {
  const comments = parseReviewComments(rawComments);
  if (!comments.length) throw new Error('请粘贴至少一条完整的审稿意见。');

  const items = comments.map((comment, index) => {
    const requestsEvidence = /实验|结果|数据|对比|消融|experiment|result|data|comparison|ablation/i.test(comment);
    const requestsClarity = /不清楚|解释|澄清|表达|语言|unclear|clarify|explain|language/i.test(comment);
    const action = requestsEvidence
      ? '补充或核对相应实验、数据与统计结果，并在回复中给出具体位置。'
      : requestsClarity
        ? '重写相关表述并标注修订页码与行号。'
        : '逐项核实意见，在论文中完成对应修改并标注位置。';
    return {
      id: `rebuttal-${index + 1}`,
      reviewerComment: comment,
      interpretation: requestsEvidence
        ? '审稿人主要关注证据是否足以支撑结论。'
        : requestsClarity
          ? '审稿人主要关注论述清晰度与可理解性。'
          : '该意见需要作者确认问题边界并提供直接回应。',
      action,
      response: `感谢审稿人的细致意见。我们认同该问题需要在稿件中得到更清楚的处理。为回应此意见，我们已/计划完成以下修改：[填写具体修改]。相应内容位于修订稿第 [X] 页第 [Y–Z] 行。修改后的表述或结果为：“[粘贴关键修订内容]”。我们相信这项修改能够充分回应审稿人的关切。`,
      completed: false,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    notice: '回复草稿保留了证据和页码占位符，提交前必须由作者逐项核实，禁止虚构实验或修改。',
    items,
  };
}

export const __testables = { normalizeTokens, parseReviewComments, sentenceHighlights };
