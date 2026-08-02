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
  getDeepSeekStatus,
  rerankJournalsWithDeepSeek,
} from './lib/deepseek.mjs';
import { journalCatalog, journals } from './data/journals.mjs';
import { getProject, listProjects, patchProject, saveProject } from './lib/store.mjs';
import {
  generateMaterials,
  generateRebuttal,
  generateReview,
  recommendJournals,
} from './lib/workflow.mjs';

const app = express();
const port = Number(process.env.PORT || 3001);
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

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
    recommendations: null,
    selectedJournal: null,
    review: null,
    materials: null,
    rebuttal: null,
  };
  return saveProject(project);
}

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    service: 'onescience-submission-agent',
    version: '0.6.0',
    model: getDeepSeekStatus(),
  });
});

app.get('/api/model/status', (_request, response) => {
  response.json(getDeepSeekStatus());
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
    const allowed = ['name', 'status', 'stage', 'profile', 'selectedJournal', 'review', 'materials', 'rebuttal'];
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

app.post('/api/projects/:id/recommend', async (request, response, next) => {
  try {
    const project = await getProject(request.params.id);
    if (!project) return response.status(404).json({ error: '未找到该投稿项目。' });
    const ruleRecommendations = recommendJournals(project, request.body, { limit: 12 });
    let recommendations = {
      ...ruleRecommendations,
      items: ruleRecommendations.items.slice(0, 5),
    };
    if (getDeepSeekStatus().configured && request.body.useAI !== false) {
      try {
        const aiRanking = await rerankJournalsWithDeepSeek(project, ruleRecommendations.items);
        recommendations = {
          ...ruleRecommendations,
          ...aiRanking,
          catalog: ruleRecommendations.catalog,
          notice: ruleRecommendations.notice,
        };
      } catch (error) {
        recommendations.aiError = 'DeepSeek 重排暂时不可用，本次已返回规则匹配结果。';
        console.error(`DeepSeek journal ranking failed: ${error.message}`);
      }
    }
    response.json(await patchProject(project.id, {
      recommendations,
      stage: Math.max(project.stage, 2),
      status: recommendations.method === 'deepseek-assisted' ? 'AI 期刊匹配已完成' : '待选择期刊',
    }));
  } catch (error) {
    next(error);
  }
});

app.post('/api/projects/:id/review', async (request, response, next) => {
  try {
    const project = await getProject(request.params.id);
    if (!project) return response.status(404).json({ error: '未找到该投稿项目。' });
    const review = generateReview(project);
    response.json(await patchProject(project.id, { review, stage: Math.max(project.stage, 3), status: '模拟审稿已完成' }));
  } catch (error) {
    next(error);
  }
});

app.post('/api/projects/:id/materials', async (request, response, next) => {
  try {
    const project = await getProject(request.params.id);
    if (!project) return response.status(404).json({ error: '未找到该投稿项目。' });
    const materials = generateMaterials(project);
    response.json(await patchProject(project.id, { materials, stage: Math.max(project.stage, 4), status: '投稿材料准备中' }));
  } catch (error) {
    next(error);
  }
});

app.post('/api/projects/:id/rebuttal', async (request, response, next) => {
  try {
    const project = await getProject(request.params.id);
    if (!project) return response.status(404).json({ error: '未找到该投稿项目。' });
    const rebuttal = generateRebuttal(project, request.body.comments);
    response.json(await patchProject(project.id, { rebuttal, stage: 5, status: 'Rebuttal 准备中' }));
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
