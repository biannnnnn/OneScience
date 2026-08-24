import test from 'node:test';
import assert from 'node:assert/strict';
import {
  __testables as discoveryTestables,
  buildCatalogLookup,
  enrichDiscoveredJournal,
  prestigeBandForDiscovered,
} from '../server/lib/journal-discovery.mjs';
import {
  discoverJournalSources,
  discoverJournalSourcesFromWorks,
  findRecentSimilarPapers,
  searchJournalSources,
} from '../server/lib/scholarly-search.mjs';

const { authoritativeBand } = discoveryTestables;

function sourceFixture(overrides = {}) {
  return {
    id: 'S999',
    openAlexUrl: 'https://openalex.org/S999',
    name: 'A Novel Journal',
    issn: null,
    hostOrganization: 'Some Publisher',
    worksCount: 1200,
    citedByCount: 5000,
    hIndex: 40,
    twoYearMeanCitedness: 2.8,
    relevanceScore: 72,
    isOa: false,
    subjects: ['artificial intelligence', 'machine learning'],
    countryCode: 'US',
    ...overrides,
  };
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const OPENALEX_ENV = { OPENALEX_API_KEY: 'test-key', OPENALEX_BASE_URL: 'https://api.openalex.org' };

test('catalog lookup resolves verified metrics by normalized name', () => {
  const lookup = buildCatalogLookup();
  const ieeeAccess = lookup.get('ieee access');
  assert.ok(ieeeAccess);
  assert.equal(ieeeAccess.id, 'ieee-access');
  assert.equal(ieeeAccess.impactFactor, 4.2);
  assert.equal(ieeeAccess.casZone, '中科院4区');
});

test('enrichment inherits authoritative ranks when the source matches the catalog', () => {
  const lookup = buildCatalogLookup();
  const enriched = enrichDiscoveredJournal(sourceFixture({ name: 'IEEE Access' }), lookup);
  assert.equal(enriched.id, 'openalex-S999');
  assert.equal(enriched.casZone, '中科院4区');
  assert.equal(enriched.impactFactor, 4.2);
  assert.equal(enriched.impactFactorSource, 'verified');
  assert.equal(enriched.metrics.impactFactor, 4.2);
  assert.match(enriched.profile, /IEEE/);
});

test('enrichment leaves unverified ranks null without fabricating metrics', () => {
  const enriched = enrichDiscoveredJournal(sourceFixture());
  assert.equal(enriched.ccfRank, null);
  assert.equal(enriched.casZone, null);
  assert.equal(enriched.impactFactor, null);
  assert.equal(enriched.impactFactorSource, null);
  assert.match(enriched.profile, /OpenAlex 主题标注/);
});

test('authoritative band prioritizes CCF-A and JIF thresholds', () => {
  assert.equal(authoritativeBand({ ccfRank: 'CCF-A' }), 'leading');
  assert.equal(authoritativeBand({ casZone: '中科院1区' }), 'leading');
  assert.equal(authoritativeBand({ impactFactor: 10 }), 'leading');
  assert.equal(authoritativeBand({ ccfRank: 'CCF-B' }), 'strong');
  assert.equal(authoritativeBand({ impactFactor: 5 }), 'strong');
  assert.equal(authoritativeBand({}), null);
});

test('prestige bands span all three tiers for unranked web candidates', () => {
  const candidates = [30, 80, 50].map((hIndex) => enrichDiscoveredJournal(sourceFixture({ hIndex })));
  prestigeBandForDiscovered(candidates);
  assert.deepEqual(
    new Set(candidates.map((item) => item.prestigeBand)),
    new Set(['leading', 'strong', 'broad']),
  );
  assert.ok(candidates.every((item) => item.prestigeBasis === 'openalex-approx'));
});

test('prestige band uses authoritative basis when a CCF-A rank matches', () => {
  const candidates = [
    enrichDiscoveredJournal(
      sourceFixture({ name: 'IEEE Transactions on Pattern Analysis and Machine Intelligence' }),
      buildCatalogLookup(),
    ),
  ];
  prestigeBandForDiscovered(candidates);
  assert.equal(candidates[0].prestigeBand, 'leading');
  assert.equal(candidates[0].prestigeBasis, 'authoritative');
});

test('searchJournalSources builds the typed journal query and normalizes results', async () => {
  let requestedUrl;
  const result = await searchJournalSources('machine learning', {
    env: OPENALEX_ENV,
    fetchImpl: async (url) => {
      requestedUrl = new URL(url.toString());
      return jsonResponse({
        results: [{
          id: 'https://openalex.org/S1',
          display_name: 'Machine Learning',
          issn_l: '0885-6125',
          host_organization: 'Springer Nature',
          works_count: 3000,
          cited_by_count: 100000,
          summary_stats: { h_index: 120, '2yr_mean_citedness': 8.5 },
          relevance_score: 90,
          is_oa: false,
          x_concepts: [{ display_name: 'machine learning' }],
          country_code: 'DE',
        }],
      });
    },
  });
  assert.equal(requestedUrl.searchParams.get('search'), 'machine learning');
  assert.equal(requestedUrl.searchParams.get('filter'), 'type:journal,works_count:>500');
  assert.equal(requestedUrl.searchParams.get('sort'), 'relevance_score:desc');
  assert.equal(requestedUrl.searchParams.get('api_key'), 'test-key');
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'S1');
  assert.equal(result[0].hIndex, 120);
  assert.deepEqual(result[0].subjects, ['machine learning']);
});

