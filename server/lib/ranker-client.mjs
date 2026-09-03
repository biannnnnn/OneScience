import crypto from 'node:crypto';
import { DEFAULT_SCORING_MODEL, scoringModelDefinition } from './scoring-models.mjs';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8788';
const DEFAULT_TIMEOUT_MS = 300_000;

function serviceConfig(env = process.env, modelId = DEFAULT_SCORING_MODEL) {
  const definition = scoringModelDefinition(modelId);
  if (!definition || definition.kind !== 'ranker') {
    throw new Error(`不支持的 Ranker 评分模型：${modelId}。`);
  }
  const legacyUrl = definition.id === DEFAULT_SCORING_MODEL ? env.RANKER_SERVICE_URL : '';
  const configuredUrl = env[definition.urlEnv] || legacyUrl;
  return {
    modelId: definition.id,
    label: definition.label,
    baseUrl: String(configuredUrl || (definition.id === DEFAULT_SCORING_MODEL ? DEFAULT_BASE_URL : '')).replace(/\/+$/, ''),
    apiKey: String(env[`${definition.urlEnv.replace('_URL', '')}_API_KEY`] || env.RANKER_SERVICE_API_KEY || env.ONESCIENCE_RANKER_API_KEY || ''),
  };
}

async function serviceRequest(pathname, options = {}) {
  const config = serviceConfig(options.env, options.modelId);
  if (!config.baseUrl) throw new Error(`${config.label} 尚未配置 ${scoringModelDefinition(config.modelId).urlEnv}。`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl || fetch)(`${config.baseUrl}${pathname}`, {
      method: options.method || 'GET',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error?.message || `Ranker 服务请求失败（HTTP ${response.status}）。`);
      error.status = response.status;
      error.code = payload.error?.code || null;
      error.details = Array.isArray(payload.error?.details) ? payload.error.details : [];
      throw error;
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Ranker 服务请求超时。');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getRankerServiceStatus(options = {}) {
  const definition = scoringModelDefinition(options.modelId || DEFAULT_SCORING_MODEL);
  try {
    const health = await serviceRequest('/health', { ...options, timeoutMs: options.timeoutMs || 3_000 });
    let models;
    try {
      models = await serviceRequest('/v1/models', { ...options, timeoutMs: options.timeoutMs || 3_000 });
    } catch (error) {
      return {
        available: false,
        healthAvailable: true,
        authenticated: false,
        backend: health.backend,
        capabilities: health.capabilities || [],
        error: error.status === 401
          ? 'Ranker Service 已在线，但主站缺少或使用了无效的访问密钥。'
          : error.message,
      };
    }
    return {
      available: true,
      id: definition.id,
      label: definition.label,
      kind: 'ranker',
      healthAvailable: true,
      authenticated: true,
      status: health.status,
      backend: models.active || health.backend,
      capabilities: models.capabilities || health.capabilities || [],
    };
  } catch (error) {
    return {
      available: false,
      id: definition?.id || options.modelId,
      label: definition?.label || options.modelId,
      kind: 'ranker',
      healthAvailable: false,
      authenticated: false,
      error: error.message,
      capabilities: [],
    };
  }
}

function scorePaperPayload(paper) {
  const payload = {
    paper_id: String(paper.paperId || paper.id),
    title: String(paper.title || 'Untitled').trim().slice(0, 1000),
    abstract: String(paper.abstract || '').replace(/\s+/g, ' ').trim().slice(0, 24_000),
  };
  const evidence = {
    research_question_contributions: paper.researchQuestionContributions ?? paper.research_question_contributions,
    experimental_setup_datasets: paper.experimentalSetupDatasets ?? paper.experimental_setup_datasets,
    key_findings_conclusion: paper.keyFindingsConclusion ?? paper.key_findings_conclusion,
  };
  for (const [field, value] of Object.entries(evidence)) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 24_000);
    if (normalized) payload[field] = normalized;
  }
  return payload;
}

export async function scorePapersWithRanker(papers, options = {}) {
  const payload = await serviceRequest('/v1/paper-scores', {
    ...options,
    method: 'POST',
    body: {
      request_id: options.requestId || crypto.randomUUID(),
      papers: papers.map(scorePaperPayload),
    },
  });
  return {
    scores: payload.scores,
    modelTrace: payload.model_trace,
    disclaimer: payload.disclaimer,
  };
}

export function scoreFromRanker(item, modelTrace = null) {
  const globalCalibration = item.score_method === 'validation_empirical_cdf';
  return {
    score: item.score,
    rawScore: item.raw_score,
    scoreMethod: item.score_method,
    verdict: 'paper_ranker',
    confidence: 0,
    rationale: globalCalibration
      ? `自训练 NAIPv2 Ranker 原始排序分 ${item.raw_score.toFixed(3)}，按固定 validation 分布映射为第 ${item.score} 百分位。`
      : `自训练 NAIPv2 Ranker 原始排序分 ${item.raw_score.toFixed(3)}；当前 ${item.score} 分为本批论文内的相对百分位。`,
    strengths: [],
    risks: [],
    limitations: ['该分数衡量相对学术质量排序，不是期刊适配分或录用概率。'],
    dimensions: null,
    modelTrace,
  };
}

export const __testables = { scorePaperPayload, serviceConfig };
