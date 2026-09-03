export const DEFAULT_SCORING_MODEL = 'ranker-8b';

export const SCORING_MODELS = Object.freeze([
  { id: 'ranker-8b', label: '8B Ranker', kind: 'ranker', urlEnv: 'RANKER_8B_SERVICE_URL' },
  { id: 'ranker-3b', label: '3B Ranker', kind: 'ranker', urlEnv: 'RANKER_3B_SERVICE_URL' },
  { id: 'ranker-0.6b', label: '0.6B Ranker', kind: 'ranker', urlEnv: 'RANKER_06B_SERVICE_URL' },
  { id: 'deepseek', label: 'DeepSeek 大模型', kind: 'deepseek' },
]);

export function normalizeScoringModel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const aliases = {
    '8b': 'ranker-8b',
    '3b': 'ranker-3b',
    '0.6b': 'ranker-0.6b',
    '06b': 'ranker-0.6b',
    'ranker-06b': 'ranker-0.6b',
  };
  const candidate = aliases[normalized] || normalized || DEFAULT_SCORING_MODEL;
  return SCORING_MODELS.some((model) => model.id === candidate) ? candidate : null;
}

export function scoringModelDefinition(value) {
  const id = normalizeScoringModel(value);
  return id ? SCORING_MODELS.find((model) => model.id === id) : null;
}
