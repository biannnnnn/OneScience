const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, Math.round(value)));

const hasAny = (text, patterns) => patterns.some((pattern) => pattern.test(text));

function scoreCompleteness(document) {
  const sections = document.detectedSections;
  const core = ['abstract', 'introduction', 'methods', 'results', 'conclusion', 'references'];
  const sectionScore = core.filter((name) => sections[name]).length * 11;
  const discussionBonus = sections.discussion ? 8 : 0;
  const lengthBonus = document.wordCount >= 3500 ? 18 : document.wordCount >= 1800 ? 12 : 6;
  return clamp(sectionScore + discussionBonus + lengthBonus);
}

function scoreReproducibility(document) {
  const text = document.text;
  let score = document.detectedSections.methods ? 42 : 18;
  if (hasAny(text, [/数据集|dataset|样本量|sample size|participants?/i])) score += 14;
  if (hasAny(text, [/参数|parameter|超参数|hyperparameter|实验设置|experimental setup/i])) score += 14;
  if (hasAny(text, [/代码|source code|github|开源|open.?source/i])) score += 12;
  if (hasAny(text, [/伦理|ethics|知情同意|informed consent|institutional review/i])) score += 8;
  if (hasAny(text, [/随机|random|对照|control group|置信区间|confidence interval/i])) score += 10;
  return clamp(score);
}

function scoreEvidence(document) {
  const text = document.text;
  let score = document.detectedSections.results ? 32 : 14;
  score += Math.min(document.referenceCount * 1.2, 28);
  if (hasAny(text, [/图\s*\d+|表\s*\d+|figure\s*\d+|table\s*\d+/i])) score += 13;
  if (hasAny(text, [/p\s*[<=>]\s*0?\./i, /显著|significant|confidence interval|置信区间/i])) score += 13;
  if (hasAny(text, [/基线|baseline|对比实验|ablation|消融/i])) score += 14;
  return clamp(score);
}

function scoreClarity(document) {
  const titleLength = document.title.length;
  let score = titleLength >= 8 && titleLength <= 120 ? 28 : 18;
  const abstractLength = document.abstract.length;
  score += abstractLength >= 120 && abstractLength <= 1800 ? 34 : abstractLength > 0 ? 20 : 6;
  if (document.keywords.length >= 3) score += 13;
  if (document.detectedSections.introduction) score += 10;
  if (document.detectedSections.conclusion) score += 10;
  if (/本文|本研究|this (paper|study|work)/i.test(document.abstract)) score += 5;
  return clamp(score);
}

function scoreNovelty(document) {
  const focus = `${document.title}\n${document.abstract}`;
  let score = document.abstract ? 44 : 25;
  if (hasAny(focus, [/首次|首个|创新|新颖|novel|new framework|for the first time/i])) score += 22;
  if (hasAny(focus, [/提出|构建|设计|propose|introduce|develop/i])) score += 16;
  if (hasAny(focus, [/相比|优于|outperform|compared with|state.?of.?the.?art/i])) score += 12;
  return clamp(score);
}

function makeIssues(document, scores) {
  const issues = [];
  const add = (severity, category, title, detail, action) =>
    issues.push({ id: `issue-${issues.length + 1}`, severity, category, title, detail, action });

  if (!document.abstract) {
    add('high', '结构完整性', '未识别到摘要', '摘要是期刊初筛和检索匹配的核心信息。', '补充结构化摘要，明确问题、方法、结果和结论。');
  }
  if (!document.detectedSections.methods) {
    add('high', '可复现性', '方法章节不明确', '系统未识别到独立的方法或材料与方法章节。', '补充研究设计、数据来源、参数设置和分析流程。');
  }
  if (!document.detectedSections.results) {
    add('high', '证据充分性', '结果章节不明确', '论文缺少可识别的结果或实验结果部分。', '将核心结果集中呈现，并与研究问题逐项对应。');
  }
  if (document.referenceCount < 12) {
    add('medium', '文献基础', '参考文献可能不足', `当前识别到约 ${document.referenceCount} 条参考文献。`, '补充近五年代表性研究，并核对关键结论的引用依据。');
  }
  if (scores.reproducibility < 65) {
    add('medium', '可复现性', '复现实验信息不足', '数据、样本、参数或代码可用性信息尚不充分。', '增加数据获取、环境配置、参数与随机性控制说明。');
  }
  if (scores.novelty < 65) {
    add('medium', '创新表达', '创新贡献表达不集中', '标题和摘要中尚未清晰识别研究相对现有工作的增量。', '用 2–3 条可验证贡献明确“已有方法—差距—本文改进”。');
  }
  if (document.keywords.length < 3) {
    add('low', '可检索性', '关键词不足', '关键词会影响期刊匹配和论文检索表现。', '补充 3–6 个领域词、方法词和任务词。');
  }
  if (!document.detectedSections.discussion) {
    add('low', '论证深度', '讨论部分不独立', '未识别到对结果含义、局限和外部有效性的集中讨论。', '增加讨论章节，解释结果、局限性和适用范围。');
  }

  return issues.slice(0, 8);
}

export function analyzeDocument(document) {
  const scores = {
    completeness: scoreCompleteness(document),
    novelty: scoreNovelty(document),
    reproducibility: scoreReproducibility(document),
    evidence: scoreEvidence(document),
    clarity: scoreClarity(document),
  };
  const overall = clamp(
    scores.completeness * 0.24 +
      scores.novelty * 0.18 +
      scores.reproducibility * 0.2 +
      scores.evidence * 0.2 +
      scores.clarity * 0.18,
  );
  const issues = makeIssues(document, scores);
  const strengths = [
    document.detectedSections.abstract && '摘要结构可用于后续期刊匹配',
    document.detectedSections.methods && '已识别独立方法章节',
    document.detectedSections.results && '已识别结果或实验章节',
    document.referenceCount >= 20 && '文献基础相对充分',
    scores.evidence >= 75 && '结果证据呈现较完整',
    scores.clarity >= 75 && '标题、摘要和章节结构较清晰',
  ].filter(Boolean);

  const confidence = clamp(
    42 +
      Math.min(document.wordCount / 150, 28) +
      Object.values(document.detectedSections).filter(Boolean).length * 4,
    45,
    92,
  );

  return {
    overall,
    level: overall >= 82 ? '准备充分' : overall >= 68 ? '具备基础' : overall >= 52 ? '需要完善' : '建议重点修改',
    confidence,
    scores,
    strengths: strengths.length ? strengths : ['已成功解析稿件，可进入结构化改进流程'],
    issues,
    summary:
      overall >= 75
        ? '稿件已具备较完整的投稿基础，建议围绕目标期刊进一步强化适配性与贡献表达。'
        : '稿件已形成基本研究结构，但在正式选刊前仍需优先处理高风险问题。',
    notice: '本结果由可解释规则生成，用于投稿前自检，不替代同行评审或期刊编辑判断。',
  };
}

export const __testables = {
  scoreCompleteness,
  scoreReproducibility,
  scoreEvidence,
  scoreClarity,
  scoreNovelty,
};
