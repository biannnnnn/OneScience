import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { extractDocument } from './lib/extractor.mjs';
import { analyzeDocument } from './lib/analyzer.mjs';
import {
  analyzeManuscriptWithDeepSeek,
  generateJournalSearchPlanWithDeepSeek,
  getDeepSeekStatus,
} from './lib/deepseek.mjs';
import { discoverJournalSourcesFromWorks, getOpenAlexStatus, findRecentSimilarPapers } from './lib/scholarly-search.mjs';
import {
  fallbackManuscriptScore,
  fallbackReferenceScore,
} from './lib/reviewer-client.mjs';
import {
  getRankerServiceStatus,
  scoreFromRanker,
  scorePapersWithRanker,
} from './lib/ranker-client.mjs';
import {
  getDeepSeekScorerStatus,
  scoreFromDeepSeek,
  scorePapersWithDeepSeek,
} from './lib/deepseek-scorer.mjs';
import {
  DEFAULT_SCORING_MODEL,
  SCORING_MODELS,
  normalizeScoringModel,
  scoringModelDefinition,
} from './lib/scoring-models.mjs';
import {
  compareWithJournalBenchmark,
  enrichJournalMetrics,
  selectDistinctJournals,
  workflowKeywords,
} from './lib/review-flow.mjs';
import { enrichDiscoveredJournal, prestigeBandForDiscovered } from './lib/journal-discovery.mjs';
import { journalCatalog, journals } from './data/journals.mjs';
import { getProject, listProjects, patchProject, saveProject } from './lib/store.mjs';

const app = express();
const port = Number(process.env.PORT || 3001);
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});
const volatileDocuments = new Map();

app.use(express.json({ limit: '2mb' }));

function publicDocument(document) {
  const { text, ...metadata } = document;
  return metadata;
}

async function createProjectFromDocument(document, profile, options = {}) {
  const analysis = analyzeDocument(document);
  const modelStatus = getDeepSeekStatus();
  let aiAnalysis = null;
  if (modelStatus.configured && options.useAI !== false) {
    try {
      aiAnalysis = await analyzeManuscriptWithDeepSeek(document);
    } catch (error) {
      aiAnalysis = {
        status: 'error',
        model: modelStatus.model,
        generatedAt: new Date().toISOString(),
        message: 'DeepSeek 深度评估暂时不可用，已保留规则评估结果。',
      };
      console.error(`DeepSeek assessment failed: ${error.message}`);
    }
  }
  const now = new Date().toISOString();
  const project = {
    id: crypto.randomUUID(),
    name: document.title,
    status: aiAnalysis?.status === 'ready' ? 'AI 深度评估已完成' : '已完成初评',
    stage: 1,
    createdAt: now,
    updatedAt: now,
    profile,
    document: publicDocument(document),
    analysis,
    aiAnalysis,
    reviewFlow: null,
  };
  volatileDocuments.set(project.id, document);
  return saveProject(project);
}

app.get('/api/health', async (_request, response) => {
  response.json({
    ok: true,
    service: 'onescience-submission-agent',
    version: '0.7.0',
    model: getDeepSeekStatus(),
    scholarlySearch: getOpenAlexStatus(),
    ranker: await getRankerServiceStatus(),
  });
});

app.get('/api/model/status', async (_request, response) => {
  const rankerStatuses = await Promise.all(
    SCORING_MODELS.filter((model) => model.kind === 'ranker')
      .map((model) => getRankerServiceStatus({ modelId: model.id })),
  );
  const deepSeekScorer = getDeepSeekScorerStatus();
  response.json({
    llm: getDeepSeekStatus(),
    scholarlySearch: getOpenAlexStatus(),
    ranker: rankerStatuses[0],
    scoringModels: [...rankerStatuses, {
      ...deepSeekScorer,
      id: 'deepseek',
      label: 'DeepSeek 大模型',
      kind: 'deepseek',
    }],
  });
});

app.get('/api/journals', (_request, response) => {
  response.json({
    catalog: { ...journalCatalog, size: journals.length },
    items: journals.map(({ keywords, ...item }) => item),
  });
});

app.get('/api/projects', async (_request, response, next) => {
  try {
    response.json(await listProjects());
  } catch (error) {
    next(error);
  }
});

app.get('/api/projects/:id', async (request, response, next) => {
  try {
    const project = await getProject(request.params.id);
    if (!project) return response.status(404).json({ error: '未找到该投稿项目。' });
    response.json(project);
  } catch (error) {
    next(error);
  }
});

