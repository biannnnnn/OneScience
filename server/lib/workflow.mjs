import { journals } from '../data/journals.mjs';

const normalizeTokens = (values) =>
  values
    .flatMap((value) => String(value || '').toLowerCase().split(/[\s,，;；、/|]+/))
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);

const GENERIC_ENGLISH_TERMS = new Set([
  'analysis', 'computer', 'data', 'engineering', 'experiment', 'intelligence',
  'learning', 'method', 'model', 'science', 'system', 'systems', 'technology',
]);

const normalizeScopeText = (values) =>
  values
    .map((value) => String(value || '').toLowerCase())
    .join(' ')
    .replace(/[-–—_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function findScopeHits(journal, documentValues) {
  const corpus = normalizeScopeText(documentValues);
  return [...new Set([...journal.fields, ...journal.keywords])]
    .filter((term) => {
      const normalized = normalizeScopeText([term]);
      if (!normalized) return false;
      if (/[^\x00-\x7f]/.test(normalized) || normalized.includes(' ')) {
        return corpus.includes(normalized);
      }
      return normalized.length >= 5 && !GENERIC_ENGLISH_TERMS.has(normalized)
        && corpus.split(/[^a-z0-9]+/).includes(normalized);
    })
    .slice(0, 8);
}

function boundedScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function evidenceFit(project) {
  const scores = project.analysis?.scores || {};
  const values = [scores.reproducibility, scores.evidence, scores.novelty].filter(Number.isFinite);
  if (values.length) return boundedScore(values.reduce((sum, value) => sum + value, 0) / values.length);
  return boundedScore(project.analysis?.overall || 50);
}

export function rankJournalCandidates(project, preferences = {}) {
  const documentValues = [
    project.profile?.researchField,
    ...(project.profile?.keywords || []),
    ...(project.document?.keywords || []),
    project.document?.title,
    project.document?.abstract,
  ];
  const preferredAccess = preferences.access || project.profile?.accessPreference || '不限';
  const manuscriptEvidenceFit = evidenceFit(project);

  return journals.map((journal) => {
    const hits = findScopeHits(journal, documentValues);
    const fieldHit = project.profile?.researchField
      ? journal.fields.some((field) =>
          field.includes(project.profile.researchField) || project.profile.researchField.includes(field),
        )
      : false;
    // A broad self-reported field is useful context, but multiple manuscript-level
    // scope hits should outrank a generic journal that only shares that field.
    const topicalFit = boundedScore(28 + hits.length * 8 + (fieldHit ? 6 : 0));
    const accessFit = preferredAccess === '不限' ? 82 : preferredAccess === journal.access ? 100 : 45;
    const readiness = boundedScore(project.analysis?.overall || 50);
    const audienceFit = boundedScore(35 + hits.length * 7 + (fieldHit ? 8 : 0));
    const matchScore = boundedScore(
      topicalFit * 0.52 + readiness * 0.16 + manuscriptEvidenceFit * 0.12 + audienceFit * 0.1 + accessFit * 0.1,
    );
    const reasons = [
      fieldHit && `与“${project.profile.researchField}”研究方向直接相关`,
      hits.length > 0 && `期刊范围词命中：${hits.slice(0, 4).join('、')}`,
      `目标读者：${journal.audience.slice(0, 2).join('、')}`,
      readiness >= 70 ? '当前稿件结构具备进一步适配基础' : '建议先完成关键修改再核对适配性',
    ].filter(Boolean);
    const manuscriptRisks = (project.analysis?.issues || [])
      .filter((issue) => issue.severity !== 'low')
      .slice(0, 2)
      .map((issue) => issue.title);
    const evidenceRisk = manuscriptEvidenceFit < 65
      ? `该刊通常重视${journal.evidencePreferences.slice(0, 2).join('与')}，当前证据准备度仍需加强`
      : null;
    const risks = [...manuscriptRisks, evidenceRisk].filter(Boolean).slice(0, 3);
    const preparationActions = (project.analysis?.issues || [])
      .slice(0, 3)
      .map((issue) => issue.action)
      .filter(Boolean);

    return {
      ...journal,
      matchScore,
      ruleScore: matchScore,
      topicalFit,
      audienceFit,
      evidenceFit: manuscriptEvidenceFit,
      accessFit,
      reasons: reasons.length ? reasons : ['属于可进一步核对的计算机领域投稿方向'],
      risks,
      preparationActions,
    };
  }).sort((a, b) => b.matchScore - a.matchScore);
}

export const __testables = { normalizeTokens, findScopeHits, boundedScore };
