const DEFAULT_BASE_URL = 'https://api.openalex.org';
const DEFAULT_TIMEOUT_MS = 20_000;

export function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function reconstructAbstract(index) {
  if (!index || typeof index !== 'object') return '';
  const positions = [];
  for (const [word, offsets] of Object.entries(index)) {
    for (const offset of offsets || []) positions.push([Number(offset), word]);
  }
  return positions
    .filter(([offset]) => Number.isInteger(offset) && offset >= 0)
    .sort((left, right) => left[0] - right[0])
    .map(([, word]) => word)
    .join(' ')
    .slice(0, 6_000);
}

function sourceMatchScore(source, journal) {
  const target = normalizeName(journal.name);
  const english = normalizeName(journal.englishName);
  const candidate = normalizeName(source.display_name);
  if (candidate === target || (english && candidate === english)) return 100;
  if (candidate.includes(target) || target.includes(candidate)) return 80;
  if (english && (candidate.includes(english) || english.includes(candidate))) return 75;
  return 0;
}

function openAlexId(value) {
  return String(value || '').split('/').pop();
}

export function getOpenAlexStatus(env = process.env) {
  return {
    provider: 'OpenAlex',
    configured: Boolean(String(env.OPENALEX_API_KEY || '').trim()),
    baseUrl: String(env.OPENALEX_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
  };
}

async function openAlexRequest(pathname, params, options = {}) {
  const status = getOpenAlexStatus(options.env);
  const apiKey = String(options.env?.OPENALEX_API_KEY ?? process.env.OPENALEX_API_KEY ?? '').trim();
  if (!apiKey) throw new Error('尚未配置 OPENALEX_API_KEY，无法执行近期论文 Web 检索。');
  const url = new URL(`${status.baseUrl}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  url.searchParams.set('api_key', apiKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl || fetch)(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`OpenAlex 请求失败（HTTP ${response.status}）。`);
    return response.json();
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('OpenAlex 请求超时。');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveJournalSource(journal, options = {}) {
  const payload = await openAlexRequest('/sources', {
    search: journal.englishName || journal.name,
    per_page: 8,
    select: 'id,display_name,issn_l,issn,type,summary_stats,works_count,cited_by_count',
  }, options);
  const matches = (payload.results || [])
    .map((source) => ({ source, score: sourceMatchScore(source, journal) }))
    .sort((left, right) => right.score - left.score);
  if (!matches[0] || matches[0].score < 75) return null;
  const source = matches[0].source;
  return {
    id: openAlexId(source.id),
    openAlexUrl: source.id,
    name: source.display_name,
    issn: source.issn_l || source.issn?.[0] || null,
    worksCount: source.works_count || 0,
    citedByCount: source.cited_by_count || 0,
    twoYearMeanCitedness: source.summary_stats?.['2yr_mean_citedness'] ?? null,
  };
}

export async function findRecentSimilarPapers(journal, keywords, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit) || 3, 250));
  const source = options.source || await resolveJournalSource(journal, options);
  if (!source) return { source: null, items: [], queries: [], errors: [] };
  const years = Math.max(1, Math.min(Number(options.recentYears) || 3, 8));
  const startYear = new Date().getUTCFullYear() - years;
  const queries = [...new Set([
    ...(options.queries || []),
    ...(keywords || []),
    ...(options.includeJournalFields === false ? [] : (journal.fields || [])),
  ].map((query) => String(query || '').trim()).filter(Boolean))].slice(0, 8);
  if (!queries.length) return { source, items: [], queries: [], errors: [] };

  const errors = [];
  const responses = await mapWithConcurrency(queries, 4, async (query) => {
    try {
      const payload = await openAlexRequest('/works', {
        search: query,
        filter: `primary_location.source.id:${source.id},from_publication_date:${startYear}-01-01,type:article,is_retracted:false`,
        sort: 'relevance_score:desc',
        per_page: Math.min(100, Math.max(limit, 10)),
        select: 'id,doi,display_name,publication_date,publication_year,authorships,primary_location,open_access,cited_by_count,abstract_inverted_index,relevance_score',
      }, options);
      return { query, works: payload.results || [] };
    } catch (error) {
      errors.push({ query, message: error.message });
      return { query, works: [] };
    }
  });

  const evidence = new Map();
  for (const { query, works } of responses) {
    works.forEach((work, rank) => {
      if (!work.display_name || !work.publication_year) return;
      const id = openAlexId(work.id);
      const current = evidence.get(id) || {
        work,
        queryHits: new Set(),
        reciprocalRank: 0,
        bestRelevance: 0,
      };
      current.queryHits.add(query);
      current.reciprocalRank += 1 / (rank + 1);
      if (Number.isFinite(work.relevance_score)) {
        current.bestRelevance = Math.max(current.bestRelevance, work.relevance_score);
      }
      evidence.set(id, current);
    });
  }

  const ranked = [...evidence.values()].sort((left, right) => (
    right.queryHits.size - left.queryHits.size
    || right.reciprocalRank - left.reciprocalRank
    || right.bestRelevance - left.bestRelevance
    || (options.excludeCitationRanking ? 0 : (right.work.cited_by_count || 0) - (left.work.cited_by_count || 0))
  ));
  const items = ranked.slice(0, limit).map(({ work, queryHits, bestRelevance }) => ({
      id: openAlexId(work.id),
      title: work.display_name,
      abstract: reconstructAbstract(work.abstract_inverted_index),
      publicationDate: work.publication_date || `${work.publication_year}-01-01`,
      year: work.publication_year,
      authors: (work.authorships || []).slice(0, 6).map((item) => item.author?.display_name).filter(Boolean),
      doi: work.doi || null,
      url: work.doi || work.primary_location?.landing_page_url || work.id,
      citedByCount: work.cited_by_count || 0,
      retrievalScore: Number.isFinite(bestRelevance)
        ? Math.max(0, Math.min(100, Math.round(bestRelevance)))
        : null,
      openAccess: Boolean(work.open_access?.is_oa),
      evidenceQueryCount: queryHits.size,
      evidenceQueries: [...queryHits],
    }));
  return { source, items, queries, errors };
}

function normalizeSource(source) {
  return {
    id: openAlexId(source.id),
    openAlexUrl: source.id,
    name: source.display_name,
    issn: source.issn_l || null,
    hostOrganization: source.host_organization || null,
    worksCount: source.works_count || 0,
    citedByCount: source.cited_by_count || 0,
    hIndex: source.summary_stats?.h_index ?? null,
    twoYearMeanCitedness: source.summary_stats?.['2yr_mean_citedness'] ?? null,
    relevanceScore: Number.isFinite(source.relevance_score)
      ? Math.max(0, Math.min(100, Math.round(source.relevance_score)))
      : null,
    isOa: typeof source.is_oa === 'boolean' ? source.is_oa : null,
    subjects: [...(source.x_concepts || []), ...(source.topics || [])]
      .map((item) => item?.display_name)
      .filter(Boolean)
      .slice(0, 8),
    countryCode: source.country_code || null,
  };
}

export async function searchJournalSources(query, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit) || 8, 25));
  const minWorksCount = Math.max(0, Math.min(Number(options.minWorksCount) || 500, 1_000_000));
  const payload = await openAlexRequest('/sources', {
    search: String(query || '').trim(),
    filter: `type:journal,works_count:>${minWorksCount}`,
    per_page: Math.min(100, Math.max(limit * 2, 10)),
    sort: 'relevance_score:desc',
    select: 'id,display_name,issn_l,host_organization,works_count,cited_by_count,summary_stats,relevance_score,is_oa,x_concepts,topics,country_code',
  }, options);
  return (payload.results || [])
    .filter((source) => source?.display_name)
    .map(normalizeSource)
    .slice(0, limit);
}

export async function discoverJournalSources(queries, options = {}) {
  const uniqueQueries = [...new Set((queries || []).map((query) => String(query || '').trim()).filter(Boolean))]
    .slice(0, 8);
  const sources = [];
  const errors = [];
  const seen = new Set();
  for (const query of uniqueQueries) {
    let matches;
    try {
      matches = await searchJournalSources(query, options);
    } catch (error) {
      errors.push({ query, message: error.message });
      continue;
    }
    for (const source of matches) {
      if (seen.has(source.id)) continue;
      seen.add(source.id);
      sources.push(source);
    }
  }
  return { sources, errors };
}

function sourceStubFromWork(source) {
  return {
    id: openAlexId(source.id),
    openAlexUrl: source.id,
    name: source.display_name,
    issn: source.issn_l || source.issn?.[0] || null,
    hostOrganization: source.host_organization_name || null,
    worksCount: 0,
    citedByCount: 0,
    hIndex: null,
    twoYearMeanCitedness: null,
    relevanceScore: null,
    isOa: typeof source.is_oa === 'boolean' ? source.is_oa : null,
    subjects: [],
    countryCode: null,
  };
}

async function getJournalSourceById(sourceId, options = {}) {
  const payload = await openAlexRequest(`/sources/${openAlexId(sourceId)}`, {
    select: 'id,display_name,issn_l,host_organization,works_count,cited_by_count,summary_stats,is_oa,x_concepts,topics,country_code',
  }, options);
  return normalizeSource(payload);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await mapper(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function discoverJournalSourcesFromWorks(queries, options = {}) {
  const uniqueQueries = [...new Set((queries || [])
    .map((query) => String(query || '').trim())
    .filter(Boolean))]
    .slice(0, 8);
  const sourceLimit = Math.max(3, Math.min(Number(options.limit) || 25, 50));
  const worksPerQuery = Math.max(10, Math.min(Number(options.worksPerQuery) || 50, 100));
  const recentYears = Math.max(1, Math.min(Number(options.recentYears) || 5, 10));
  const startYear = new Date().getUTCFullYear() - recentYears;
  const evidence = new Map();
  const errors = [];
  let worksExamined = 0;

  for (const query of uniqueQueries) {
    let payload;
    try {
      payload = await openAlexRequest('/works', {
        search: query,
        filter: `type:article,is_retracted:false,from_publication_date:${startYear}-01-01`,
        sort: 'relevance_score:desc',
        per_page: worksPerQuery,
        select: 'id,primary_location,relevance_score,publication_year',
      }, options);
    } catch (error) {
      errors.push({ query, stage: 'works', message: error.message });
      continue;
    }
    const works = payload.results || [];
    worksExamined += works.length;
    works.forEach((work, rank) => {
      const source = work.primary_location?.source;
      if (!source?.id || !source.display_name || source.type !== 'journal') return;
      const id = openAlexId(source.id);
      const current = evidence.get(id) || {
        source: sourceStubFromWork(source),
        paperCount: 0,
        queryHits: new Set(),
        reciprocalRank: 0,
        bestRelevance: 0,
      };
      current.paperCount += 1;
      current.queryHits.add(query);
      current.reciprocalRank += 1 / (rank + 1);
      if (Number.isFinite(work.relevance_score)) {
        current.bestRelevance = Math.max(current.bestRelevance, work.relevance_score);
      }
      evidence.set(id, current);
    });
  }

  const rankedEvidence = [...evidence.values()]
    .sort((left, right) => (
      right.queryHits.size - left.queryHits.size
      || right.paperCount - left.paperCount
      || right.reciprocalRank - left.reciprocalRank
      || right.bestRelevance - left.bestRelevance
    ))
    .slice(0, sourceLimit);

  const detailed = await mapWithConcurrency(rankedEvidence, 5, async (item, index) => {
    let source = item.source;
    try {
      source = await getJournalSourceById(source.id, options);
    } catch (error) {
      errors.push({ sourceId: source.id, stage: 'source-detail', message: error.message });
    }
    const topicalScore = Math.max(1, Math.min(100, Math.round(
      100 - index * (70 / Math.max(1, rankedEvidence.length - 1)),
    )));
    return {
      ...source,
      relevanceScore: topicalScore,
      evidencePaperCount: item.paperCount,
      evidenceQueryCount: item.queryHits.size,
      evidenceQueries: [...item.queryHits],
    };
  });

  const minWorksCount = Math.max(0, Math.min(Number(options.minWorksCount) || 0, 1_000_000));
  const sources = detailed.filter((source) => (
    !minWorksCount || !source.worksCount || source.worksCount >= minWorksCount
  ));
  return {
    sources,
    errors,
    worksExamined,
    evidenceJournalCount: evidence.size,
  };
}

export const __testables = {
  normalizeName,
  reconstructAbstract,
  sourceMatchScore,
  normalizeSource,
  sourceStubFromWork,
};