app.post('/api/analyze', upload.single('paper'), async (request, response, next) => {
  try {
    if (!request.file) return response.status(400).json({ error: '请选择需要分析的论文文件。' });
    const extracted = await extractDocument(request.file);
    const project = await createProjectFromDocument(
      extracted,
      {
        researchField: request.body.researchField?.trim() || '',
        keywords: String(request.body.keywords || '')
          .split(/[,，;；、]/)
          .map((item) => item.trim())
          .filter(Boolean),
        accessPreference: request.body.accessPreference || '不限',
      },
      { useAI: request.body.useAI !== 'false' },
    );
    response.status(201).json(project);
  } catch (error) {
    next(error);
  }
});

app.post('/api/demo', async (request, response, next) => {
  try {
    const demoText = `面向科研论文的可解释智能投稿辅助方法\n\n摘要：针对科研人员选刊依据分散、投稿准备重复和审稿意见处理效率低的问题，本研究提出一种可解释的全链路智能投稿辅助框架。该框架融合论文结构分析、期刊知识检索和任务化修订机制，并在计算机科学领域样例数据上开展验证。实验结果表明，该方法能够稳定识别稿件结构风险并生成可追踪的修改任务，为人机协同投稿提供可复现的实现路径。\n\n关键词：学术投稿；智能体；论文评估；期刊推荐；可解释人工智能\n\n1 引言\n学术投稿涉及论文评估、选刊、格式准备和审稿回复等多个阶段。现有工具通常只覆盖其中一个环节，难以保留跨阶段决策依据。本文提出一个统一工作流，并总结三项主要贡献。\n\n2 研究方法\n我们构建包含论文解析器、规则评估器和期刊匹配器的原型系统。数据集包含 120 篇公开论文元数据，按照 8:2 划分测试样本。所有评分参数、随机种子和实验配置均保存在公开配置文件中。\n\n3 实验结果\n与关键词检索基线相比，本方法在 30 个测试样例上的任务覆盖率提高 18.4%。消融实验显示，结构识别和用户偏好分别贡献 9.1% 和 6.3% 的增益，p < 0.05。\n\n4 讨论\n结果表明结构化流程能够提高投稿准备的一致性，但当前样本规模有限，且尚未覆盖不同学科的评价差异。\n\n5 结论\n本文验证了可解释智能投稿辅助流程的可行性，后续将扩大数据规模并引入真实投稿结果。\n\n参考文献\n[1] Author A. Intelligent research workflows. 2024.\n[2] Author B. Journal recommendation systems. 2023.\n[3] Author C. Explainable artificial intelligence. 2022.\n[4] Author D. Scientific document analysis. 2024.\n[5] Author E. Human-AI collaboration. 2021.\n[6] Author F. Scholarly communication. 2020.\n[7] Author G. Reproducible experiments. 2023.\n[8] Author H. Peer review analytics. 2022.\n[9] Author I. Academic writing support. 2024.\n[10] Author J. Research information retrieval. 2021.\n[11] Author K. Submission decision support. 2023.\n[12] Author L. Document quality assessment. 2022.`;
    const fakeFile = { originalname: 'OneScience-MVP-示例论文.txt', buffer: Buffer.from(demoText) };
    const extracted = await extractDocument(fakeFile);
    const project = await createProjectFromDocument(
      extracted,
      {
        researchField: '计算机科学',
        keywords: ['智能体', '论文评估', '期刊推荐'],
        accessPreference: '不限',
      },
      { useAI: true },
    );
    response.status(201).json(project);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/projects/:id', async (request, response, next) => {
  try {
    const allowed = ['name', 'status'];
    const safePatch = Object.fromEntries(
      Object.entries(request.body).filter(([key]) => allowed.includes(key)),
    );
    const project = await patchProject(request.params.id, safePatch);
    if (!project) return response.status(404).json({ error: '未找到该投稿项目。' });
    response.json(project);
  } catch (error) {
    next(error);
  }
});

app.post('/api/projects/:id/review-flow', async (request, response, next) => {
  try {
    const project = await getProject(request.params.id);
    if (!project) return response.status(404).json({ error: '未找到该投稿项目。' });
    const journalCount = Math.max(2, Math.min(Number(request.body.k) || 5, 8));
    const papersPerJournal = Math.max(1, Math.min(Number(request.body.n) || 3, 8));
    const recentYears = Math.max(1, Math.min(Number(request.body.recentYears) || 3, 8));
    const scoringModel = normalizeScoringModel(request.body.scoringModel || DEFAULT_SCORING_MODEL);
    if (!scoringModel) {
      return response.status(422).json({ error: '评分模型无效，可选值为 ranker-8b、ranker-3b、ranker-0.6b 或 deepseek。' });
    }
    const scorerDefinition = scoringModelDefinition(scoringModel);
    const keywords = workflowKeywords(project);
    if (!keywords.length) return response.status(422).json({ error: '未能提取有效关键词，请补充研究方向或关键词后重试。' });

    const openAlexStatus = getOpenAlexStatus();
    let searchQueries = [];
    let searchSubjects = [];
    let discoveryMethod = 'openalex-web-discovery';
    let discoveryModel = null;
    let llmError = null;
    if (getDeepSeekStatus().configured && request.body.useAI !== false) {
      try {
        const plan = await generateJournalSearchPlanWithDeepSeek(project);
        searchQueries = plan.searchQueries;
        searchSubjects = plan.subjects;
        discoveryMethod = 'openalex-web-discovery+llm-search-plan';
        discoveryModel = plan.model;
      } catch (error) {
        llmError = error.message;
      }
    }
    if (!searchQueries.length) {
      searchQueries = [keywords.slice(0, 8).join(' ')];
      discoveryMethod = 'openalex-web-discovery+keyword-fallback';
    }
    if (!openAlexStatus.configured) {
      return response.status(422).json({ error: '未配置 OPENALEX_API_KEY，无法执行期刊 Web 检索。' });
    }
    const worksPerQuery = Math.max(10, Math.min(Number(request.body.worksPerQuery) || 50, 100));
    const minWorksCount = Math.max(0, Math.min(Number(request.body.minWorksCount) || 500, 1_000_000));
    const discovery = await discoverJournalSourcesFromWorks(searchQueries, {
      limit: Math.max(15, journalCount * 5),
      worksPerQuery,
      recentYears: Math.max(recentYears, 5),
      minWorksCount,
    });
    const discoveredCandidates = discovery.sources.map((source) => enrichDiscoveredJournal(source));
    prestigeBandForDiscovered(discoveredCandidates);
    const candidates = selectDistinctJournals(discoveredCandidates, journalCount);
    const scorerStatus = scorerDefinition.kind === 'deepseek'
      ? { ...getDeepSeekScorerStatus(), id: scoringModel, label: scorerDefinition.label, kind: 'deepseek' }
      : await getRankerServiceStatus({ modelId: scoringModel });
    const journalResults = [];

    for (const candidate of candidates) {
      let retrieval = { source: null, items: [] };
      let retrievalError = null;
      if (openAlexStatus.configured) {
        try {
          retrieval = await findRecentSimilarPapers(candidate, keywords, {
            limit: papersPerJournal,
            recentYears,
            queries: searchQueries,
            source: {
              id: candidate.openAlexId,
              openAlexUrl: candidate.source?.url || null,
              name: candidate.name,
              issn: null,
              worksCount: candidate.openAlex?.worksCount || 0,
              citedByCount: candidate.openAlex?.citedByCount || 0,
              twoYearMeanCitedness: candidate.openAlex?.twoYearMeanCitedness ?? null,
            },
          });
        } catch (error) {
          retrievalError = error.message;
        }
      } else {
        retrievalError = '未配置 OPENALEX_API_KEY，未执行近期论文 Web 检索。';
      }
      const journal = enrichJournalMetrics(candidate, retrieval.source);
      const originalDocument = volatileDocuments.get(project.id) || {
        ...project.document,
        text: project.document?.abstract || '',
      };
      let referencePapers = retrieval.items.map((paper) => ({
        ...paper,
        modelScore: fallbackReferenceScore(paper),
        scoringError: null,
      }));
      let manuscriptScore = fallbackManuscriptScore(project, journal);
      let manuscriptReview = null;
      let scoringError = null;
      let scoringTrace = null;
      const batchScoringAvailable = scorerStatus.available
        && (scorerDefinition.kind === 'deepseek'
          || scorerStatus.capabilities?.includes('paper_score_batch'));
      if (batchScoringAvailable && originalDocument.abstract) {
        try {
          const scoreInputs = [
            {
              paperId: project.id,
              title: originalDocument.title,
              abstract: originalDocument.abstract,
            },
            ...referencePapers
              .filter((paper) => paper.abstract)
              .map((paper) => ({
                paperId: paper.id,
                title: paper.title,
                abstract: paper.abstract,
              })),
          ];
          const scored = scorerDefinition.kind === 'deepseek'
            ? await scorePapersWithDeepSeek(scoreInputs)
            : await scorePapersWithRanker(scoreInputs, { modelId: scoringModel });
          scoringTrace = scored.modelTrace;
          const scoreById = new Map(scored.scores.map((item) => [item.paper_id, item]));
          const manuscriptItem = scoreById.get(project.id);
          if (!manuscriptItem) throw new Error(`${scorerDefinition.label} 未返回用户稿件评分。`);
          const mapScore = scorerDefinition.kind === 'deepseek' ? scoreFromDeepSeek : scoreFromRanker;
          manuscriptScore = mapScore(manuscriptItem, scored.modelTrace);
          referencePapers = referencePapers.map((paper) => {
            const scoreItem = scoreById.get(paper.id);
            return scoreItem
              ? { ...paper, modelScore: mapScore(scoreItem, scored.modelTrace) }
              : { ...paper, scoringError: paper.abstract ? '批量评分结果缺少该论文。' : 'OpenAlex 未提供摘要。' };
          });
        } catch (error) {
          scoringError = error.message;
          referencePapers = referencePapers.map((paper) => ({
            ...paper,
            scoringError: paper.abstract ? error.message : 'OpenAlex 未提供摘要。',
          }));
        }
      } else if (scorerStatus.available && !originalDocument.abstract) {
        scoringError = `用户稿件未识别到摘要，${scorerDefinition.label} 不会使用全文替代标题+摘要输入。`;
        referencePapers = referencePapers.map((paper) => ({
          ...paper,
          scoringError: paper.abstract ? scoringError : 'OpenAlex 未提供摘要。',
        }));
      } else if (scorerStatus.available) {
        scoringError = `${scorerDefinition.label} 尚未部署 paper_score_batch 能力。`;
      } else {
        scoringError = scorerStatus.error || `${scorerDefinition.label} 不可用。`;
      }
      journalResults.push({
        journal,
        retrieval: {
          provider: 'OpenAlex',
          source: retrieval.source,
          queryKeywords: keywords,
          searchQueries: retrieval.queries || searchQueries,
          queryErrors: retrieval.errors || [],
          recentYears,
          error: retrievalError,
        },
        referencePapers,
        manuscriptScore,
        manuscriptReview,
        scoringTrace,
        rankerTrace: scorerDefinition.kind === 'ranker' ? scoringTrace : null,
        scoringError,
        comparison: compareWithJournalBenchmark(manuscriptScore, referencePapers),
      });
    }

    const reviewFlow = {
      schemaVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      hyperparameters: { k: journalCount, n: papersPerJournal, recentYears, scoringModel },
      scoring: { model: scoringModel, label: scorerDefinition.label, kind: scorerDefinition.kind },
      keywords,
      discovery: {
        method: discoveryMethod,
        model: discoveryModel,
        llmError,
        searchQueries,
        subjects: searchSubjects,
        queryCount: searchQueries.length,
        worksExamined: discovery.worksExamined,
        evidenceJournalCount: discovery.evidenceJournalCount,
        sourceCount: discovery.sources.length,
        retrievalErrors: discovery.errors,
        diversityPolicy: '至少覆盖高挑战、稳健、广覆盖三个梯度（候选充足时）；分级优先权威 JIF/CCF/中科院，缺失时用 OpenAlex 引用指标近似分档。',
      },
      services: {
        openAlex: openAlexStatus,
        ranker: scorerDefinition.kind === 'ranker' ? scorerStatus : null,
        scorer: scorerStatus,
      },
      journals: journalResults,
      notice: `${scorerDefinition.label} 只提供论文质量相对排序；系统据此比较稿件与每本期刊的近期相似论文基线，不展示录用概率。`,
    };
    response.json(await patchProject(project.id, {
      reviewFlow,
      stage: 4,
      status: '当前审稿流程已完成',
    }));
  } catch (error) {
    next(error);
  }
});

if (process.env.NODE_ENV === 'production') {
  const distDir = path.resolve(currentDir, '../dist');
  app.use(express.static(distDir));
  app.get('*splat', (_request, response) => response.sendFile(path.join(distDir, 'index.html')));
}

app.use((error, _request, response, _next) => {
  const isUploadLimit = error?.code === 'LIMIT_FILE_SIZE';
  const status = isUploadLimit ? 413 : 400;
  const message = isUploadLimit ? '文件不能超过 15 MB。' : error.message || '处理请求时发生错误。';
  console.error(error);
  response.status(status).json({ error: message });
});

app.listen(port, '127.0.0.1', () => {
  console.log(`OneScience API running at http://127.0.0.1:${port}`);
});
