import crypto from 'node:crypto';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 300_000;

function serviceConfig(env = process.env) {
  return {
    baseUrl: String(env.REVIEWER_SERVICE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiKey: String(env.REVIEWER_SERVICE_API_KEY || env.ONESCIENCE_REVIEWER_API_KEY || ''),
  };
}

async function serviceRequest(pathname, options = {}) {
  const config = serviceConfig(options.env);
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
      const error = new Error(payload.error?.message || `本地小模型服务请求失败（HTTP ${response.status}）。`);
      error.status = response.status;
      error.code = payload.error?.code || null;
      error.details = Array.isArray(payload.error?.details) ? payload.error.details : [];
      throw error;
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('本地小模型服务请求超时。');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function fingerprint(paragraphs) {
  return crypto.createHash('sha256').update(paragraphs.map((item) => item.text).join('\n')).digest('hex');
}

export function documentToManuscript(document, options = {}) {
  const blocks = String(document.text || document.abstract || '')
    .split(/\n{2,}/)
    .map((text) => text.replace(/\s+/g, ' ').trim())
    .filter((text) => text.length >= 20)
    .slice(0, 80);
  const paragraphs = (blocks.length ? blocks : [document.abstract || document.title])
    .filter(Boolean)
    .map((text, index) => ({
      section: index === 0 && document.abstract ? 'Abstract' : 'Manuscript',
      paragraph_id: `p-${String(index + 1).padStart(3, '0')}`,
      text: String(text).slice(0, 20_000),
    }));
  return {
    paper_id: options.paperId || null,
    title: document.title,
    language: document.language === '中文' ? 'zh' : (document.language || 'en'),
    fingerprint: fingerprint(paragraphs),
    paragraphs,
  };
}

function venuePayload(journal) {
  return {
    id: journal.id || null,
    name: journal.name,
    scope: journal.profile || null,
    requirements: journal.evidencePreferences || [],
    scope_source: journal.source?.url || null,
    scope_checked_at: journal.source?.checkedAt || null,
  };
}

export async function getReviewerServiceStatus(options = {}) {
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
          ? 'Reviewer Service 已在线，但主站缺少或使用了无效的访问密钥。'
          : error.message,
        acceptancePrediction: health.acceptance_prediction || { loaded: false },
      };
    }
    return {
      available: true,
      healthAvailable: true,
      authenticated: true,
      backend: models.active || health.backend,
      capabilities: models.capabilities || health.capabilities || [],
      acceptancePrediction: health.acceptance_prediction || { loaded: false },
    };
  } catch (error) {
    return {
      available: false,
      healthAvailable: false,
      authenticated: false,
      error: error.message,
      acceptancePrediction: { loaded: false },
      capabilities: [],
    };
  }
}

export async function reviewForVenue(document, journal, options = {}) {
  const manuscript = documentToManuscript(document, { paperId: options.paperId });
  const payload = await serviceRequest('/v1/reviews', {
    ...options,
    method: 'POST',
    body: {
      request_id: options.requestId || crypto.randomUUID(),
      review_type: 'venue_conditioned',
      review_language: 'zh-CN',
      manuscript,
      target_venue: venuePayload(journal),
    },
  });
  return { manuscript, review: payload.review, backend: payload.backend, usage: payload.usage };
}

function scorePaperPayload(paper) {
  const inputType = paper.inputType === 'manuscript' ? 'manuscript' : 'abstract';
  const textLimit = inputType === 'manuscript' ? 15_000 : 3_500;
  return {
    paper_id: String(paper.paperId || paper.id),
    title: String(paper.title || 'Untitled'),
    input_type: inputType,
    language: paper.language === '中文' ? 'zh-CN' : (paper.language || 'en'),
    text: String(paper.text || paper.abstract || '').trim().slice(0, textLimit),
  };
}

export async function scorePapersForVenue(papers, journal, options = {}) {
  const payload = await serviceRequest('/v1/venue-scores', {
    ...options,
    method: 'POST',
    body: {
      request_id: options.requestId || crypto.randomUUID(),
      review_language: 'zh-CN',
      target_venue: venuePayload(journal),
      papers: papers.map(scorePaperPayload),
    },
  });
  return {
    scores: payload.score_batch.scores,
    modelTrace: payload.score_batch.model_trace,
    disclaimer: payload.score_batch.disclaimer,
    backend: payload.backend,
    usage: payload.usage,
  };
}