test('discoverJournalSources deduplicates sources across queries', async () => {
  const result = await discoverJournalSources(['query a', 'query b'], {
    env: OPENALEX_ENV,
    fetchImpl: async () => jsonResponse({
      results: [{
        id: 'https://openalex.org/S1',
        display_name: 'Shared Journal',
        works_count: 2000,
        summary_stats: {},
      }],
    }),
  });
  assert.equal(result.sources.length, 1);
  assert.equal(result.errors.length, 0);
});

test('discoverJournalSourcesFromWorks aggregates journals from similar papers', async () => {
  const requestedUrls = [];
  const sourceDetails = {
    S1: {
      id: 'https://openalex.org/S1',
      display_name: 'Shared Journal',
      issn_l: '1234-5678',
      host_organization: 'P1',
      works_count: 2000,
      cited_by_count: 10000,
      summary_stats: { h_index: 80, '2yr_mean_citedness': 4.2 },
      topics: [{ display_name: 'Artificial intelligence' }],
    },
    S2: {
      id: 'https://openalex.org/S2',
      display_name: 'Second Journal',
      works_count: 1500,
      cited_by_count: 5000,
      summary_stats: { h_index: 50 },
      topics: [{ display_name: 'Information systems' }],
    },
  };
  const result = await discoverJournalSourcesFromWorks(['query a', 'query b'], {
    env: OPENALEX_ENV,
    limit: 5,
    minWorksCount: 500,
    fetchImpl: async (url) => {
      const requestedUrl = new URL(url.toString());
      requestedUrls.push(requestedUrl);
      if (requestedUrl.pathname.startsWith('/sources/')) {
        const id = requestedUrl.pathname.split('/').pop();
        return jsonResponse(sourceDetails[id]);
      }
      const query = requestedUrl.searchParams.get('search');
      return jsonResponse({
        results: [
          {
            id: `https://openalex.org/W-${query}-1`,
            relevance_score: 95,
            primary_location: {
              source: { id: 'https://openalex.org/S1', display_name: 'Shared Journal', type: 'journal' },
            },
          },
          ...(query === 'query a' ? [{
            id: 'https://openalex.org/W-a-2',
            relevance_score: 80,
            primary_location: {
              source: { id: 'https://openalex.org/S2', display_name: 'Second Journal', type: 'journal' },
            },
          }] : []),
          {
            id: `https://openalex.org/W-${query}-repository`,
            primary_location: {
              source: { id: 'https://openalex.org/S3', display_name: 'Repository', type: 'repository' },
            },
          },
        ],
      });
    },
  });

  const worksRequests = requestedUrls.filter((url) => url.pathname === '/works');
  assert.equal(worksRequests.length, 2);
  assert.match(worksRequests[0].searchParams.get('filter'), /type:article/);
  assert.match(worksRequests[0].searchParams.get('filter'), /from_publication_date:/);
  assert.equal(result.worksExamined, 5);
  assert.equal(result.evidenceJournalCount, 2);
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0].id, 'S1');
  assert.equal(result.sources[0].evidencePaperCount, 2);
  assert.equal(result.sources[0].evidenceQueryCount, 2);
  assert.deepEqual(result.sources[0].evidenceQueries, ['query a', 'query b']);
  assert.equal(result.sources[0].hIndex, 80);
  assert.equal(result.errors.length, 0);
});

test('findRecentSimilarPapers searches planned queries separately and merges duplicate works', async () => {
  const requestedSearches = [];
  const result = await findRecentSimilarPapers(
    { name: 'IEEE Access', fields: ['artificial intelligence'] },
    ['大语言模型'],
    {
      env: OPENALEX_ENV,
      source: { id: 'S1', name: 'IEEE Access' },
      queries: ['large language model', 'multimodal report generation'],
      limit: 3,
      recentYears: 3,
      fetchImpl: async (url) => {
        const requestedUrl = new URL(url.toString());
        const search = requestedUrl.searchParams.get('search');
        requestedSearches.push(search);
        const shared = {
          id: 'https://openalex.org/W1',
          display_name: 'Shared Relevant Paper',
          publication_year: 2025,
          publication_date: '2025-01-01',
          relevance_score: 90,
          cited_by_count: 12,
          authorships: [],
          primary_location: {},
          open_access: { is_oa: true },
        };
        return jsonResponse({
          results: search === 'artificial intelligence'
            ? []
            : [shared, {
              ...shared,
              id: `https://openalex.org/W-${requestedSearches.length}`,
              display_name: `Paper for ${search}`,
              relevance_score: 70,
            }],
        });
      },
    },
  );

  assert.deepEqual(requestedSearches, [
    'large language model',
    'multimodal report generation',
    '大语言模型',
    'artificial intelligence',
  ]);
  assert.match(requestedSearches.join('|'), /large language model/);
  assert.ok(!requestedSearches.includes('large language model multimodal report generation 大语言模型'));
  assert.equal(result.items.length, 3);
  assert.equal(result.items[0].id, 'W1');
  assert.equal(result.items[0].evidenceQueryCount, 3);
  assert.equal(result.errors.length, 0);
});
