import { journals } from '../data/journals.mjs';
import { verifiedJournalMetrics } from '../data/journal-metrics.mjs';
import { normalizeName } from './scholarly-search.mjs';

const PRESTIGE_LABEL = { leading: '高挑战', strong: '稳健', broad: '广覆盖' };

// Build a name-normalized lookup of the authoritative catalog so that web
// candidates can inherit verified CCF/CAS/JIF ranks and curated scope profiles
// without the catalog ever generating the candidate list itself.
export function buildCatalogLookup() {
  const index = new Map();
  for (const item of journals) {
    const record = {
      id: item.id,
      name: item.name,
      englishName: item.englishName || null,
      publisher: item.publisher || null,
      access: item.access || null,
      profile: item.profile || null,
      audience: item.audience || [],
      evidencePreferences: item.evidencePreferences || [],
      fields: item.fields || [],
      keywords: item.keywords || [],
      ccfRank: item.ccfRank || null,
      ccfTier: item.ccfTier || null,
      casZone: item.casZone || null,
      impactFactor: verifiedJournalMetrics[item.id]?.impactFactor ?? null,
      impactFactorYear: verifiedJournalMetrics[item.id]?.impactFactorYear ?? null,
      impactFactorSource: verifiedJournalMetrics[item.id]?.source ?? null,
      sourceUrl: item.source?.url || null,
    };
    for (const name of [item.name, item.englishName]) {
      const key = name ? normalizeName(name) : '';
      if (key && !index.has(key)) index.set(key, record);
    }
  }
  return index;
}

export function enrichDiscoveredJournal(source, lookup = buildCatalogLookup()) {
  const matched = lookup.get(normalizeName(source.name)) || null;
  const publisher = source.hostOrganization || matched?.publisher || '未标注';
  const isOa = source.isOa;
  const access = isOa === true
    ? '开放获取'
    : isOa === false
      ? '混合模式'
      : (matched?.access || '未标注');
  const profile = matched?.profile || (
    source.subjects.length
      ? `基于 OpenAlex 主题标注的期刊画像，主要覆盖 ${source.subjects.slice(0, 4).join('、')} 等方向。具体征稿范围请以期刊官网为准。`
      : '期刊范围待从官方渠道确认，投稿前请核对期刊官网。'
  );
  const evidencePreferences = matched?.evidencePreferences?.length
    ? matched.evidencePreferences
    : ['充分实验验证', '清晰技术贡献', '可复现材料'];

  return {
    id: `openalex-${source.id}`,
    openAlexId: source.id,
    name: source.name,
    publisher,
    access,
    fields: matched?.fields || source.subjects.slice(0, 5),
    keywords: matched?.keywords || [],
    audience: matched?.audience?.length
      ? matched.audience
      : (source.subjects.length ? source.subjects.slice(0, 2).map((item) => `${item}研究者`) : ['相关领域研究者']),
    evidencePreferences,
    profile,
    ccfRank: matched?.ccfRank || null,
    ccfTier: matched?.ccfTier || null,
    casZone: matched?.casZone || null,
    impactFactor: matched?.impactFactor ?? null,
    impactFactorYear: matched?.impactFactorYear ?? null,
    impactFactorSource: matched?.impactFactor ? 'verified' : null,
    prestigeBand: null,
    prestigeLabel: null,
    prestigeBasis: null,
    matchScore: Number.isFinite(source.relevanceScore) ? source.relevanceScore : 50,
    reasons: [
      ...(source.evidencePaperCount ? [`由 ${source.evidencePaperCount} 篇相似论文支持`] : []),
      ...(source.evidenceQueryCount ? [`命中 ${source.evidenceQueryCount} 组检索主题`] : []),
      ...(source.subjects.length ? [`OpenAlex 主题：${source.subjects.slice(0, 3).join('、')}`] : []),
      ...(source.hIndex !== null ? [`期刊 h-index ${source.hIndex}`] : []),
    ],
    source: {
      label: matched ? 'OpenAlex 检索（已反查官方期刊目录）' : 'OpenAlex 检索',
      url: source.openAlexUrl,
      checkedAt: new Date().toISOString().slice(0, 10),
    },
    metrics: {
      impactFactor: matched?.impactFactor ?? null,
      impactFactorYear: matched?.impactFactorYear ?? null,
      impactFactorSource: matched?.impactFactorSource ?? null,
      ccf: matched?.ccfRank || matched?.ccfTier || null,
      cas: matched?.casZone || null,
      openAlexTwoYearMeanCitedness: source.twoYearMeanCitedness,
      openAlexHIndex: source.hIndex,
      openAlexWorksCount: source.worksCount,
      openAlexSource: source.openAlexUrl,
    },
    openAlex: {
      worksCount: source.worksCount,
      citedByCount: source.citedByCount,
      hIndex: source.hIndex,
      twoYearMeanCitedness: source.twoYearMeanCitedness,
      isOa: source.isOa,
      subjects: source.subjects,
      countryCode: source.countryCode,
      evidencePaperCount: source.evidencePaperCount || 0,
      evidenceQueryCount: source.evidenceQueryCount || 0,
      evidenceQueries: source.evidenceQueries || [],
    },
  };
}

function authoritativeBand(item) {
  const impactFactor = item.impactFactor ?? null;
  if (item.ccfRank === 'CCF-A' || item.casZone === '中科院1区' || (impactFactor !== null && impactFactor >= 10)) return 'leading';
  if (item.ccfRank === 'CCF-B' || item.casZone === '中科院2区' || (impactFactor !== null && impactFactor >= 5)) return 'strong';
  return null;
}

// Assign prestige bands in two passes: authoritative ranks first, then a
// relative split on OpenAlex citation metrics so web candidates still span
// leading / strong / broad without fabricating CCF/CAS/JIF values.
export function prestigeBandForDiscovered(candidates) {
  const items = Array.isArray(candidates) ? candidates : [];
  const unresolved = [];
  for (const item of items) {
    const band = authoritativeBand(item);
    if (band) {
      item.prestigeBand = band;
      item.prestigeLabel = PRESTIGE_LABEL[band];
      item.prestigeBasis = 'authoritative';
    } else {
      unresolved.push(item);
    }
  }
  const ranked = unresolved
    .map((item) => ({
      item,
      metric: item.openAlex?.hIndex ?? item.openAlex?.twoYearMeanCitedness ?? 0,
    }))
    .sort((left, right) => right.metric - left.metric);
  const size = ranked.length;
  const firstThird = Math.ceil(size / 3);
  const secondThird = Math.ceil((2 * size) / 3);
  ranked.forEach((entry, index) => {
    let band;
    if (size < 3) {
      band = ['leading', 'strong', 'broad'][index % 3];
    } else {
      band = index < firstThird ? 'leading' : index < secondThird ? 'strong' : 'broad';
    }
    entry.item.prestigeBand = band;
    entry.item.prestigeLabel = PRESTIGE_LABEL[band];
    entry.item.prestigeBasis = 'openalex-approx';
  });
  return items;
}

export const __testables = { buildCatalogLookup, enrichDiscoveredJournal, prestigeBandForDiscovered, authoritativeBand };