export function scoreFromVenueBatch(item, modelTrace = null) {
  return {
    score: item.overall,
    verdict: 'venue_score',
    confidence: item.confidence,
    rationale: item.rationale,
    strengths: item.strengths,
    risks: item.risks,
    limitations: item.limitations,
    dimensions: {
      originality: item.originality,
      rigor: item.rigor,
      evidence: item.evidence,
      clarity: item.clarity,
      reproducibility: item.reproducibility,
      venueFit: item.venue_fit,
    },
    modelTrace,
  };
}

export async function predictAcceptance(manuscript, journal, review, options = {}) {
  const payload = await serviceRequest('/v1/acceptance-predictions', {
    ...options,
    method: 'POST',
    body: {
      request_id: options.requestId || crypto.randomUUID(),
      manuscript,
      target_venue: venuePayload(journal),
      review,
    },
  });
  return payload.prediction;
}

export function scoreToAcceptancePayload(scoreItem) {
  return {
    originality: scoreItem.originality,
    rigor: scoreItem.rigor,
    evidence: scoreItem.evidence,
    clarity: scoreItem.clarity,
    reproducibility: scoreItem.reproducibility,
    venue_fit: scoreItem.venue_fit,
    overall: scoreItem.overall,
    confidence: scoreItem.confidence,
    rationale: scoreItem.rationale,
    strengths: scoreItem.strengths,
    risks: scoreItem.risks,
    limitations: scoreItem.limitations,
  };
}

export async function predictAcceptanceFromScore(manuscript, journal, scoreItem, modelTrace, options = {}) {
  const payload = await serviceRequest('/v1/acceptance-predictions', {
    ...options,
    method: 'POST',
    body: {
      request_id: options.requestId || crypto.randomUUID(),
      manuscript,
      target_venue: venuePayload(journal),
      score: scoreToAcceptancePayload(scoreItem),
      model_trace: modelTrace || {},
    },
  });
  return payload.prediction;
}

export function scoreStructuredReview(review) {
  const verdictScores = {
    ready_for_submission: 90,
    minor_revision: 76,
    major_revision: 56,
    fundamental_revision: 34,
    insufficient_evidence: 24,
  };
  const recommendation = review?.recommendation || {};
  const base = verdictScores[recommendation.verdict] ?? 50;
  const strengthBonus = Math.min((review?.strengths?.length || 0) * 2, 8);
  const concernPenalty = Math.min((review?.major_concerns?.length || 0) * 4, 16)
    + Math.min((review?.minor_concerns?.length || 0), 5);
  const score = Math.max(0, Math.min(100, Math.round(base + strengthBonus - concernPenalty)));
  return {
    score,
    verdict: recommendation.verdict || 'insufficient_evidence',
    confidence: Number(recommendation.confidence) || 0,
    rationale: recommendation.rationale || review?.summary || '',
    strengths: (review?.strengths || []).slice(0, 3).map((item) => item.point),
    risks: [...(review?.major_concerns || []), ...(review?.minor_concerns || [])]
      .slice(0, 4)
      .map((item) => item.problem),
    modelTrace: review?.model_trace || null,
  };
}

export function fallbackManuscriptScore(project, journal) {
  const readiness = Number(project.analysis?.overall) || 50;
  const match = Number(journal.matchScore) || 50;
  return {
    score: Math.round(readiness * 0.65 + match * 0.35),
    verdict: 'rule_fallback',
    confidence: 0,
    rationale: '本地小模型不可用，当前仅融合稿件规则准备度与期刊主题适配分。',
    strengths: project.analysis?.strengths?.slice(0, 3) || [],
    risks: project.analysis?.issues?.slice(0, 4).map((item) => item.title) || [],
    modelTrace: null,
  };
}

export function fallbackReferenceScore(paper) {
  const abstractCoverage = Math.min(String(paper.abstract || '').length / 12, 35);
  const retrieval = Number.isFinite(paper.retrievalScore) ? paper.retrievalScore * 0.45 : 25;
  const recency = Math.max(0, 20 - (new Date().getUTCFullYear() - Number(paper.year || 0)) * 4);
  return {
    score: Math.max(0, Math.min(100, Math.round(20 + abstractCoverage + retrieval + recency))),
    verdict: 'retrieval_fallback',
    confidence: 0,
    rationale: '本地小模型不可用，此分数只表示检索相关性与元数据完整度，不代表论文质量。',
    strengths: [],
    risks: ['尚未经过训练好的本地小模型评分'],
    modelTrace: null,
  };
}
